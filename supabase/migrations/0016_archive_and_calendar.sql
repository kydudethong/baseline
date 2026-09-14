-- ---------------------------------------------------------------------------
-- Two features, one migration, because they are the same story from opposite
-- ends: a video the player removes must also leave the practice calendar it
-- helped build, so the calendar needs to know which analyses still count.
--
-- PART 1 — ARCHIVING
--
-- `archived_at` rather than a delete. A delete is the obvious implementation
-- and the wrong default: the row is the anchor for a coaching read, skill
-- ratings, a technique pass and a month of calendar entries, all of which cost
-- real compute to produce and none of which can be recovered from a misclick.
-- Archiving hides it everywhere the player looks -- library, calendar, trends
-- -- immediately, and leaves a window in which "actually, put that back" is a
-- single update rather than a re-upload and a re-analysis.
--
-- Permanent deletion stays available and is a genuinely different operation:
-- it removes the R2 object and lets the existing ON DELETE CASCADE take every
-- dependent row with it. That one is not undoable and the UI says so.
--
-- PART 2 — THE PRACTICE CALENDAR
--
-- A month of sessions, generated from the weaknesses the analyses found, that
-- the player ticks off as they go. Two tables and not one: a session is a
-- thing that happens on a date and gets checked off, and a drill is a thing
-- inside a session that gets checked off separately, because a player who did
-- three of four drills has not done nothing and has not done the session.
--
-- WHY THE SCHEDULE IS STORED ON THE PLAN AND NOT RECOMPUTED. "I play Tuesdays
-- and Saturdays, about twice a week" is an answer the player gave once. If the
-- calendar recomputed itself from their current answer every render, editing
-- the answer in October would silently rewrite what September said they did.
-- The plan records the schedule it was built from.
-- ---------------------------------------------------------------------------

-- ---- Part 1: archiving ----------------------------------------------------

alter table public.analyses
  add column if not exists archived_at timestamptz;

--: Every list the player sees filters on this, so it earns an index. Partial,
--: because the rows anyone queries for are the ones where it is null.
create index if not exists analyses_user_active_idx
  on public.analyses (user_id, created_at desc)
  where archived_at is null;

-- ---- Part 2: the practice calendar ---------------------------------------

create table if not exists public.practice_plans (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  --: The month this plan covers, stored as its first day. One plan per month
  --: per player -- a second plan for the same month would leave two calendars
  --: disagreeing about what today's session is.
  month           date not null,
  --: What the player said about how they play, kept as given.
  sessions_per_month integer,
  --: Which weekdays they usually play, 0=Sunday..6=Saturday.
  play_days       integer[] not null default '{}',
  --: One line: what this month is for.
  focus           text,
  --: Which weaknesses this month is answering, so a later month can tell
  --: whether it is still the same list.
  targets         text[] not null default '{}',
  --: The analyses this plan was generated from. When one is archived the plan
  --: can say honestly that it was built partly on footage no longer here.
  source_analysis_ids uuid[] not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists practice_plans_user_month_idx
  on public.practice_plans (user_id, month);

create table if not exists public.practice_sessions (
  id           uuid primary key default gen_random_uuid(),
  plan_id      uuid not null references public.practice_plans (id) on delete cascade,
  --: The day this session is scheduled for. A date, not a timestamp: a
  --: practice session happens on a day, and storing a time would invent a
  --: precision the player never gave and would shift under time zones.
  scheduled_on date not null,
  --: warmup-only days and match days are sessions too -- the calendar is a
  --: month of what to do, not a month of drills.
  kind         text not null default 'practice'
                 check (kind in ('practice', 'match', 'rest', 'assessment')),
  title        text not null,
  focus        text,
  minutes      integer,
  --: Ticked by the player. Null means not done; a timestamp records when.
  completed_at timestamptz,
  --: How it felt / what happened. Optional, and the most useful thing a player
  --: can give the next month's plan.
  notes        text,
  created_at   timestamptz not null default now()
);

create index if not exists practice_sessions_plan_idx
  on public.practice_sessions (plan_id, scheduled_on);

create table if not exists public.practice_session_drills (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.practice_sessions (id) on delete cascade,
  idx          integer not null,
  --: The library drill, when it came from one. Null for warm-ups and free
  --: play, which have no library entry and need none.
  drill_slug   text,
  name         text not null,
  minutes      integer,
  --: Step by step, second person. The difference between a plan and a list.
  how          text,
  --: The measurable stop condition. Without one a drill is just a duration.
  success      text,
  --: Which weakness this drill answers.
  targets      text,
  completed_at timestamptz,
  created_at   timestamptz not null default now()
);

create unique index if not exists practice_session_drills_idx
  on public.practice_session_drills (session_id, idx);

-- ---- RLS ------------------------------------------------------------------

alter table public.practice_plans enable row level security;
alter table public.practice_sessions enable row level security;
alter table public.practice_session_drills enable row level security;

drop policy if exists "practice plans are yours" on public.practice_plans;
create policy "practice plans are yours" on public.practice_plans
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "practice sessions follow their plan" on public.practice_sessions;
create policy "practice sessions follow their plan" on public.practice_sessions
  for all
  using (exists (select 1 from public.practice_plans p where p.id = plan_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.practice_plans p where p.id = plan_id and p.user_id = auth.uid()));

drop policy if exists "practice drills follow their session" on public.practice_session_drills;
create policy "practice drills follow their session" on public.practice_session_drills
  for all
  using (exists (
    select 1 from public.practice_sessions s join public.practice_plans p on p.id = s.plan_id
    where s.id = session_id and p.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.practice_sessions s join public.practice_plans p on p.id = s.plan_id
    where s.id = session_id and p.user_id = auth.uid()
  ));
