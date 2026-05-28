
-- Web knowledge cache (periodically crawled HZAU pages)
CREATE TABLE public.web_knowledge (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}'::text[],
  source TEXT NOT NULL DEFAULT 'hzau',
  embedding vector(768),
  last_crawled_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.web_knowledge TO authenticated;
GRANT ALL ON public.web_knowledge TO service_role;

ALTER TABLE public.web_knowledge ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage web_knowledge"
ON public.web_knowledge FOR ALL
TO authenticated
USING (is_admin(auth.uid()))
WITH CHECK (is_admin(auth.uid()));

CREATE INDEX idx_web_knowledge_embedding ON public.web_knowledge USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
CREATE INDEX idx_web_knowledge_source ON public.web_knowledge(source);
CREATE INDEX idx_web_knowledge_last_crawled ON public.web_knowledge(last_crawled_at DESC);

CREATE TRIGGER trg_web_knowledge_updated_at
BEFORE UPDATE ON public.web_knowledge
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Match function for web knowledge
CREATE OR REPLACE FUNCTION public.match_web_knowledge(
  query_embedding vector,
  match_threshold double precision DEFAULT 0.35,
  match_count integer DEFAULT 5
)
RETURNS TABLE(
  id UUID, url TEXT, title TEXT, content TEXT, summary TEXT,
  tags TEXT[], source TEXT, similarity double precision
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT w.id, w.url, w.title, w.content, w.summary, w.tags, w.source,
         1 - (w.embedding <=> query_embedding) AS similarity
  FROM public.web_knowledge w
  WHERE w.embedding IS NOT NULL
    AND 1 - (w.embedding <=> query_embedding) > match_threshold
  ORDER BY w.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- Knowledge gaps: queries we couldn't answer well
CREATE TABLE public.knowledge_gaps (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_query TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  user_id UUID,
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT,
  occurrences INTEGER NOT NULL DEFAULT 1,
  last_seen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  suggested_topic TEXT,
  resolved_at TIMESTAMP WITH TIME ZONE,
  resolved_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_knowledge_gaps_normalized ON public.knowledge_gaps(normalized_query);
CREATE INDEX idx_knowledge_gaps_status ON public.knowledge_gaps(status);
CREATE INDEX idx_knowledge_gaps_last_seen ON public.knowledge_gaps(last_seen_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.knowledge_gaps TO authenticated;
GRANT ALL ON public.knowledge_gaps TO service_role;

ALTER TABLE public.knowledge_gaps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage knowledge_gaps"
ON public.knowledge_gaps FOR ALL
TO authenticated
USING (is_admin(auth.uid()))
WITH CHECK (is_admin(auth.uid()));

CREATE TRIGGER trg_knowledge_gaps_updated_at
BEFORE UPDATE ON public.knowledge_gaps
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Upsert helper called from edge functions via service role
CREATE OR REPLACE FUNCTION public.log_knowledge_gap(
  _query TEXT,
  _user_id UUID,
  _reason TEXT
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _norm TEXT;
BEGIN
  _norm := lower(regexp_replace(coalesce(_query, ''), '\s+', ' ', 'g'));
  _norm := substring(_norm, 1, 300);
  IF length(_norm) < 2 THEN RETURN; END IF;

  INSERT INTO public.knowledge_gaps (user_query, normalized_query, user_id, reason)
  VALUES (substring(_query, 1, 1000), _norm, _user_id, _reason)
  ON CONFLICT (normalized_query) DO UPDATE
    SET occurrences = public.knowledge_gaps.occurrences + 1,
        last_seen_at = now(),
        reason = EXCLUDED.reason,
        status = CASE WHEN public.knowledge_gaps.status = 'resolved' THEN 'pending'
                      ELSE public.knowledge_gaps.status END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_knowledge_gap(TEXT, UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.match_web_knowledge(vector, double precision, integer) TO authenticated, service_role;
