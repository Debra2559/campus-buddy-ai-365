// Shared chunking + embedding helpers
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const EMBED_MODEL = "openai/text-embedding-3-small"; // dim 768 to match vector(768)
const EMBED_DIMS = 768;
const CHUNK_SIZE = 800;     // chars per chunk
const CHUNK_OVERLAP = 150;  // overlap to preserve context across boundaries
const MAX_BATCH = 64;

export function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= CHUNK_SIZE) return [clean];

  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + CHUNK_SIZE, clean.length);
    // try to cut on a sentence/paragraph boundary if available
    if (end < clean.length) {
      const slice = clean.slice(i, end);
      const cut = Math.max(
        slice.lastIndexOf("\n\n"),
        slice.lastIndexOf("。"),
        slice.lastIndexOf("！"),
        slice.lastIndexOf("？"),
        slice.lastIndexOf(". "),
      );
      if (cut > CHUNK_SIZE * 0.5) end = i + cut + 1;
    }
    const piece = clean.slice(i, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    i = end - CHUNK_OVERLAP;
    if (i < 0) i = 0;
  }
  return chunks;
}

export async function embedBatch(inputs: string[], apiKey: string): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const out: number[][] = [];
  for (let i = 0; i < inputs.length; i += MAX_BATCH) {
    const batch = inputs.slice(i, i + MAX_BATCH).map(t => t.slice(0, 8000));
    const resp = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: batch, dimensions: EMBED_DIMS }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Embedding API ${resp.status}: ${body.slice(0, 200)}`);
    }
    const json = await resp.json();
    for (const item of json.data ?? []) out.push(item.embedding as number[]);
  }
  return out;
}

export async function embedFile(
  supabase: ReturnType<typeof createClient>,
  fileId: string,
  contentText: string,
  apiKey: string
): Promise<{ chunks: number; fileEmbedded: boolean }> {
  const chunks = chunkText(contentText);
  if (chunks.length === 0) return { chunks: 0, fileEmbedded: false };

  const vectors = await embedBatch(chunks, apiKey);

  // Replace existing chunks atomically
  await supabase.from("knowledge_chunks").delete().eq("file_id", fileId);

  const rows = chunks.map((content, idx) => ({
    file_id: fileId,
    chunk_index: idx,
    content,
    embedding: vectors[idx] as unknown as string, // pgvector accepts number[]
  }));
  const { error: insErr } = await supabase.from("knowledge_chunks").insert(rows);
  if (insErr) throw new Error(`Insert chunks failed: ${insErr.message}`);

  // Also store a file-level embedding (first chunk, good enough as fallback)
  await supabase
    .from("knowledge_files")
    .update({ embedding: vectors[0] as unknown as string })
    .eq("id", fileId);

  return { chunks: chunks.length, fileEmbedded: true };
}

export async function embedQuery(query: string, apiKey: string): Promise<number[] | null> {
  try {
    const [v] = await embedBatch([query], apiKey);
    return v ?? null;
  } catch (e) {
    console.error("embedQuery error:", e);
    return null;
  }
}
