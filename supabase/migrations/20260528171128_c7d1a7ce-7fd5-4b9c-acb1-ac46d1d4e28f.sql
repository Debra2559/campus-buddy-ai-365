ALTER TABLE public.knowledge_files ADD COLUMN IF NOT EXISTS content_hash text;
CREATE INDEX IF NOT EXISTS idx_knowledge_files_content_hash ON public.knowledge_files(content_hash);