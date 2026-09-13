-- Phase 1: make the analysis readable by a frontend without parsing blobs.
--
-- Additive only. Nothing here drops or rewrites an existing table, and
-- coaching_rallies is deliberately left alone so anything already reading it
-- keeps working.
--
-- Four problems this fixes, in order of how much they hurt:
--
--   1. Rally boundaries only existed if the COACHING pass had run, and even
--      then they were a re-derivation: run-coaching.ts re-clusters the stored
--      contact timestamps, which disagrees with the segmenter on numbering and
--      often on rally count. The segmenter's real output -- net crossings,
--      keep-alive, why each rally ended -- never reached the database at all.
--   2. Swing mechanics existed only inside coaching_reads.facts_json, a TEXT
--      column, so the only way to show a knee angle was to fetch and parse the
--      whole coaching payload.
--   3. The pipeline computes a full QualityDiagnostics and persists four
--      numbers of it. Everything a UI needs to be honest about confidence was
--      dropped on the floor.
--   4. The UI could not tell a user what was happening during a multi-minute
--      run because stage information never left stderr.

-- ---------------------------------------------------------------------------
-- The segmenter's own rallies.
--
-- Separate from coaching_rallies on purpose. These are written in the SAME
-- transaction as analysis_shots, from the same `rallies` array the shots were
-- cut from -- so analysis_shots.rally_idx IS a valid join key against THIS
-- table, though it remains unsafe against coaching_rallies. That is the whole
-- reason this table exists rather than a synthetic rally id: the relationship
-- is already real, it just was not being stored.
-- ---------------------------------------------------------------------------
create table if not exists public.analysis_rallies (
  id                uuid primary key default gen_random_uuid(),
  analysis_id       uuid not null references public.analyses (id) on delete cascade,
  idx               integer not null,
  start_s           numeric not null,
  end_s             numeric not null,
  -- Which segmenter drew this boundary. A UI should say so rather than imply
  -- every rally was found the same way.
  source            text not null default 'unknown'
                      check (source in ('net-crossings', 'hit-clustering', 'contacts', 'rally_seg', 'unknown')),
  -- Why it ended, where the segmenter knows. Null is honest, not missing data.
  end_reason        text,
  contact_count     integer not null default 0,
  crossing_count    integer,
  -- Seconds keep-alive added after the last net crossing. 0 = ended on its own.
  extended_seconds  numeric not null default 0,
  -- Per-contact side attribution: [{t_s, side, confidence}]. The rally timeline
  -- needs this and nothing else stores it; it is small (tens of entries).
  contacts          jsonb,
  -- Whatever the coaching pass concluded about how this rally went. Null until
  -- coaching runs, and null is displayed as "no verdict", never as neutral.
  verdict           text check (verdict in ('won', 'lost', 'unforced_error', 'neutral', 'unknown')),
  verdict_reason    text,
  verdict_confidence numeric check (verdict_confidence between 0 and 1),
  created_at        timestamptz not null default now(),
  unique (analysis_id, idx)
);

create index if not exists analysis_rallies_analysis_idx
  on public.analysis_rallies (analysis_id, idx);

-- ---------------------------------------------------------------------------
-- Mechanics live ON the shot.
--
-- A column rather than a table because mechanics are strictly 1:1 with a shot
-- and are never fetched without it -- a separate table would buy a join and
-- nothing else. NULL means "not measured", and the loader must keep it null
-- rather than defaulting to zero: a knee angle of 0 is a claim, absence is not.
-- ---------------------------------------------------------------------------
alter table public.analysis_shots
  add column if not exists mechanics jsonb;

-- ---------------------------------------------------------------------------
-- Everything the pipeline measures about its own reliability.
-- ---------------------------------------------------------------------------
create table if not exists public.analysis_quality (
  analysis_id             uuid primary key references public.analyses (id) on delete cascade,
  vision_fps              numeric,
  video_duration_s        numeric,
  frames_sampled          integer,
  players_per_frame       jsonb,      -- {min, max, mean}
  tracks_produced         integer,
  tracks_with_stable_id   integer,
  pose_frames_attempted   integer,
  pose_frames_succeeded   integer,
  ball_coverage           numeric check (ball_coverage between 0 and 1),
  ball_frames_processed   integer,
  ball_points_detected    integer,
  ball_points_interpolated integer,
  court_confidence        numeric check (court_confidence between 0 and 1),
  court_method            text,
  contacts_found          integer,
  shots_classified        integer,
  -- Balls that crossed the net once and never came back: a serve into the net,
  -- a ball nobody returned. Coachable, and currently computed then discarded.
  dead_ball_count         integer,
  rally_source            text,
  limitations             jsonb,      -- string[], the honest-limits list
  created_at              timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Live progress, and a storage-agnostic home for the debug video.
--
-- progress carries {stage, message, completedStages[], updatedAt} and
-- deliberately has NO percentage field: the pipeline does not know how far
-- through it is, and a bar that invents one would be the exact dishonesty this
-- product is built against.
--
-- debug_video_path is a storage KEY, not a URL and not a local path, so the
-- renderer can move from public/rally-debug to R2 without the frontend
-- changing.
-- ---------------------------------------------------------------------------
alter table public.analyses
  add column if not exists progress jsonb,
  add column if not exists debug_video_path text,
  add column if not exists debug_video_bucket text;

-- ---------------------------------------------------------------------------
-- Coaching depth: what happened -> why it matters -> what to change -> practice.
--
-- Until now that four-part shape existed for exactly ONE thing per analysis
-- (CoachingRead.top_priority_fix). Every other observation carried title and
-- detail only, so a per-rally or per-shot insight could not be rendered in the
-- product's own coaching hierarchy without inventing the missing halves.
--
-- All nullable: an observation the model could not justify keeps them null and
-- the UI shows what exists rather than a blank template.
-- ---------------------------------------------------------------------------
alter table public.coaching_observations
  add column if not exists why_it_matters text,
  add column if not exists what_to_change text,
  add column if not exists drill_slug text references public.coaching_drills (slug),
  add column if not exists shot_idx integer;

-- ---------------------------------------------------------------------------
-- RLS: identical shape to every other analysis-scoped table -- the owner may
-- read, only the service role may write.
-- ---------------------------------------------------------------------------
alter table public.analysis_rallies enable row level security;
alter table public.analysis_quality enable row level security;

-- Same loop form as 0003 so the policy shape stays identical across every
-- analysis-scoped table, and re-running the migration is safe.
do $$
declare
  t text;
begin
  foreach t in array array['analysis_rallies','analysis_quality']
  loop
    execute format($f$
      drop policy if exists "%1$s_select_own" on public.%1$I;
      drop policy if exists "%1$s_select_own" on public.;
create policy "%1$s_select_own" on public.%1$I
        for select using (
          exists (select 1 from public.analyses a where a.id = %1$I.analysis_id and a.user_id = auth.uid())
        );

      drop policy if exists "%1$s_service_write" on public.%1$I;
      drop policy if exists "%1$s_service_write" on public.;
create policy "%1$s_service_write" on public.%1$I
        for all to service_role using (true) with check (true);
    $f$, t);
  end loop;
end
$$;
