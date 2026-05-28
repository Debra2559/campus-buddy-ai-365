// Scheduled / on-demand crawler for HZAU (华中农业大学) official sites.
// Uses Firecrawl /v2/search to find recent pages on hzau.edu.cn for a set of
// curated topics, then embeds + upserts them into public.web_knowledge.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { embedBatch } from "../_shared/embeddings.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Topics to cover. Crawling these covers most everyday student questions.
const DEFAULT_TOPICS = [
  "招生 简章 录取",
  "就业 实习 招聘",
  "教务 课程 学籍 选课",
  "学生工作 奖学金 助学金",
  "保研 推免 考研",
  "心理健康 咨询 帮助",
  "校历 学期 通知 公告",
  "宿舍 后勤 报修 食堂",
  "国际交流 出国 留学",
  "学院 信息学院 生命科学 园艺 动科 经管",
];

async function firecrawlSearchHZAU(topic: string, apiKey: string) {
  const res = await fetch("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `${topic} site:hzau.edu.cn`,
      limit: 5,
      lang: "zh",
      country: "cn",
      scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
    }),
  });
  if (!res.ok) {
    console.error("Firecrawl search failed", res.status, await res.text().catch(() => ""));
    return [];
  }
  const json = await res.json();
  const items: any[] = json?.data?.web || json?.data || [];
  return items.filter((it) => typeof it?.url === "string" && it.url.includes("hzau.edu.cn"));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const lovableKey = Deno.env.get("LOVABLE_API_KEY")!;
  const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");

  if (!firecrawlKey) {
    return new Response(JSON.stringify({ error: "FIRECRAWL_API_KEY not configured" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // Allow caller to override topics (e.g., from admin panel)
  let topics = DEFAULT_TOPICS;
  try {
    const body = await req.json().catch(() => ({}));
    if (Array.isArray(body?.topics) && body.topics.length > 0) {
      topics = body.topics.slice(0, 20).map((t: any) => String(t));
    }
  } catch { /* no body */ }

  console.log(`Starting HZAU crawl for ${topics.length} topics`);

  // Collect all unique URLs first
  const collected = new Map<string, { url: string; title: string; markdown: string; topic: string }>();
  for (const topic of topics) {
    try {
      const items = await firecrawlSearchHZAU(topic, firecrawlKey);
      for (const it of items) {
        if (collected.has(it.url)) continue;
        const md: string = it.markdown || it.description || "";
        if (!md || md.length < 100) continue;
        collected.set(it.url, {
          url: it.url,
          title: String(it.title || it.url).substring(0, 300),
          markdown: md.substring(0, 8000),
          topic,
        });
      }
    } catch (e) {
      console.error("Topic failed", topic, e);
    }
  }

  const pages = Array.from(collected.values());
  console.log(`Collected ${pages.length} unique pages`);

  if (pages.length === 0) {
    return new Response(JSON.stringify({ ok: true, crawled: 0 }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Embed all in one batch (chunked internally)
  const embeddings = await embedBatch(
    pages.map((p) => `${p.title}\n${p.markdown}`.slice(0, 7800)),
    lovableKey,
  );

  let inserted = 0;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const emb = embeddings[i];
    if (!emb) continue;

    const { error } = await supabase
      .from("web_knowledge")
      .upsert(
        {
          url: p.url,
          title: p.title,
          content: p.markdown,
          summary: p.markdown.substring(0, 300).replace(/\s+/g, " "),
          tags: ["华中农业大学", "官方网站", p.topic],
          source: "hzau",
          embedding: emb as unknown as string,
          last_crawled_at: new Date().toISOString(),
        },
        { onConflict: "url" },
      );
    if (error) console.error("Upsert failed for", p.url, error.message);
    else inserted++;
  }

  console.log(`Upserted ${inserted}/${pages.length} pages`);

  return new Response(
    JSON.stringify({ ok: true, crawled: pages.length, upserted: inserted, topics: topics.length }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
