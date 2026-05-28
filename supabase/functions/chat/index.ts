import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireUser } from "../_shared/auth.ts";
import { embedQuery } from "../_shared/embeddings.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Calculate TF-IDF inspired similarity score
function calculateSimilarity(
  keywords: string[],
  content: string,
  fileName: string,
  tags: string[],
  totalDocs: number,
  docFrequency: Map<string, number>
): { score: number; matchedKeywords: string[]; details: { keyword: string; weight: number }[] } {
  const contentLower = content.toLowerCase();
  const fileNameLower = fileName.toLowerCase();
  const tagsLower = tags.join(' ').toLowerCase();
  const contentLength = content.length;
  
  let totalScore = 0;
  const matchedKeywords: string[] = [];
  const details: { keyword: string; weight: number }[] = [];
  
  for (const keyword of keywords) {
    // Count occurrences (term frequency)
    const regex = new RegExp(keyword, 'gi');
    const contentMatches = (content.match(regex) || []).length;
    const fileNameMatch = fileNameLower.includes(keyword);
    const tagsMatch = tagsLower.includes(keyword);
    
    if (contentMatches > 0 || fileNameMatch || tagsMatch) {
      matchedKeywords.push(keyword);
      
      // Term frequency with logarithmic scaling (prevents long docs from dominating)
      const tf = contentMatches > 0 ? 1 + Math.log(contentMatches) : 0;
      
      // Inverse document frequency (rarer terms are more important)
      const df = docFrequency.get(keyword) || 1;
      const idf = Math.log(1 + totalDocs / df);
      
      // Base TF-IDF score
      let keywordScore = tf * idf;
      
      // Position bonus: keywords appearing in first 500 chars are more relevant
      const firstOccurrence = contentLower.indexOf(keyword);
      if (firstOccurrence >= 0 && firstOccurrence < 500) {
        keywordScore *= 1.3; // 30% bonus for early occurrence
      }
      
      // Filename match bonus (very strong indicator of relevance)
      if (fileNameMatch) {
        keywordScore += 3 * idf; // Strong bonus for filename match
      }
      
      // Tags match bonus (curated metadata is valuable)
      if (tagsMatch) {
        keywordScore += 2 * idf;
      }
      
      // Density bonus: higher density = more focused document
      const density = contentMatches / (contentLength / 100);
      if (density > 0.5) {
        keywordScore *= 1.2;
      }
      
      totalScore += keywordScore;
      details.push({ keyword, weight: keywordScore });
    }
  }
  
  // Keyword coverage factor: matching more keywords = higher relevance
  const coverageRatio = matchedKeywords.length / keywords.length;
  const coverageBonus = 0.5 + coverageRatio * 0.5; // 0.5 to 1.0 multiplier
  totalScore *= coverageBonus;
  
  // Consecutive keyword bonus: if multiple keywords appear near each other
  if (matchedKeywords.length >= 2) {
    for (let i = 0; i < matchedKeywords.length - 1; i++) {
      const k1 = matchedKeywords[i];
      const k2 = matchedKeywords[i + 1];
      const pos1 = contentLower.indexOf(k1);
      const pos2 = contentLower.indexOf(k2);
      if (pos1 >= 0 && pos2 >= 0 && Math.abs(pos1 - pos2) < 100) {
        totalScore *= 1.15; // 15% bonus for proximity
      }
    }
  }
  
  return { score: totalScore, matchedKeywords, details };
}

// Calibrated similarity for keyword channel.
// Returns conservative values: weak matches stay low, only very strong matches approach ~0.75.
// Heavily weighted by coverage (how many query keywords actually matched).
function calibratedKeywordSimilarity(
  score: number,
  maxScore: number,
  coverageRatio: number,
): number {
  if (maxScore <= 0 || score <= 0) return 0;
  const rel = Math.min(1, score / maxScore); // 0..1 relative to top doc
  // Square-root softens the curve; coverage gates the ceiling.
  const base = Math.sqrt(rel) * 0.6;  // up to 0.6 for top doc
  const covWeighted = base * (0.4 + 0.6 * coverageRatio); // <40% coverage → strongly damped
  return Math.max(0, Math.min(0.78, covWeighted));
}


