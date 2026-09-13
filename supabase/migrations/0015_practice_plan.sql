-- ---------------------------------------------------------------------------
-- A practice plan: what to do at the next session, in order, with timings.
--
-- WHY THIS IS NOT THE EXISTING `drills` LIST. The analyst already returns a
-- handful of drill suggestions, and a list of drills is not a plan. A player
-- standing on a court with forty minutes and a bucket of balls needs to know
-- what to hit first, for how long, what "good" looks like, and when to stop
-- and move on. "Work on your third shot drop" is a diagnosis; "ten minutes of
-- X, then fifteen of Y, stop when you hit eight in ten" is something you can
-- actually follow.
--
-- ONE ROW PER BLOCK, not one JSON blob per plan. Blocks are the unit a player
-- works through and ticks off, so they need their own identity -- and when the
-- closed loop lands (did the drill move the number?), progress is recorded
-- against a block rather than parsed out of a document.
--
-- `minutes` is advisory and says so in the UI. The model is estimating how
-- long a drill takes, which it cannot know precisely; the ORDER and the
-- success criterion are the parts that carry the coaching.
-- ---------------------------------------------------------------------------

create table if not exists public.coaching_practice_plans (
  id            uuid primary key default gen_random_uuid(),
  analysis_id   uuid not null references public.analyses (id) on delete cascade,
  --: One line the player reads before they start: what this session is FOR.
  focus         text not null,
  --: Total advisory length, the sum of the blocks.
  total_minutes integer,
  --: What should be measurably different by the next upload. The closed loop
  --: reads this: it is the claim a later analysis can confirm or refute.
  success_looks_like text,
  created_at    timestamptz not null default now()
);

create table if not exists public.coaching_practice_blocks (
  id           uuid primary key default gen_random_uuid(),
  plan_id      uuid not null references public.coaching_practice_plans (id) on delete cascade,
  --: Order within the session. Warm-up first, hardest work while fresh.
  idx          integer not null,
  kind         text not null default 'drill'
                 check (kind in ('warmup', 'drill', 'game', 'cooldown')),
  name         text not null,
  --: The library drill this came from, when it came from one. Null for
  --: warm-ups and free play, which have no library entry and need none.
  drill_slug   text,
  minutes      integer,
  --: Step by step, in the second person. This is the "how", and it is the
  --: difference between a plan and a list.
  how          text not null,
  --: The measurable stop condition -- "8 of 10 land in the kitchen". Without
  --: one, a block is just a duration and the player cannot tell if it worked.
  success      text,
  --: Which weakness this block is answering, so the plan can be read back
  --: against the coaching that produced it.
  targets      text,
  created_at   timestamptz not null default now()
);

create unique index if not exists coaching_practice_plans_analysis_idx
  on public.coaching_practice_plans (analysis_id);
create unique index if not exists coaching_practice_blocks_plan_idx
  on public.coaching_practice_blocks (plan_id, idx);

alter table public.coaching_practice_plans enable row level security;
alter table public.coaching_practice_blocks enable row level security;

drop policy if exists "practice plans follow their analysis" on public.coaching_practice_plans;
create policy "practice plans follow their analysis" on public.coaching_practice_plans
  for all
  using (exists (select 1 from public.analyses a where a.id = analysis_id and a.user_id = auth.uid()))
  with check (exists (select 1 from public.analyses a where a.id = analysis_id and a.user_id = auth.uid()));

drop policy if exists "practice blocks follow their plan" on public.coaching_practice_blocks;
create policy "practice blocks follow their plan" on public.coaching_practice_blocks
  for all
  using (exists (
    select 1 from public.coaching_practice_plans p join public.analyses a on a.id = p.analysis_id
    where p.id = plan_id and a.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.coaching_practice_plans p join public.analyses a on a.id = p.analysis_id
    where p.id = plan_id and a.user_id = auth.uid()
  ));
