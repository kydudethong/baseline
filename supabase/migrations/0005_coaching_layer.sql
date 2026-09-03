-- Baseline coaching layer — merges what used to be two separate apps.
--
-- Provenance: this schema is a Postgres/RLS port of a working SQLite schema
-- from a sibling local-only app ("Baseline", formerly `coach`), which paired
-- Twelve Labs (rich video extraction: rally boundaries, shot types,
-- ready-position/paddle-recovery judgments) with an LLM coaching-read layer.
-- This merge REPLACES Twelve Labs with Rally IQ's own CV pipeline (court
-- calibration, player tracking, pose estimation, audio contact detection —
-- see 0003_phase2_vision.sql) as the fact source. That pipeline measures
-- less than Twelve Labs did: no shot-type classification, no native rally
-- boundaries. Both are approximated by new heuristics (see
-- src/lib/coaching/facts.ts) built from what Rally IQ actually measures —
-- audio-onset clustering for rally boundaries (ported from coach's
-- segment.ts), knee-angle for stance, wrist-height-vs-shoulder as an
-- explicit *proxy* for paddle position (no paddle is ever detected —
-- YOLOv8n-pose is body-only). Shot type stays permanently unclassified;
-- nothing here invents a drive/dink/drop/volley label that no signal
-- supports. Every table and prompt downstream must keep treating these as
-- confidence-scored heuristics, not measurements, the same way
-- movement_metrics already does for distance/speed.

-- ---------------------------------------------------------------------------
-- profiles: add the player-level fields coach's singleton `player` row held.
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists skill_level text;
alter table public.profiles add column if not exists paddle_hand text; -- 'left' | 'right'

-- ---------------------------------------------------------------------------
-- analyses: which tracked player (player_tracks.player_label) is the user.
-- Set via the self-tag picker after processing completes (see
-- src/components/coaching/WhoAmI.tsx) — nullable until then; the coaching
-- pipeline stage waits for this before it can score "you" specifically
-- rather than the whole court.
-- ---------------------------------------------------------------------------
alter table public.analyses add column if not exists self_player_label text;
alter table public.analyses add column if not exists coaching_notes text; -- what the player said about this session, free text
alter table public.analyses add column if not exists coaching_kind text not null default 'match_doubles';