// Chinese text segmentation - extract meaningful terms from Chinese text
function segmentChinese(text: string): string[] {
  const stopWords = new Set([
    '的', '是', '在', '有', '和', '了', '我', '你', '他', '她', '它', '们', 
    '这', '那', '什么', '怎么', '如何', '吗', '呢', '吧', '啊', '请', '能', 
    '可以', '想', '要', '问', '一下', '关于', '一些', '一个', '哪些', '哪个',
    '为什么', '怎样', '还是', '或者', '但是', '因为', '所以', '如果', '虽然',
    '就是', '那么', '这个', '那个', '都是', '不是', '没有', '已经', '正在'
  ]);
  
  // Common Chinese word patterns (high-value terms)
  const commonTerms = [
    '华中农业大学', '信息学院', '毕业生', '就业', '政策', '西部计划', '志愿服务',
    '研究生', '支教团', '签约', '单位', '灵活就业', '基层', '实习', '工作',
    '学生', '学校', '学院', '考研', '保研', '出国', '留学', '创业', '公务员',
    '选调生', '教师', '研支团', '三支一扶', '特岗', '村官', '招聘', '面试',
    '简历', '求职', '薪资', '待遇', '补贴', '奖学金', '助学金', '贷款',
    '心理', '咨询', '辅导员', '导师', '课程', '学分', '论文', '答辩'
  ];
  
  const results = new Set<string>();
  const cleanText = text.toLowerCase().replace(/[，。？！、；：""''（）【】《》\s]/g, '');
  
  // First, extract known common terms
  for (const term of commonTerms) {
    if (cleanText.includes(term.toLowerCase())) {
      results.add(term.toLowerCase());
    }
  }
  
  // Then, use n-gram approach for Chinese characters (2-4 chars)
  // This helps catch terms not in our dictionary
  const chineseChars = cleanText.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const segment of chineseChars) {
    // Extract 2-char, 3-char, and 4-char n-grams
    for (let len = 2; len <= Math.min(4, segment.length); len++) {
      for (let i = 0; i <= segment.length - len; i++) {
        const ngram = segment.substring(i, i + len);
        if (!stopWords.has(ngram)) {
          results.add(ngram);
        }
      }
    }
  }
  
  // Also extract English words and numbers
  const englishWords = text.toLowerCase().match(/[a-z]+/gi) || [];
  for (const word of englishWords) {
    if (word.length >= 2) {
      results.add(word);
    }
  }
  
  return Array.from(results);
}

