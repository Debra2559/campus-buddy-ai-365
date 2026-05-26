
create table if not exists public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references public.knowledge_files(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  embedding vector(768),
  created_at timestamptz not null default now()
);

create index if not exists knowledge_chunks_file_idx on public.knowledge_chunks(file_id);
create index if not exists knowledge_chunks_embedding_idx
  on public.knowledge_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

alter table public.knowledge_chunks enable row level security;

create policy "Admins manage knowledge_chunks"
  on public.knowledge_chunks for all
  to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create or replace function public.match_knowledge_chunks(
  query_embedding vector(768),
  match_threshold double precision default 0.2,
  match_count integer default 12
)
returns table (
  id uuid,
  file_id uuid,
  file_name text,
  chunk_index integer,
  chunk_content text,
  tags text[],
  similarity double precision
)
language sql stable security definer set search_path = public as $$
  select
    c.id,
    c.file_id,
    f.file_name,
    c.chunk_index,
    c.content as chunk_content,
    f.tags,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.knowledge_chunks c
  join public.knowledge_files f on f.id = c.file_id
  where c.embedding is not null
    and f.status = 'ready'
    and 1 - (c.embedding <=> query_embedding) > match_threshold
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
