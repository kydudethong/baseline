-- ---------------------------------------------------------------------------
-- Reference library: what good looks like, as numbers.
--
-- The point of this table is what it does NOT store. No footage, no frames,
-- no clips -- only measurements extracted from them. That is the difference
-- between building a benchmark from professional matches and republishing
-- professional matches, and it is also simply the useful part: a percentile
-- needs a distribution, not a video.
--
-- Every measurement here comes out of the same pipeline that measures the
-- user, so a comparison is between two numbers produced the same way.
-- ---------------------------------------------------------------------------

alter table public.analyses
  add column if not exists reference_role text
    check (reference_role in ('subject', 'reference'));

comment on column public.analyses.reference_role is
  'null/subject = a user''s own clip. reference = professional or benchmark footage, measured to populate reference_measurements and never shown as the user''s own analysis.';

-- ---------------------------------------------------------------------------
-- reference_measurements: one row per measured shot or rally from reference
-- footage. Deliberately narrow and long rather than wide -- a metric can be
-- added without a migration, and a metric that turns out not to survive a
-- change of camera can be retired by deleting its rows.
-- ---------------------------------------------------------------------------
create table if not exists public.reference_measurements (
  id                uuid primary key default gen_random_uuid(),
  analysis_id       uuid references public.analyses (id) on delete cascade,
  --: what was measured, e.g. contact_distance_from_kitchen_ft
  metric            text not null,
  value             numeric not null,
  --: shot type this belongs to, when the metric is per-shot
  shot_type         text,
  --: 'pro' | 'advanced' | 'intermediate' -- benchmarks are level-specific
  level             text not null default 'pro',
  --: Where it came from, for provenance. A title and a timestamp, not a file.
  source_label      text,
  source_timestamp_s numeric,
  --: How comparable the CAMERA was to a baseline-behind view. 1 = same kind of
  --: geometry as the app's own footage, 0 = nothing like it. Metrics that are
  --: projection-dependent (joint angles) must only be compared across similar
  --: values; court-space and timing metrics ignore this.
  camera_similarity numeric check (camera_similarity >= 0 and camera_similarity <= 1),
  created_at        timestamptz not null default now()
);

create index if not exists reference_measurements_metric_idx
  on public.reference_measurements (metric, level);
create index if not exists reference_measurements_analysis_idx
  on public.reference_measurements (analysis_id);

comment on table public.reference_measurements is
  'Numbers extracted from reference footage, never the footage. One row per measured shot/rally so distributions and percentiles can be computed per metric and level.';

-- ---------------------------------------------------------------------------
-- reference_benchmarks: the rolled-up distribution per metric. Recomputed
-- from reference_measurements; kept as a table so the coaching pipeline reads
-- one small row instead of aggregating thousands on every run.
-- ---------------------------------------------------------------------------
create table if not exists public.reference_benchmarks (
  metric            text not null,
  level             text not null default 'pro',
  --: '' rather than null for "applies to every shot type". A nullable column
  --: cannot carry a primary key (nulls never compare equal), and the
  --: expression form of that key is not something Postgres accepts.
  shot_type         text not null default '',
  sample_count      integer not null,
  p10               numeric,
  p25               numeric,
  p50               numeric,
  p75               numeric,
  p90               numeric,
  mean              numeric,
  --: Lowest camera_similarity in the sample. A projection-dependent metric
  --: built from mixed cameras is not a benchmark, and this is what says so.
  min_camera_similarity numeric,
  updated_at        timestamptz not null default now(),
  primary key (metric, level, shot_type)
);

comment on table public.reference_benchmarks is
  'Rolled-up percentiles per metric. sample_count is load-bearing: a percentile from nine shots is not a benchmark and the coaching layer must be able to see how thin the evidence is.';

alter table public.reference_measurements enable row level security;
alter table public.reference_benchmarks enable row level security;

-- Benchmarks are shared reference data: every signed-in user reads them,
-- only the service role writes them.
drop policy if exists "reference_measurements readable" on public.reference_measurements;
create policy "reference_measurements readable" on public.reference_measurements
  for select using (auth.role() = 'authenticated');

drop policy if exists "reference_benchmarks readable" on public.reference_benchmarks;
create policy "reference_benchmarks readable" on public.reference_benchmarks
  for select using (auth.role() = 'authenticated');
