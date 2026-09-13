-- ---------------------------------------------------------------------------
-- Per-shot technique, read from a high-frame-rate clip of the stroke itself.
--
-- WHY A SECOND PASS EXISTS AT ALL. Gemini samples video at 1 frame per second
-- by default, and a pickleball stroke lasts about a third of a second -- so
-- the whole swing falls between two sampled frames and the model genuinely
-- never sees it. Measured on ky-720p: at 1fps it reported "only a single still
-- frame is shown and no stroke is visible"; on the same second at 15fps and
-- high media resolution it reported an open paddle face, knee-level contact,
-- and "bend the knees more to get down to the level of the low bounce rather
-- than swinging predominantly with the arm from an upright posture" -- at high
-- confidence, citing backswing, bounce, contact and follow-through.
--
-- Raising the rate over a whole match is not an option: 10fps across 20
-- minutes is ~830k tokens against a 1M context window, and a 30-minute match
-- does not fit. Raising it over a ONE-SECOND window costs ~4k tokens. So the
-- first pass watches everything cheaply and finds the shots; this table holds
-- what the second pass saw when it looked closely at each one.
--
-- clip_start_s / clip_end_s ARE THE DELIVERABLE, not bookkeeping. They are the
-- exact window the model was shown, which makes them the exact window to play
-- back to the player beside the correction. A coaching note that says "here,
-- watch this second" is worth more than the same note alone.
-- ---------------------------------------------------------------------------

create table if not exists public.coaching_shot_technique (
  id               uuid primary key default gen_random_uuid(),
  analysis_id      uuid not null references public.analyses (id) on delete cascade,
  --: Contact time in the source video, as the first pass reported it.
  t_s              numeric not null,
  --: Which half the striker was in, as the model saw it -- not as we assumed.
  --: Far-court reads are usable but lower confidence: the player is smaller in
  --: frame, and the model says so itself rather than being filtered out here.
  striker_court    text,
  --: False when the window contained no stroke. This is a real and useful
  --: answer: on ky-720p it correctly caught a player bouncing the ball between
  --: points and another window where the point had already ended.
  stroke_visible   boolean not null default false,
  paddle_face      text,
  contact_height   text,
  correction       text,
  confidence       text,
  --: The window actually sent, so the UI can replay exactly what was judged.
  clip_start_s     numeric not null,
  clip_end_s       numeric not null,
  created_at       timestamptz not null default now()
);

-- One row per shot per analysis; a re-run replaces rather than accumulates.
create unique index if not exists coaching_shot_technique_analysis_t_idx
  on public.coaching_shot_technique (analysis_id, t_s);

alter table public.coaching_shot_technique enable row level security;

-- Readable and writable only through the owning analysis, matching how every
-- other coaching table is gated.
drop policy if exists "shot technique follows its analysis" on public.coaching_shot_technique;
create policy "shot technique follows its analysis" on public.coaching_shot_technique
  for all
  using (exists (
    select 1 from public.analyses a
    where a.id = analysis_id and a.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.analyses a
    where a.id = analysis_id and a.user_id = auth.uid()
  ));
