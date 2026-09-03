-- Phase 1 schema: profiles, analyses (with embedded state machine + mock
-- result payload), and video metadata. Run this in the Supabase SQL editor
-- or via `supabase db push` once the project is linked.
--
-- Design notes:
--   * Every table uses uuid primary keys.
--   * `analyses` is the parent record a user creates; `videos` holds the
--     metadata for the single uploaded file backing that analysis. They are
--     split into two tables (rather than one) so a future phase can attach
--     more than one video/clip to an analysis without a schema rewrite.
--   * The actual video bytes live in Supabase Storage, never in Postgres.
--     `videos.storage_path` is the only pointer to them.
--   * RLS is enabled on every table; a user can only ever see their own rows.

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- profiles: one row per auth.users row, created automatically on signup.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.profiles is 'One row per authenticated user, mirrors auth.users.';

-- ---------------------------------------------------------------------------
-- analysis_status: the state machine driving the UI.
--   uploaded   -> video file has been stored, no processing has started
--   queued     -> processing has been requested and is waiting to run
--   processing -> the pipeline (metadata, CV, insights) is actively running
--   completed  -> a result is available
--   failed     -> processing could not finish; see analyses.error_message
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'analysis_status') then
    create type public.analysis_status as enum (
      'uploaded',
      'queued',
      'processing',
      'completed',
      'failed'
    );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- analyses: the parent record. One per "upload a game" action.
-- ---------------------------------------------------------------------------
create table if not exists public.analyses (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  title         text not null,
  status        public.analysis_status not null default 'uploaded',
  error_message text,
  -- Mock (Phase 1) or, later, real AnalysisEngine output. Always labelled
  -- with a `source` field inside the JSON so the UI can tell mock data from
  -- real data at a glance. Null until status = 'completed'.
  result        jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists analyses_user_id_idx on public.analyses (user_id);
create index if not exists analyses_status_idx on public.analyses (status);

comment on table public.analyses is 'One row per uploaded-game analysis; drives the dashboard and the status UI.';
comment on column public.analyses.result is 'Structured output of AnalysisEngine. Always mock in Phase 1 — see result->>''source''.';

-- ---------------------------------------------------------------------------
-- videos: metadata for the single file backing an analysis. The bytes live
-- in Supabase Storage; this row is just the pointer + probed metadata.
-- ---------------------------------------------------------------------------
create table if not exists public.videos (
  id                uuid primary key default gen_random_uuid(),
  analysis_id       uuid not null unique references public.analyses (id) on delete cascade,
  user_id           uuid not null references auth.users (id) on delete cascade,
  storage_bucket    text not null default 'videos',
  storage_path      text not null,
  original_filename text not null,
  mime_type         text not null,
  size_bytes        bigint not null,
  duration_seconds  numeric,
  width             integer,
  height            integer,
  fps               numeric,
  codec             text,
  -- Full ffprobe dump for anything the typed columns above don't capture.
  probe_metadata    jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists videos_user_id_idx on public.videos (user_id);
create index if not exists videos_analysis_id_idx on public.videos (analysis_id);

comment on table public.videos is 'Metadata for the uploaded file backing one analysis. Bytes live in Storage, not here.';

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists analyses_set_updated_at on public.analyses;
create trigger analyses_set_updated_at
  before update on public.analyses
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Auto-create a profile row whenever a new auth user signs up.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row Level Security — every table, every user scoped to their own rows.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.analyses enable row level security;
alter table public.videos enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

drop policy if exists "analyses_select_own" on public.analyses;
create policy "analyses_select_own" on public.analyses
  for select using (auth.uid() = user_id);

drop policy if exists "analyses_insert_own" on public.analyses;
create policy "analyses_insert_own" on public.analyses
  for insert with check (auth.uid() = user_id);

drop policy if exists "analyses_update_own" on public.analyses;
create policy "analyses_update_own" on public.analyses
  for update using (auth.uid() = user_id);

drop policy if exists "analyses_delete_own" on public.analyses;
create policy "analyses_delete_own" on public.analyses
  for delete using (auth.uid() = user_id);

drop policy if exists "videos_select_own" on public.videos;
create policy "videos_select_own" on public.videos
  for select using (auth.uid() = user_id);

drop policy if exists "videos_insert_own" on public.videos;
create policy "videos_insert_own" on public.videos
  for insert with check (auth.uid() = user_id);

drop policy if exists "videos_update_own" on public.videos;
create policy "videos_update_own" on public.videos
  for update using (auth.uid() = user_id);

drop policy if exists "videos_delete_own" on public.videos;
create policy "videos_delete_own" on public.videos
  for delete using (auth.uid() = user_id);
