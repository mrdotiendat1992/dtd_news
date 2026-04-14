create extension if not exists pgcrypto;

create table if not exists public.news_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  feed_url text not null unique,
  category text not null default 'general',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.raw_news_items (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.news_sources(id) on delete cascade,
  title text not null,
  url text not null unique,
  summary text,
  content text,
  image_url text,
  published_at timestamptz,
  fingerprint text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.aggregated_articles (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  summary text not null,
  body text not null,
  category text not null default 'general',
  source_count int not null default 0,
  source_links jsonb not null default '[]'::jsonb,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ingest_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null,
  sources_count int not null default 0,
  items_count int not null default 0,
  articles_count int not null default 0,
  message text,
  created_at timestamptz not null default now()
);

create index if not exists raw_news_items_source_id_idx on public.raw_news_items(source_id);
create index if not exists raw_news_items_published_at_idx on public.raw_news_items(published_at desc);
create index if not exists aggregated_articles_published_at_idx on public.aggregated_articles(published_at desc);
create index if not exists ingest_runs_started_at_idx on public.ingest_runs(started_at desc);

alter table public.news_sources enable row level security;
alter table public.raw_news_items enable row level security;
alter table public.aggregated_articles enable row level security;
alter table public.ingest_runs enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'news_sources' and policyname = 'Public read news sources'
  ) then
    create policy "Public read news sources"
    on public.news_sources
    for select
    using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'raw_news_items' and policyname = 'Public read raw news items'
  ) then
    create policy "Public read raw news items"
    on public.raw_news_items
    for select
    using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'aggregated_articles' and policyname = 'Public read aggregated articles'
  ) then
    create policy "Public read aggregated articles"
    on public.aggregated_articles
    for select
    using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'ingest_runs' and policyname = 'Public read ingest runs'
  ) then
    create policy "Public read ingest runs"
    on public.ingest_runs
    for select
    using (true);
  end if;
end $$;

insert into public.news_sources (name, feed_url, category)
values
  ('VnExpress - Thời sự', 'https://vnexpress.net/rss/thoi-su.rss', 'thoi-su'),
  ('VnExpress - Kinh doanh', 'https://vnexpress.net/rss/kinh-doanh.rss', 'kinh-doanh'),
  ('VnExpress - Thế giới', 'https://vnexpress.net/rss/the-gioi.rss', 'the-gioi'),
  ('VOV - Tin thời sự', 'https://vov.vn/rss/tin-moi.rss', 'thoi-su'),
  ('VietnamPlus - Thời sự', 'https://www.vietnamplus.vn/rss/thoisu.rss', 'thoi-su')
on conflict (feed_url) do nothing;
