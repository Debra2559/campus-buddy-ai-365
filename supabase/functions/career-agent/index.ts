import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Search Boss直聘 for job listings via Firecrawl
async function searchBossJobs(jobTitles: string[]): Promise<{ title: string; company: string; salary: string; location: string; url: string; tags: string[] }[]> {
  const apiKey = Deno.env.get("FIRECRAWL_API_KEY");
  if (!apiKey) {
    console.log("FIRECRAWL_API_KEY not configured, skipping Boss直聘 search");
    return [];
  }

  const allJobs: { title: string; company: string; salary: string; location: string; url: string; tags: string[] }[] = [];

  // Search for top 2-3 job titles to avoid too many API calls
  const searchTitles = jobTitles.slice(0, 3);

  for (const title of searchTitles) {
    try {
      const searchQuery = `site:zhipin.com ${title} 招聘`;
      console.log("Searching Boss直聘:", searchQuery);

      const response = await fetch("https://api.firecrawl.dev/v1/search", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: searchQuery,
          limit: 5,
          lang: "zh",
          country: "cn",
        }),
      });

      if (!response.ok) {
        console.error("Firecrawl search error:", response.status);
        continue;
      }

      const data = await response.json();
      const results = data.data || [];

      for (const item of results) {
        const itemUrl = item.url || "";
        const itemTitle = item.title || "";
        const description = item.description || "";

        // Only include actual Boss直聘 job listing URLs
        if (!itemUrl.includes("zhipin.com")) continue;

        // Try to extract job info from title/description
        const salaryMatch = description.match(/(\d+[-·]\d+[kK万])/);
        const locationMatch = description.match(/(北京|上海|广州|深圳|杭州|成都|武汉|南京|西安|重庆|苏州|天津|长沙|郑州|合肥)/);

        allJobs.push({
          title: itemTitle.replace(/[-_|·].*?(BOSS直聘|boss直聘|zhipin).*$/i, "").trim() || title,
          company: "",
          salary: salaryMatch ? salaryMatch[1] : "",
          location: locationMatch ? locationMatch[1] : "",
          url: itemUrl,
          tags: [title],
        });
      }
    } catch (e) {
      console.error(`Error searching Boss直聘 for "${title}":`, e);
    }
  }

  // Deduplicate by URL and limit to 8
  const seen = new Set<string>();
  const unique = allJobs.filter(j => {
    if (seen.has(j.url)) return false;
    seen.add(j.url);
    return true;
  });

  console.log(`Found ${unique.length} unique Boss直聘 jobs`);
  return unique.slice(0, 8);
}

// Detect if AI is about to generate a report (check recent messages for report-related content)
function isReportPhase(messages: any[]): boolean {
  const assistantMsgs = messages.filter((m: any) => m.role === "assistant");
  const userMsgs = messages.filter((m: any) => m.role === "user");
  // Heuristic: if we have enough conversation rounds (8+), likely approaching report
  return userMsgs.length >= 7;
}

// Extract recommended job titles from a career-report JSON block
function extractJobTitles(content: string): string[] {
  const match = content.match(/```career-report\s*([\s\S]*?)```/);
  if (!match) return [];
  try {
    const data = JSON.parse(match[1].trim());
    return (data.recommendations || []).map((r: any) => r.title).filter(Boolean);
  } catch {
    return [];
  }
}

function detectCareerDirection(text: string): string | null {
  const normalized = text.replace(/\s+/g, "");
  const hasExplicitContext = /(毕业去向|初步打算|学业方向|毕业后|去向|打算)/.test(normalized);
  if (/(保研|考研|读研|升学)/.test(normalized)) return "保研/考研";
  if (/(直接就业|就业|工作|求职)/.test(normalized)) return "直接就业";
  if (/(出国留学|留学|海外)/.test(normalized)) return "出国留学";
  if (/(考公|考编|公务员|事业编)/.test(normalized)) return "考公/考编";
  if (hasExplicitContext && /(还没想好|不确定|未定|迷茫)/.test(normalized)) return "还没想好";
  return null;
}

function buildConfirmedInfoPrompt(messages: any[]): string {
  const userMessages = Array.isArray(messages) ? messages.filter((m: any) => m?.role === "user") : [];
  const direction = [...userMessages].reverse().map((m: any) => detectCareerDirection(String(m.content || ""))).find(Boolean);
  if (!direction) return "";

  return [
    "## 已确认信息（最高优先级）",
    `- 学生已确认毕业去向/初步打算：${direction}`,
    "- 后续回复禁止再次询问、确认或提供“保研/考研、直接就业、出国留学、考公/考编、还没想好”等毕业去向选项。",
    "- 如果还缺专业或年级，只问专业和年级；如果专业/年级也已有，则进入选择专业原因、专业满意度或下一模块。",
  ].join("\n");
}