-- ---------------------------------------------------------------------------
-- coaching_rallies: rally boundaries approximated by clustering Rally IQ's
-- own audio-onset contact timestamps (gap-based grouping — see
-- coach's segment.ts `clusterRallies`, ported to facts.ts). Not a measured
-- rally boundary the way Twelve Labs' video-language read was; a heuristic
-- over real audio timestamps.
-- ---------------------------------------------------------------------------
create table if not exists public.coaching_rallies (
  id          uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.analyses (id) on delete cascade,
  idx         integer not null,
  start_s     numeric not null,
  end_s       numeric not null,
  shots       integer not null,
  unique (analysis_id, idx)
);

-- ---------------------------------------------------------------------------
-- coaching_reads: one per analysis. Holds the coaching LLM's verbatim first
-- call (coaching_json — strengths / top priority fix / secondary
-- observations / drill recommendation / data gaps) and the exact facts
-- payload it was given (facts_json), so a disputed observation can be
-- checked against what was actually measured rather than guessed at later.
-- ---------------------------------------------------------------------------
create table if not exists public.coaching_reads (
  id          uuid primary key default gen_random_uuid(),
  analysis_id uuid not null unique references public.analyses (id) on delete cascade,
  model       text,
  headline    text,
  summary     text,
  quality     jsonb,
  coaching_json text, -- verbatim first-call JSON, stored as text like coach did
  facts_json    text, -- the measured-facts payload the model actually read
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- coaching_observations: the tagged, per-skill records the rest of the app
-- tracks over time (progress, weakness ranking, practice plans).
-- ---------------------------------------------------------------------------
create table if not exists public.coaching_observations (
  id                 uuid primary key default gen_random_uuid(),
  analysis_id        uuid not null references public.analyses (id) on delete cascade,
  read_id            uuid not null references public.coaching_reads (id) on delete cascade,
  rally_idx          integer,
  t_s                numeric,
  skill_key          text not null,
  coaching_dimension text not null default 'shot_mechanics',
  valence            text not null check (valence in ('strength', 'weakness')),
  title              text not null,
  detail             text not null,
  severity           integer not null default 3 check (severity between 1 and 5),
  dismissed          boolean not null default false
);

create index if not exists coaching_observations_analysis_idx on public.coaching_observations (analysis_id);
create index if not exists coaching_observations_skill_idx on public.coaching_observations (skill_key);

-- ---------------------------------------------------------------------------
-- coaching_skill_ratings: 1-5 per skill per analysis, as the model judged
-- it. skill_profiles (progress page) aggregates these across analyses with
-- recency weighting — see src/lib/coaching/stats.ts.
-- ---------------------------------------------------------------------------
create table if not exists public.coaching_skill_ratings (
  id           uuid primary key default gen_random_uuid(),
  analysis_id  uuid not null references public.analyses (id) on delete cascade,
  skill_key    text not null,
  raw          numeric not null check (raw between 1 and 5),
  observations integer not null default 0,
  basis        text,
  unique (analysis_id, skill_key)
);

create index if not exists coaching_skill_ratings_skill_idx on public.coaching_skill_ratings (skill_key);

-- ---------------------------------------------------------------------------
-- coaching_drills: shared reference content (the drill library), not
-- per-user data. Seeded below. Readable by every authenticated user;
-- writable only by the service role.
-- ---------------------------------------------------------------------------
create table if not exists public.coaching_drills (
  slug        text primary key,
  name        text not null,
  skill_key   text not null,
  difficulty  text not null,
  players     integer not null,
  equipment   text not null,
  purpose     text not null,
  steps       jsonb not null,
  mistakes    jsonb not null,
  progression text references public.coaching_drills (slug),
  regression  text references public.coaching_drills (slug)
);

-- ---------------------------------------------------------------------------
-- coaching_blueprints / coaching_blueprint_steps: five-session practice
-- progressions for one ranked weakness. Drills are retrieved from
-- coaching_drills, never invented by the model — see src/lib/coaching/blueprint.ts.
-- ---------------------------------------------------------------------------
create table if not exists public.coaching_blueprints (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  analysis_id uuid references public.analyses (id) on delete set null,
  skill_key   text not null,
  title       text not null,
  goal        text not null,
  target      text not null,
  status      text not null default 'active',
  created_at  timestamptz not null default now()
);

create index if not exists coaching_blueprints_user_idx on public.coaching_blueprints (user_id);

create table if not exists public.coaching_blueprint_steps (
  id            uuid primary key default gen_random_uuid(),
  blueprint_id  uuid not null references public.coaching_blueprints (id) on delete cascade,
  idx           integer not null,
  focus         text not null,
  drill_slug    text references public.coaching_drills (slug),
  drill_name    text not null,
  target        text not null,
  done_at       timestamptz
);

create index if not exists coaching_blueprint_steps_bp_idx on public.coaching_blueprint_steps (blueprint_id);

-- ---------------------------------------------------------------------------
-- coaching_chat_messages: the in-app coach chat, per user (spans all of
-- that user's analyses, like coach's global chat history).
-- ---------------------------------------------------------------------------
create table if not exists public.coaching_chat_messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        text not null check (role in ('user', 'coach')),
  content     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists coaching_chat_messages_user_idx on public.coaching_chat_messages (user_id, created_at);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.coaching_rallies enable row level security;
alter table public.coaching_reads enable row level security;
alter table public.coaching_observations enable row level security;
alter table public.coaching_skill_ratings enable row level security;
alter table public.coaching_drills enable row level security;
alter table public.coaching_blueprints enable row level security;
alter table public.coaching_blueprint_steps enable row level security;
alter table public.coaching_chat_messages enable row level security;

-- Analysis-scoped tables: same "own it via analyses.user_id" pattern as
-- 0003_phase2_vision.sql's Phase 2 tables.
do $$
declare
  t text;
begin
  foreach t in array array['coaching_rallies', 'coaching_reads', 'coaching_observations', 'coaching_skill_ratings']
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
end $$;

-- User-scoped tables (own user_id column directly).
do $$
declare
  t text;
begin
  foreach t in array array['coaching_blueprints', 'coaching_chat_messages']
  loop
    execute format($f$
      drop policy if exists "%1$s_select_own" on public.%1$I;
      create policy "%1$s_select_own" on public.%1$I
        for select using (auth.uid() = user_id);

      drop policy if exists "%1$s_insert_own" on public.%1$I;
      create policy "%1$s_insert_own" on public.%1$I
        for insert with check (auth.uid() = user_id);

      drop policy if exists "%1$s_update_own" on public.%1$I;
      create policy "%1$s_update_own" on public.%1$I
        for update using (auth.uid() = user_id);

      drop policy if exists "%1$s_service_write" on public.%1$I;
      create policy "%1$s_service_write" on public.%1$I
        for all to service_role using (true) with check (true);
    $f$, t);
  end loop;
end $$;

-- coaching_blueprint_steps: scoped via its parent blueprint's user_id.
drop policy if exists "coaching_blueprint_steps_select_own" on public.coaching_blueprint_steps;
create policy "coaching_blueprint_steps_select_own" on public.coaching_blueprint_steps
  for select using (
    exists (
      select 1 from public.coaching_blueprints b
      where b.id = coaching_blueprint_steps.blueprint_id and b.user_id = auth.uid()
    )
  );

drop policy if exists "coaching_blueprint_steps_update_own" on public.coaching_blueprint_steps;
create policy "coaching_blueprint_steps_update_own" on public.coaching_blueprint_steps
  for update using (
    exists (
      select 1 from public.coaching_blueprints b
      where b.id = coaching_blueprint_steps.blueprint_id and b.user_id = auth.uid()
    )
  );

drop policy if exists "coaching_blueprint_steps_service_write" on public.coaching_blueprint_steps;
create policy "coaching_blueprint_steps_service_write" on public.coaching_blueprint_steps
  for all to service_role using (true) with check (true);

-- coaching_drills: shared reference data — every authenticated user can
-- read the whole library; only the service role (or a migration) writes it.
drop policy if exists "coaching_drills_select_all" on public.coaching_drills;
create policy "coaching_drills_select_all" on public.coaching_drills
  for select to authenticated using (true);

drop policy if exists "coaching_drills_service_write" on public.coaching_drills;
create policy "coaching_drills_service_write" on public.coaching_drills
  for all to service_role using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Seed the drill library — the same 12 real drills from Baseline's local
-- version, written to be followed without a coach standing next to you.
-- ---------------------------------------------------------------------------
insert into public.coaching_drills (slug, name, skill_key, difficulty, players, equipment, purpose, steps, mistakes, progression, regression) values
('backhand-dink-fundamentals', 'Backhand dink fundamentals', 'dinking', 'Beginner', 2, 'Paddles, 6 balls',
 'Groove a repeatable backhand contact point out in front of the body so the paddle face stays stable and the ball comes off low',
 '["Both players at the kitchen line, cross-court from each other.","Rally soft backhand dinks. The ball should not bounce above knee height on your side.","Contact the ball out in front of your lead hip. If you feel it beside your body, you were late.","Keep the paddle face open and the wrist quiet — the lift comes from the legs.","Fifty balls without a pop-up before you stop."]'::jsonb,
 '["Taking the ball beside the body instead of in front, which forces you to lift it.","Flicking the wrist to add height.","Standing upright. Dinking is a knees game."]'::jsonb,
 'cross-court-dink-ladder', null),
('cross-court-dink-ladder', 'Cross-court dink ladder', 'dinking', 'Intermediate', 2, 'Paddles, 6 balls',
 'Build height control by lowering the target band every five balls until the margin over the net is genuinely small',
 '["Rally cross-court, backhand to backhand.","First five balls: aim two feet above the net.","Next five: one foot. Then six inches.","Any ball above the current band resets you to the first rung.","Clear all three rungs twice."]'::jsonb,
 '["Racing the ladder. The point is control, not speed.","Dropping the target so low you start netting — the lowest rung should still be about 90% makeable."]'::jsonb,
 'dink-lateral-movement', 'backhand-dink-fundamentals'),
('dink-lateral-movement', 'Dink plus lateral movement', 'kitchen', 'Intermediate', 2, 'Paddles, 6 balls, 2 cones',
 'Keep the contact point in front while the feet are moving, which is the situation where high dinks actually happen in a match',
 '["Partner alternates dinks between your backhand corner and the middle.","Step to every ball with the outside foot. Never reach.","Reset to a centre cone between shots.","Five sets of twenty balls. A set is successful if fewer than four balls sit above net height."]'::jsonb,
 '["Reaching with the paddle instead of moving the feet — the exact habit this drill exists to break.","Recovering late, so the next ball gets taken beside the body."]'::jsonb,
 'dink-game-attack-restricted', 'cross-court-dink-ladder'),
('dink-game-attack-restricted', 'Dink game, attack restricted', 'kitchen', 'Advanced', 4, 'Paddles, balls',
 'Hold a low trajectory when the rally has consequences, which is where technique that works in drilling usually falls apart',
 '["Play games to 11, kitchen dinking only.","Nobody may attack until a ball rises above net height — then it is fair game.","Every ball you leave high becomes a live attack against you.","Play three games and count how many balls you gave away."]'::jsonb,
 '["Speeding up out of impatience rather than because a ball was genuinely attackable.","Backing off the line after a hard ball."]'::jsonb,
 null, 'dink-lateral-movement'),
('transition-reset-progression', 'Transition reset progression', 'transition', 'Intermediate', 2, 'Paddles, balls',
 'Absorb pace from the transition zone so you can keep moving forward instead of retreating to the baseline',
 '["Start mid-court. Partner drives from the baseline.","Take pace off and land the ball in the kitchen.","Take one step forward after every successful reset.","Reach the kitchen line without a pop-up, then restart from mid-court."]'::jsonb,
 '["Swinging at the reset instead of blocking it.","Stopping in the transition zone with the paddle down."]'::jsonb,
 'transition-reset-live', null),
('transition-reset-live', 'Live transition, two on one', 'transition', 'Advanced', 3, 'Paddles, balls',
 'Survive real pressure while advancing, with two opponents attacking every ball that sits up',
 '["Two players at the kitchen, you at the baseline.","Feed a third shot and work forward. They attack anything above net height.","Score a point every time you reach the kitchen line with the ball still live.","Ten attempts, then swap."]'::jsonb,
 '["Running through the transition zone instead of split-stepping as they strike.","Trying to win the point from mid-court."]'::jsonb,
 null, 'transition-reset-progression'),
('third-shot-drop-ladder', 'Third shot drop ladder', 'thirdshot', 'Intermediate', 2, 'Paddles, balls',
 'Make the drop the default from anywhere behind the baseline, where the drive is a low-percentage shot',
 '["Partner feeds a deep return.","Drop from three feet behind the baseline. Ten balls.","Move back three feet and repeat.","Find how deep you can go and still land eight of ten inside the kitchen."]'::jsonb,
 '["Rushing forward before the drop has landed.","Driving when off balance — the habit the ladder exists to replace."]'::jsonb,
 'third-shot-decision', null),
('third-shot-decision', 'Third shot decision game', 'selection', 'Advanced', 4, 'Paddles, balls',
 'Choose the drop or the drive based on where the return actually put you, rather than out of habit',
 '["Play out points starting from a serve.","Before each third shot, call your intent out loud: ''drop'' or ''drive''.","You lose the point immediately if you call one and hit the other.","Play to 11. The calling is the drill."]'::jsonb,
 '["Calling drive because the last one felt good rather than because you are balanced and inside the baseline.","Calling too late to commit properly."]'::jsonb,
 null, 'third-shot-drop-ladder'),
('serve-depth-targets', 'Serve depth targets', 'serve', 'Beginner', 1, 'Paddles, a bucket of balls, 2 towels',
 'Put serves in the back third consistently, which is what forces the floating return you can attack',
 '["Lay two towels across the back three feet of each service box.","Serve twenty balls to the deuce side, then twenty to the ad side.","Count how many land on or past the towel.","Repeat until you clear fifteen of twenty on both sides."]'::jsonb,
 '["Adding pace instead of adding arc. Depth comes from trajectory.","Only practising to your favourite side."]'::jsonb,
 null, null),
('return-deep-and-in', 'Deep return, then close', 'return', 'Beginner', 2, 'Paddles, balls',
 'Return deep and get to the kitchen line before the third shot arrives, which is most of what a return has to do',
 '["Partner serves. Return deep, then move straight to the kitchen line.","Freeze when the third shot is struck. Note where your feet are.","Twenty returns. Count how many times you were at the line in time.","If you are late, hit the return higher and deeper, not harder."]'::jsonb,
 '["Admiring the return before moving.","Driving the return low and fast, which buys you no time."]'::jsonb,
 null, null),
('hands-battle-blocks', 'Hands battle blocks', 'hands', 'Intermediate', 2, 'Paddles, balls',
 'Keep the paddle in front and block rather than swing when the exchange speeds up at the kitchen',
 '["Both at the kitchen line. Partner attacks at your body from a feed.","Block only — no backswing. Paddle stays in front of your chest.","Reset the ball into their kitchen if you can.","Thirty balls, then swap roles."]'::jsonb,
 '["Taking a backswing under pressure, which is always late.","Dropping the paddle head between shots."]'::jsonb,
 null, null),
('reset-from-pressure', 'Reset from pressure', 'resets', 'Intermediate', 2, 'Paddles, balls',
 'Turn a hard ball into a soft one instead of trading pace you cannot win',
 '["Partner drives hard at you from mid-court.","Absorb and land it in the kitchen. Soft hands, no swing.","Ten in a row from mid-court, then ten from the kitchen line.","Track your longest streak and try to beat it."]'::jsonb,
 '["Gripping tight, which sends the ball back with the same pace.","Backing up instead of holding position and absorbing."]'::jsonb,
 null, null)
on conflict (slug) do update set
  name = excluded.name, skill_key = excluded.skill_key, difficulty = excluded.difficulty,
  players = excluded.players, equipment = excluded.equipment, purpose = excluded.purpose,
  steps = excluded.steps, mistakes = excluded.mistakes,
  progression = excluded.progression, regression = excluded.regression;
