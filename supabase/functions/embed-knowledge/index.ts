import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAdmin } from "../_shared/auth.ts";
import { embedFile } from "../_shared/embeddings.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await requireAdmin(req, corsHeaders);
  if (!auth.ok) return auth.response!;

  try {
    const { fileId, all } = await req.json().catch(() => ({}));
    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let targets: { id: string; content_text: string | null }[] = [];
    if (all) {
      const { data, error } = await supabase
        .from("knowledge_files")
        .select("id, content_text")
        .eq("status", "ready")
        .not("content_text", "is", null);
      if (error) throw error;
      targets = data ?? [];
    } else if (fileId) {
      const { data, error } = await supabase
        .from("knowledge_files")
        .select("id, content_text")
        .eq("id", fileId)
        .maybeSingle();
      if (error) throw error;
      if (data) targets = [data];
    } else {
      return new Response(JSON.stringify({ error: "fileId or all required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let totalChunks = 0;
    let processed = 0;
    const failures: { id: string; error: string }[] = [];

    for (const t of targets) {
      if (!t.content_text) continue;
      try {
        const r = await embedFile(supabase, t.id, t.content_text, apiKey);
        totalChunks += r.chunks;
        processed += 1;
      } catch (e) {
        failures.push({ id: t.id, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return new Response(
      JSON.stringify({ success: true, processed, totalChunks, failures }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("embed-knowledge error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
