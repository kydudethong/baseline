-- ---------------------------------------------------------------------------
-- Saved court calibrations, so a fixed camera is marked once rather than once
-- per upload.
--
-- WHY A TABLE RATHER THAN BETTER DETECTION. The most accurate court fit
-- available is a person dragging four corners, and the setup screen already
-- has that. What made it expensive was doing it every single time. A player
-- who films from the same spot at the same courts every week is answering an
-- identical question over and over, and the answer does not change.
--
-- NAMED, NOT AUTO-MATCHED. The obvious alternative is recognising the venue
-- from the frame. That is rejected on failure mode, not difficulty: a wrong
-- match applies someone else's court geometry silently, and since the
-- homography is what turns pixels into feet, EVERY spatial number downstream
-- would be confidently wrong with nothing on screen to say so. A dropdown the
-- user picks from cannot do that. Auto-suggestion can come later as a hint
-- that still requires confirming.
--
-- A PRESET IS A STARTING POSITION, NOT A LOCK. Corners are stored with the
-- frame size they were marked in, and applying one to a differently sized
-- video scales them. The tripod also moves a few inches between sessions, so
-- the setup screen must still let the corners be nudged after a preset is
-- applied -- which it does, since applying one just fills in the same state
-- the user would otherwise have dragged.
-- ---------------------------------------------------------------------------

create table if not exists public.court_presets (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  --: What the player calls this spot, e.g. "Balboa Park court 3".
  name            text not null,
  --: {nearLeft,nearRight,farRight,farLeft} each [x, y] in the pixel space
  --: of frame_width_px x frame_height_px below -- never normalised, because
  --: the setup screen works in pixels and a round-trip through 0-1 loses
  --: precision for no gain.
  corners         jsonb not null,
  --: The frame the corners were marked in. Required for scaling onto a video
  --: of a different resolution; without it the corners are meaningless.
  frame_width_px  integer not null check (frame_width_px > 0),
  frame_height_px integer not null check (frame_height_px > 0),
  --: Null means white, matching pre_analysis_setup.lineColorHex.
  line_color_hex  text,
  match_mode      text not null default 'doubles' check (match_mode in ('singles', 'doubles')),
  created_at      timestamptz not null default now(),
  --: Ordering hint for the picker: most recently used first is almost always
  --: the one wanted, because people play at the same place repeatedly.
  last_used_at    timestamptz
);

-- One name per person, not globally: two users may both have a "home court".
create unique index if not exists court_presets_user_name_idx
  on public.court_presets (user_id, lower(name));

create index if not exists court_presets_user_recent_idx
  on public.court_presets (user_id, last_used_at desc nulls last);

alter table public.court_presets enable row level security;

-- A preset is personal data: it says where someone plays. Owner-only, all
-- four verbs, no shared read.
create policy "court_presets are owner-only" on public.court_presets
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
