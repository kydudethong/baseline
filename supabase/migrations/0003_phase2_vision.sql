-- Phase 2 schema: real CV pipeline output. Extends 0001_init.sql's
-- analyses/videos tables with the structured, timestamped data a real
-- VisionProvider run produces — court calibration, per-frame detections,
-- player tracks, pose keypoints, movement metrics, and events.
--
-- Design notes:
--   * Everything here hangs off analyses.id (one CV run per analysis).
--   * RLS mirrors 0001_init.sql: a user can only see rows for analyses
--     they own, checked via a join back to analyses.user_id.
--   * Nothing in this schema has a NOT NULL confidence/value where the
--     pipeline might legitimately have nothing to report — e.g.
--     court_calibrations.confidence can be 0 with null corners, and that's
--     a valid, expected row, not an error state.

-- ---------------------------------------------------------------------------
-- court_calibrations: one row per analysis (Phase 2 calibrates once, from a
-- representative frame — see pipeline-v2.ts). confidence = 0 means "could
-- not calibrate", not "perfectly uncertain calibration".
-- ---------------------------------------------------------------------------
create table if not exists public.court_calibrations (
  id                  uuid primary key default gen_random_uuid(),
  analysis_id         uuid not null unique references public.analyses (id) on delete cascade,
  method              text not null,
  confidence          numeric not null check (confidence >= 0 and confidence <= 1),
  corners_image_px    jsonb, -- {topLeft:[x,y], topRight:[x,y], bottomLeft:[x,y], bottomRight:[x,y]} | null
  frame_timestamp_s   numeric not null,
  diagnostics         jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

comment on table public.court_calibrations is 'Classical-CV court corner detection result for one analysis. confidence=0/corners=null means calibration failed honestly, not a fabricated guess.';

-- ---------------------------------------------------------------------------
-- analysis_frames: the sampled frames actually run through CV (at
-- VISION_FPS), independent of which players/tracks/poses were found in
-- them — lets the debug page and QC diagnostics reconstruct exactly what
-- was looked at.
-- ---------------------------------------------------------------------------
create table if not exists public.analysis_frames (
  id                uuid primary key default gen_random_uuid(),
  analysis_id       uuid not null references public.analyses (id) on delete cascade,
  timestamp_s       numeric not null,
  frame_index       integer not null,
  player_count      integer not null default 0,
  -- Populated only for a sparse debug subset (see pipeline-v2.ts
  -- DEBUG_FRAME_SAMPLE_COUNT) — persisting every sampled frame for every
  -- analysis would make storage cost scale with VISION_FPS instead of with
  -- clip count, which the debug page doesn't need. Path in the `videos`
  -- bucket, same RLS-by-folder pattern as the source video
  -- (0002_storage.sql): "${user_id}/${analysis_id}/debug/frame-XXXX.jpg".
  debug_storage_path text,
  created_at        timestamptz not null default now(),
  unique (analysis_id, frame_index)
);

create index if not exists analysis_frames_analysis_id_idx on public.analysis_frames (analysis_id);

comment on table public.analysis_frames is 'One row per frame actually sampled and run through CV, independent of what was found in it.';

-- ---------------------------------------------------------------------------
-- player_tracks: one row per stable player_N identity in the clip.
-- ---------------------------------------------------------------------------
create table if not exists public.player_tracks (
  id                uuid primary key default gen_random_uuid(),
  analysis_id       uuid not null references public.analyses (id) on delete cascade,
  player_label      text not null, -- "player_1".."player_4"
  first_seen_s      numeric not null,
  last_seen_s       numeric not null,
  point_count       integer not null,
  points            jsonb not null, -- PlayerTrackPoint[] — timestamp, box, confidence, courtPosition|null
  created_at        timestamptz not null default now(),
  unique (analysis_id, player_label)
);

create index if not exists player_tracks_analysis_id_idx on public.player_tracks (analysis_id);

comment on table public.player_tracks is 'One stable player_N identity per row, with its full point history as JSON. IDs are assignment order, not court position — see AGENTS/PHASE2 report for how to map to a real player.';

-- ---------------------------------------------------------------------------
-- player_keypoints: pose estimation output, one row per (player, frame).
-- ---------------------------------------------------------------------------
create table if not exists public.player_keypoints (
  id                    uuid primary key default gen_random_uuid(),
  analysis_id           uuid not null references public.analyses (id) on delete cascade,
  player_label          text not null,
  timestamp_s           numeric not null,
  detection_confidence  numeric,
  keypoints             jsonb not null, -- PoseKeypoint[] (17 COCO points, each nullable)
  model_source          text not null,
  created_at            timestamptz not null default now()
);

create index if not exists player_keypoints_analysis_id_idx on public.player_keypoints (analysis_id);
create index if not exists player_keypoints_player_idx on public.player_keypoints (analysis_id, player_label);

-- ---------------------------------------------------------------------------
-- movement_metrics: one row per player per analysis — the derived
-- speed/distance/coverage summary (analyzeMovement() output).
-- ---------------------------------------------------------------------------
create table if not exists public.movement_metrics (
  id                              uuid primary key default gen_random_uuid(),
  analysis_id                     uuid not null references public.analyses (id) on delete cascade,
  player_label                    text not null,
  distance_covered_court_units    numeric,
  distance_covered_meters_approx  numeric,
  average_speed_court_units_s     numeric,
  max_speed_court_units_s         numeric,
  court_coverage_bounds           jsonb,
  transformed_sample_count        integer not null default 0,
  total_sample_count              integer not null default 0,
  footwork                        jsonb, -- FootworkFoundationMetrics (lateral range, box-height series, possible_split_step candidates)
  created_at                      timestamptz not null default now(),
  unique (analysis_id, player_label)
);

create index if not exists movement_metrics_analysis_id_idx on public.movement_metrics (analysis_id);

comment on table public.movement_metrics is 'Distance/speed are null (not zero) when court calibration failed for this clip — see transformed_sample_count vs total_sample_count to see how much of the track actually had a court position.';

-- ---------------------------------------------------------------------------
-- analysis_events: unknown_shot (audio-derived contact timestamps) and
-- possible_split_step (movement-heuristic candidates). Deliberately not
-- classified further — see events.ts.
-- ---------------------------------------------------------------------------
create table if not exists public.analysis_events (
  id              uuid primary key default gen_random_uuid(),
  analysis_id     uuid not null references public.analyses (id) on delete cascade,
  event_type      text not null check (event_type in ('unknown_shot', 'possible_split_step')),
  timestamp_s     numeric not null,
  player_label    text, -- null when the source has no spatial info (e.g. audio-only unknown_shot)
  confidence      numeric not null check (confidence >= 0 and confidence <= 1),
  source          text not null check (source in ('audio-onset', 'movement-heuristic', 'mock')),
  created_at      timestamptz not null default now()
);

create index if not exists analysis_events_analysis_id_idx on public.analysis_events (analysis_id);
create index if not exists analysis_events_type_idx on public.analysis_events (analysis_id, event_type);

-- ---------------------------------------------------------------------------
-- Row Level Security — scoped via analyses.user_id, same pattern as 0001.
-- ---------------------------------------------------------------------------
alter table public.court_calibrations enable row level security;
alter table public.analysis_frames enable row level security;
alter table public.player_tracks enable row level security;
alter table public.player_keypoints enable row level security;
alter table public.movement_metrics enable row level security;
alter table public.analysis_events enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['court_calibrations','analysis_frames','player_tracks','player_keypoints','movement_metrics','analysis_events']
  loop
    execute format($f$
      drop policy if exists "%1$s_select_own" on public.%1$I;
      create policy "%1$s_select_own" on public.%1$I
        for select using (
          exists (select 1 from public.analyses a where a.id = %1$I.analysis_id and a.user_id = auth.uid())
        );

      drop policy if exists "%1$s_service_write" on public.%1$I;
      create policy "%1$s_service_write" on public.%1$I
        for all to service_role using (true) with check (true);
    $f$, t);
  end loop;
end
$$;

comment on schema public is 'Phase 2 tables are written by the background processing job using the service-role client (bypasses RLS by design — see src/lib/supabase/server.ts createServiceRoleClient()), and read by users through the standard RLS-scoped client.';
