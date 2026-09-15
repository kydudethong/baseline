-- ---------------------------------------------------------------------------
-- The training set.
--
-- WHY THIS EXISTS, in one sentence: everything Baseline does today is a call to
-- somebody else's model, and the only thing that will ever be uniquely ours is
-- a record of what that model said and where it was WRONG.
--
-- A thousand stored model outputs is an archive. A thousand with corrections
-- attached is a dataset nobody else on earth has, because it takes real
-- players watching their own footage to produce it. That is the whole
-- distinction these two tables are built around, and it is why the passive
-- half is worthless without the active half.
--
-- PART 1 — CAPTURES. One row per model call: what we sent, what came back, at
-- what settings, costing what. Kept even when nothing ever labels it, because
-- the settings drift (fps, resolution, model, prompt) and a correction filed
-- six months from now is meaningless unless the exact configuration that
-- produced the output is recorded beside it.
--
-- PART 2 — FEEDBACK. A player saying "that's wrong" about one specific claim.
-- Polymorphic on purpose: coaching points, technique notes, rallies and
-- practice sessions are all things somebody can disagree with, they all need
-- the same three fields, and a table per target would be four tables that
-- drift apart and four UIs that behave differently.
-- ---------------------------------------------------------------------------

create table if not exists public.analysis_captures (
  id            uuid primary key default gen_random_uuid(),
  analysis_id   uuid not null references public.analyses (id) on delete cascade,
  --: Which call this was: scan | technique | practice_plan | month_plan.
  pass          text not null,
  model         text not null,
  --: fps, media resolution, segment windows -- everything that changes what
  --: the model saw. Without it a correction cannot be attributed to a cause.
  config        jsonb,
  --: What the model was asked. Stored whole: a prompt is a few KB and
  --: reconstructing one from a version tag is guesswork the moment the code
  --: has moved on.
  prompt        text,
  --: What it answered, exactly as parsed.
  output        jsonb,
  --: Tokens in/out and wall-clock, so cost per analysis stops being estimated.
  usage         jsonb,
  duration_ms   integer,
  created_at    timestamptz not null default now()
);

create index if not exists analysis_captures_analysis_idx
  on public.analysis_captures (analysis_id, created_at);
--: "Every scan run at 5fps low" is the query that builds a training split.
create index if not exists analysis_captures_pass_idx
  on public.analysis_captures (pass, created_at desc);

create table if not exists public.coaching_feedback (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  analysis_id   uuid not null references public.analyses (id) on delete cascade,
  --: What is being judged. Not a foreign key, deliberately: these point at
  --: five different tables, and a correction about a coaching point that was
  --: later regenerated is still evidence about the model that produced it.
  --: The row it referred to may legitimately be gone.
  target_kind   text not null
                  check (target_kind in ('observation','technique','rally','shot','read','practice_session')),
  target_id     text not null,
  --: The label. Three values rather than a 1-5 scale: a rating asks the player
  --: to calibrate, which they will do inconsistently, where "is this right"
  --: has an answer they actually hold. 'unsure' is kept because forcing a
  --: guess produces noise dressed as signal.
  verdict       text not null check (verdict in ('right','wrong','unsure')),
  --: WHY it is wrong, from a short fixed list, so corrections can be counted.
  --: Free text alone cannot be aggregated and a fixed list alone cannot
  --: capture what nobody anticipated -- so both.
  reason        text,
  note          text,
  created_at    timestamptz not null default now()
);

create index if not exists coaching_feedback_analysis_idx
  on public.coaching_feedback (analysis_id);
create index if not exists coaching_feedback_target_idx
  on public.coaching_feedback (target_kind, target_id);
--: One verdict per person per thing. Changing your mind updates rather than
--: appends, or the same disagreement counts twice.
create unique index if not exists coaching_feedback_unique_idx
  on public.coaching_feedback (user_id, target_kind, target_id);

-- Did the practice actually help? The closed loop, and the rarest label here:
-- it needs somebody to do the drill AND come back.
alter table public.practice_sessions
  add column if not exists helped smallint check (helped between -1 and 1);

-- ---- RLS ------------------------------------------------------------------

alter table public.analysis_captures enable row level security;
alter table public.coaching_feedback enable row level security;

--: Read-only to the owner. Captures are WRITTEN by the service role during a
--: run; nothing a browser does should be able to forge one.
drop policy if exists "captures are readable by the analysis owner" on public.analysis_captures;
create policy "captures are readable by the analysis owner" on public.analysis_captures
  for select
  using (exists (select 1 from public.analyses a where a.id = analysis_id and a.user_id = auth.uid()));

drop policy if exists "your own feedback" on public.coaching_feedback;
create policy "your own feedback" on public.coaching_feedback
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