// Improved keyword-based search with TF-IDF scoring
async function keywordSearch(
  supabase: any, 
  query: string
): Promise<Array<{ file_name: string; content_text: string; tags: string[]; score: number; similarity: number; id: string; matchDetails: string }>> {
  try {
    // Get all files with content
    const { data: files, error } = await supabase
      .from('knowledge_files')
      .select('id, file_name, content_text, tags')
      .eq('status', 'ready')
      .not('content_text', 'is', null);

    if (error || !files) {
      console.error("Keyword search error:", error);
      return [];
    }

    console.log(`Found ${files.length} knowledge files to search`);

    // Use Chinese segmentation to extract keywords
    const keywords = segmentChinese(query);
    
    // Prioritize longer terms (they're more specific)
    keywords.sort((a, b) => b.length - a.length);
    
    // Take top 15 keywords (avoid too many n-grams)
    const topKeywords = keywords.slice(0, 15);
    
    console.log("Search keywords:", topKeywords.join(", "));
    
    if (topKeywords.length === 0) {
      console.log("No valid keywords extracted");
      return [];
    }

    // Build document frequency map (how many docs contain each keyword)
    const docFrequency = new Map<string, number>();
    for (const keyword of topKeywords) {
      let count = 0;
      for (const file of files) {
        if (!file.content_text) continue;
        const content = file.content_text.toLowerCase();
        const fileName = file.file_name.toLowerCase();
        const tags = (file.tags || []).join(' ').toLowerCase();
        if (content.includes(keyword) || fileName.includes(keyword) || tags.includes(keyword)) {
          count++;
        }
      }
      docFrequency.set(keyword, count);
    }
    
    console.log("Top document frequencies:", 
      Array.from(docFrequency.entries())
        .filter(([_, count]) => count > 0)
        .slice(0, 10)
        .map(([k, v]) => `${k}:${v}`)
        .join(", "));

    const results: Array<{ 
      file_name: string; 
      content_text: string; 
      tags: string[]; 
      score: number; 
      similarity: number;
      id: string;
      matchDetails: string;
    }> = [];

    for (const file of files) {
      if (!file.content_text) continue;
      
      const { score, matchedKeywords, details } = calculateSimilarity(
        topKeywords,
        file.content_text,
        file.file_name,
        file.tags || [],
        files.length,
        docFrequency
      );
      
      if (score > 0) {
        const matchDetails = details
          .sort((a, b) => b.weight - a.weight)
          .map(d => `${d.keyword}(${d.weight.toFixed(1)})`)
          .join(', ');

        results.push({
          id: file.id,
          file_name: file.file_name,
          content_text: file.content_text,
          tags: file.tags || [],
          score,
          similarity: 0, // Will be calibrated later
          matchDetails,
          coverage: matchedKeywords.length / Math.max(1, topKeywords.length),
        } as any);
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    // Calibrate scores to similarity (conservative, coverage-weighted)
    const maxScore = results.length > 0 ? results[0].score : 1;
    for (const result of results as any[]) {
      result.similarity = calibratedKeywordSimilarity(result.score, maxScore, result.coverage ?? 0);
    }
    // Drop low-confidence results to avoid 30%+ noise
    const filtered = (results as any[]).filter(r => r.similarity >= 0.25);

    
    console.log(`Keyword search found ${results.length} matching files`);
    if (results.length > 0) {
      console.log("Top matches:", results.slice(0, 3).map(r => ({
        file: r.file_name,
        score: r.score.toFixed(2),
        similarity: (r.similarity * 100).toFixed(0) + '%',
        details: r.matchDetails
      })));
    }
    
    return filtered.slice(0, 5);

  } catch (e) {
    console.error("Error in keyword search:", e);
    return [];
  }
}

// Get some knowledge files as fallback context
async function getFallbackKnowledge(
  supabase: any, 
  limit: number = 3
): Promise<Array<{ file_name: string; content_text: string; tags: string[]; id: string }>> {
  try {
    const { data, error } = await supabase
      .from('knowledge_files')
      .select('id, file_name, content_text, tags')
      .eq('status', 'ready')
      .not('content_text', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (error || !data) {
      console.error("Fallback knowledge error:", error);
      return [];
    }

    return data;
  } catch (e) {
    console.error("Error getting fallback knowledge:", e);
    return [];
  }
}

// Vector-based search over knowledge_chunks (precision channel)
async function vectorSearch(
  supabase: any,
  query: string,
  apiKey: string,
): Promise<Array<{ id: string; file_id: string; file_name: string; chunk_content: string; tags: string[]; similarity: number; chunk_index: number }>> {
  try {
    const vec = await embedQuery(query, apiKey);
    if (!vec) return [];
    const { data, error } = await supabase.rpc("match_knowledge_chunks", {
      query_embedding: vec,
      match_threshold: 0.35,
      match_count: 12,
    });
    if (error) {
      console.error("vectorSearch RPC error:", error);
      return [];
    }
    console.log(`Vector search returned ${data?.length || 0} chunks`);
    return data || [];
  } catch (e) {
    console.error("vectorSearch error:", e);
    return [];
  }
}

// Get knowledge context - hybrid: TF-IDF keyword search + chunk-level vector search, fused via RRF
async function getKnowledgeContext(
  supabase: any,
  userQuery: string,
  apiKey: string,
): Promise<{ context: string; sources: Array<{ fileName: string; similarity: number; tags: string[]; id: string; index?: number; snippet?: string }> }> {
  try {
    // Run both channels in parallel
    const [keywordResults, vectorChunks] = await Promise.all([
      keywordSearch(supabase, userQuery),
      vectorSearch(supabase, userQuery, apiKey),
    ]);

    // ---- RRF fusion at file level ----
    // For vector channel, aggregate chunks per file: take best chunk per file as the file's hit.
    const bestChunkPerFile = new Map<string, typeof vectorChunks[number]>();
    for (const c of vectorChunks) {
      const prev = bestChunkPerFile.get(c.file_id);
      if (!prev || c.similarity > prev.similarity) bestChunkPerFile.set(c.file_id, c);
    }
    const vectorRanked = Array.from(bestChunkPerFile.values())
      .sort((a, b) => b.similarity - a.similarity);

    const K = 60; // RRF constant
    type FileHit = {
      id: string;
      file_name: string;
      tags: string[];
      bestSnippet: string;       // most relevant chunk (vector) or content head (kw)
      content_text?: string;     // for keyword channel context
      rrf: number;
      vectorSim?: number;
      keywordSim?: number;
    };
    const fused = new Map<string, FileHit>();

    keywordResults.forEach((r, i) => {
      const cur = fused.get(r.id) ?? {
        id: r.id, file_name: r.file_name, tags: r.tags || [],
        bestSnippet: r.content_text.substring(0, 600), content_text: r.content_text, rrf: 0,
      };
      cur.rrf += 1 / (K + i + 1);
      cur.keywordSim = r.similarity;
      cur.content_text = r.content_text;
      fused.set(r.id, cur);
    });

    vectorRanked.forEach((c, i) => {
      const cur = fused.get(c.file_id) ?? {
        id: c.file_id, file_name: c.file_name, tags: c.tags || [],
        bestSnippet: c.chunk_content, rrf: 0,
      };
      cur.rrf += 1.4 / (K + i + 1); // slight weight to vector for precision
      cur.vectorSim = c.similarity;
      // Prefer the matching chunk as snippet (more focused than head-of-doc)
      cur.bestSnippet = c.chunk_content;
      fused.set(c.file_id, cur);
    });

    const merged = Array.from(fused.values()).sort((a, b) => b.rrf - a.rrf).slice(0, 5);

    if (merged.length > 0) {
      console.log("Fused top sources:", merged.map(m => ({
        file: m.file_name,
        rrf: m.rrf.toFixed(4),
        kw: m.keywordSim ? (m.keywordSim * 100).toFixed(0) + "%" : "-",
        vec: m.vectorSim ? (m.vectorSim * 100).toFixed(0) + "%" : "-",
      })));

      // Effective similarity for display: combine vector + keyword.
      // - Both: weighted blend (vector dominant) — confirms relevance from two channels.
      // - Vector only: use vector cosine directly (already calibrated 0-1).
      // - Keyword only: use calibrated keyword similarity, but cap lower since no semantic confirmation.
      const effectiveSim = (m: typeof merged[number]): number => {
        const v = m.vectorSim;
        const k = m.keywordSim;
        if (v != null && k != null) return Math.min(0.98, v * 0.75 + k * 0.25 + 0.03);
        if (v != null) return v;
        if (k != null) return Math.min(0.6, k); // keyword-only: cap at 60%
        return 0.3;
      };

      const sources = merged.map((m, index) => ({
        id: m.id,
        fileName: m.file_name,
        similarity: effectiveSim(m),
        tags: m.tags,
        index: index + 1,
        snippet: m.bestSnippet.substring(0, 200).replace(/\n/g, ' '),
      }));

      const contents = merged.map((m, index) => {
        const tags = m.tags?.length > 0 ? `[标签: ${m.tags.join(', ')}]` : '';
        const sim = effectiveSim(m);
        const scoreLabel = `[匹配度: ${Math.round(sim * 100)}%]`;
        // Use the matched chunk content if available, else doc head
        const body = m.bestSnippet.length > 2500
          ? m.bestSnippet.substring(0, 2500) + '...'
          : m.bestSnippet;
        return `【来源[${index + 1}]: ${m.file_name}】${tags} ${scoreLabel}\n${body}`;
      });


      return {
        context: `\n\n以下是与问题最相关的知识库片段（已做语义+关键词融合检索）：\n\n${contents.join('\n\n---\n\n')}`,
        sources,
      };
    }

    // Fallback: get recent knowledge files
    console.log("No fused matches, using fallback");
    const fallbackKnowledge = await getFallbackKnowledge(supabase, 3);
    if (fallbackKnowledge.length > 0) {
      const contents = fallbackKnowledge.map(r => {
        const tags = r.tags?.length > 0 ? `[标签: ${r.tags.join(', ')}]` : '';
        const truncated = r.content_text.length > 2000
          ? r.content_text.substring(0, 2000) + '...'
          : r.content_text;
        return `【${r.file_name}】${tags} [参考资料]\n${truncated}`;
      });
      return {
        context: `\n\n以下是知识库中的参考资料（供参考）：\n\n${contents.join('\n\n---\n\n')}`,
        sources: fallbackKnowledge.map(r => ({
          id: r.id, fileName: r.file_name, similarity: 0.5, tags: r.tags || [],
        })),
      };
    }

    return { context: '', sources: [] };
  } catch (e) {
    console.error("Error in getKnowledgeContext:", e);
    return { context: '', sources: [] };
  }
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await requireUser(req, corsHeaders);
  if (!auth.ok) return auth.response!;

  try {
    const { messages, files } = await req.json();
    console.log("Received chat request with", messages?.length || 0, "messages and", files?.length || 0, "files");
    
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      console.error("LOVABLE_API_KEY is not configured");
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    // Create Supabase client for fetching knowledge
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Extract latest user query for knowledge search
    const latestUserMessage = messages
      .filter((m: any) => m.role === 'user')
      .pop()?.content || '';
    
    console.log("User query for knowledge search:", latestUserMessage.substring(0, 100));

    // Process uploaded files
    let fileContext = '';
    if (files && files.length > 0) {
      console.log("Processing uploaded files:", files.map((f: any) => f.name).join(', '));
      
      const fileContents = files.map((f: any) => {
        if (f.type === 'text') {
          return `【用户上传的文件: ${f.name}】\n${f.content}`;
        } else if (f.type === 'image') {
          return `【用户上传的图片: ${f.name}】（图片已接收，请在回复中描述看到的内容）`;
        } else {
          return `【用户上传的文件: ${f.name}】${f.content}`;
        }
      });
      
      fileContext = `\n\n用户上传的文件内容：\n${fileContents.join('\n\n---\n\n')}`;
    }

    // Get knowledge base context using keyword search
    const { context: knowledgeContext, sources } = await getKnowledgeContext(supabase, latestUserMessage, LOVABLE_API_KEY);
    console.log("Knowledge context length:", knowledgeContext.length, "Sources:", sources.length);

    // Build system prompt with file context if present
    let systemPrompt = `你是一位友善、专业的校园AI辅导员。

**回答风格要求（必须遵守）：**
- 回答要**简洁精炼**，直接给出核心信息，避免冗长
- 使用清晰的结构：要点用简短列表，复杂内容分步骤
- 每个要点控制在1-2句话内
- 适当使用emoji增加亲和力，但不要过多
- 不要写太长的开场白，直接进入正题
- 避免重复和啰嗦的表达

**推荐问题（必须遵守）：**
- 在每次回答的最末尾，必须附上2-3个相关的推荐问题，帮助用户继续深入了解
- 格式严格为：<<SUGGESTIONS>>问题1||问题2||问题3<</SUGGESTIONS>>
- 推荐问题要与当前话题相关，简短有吸引力，像是用户可能会继续问的问题
- 不要在推荐问题前加任何说明文字，直接输出标记
- 例如：<<SUGGESTIONS>>如何申请奖学金？||转专业需要什么条件？||大一可以参加哪些社团？<</SUGGESTIONS>>`;

    // Add file analysis instructions if files are uploaded
    if (fileContext) {
      systemPrompt += `

**用户上传了文件，请仔细分析文件内容：**
1. 如果是文本文件，请阅读并理解其内容，根据用户问题进行分析
2. 如果用户没有具体问题，请总结文件的主要内容
3. 可以结合知识库内容对文件进行补充说明
${fileContext}`;
    }

    // Add knowledge base rules
    systemPrompt += `

**知识库使用规则：**
1. 优先基于知识库内容回答校园相关问题
2. **必须在回答中使用行内引用标记**：当你使用了某个来源的内容时，在相关句子末尾添加对应的引用标记，格式为 [1]、[2] 等，对应知识库来源的编号
3. 每个要点或段落后标注所引用的来源编号，可以同时引用多个来源如 [1][3]
4. 如果知识库中有相关内容，直接回答要点并标注来源
5. **如果知识库没有相关信息且没有用户上传文件，说："抱歉，我没有找到相关信息，建议咨询学院老师或相关部门。"**
6. **严禁编造知识库中没有的信息**
7. **不要在回答末尾列出参考来源列表**，系统会自动展示来源信息${knowledgeContext}`;

    console.log("Calling Lovable AI Gateway...");
    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-pro",
        messages: [
          { role: "system", content: systemPrompt },
          ...messages,
        ],
        stream: true,
        max_tokens: 2048,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("AI gateway error:", response.status, errorText);
      
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "请求过于频繁，请稍后再试。" }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "AI额度已用完，请联系管理员充值。" }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      
      return new Response(JSON.stringify({ error: "AI服务暂时不可用，请稍后重试。" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Log knowledge usage for statistics (background task)
    if (sources.length > 0) {
      // Log usage in background (fire and forget)
      (async () => {
        for (const source of sources) {
          try {
            await supabase.from('knowledge_usage').insert({
              file_id: source.id,
              user_query: latestUserMessage.substring(0, 500),
              similarity: source.similarity,
            });
          } catch (e) {
            console.error('Error logging knowledge usage:', e);
          }
        }
      })();
    }

    // Create a TransformStream to inject sources at the start, so citations can render while streaming
    const sourcesData = sources.length > 0 ? JSON.stringify(sources) : null;
    
    // If we have sources, prepend them without waiting for the AI stream to finish
    if (sourcesData && response.body) {
      const reader = response.body.getReader();
      const encoder = new TextEncoder();
      
      const stream = new ReadableStream({
        async start(controller) {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ sources })}\n\n`));
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              controller.enqueue(value);
            }
            controller.close();
          } catch (e) {
            controller.error(e);
          }
        }
      });

      return new Response(stream, {
        headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
      });
    }

    console.log("Streaming response from AI gateway...");
    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("Chat function error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "服务器错误" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