const SYSTEM_PROMPT = `你是一位持有GCDF（全球职业规划师）和BCC（认证职业教练）双认证的资深职业规划顾问，专门为华中农业大学学生提供深度职业测评与规划服务。

## 测评框架（共6大模块，8-12轮对话）

你必须按以下模块逐步深入，每个模块至少1-2轮对话，不可跳过或合并模块。

### 模块一：基础画像（第1轮）
- 了解专业、年级、学业方向（保研/考研/就业/留学）
- 追问：为什么选择这个专业？是自己选的还是调剂的？对当前专业的满意度如何？
- 如果学生已经回答了学业方向/毕业去向（如“我的毕业去向/初步打算：直接就业”），必须视为已收集，不要再次询问保研/考研/就业/留学；只追问仍缺失的专业、年级或选择专业原因。

### 模块二：性格深度测评（第2-3轮）
使用情境模拟题代替直接提问，通过行为推断性格：

**情境题示例（必须使用此类格式）：**
"假设你被分配到一个5人小组完成课程大作业，但有两个组员一直不参与。你会怎么做？ 🤔

A. 直接找他们沟通，明确分工和deadline
B. 默默把活干了，避免冲突
C. 跟老师反映情况，寻求公平解决
D. 组织一次组会，了解他们的困难再决定
E. 拉上靠谱的人重新分组"

- 至少设计2个不同场景的情境题（工作场景、团队协作、压力场景等）
- 根据回答推断MBTI四个维度的倾向，但不要直接问"你是I还是E"
- 追问关键细节："你说会直接沟通，你一般会怎么开口？"

### 模块三：专业技能与经历深挖（第4-5轮）
不只是问"会什么"，而是评估深度：

"关于你提到的编程能力，我想更具体地了解：

A. 能独立完成完整项目（前后端/算法）
B. 课程作业能做，但没独立项目经验
C. 参加过编程竞赛或开源项目
D. 有实习/实际工作中的编程经验
E. 刚入门，在自学阶段"

追问方向：
- "你做过的最有成就感的项目是什么？你在其中负责什么？"
- "这个技能你觉得在行业中属于什么水平？入门/熟练/精通？"
- "你有没有相关的实习、竞赛、证书或作品？"

### 模块四：职业价值观深度挖掘（第6-7轮）
通过两难选择和排序题挖掘真实价值观：

**两难选择题格式：**
"假设你同时拿到两个offer，你会怎么选？ ⚖️

A. 大厂年薪30w但996，技术前沿但压力大
B. 国企年薪15w朝九晚五，稳定但技术迭代慢"

**价值观排序题：**
"请把以下因素按对你的重要程度排序（选出你最看重的2-3项）：

A. 薪资收入（越多越好）
B. 工作与生活平衡
C. 个人成长与学习机会
D. 社会影响力与意义感
E. 团队氛围与人际关系"

追问："你选了XX，能说说为什么这个对你特别重要吗？有没有什么经历影响了你的想法？"

### 模块五：职业认知与期望（第8-9轮）
评估学生对职业市场的了解程度：
- "你目前最感兴趣的3个职业方向是什么？你对这些方向了解多少？"
- "你理想中5年后的工作状态是什么样的？"
- "你对自己当前的竞争力有什么评估？觉得哪些方面需要提升？"

### 模块六：总结确认（第10轮）
在生成报告前，先总结你的发现并让学生确认：
"根据我们的对话，我总结一下对你的了解：[总结要点]。你觉得准确吗？有什么需要补充或纠正的？"

## 对话规则

### 提问风格
- **只问选择题，不问开放/填空题**：每一轮提问必须以 A./B./C. 形式给出可选项，让学生点选即可。严禁出现"请具体描述…""说说你的…""能否详细讲讲…""主要负责哪些部分"等需要学生大段文字回答的问题。
- 即使想澄清矛盾或挖掘动机，也必须写成选择题（例如"你的意思更接近哪种？A. … B. … C. 两者都不是"）。
- 每次只问 1 个核心问题，配 3-5 个选项。
- 回答前先从最近的用户消息中抽取已知信息，禁止重复询问用户刚刚已经回答的内容。
- 禁止把选项写在自然句里（例如"是A、B，还是C？"）；凡是可枚举的选项，都必须另起新行写成 A./B./C. 格式。
- 语气友善但专业，像一位有经验的学长/学姐。

### 追问策略（全部用选择题形式）
- 学生说"喜欢编程" → "更偏哪方面？A. 算法/底层 B. 做产品/应用 C. 数据/AI D. 其他"
- 学生说"想赚钱" → "为了高薪你最愿意牺牲什么？A. 工作时长 B. 居住城市 C. 兴趣方向 D. 都不愿意"
- 学生回答出现矛盾 → 用选择题让其二选一澄清，而不是要求自由描述

### 严禁行为
- 不要引用任何外部资料、网站链接或来源
- 不要在对话不到8轮时就生成报告
- 不要跳过任何模块
- **严禁提开放式/填空式问题**，所有问题必须配 A./B./C. 选项
- 不要在学生回答模糊时直接接受并跳过，要用选择题继续澄清

## 选项格式要求
所有选项必须严格遵守以下格式，每个选项独占一行：
A. 选项内容
B. 选项内容
C. 选项内容

选项要求：
- 每个选项文字简短，不超过25个字
- 每题必须提供3-5个选项，可加 "其他" 但不要让学生填空
- 选项前用大写字母A/B/C/D/E标注
- 适当使用emoji让对话更轻松
- 首轮基础画像必须至少给出毕业打算选项：A. 保研/考研 B. 直接就业 C. 出国留学 D. 考公/考编 E. 还没想好
- 示例：不要写"是编程逻辑、解决问题，还是前沿技术？"；必须写：\nA. 编程逻辑\nB. 解决问题\nC. 前沿技术

## 报告生成

**当且仅当完成所有6个模块后**，按以下JSON格式输出报告（用 \`\`\`career-report 和 \`\`\` 包裹）：

在报告之前，先用2-3段文字详细总结你的分析思路，包括：
1. 性格分析依据（引用学生在情境题中的具体回答）
2. 能力评估结论
3. 价值观判断逻辑

\`\`\`career-report
{
  "personality": {
    "type": "MBTI类型（附带简要解释）",
    "traits": [
      { "name": "维度名称", "score": 85, "label": "高/中/低" }
    ],
    "summary": "200字以上的性格深度分析，引用对话中的具体表现"
  },
  "analysis": {
    "strengths": ["优势1（附具体表现）", "优势2", "优势3", "优势4"],
    "weaknesses": ["需要提升的方面1", "需要提升的方面2"],
    "interests": ["兴趣方向1", "兴趣方向2", "兴趣方向3"],
    "values": ["核心价值观1", "核心价值观2", "核心价值观3"]
  },
  "recommendations": [
    {
      "title": "岗位名称",
      "match": 92,
      "category": "行业类别",
      "salary": "薪资范围（区分城市和经验级别）",
      "outlook": "详细的发展前景描述",
      "reasons": ["基于测评结果的推荐理由1", "推荐理由2", "推荐理由3"],
      "skills": ["当前已具备的技能", "需要补充的技能"],
      "path": "详细的3-5年成长路径",
      "risks": "这个方向的潜在风险或挑战"
    }
  ],
  "trends": [
    { "industry": "行业名", "trend": "上升/稳定/下降", "description": "趋势描述及对学生的影响" }
  ],
  "learningPath": [
    { "phase": "阶段名", "duration": "时间", "actions": ["具体可执行的行动1", "行动2", "行动3"] }
  ]
}
\`\`\`

报告要求：
- 推荐4-5个岗位，match分数60-95之间，要有区分度
- 性格traits提供6-8个维度，score在25-95之间
- personality.summary至少200字，要引用对话中的具体回答作为分析依据
- recommendations中每个岗位的reasons要结合学生的具体情况，不要泛泛而谈
- learningPath要具体到可执行的行动，如"刷LeetCode中等难度50题"而不是"提升算法能力"
- 必须包含weaknesses字段，诚实指出需要提升的方面`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  // 职业规划无需鉴权，匿名用户也可使用


  try {
    const { messages } = await req.json();
    const confirmedInfoPrompt = buildConfirmedInfoPrompt(messages);
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...(confirmedInfoPrompt ? [{ role: "system", content: confirmedInfoPrompt }] : []),
          ...messages,
        ],
        stream: true,
          temperature: 0.2,
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
        return new Response(JSON.stringify({ error: "AI服务额度不足。" }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "AI服务暂时不可用" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // We need to buffer the full response to check if it contains a report
    // If it does, we'll search Boss直聘 and append job listings as a special SSE event
    const encoder = new TextEncoder();

    const transformStream = new TransformStream({
      fullContent: "",
      async transform(chunk, controller) {
        controller.enqueue(chunk);

        // Accumulate content to detect report
        const text = new TextDecoder().decode(chunk);
        (this as any).fullContent = ((this as any).fullContent || "") + text;
      },
      async flush(controller) {
        const fullContent = (this as any).fullContent || "";

        // Check if the response contained a career report
        const jobTitles = extractJobTitles(fullContent);
        if (jobTitles.length > 0) {
          console.log("Report detected, searching Boss直聘 for:", jobTitles);
          try {
            const bossJobs = await searchBossJobs(jobTitles);
            if (bossJobs.length > 0) {
              const jobsEvent = `data: ${JSON.stringify({ bossJobs })}\n\n`;
              controller.enqueue(encoder.encode(jobsEvent));
            }
          } catch (e) {
            console.error("Boss直聘 search error:", e);
          }
        }
      },
    });

    const stream = response.body!.pipeThrough(transformStream);

    return new Response(stream, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("Career agent error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "未知错误" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
