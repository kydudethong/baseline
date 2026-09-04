-- ---------------------------------------------------------------------------
-- Shot classification (ball tracking) — see src/lib/vision/ball.ts and
-- src/lib/vision/shots.ts.
--
-- ball_tracks: one row per analysis, the ball's image-normalized track over
-- every audio-segmented rally (points jsonb: [{t,x,y,conf,interpolated}]),
-- plus coverage stats — the honest "how much of the ball did we actually
-- see" number the UI and the coach are told about.
--
-- analysis_shots: one row per paddle contact, with the type the classifier
-- decided (serve/return/dink/drive/drop/reset/...), the physical features
-- it decided on (where it was hit from, speed, arc, landing) and a
-- confidence that degrades when any of those were missing. Written by the
-- background job with the service role; read by the owner through RLS.
-- ---------------------------------------------------------------------------
create table if not exists public.ball_tracks (
  id                   uuid primary key default gen_random_uuid(),
  analysis_id          uuid not null unique references public.analyses (id) on delete cascade,
  points               jsonb not null default '[]'::jsonb,
  frames_processed     integer not null default 0,
  points_detected      integer not null default 0,
  points_interpolated  integer not null default 0,
  coverage             numeric not null default 0 check (coverage >= 0 and coverage <= 1),
  diagnostics          jsonb,
  created_at           timestamptz not null default now()
);

create table if not exists public.analysis_shots (
  id                 uuid primary key default gen_random_uuid(),
  analysis_id        uuid not null references public.analyses (id) on delete cascade,
  rally_idx          integer not null,
  shot_idx           integer not null,
  timestamp_s        numeric not null,
  player_label       text,
  shot_type          text not null check (shot_type in (
                       'serve','return','third_shot_drop','third_shot_drive','dink','drop','reset',
                       'drive','volley','speed_up','overhead','lob','block','unknown')),
  category           text not null check (category in ('serve_return','kitchen','offense','defense','transition','unknown')),
  confidence         numeric not null check (confidence >= 0 and confidence <= 1),
  hit_court          jsonb,
  hit_zone           text not null check (hit_zone in ('kitchen','transition','back','unknown')),
  landing_court      jsonb,
  landing_zone       text not null check (landing_zone in ('kitchen','mid','deep','out','unknown')),
  speed_mps_approx   numeric,
  arc_norm           numeric,
  bounced_before     boolean,
  outcome            text not null check (outcome in ('in','net','out','unknown')),
  features           jsonb,
  created_at         timestamptz not null default now(),
  unique (analysis_id, rally_idx, shot_idx)
);

create index if not exists analysis_shots_analysis_id_idx on public.analysis_shots (analysis_id);
create index if not exists analysis_shots_player_idx on public.analysis_shots (analysis_id, player_label);

alter table public.ball_tracks enable row level security;
alter table public.analysis_shots enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['ball_tracks','analysis_shots']
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
