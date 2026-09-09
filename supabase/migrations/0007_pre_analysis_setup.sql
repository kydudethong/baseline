-- ---------------------------------------------------------------------------
-- pre_analysis_setup: what the user told us before the pipeline ran.
--
-- Two things the CV layer cannot reliably work out on its own, and a person
-- can settle in fifteen seconds:
--
--   court   Four corners clicked on the painted lines. Automatic court fitting
--           is genuinely hard from a low camera behind the baseline -- the far
--           half is often occluded by the net, neighbouring courts add their
--           own lines, and a wrong homography is worse than none because it
--           turns every out-of-bounds call and every "is this player on the
--           court" test into a coin flip while still reporting a confident
--           number.
--   players Which people on screen are actually playing, and which one is the
--           user. Public courts are surrounded by spectators, a queue behind
--           the fence, and two more games either side.
--
-- Stored as JSONB rather than columns because the shape is still moving and
-- this is one small document read once per analysis, never queried into.
-- ---------------------------------------------------------------------------

alter table public.analyses
  add column if not exists pre_analysis_setup jsonb;

comment on column public.analyses.pre_analysis_setup is
  'User-supplied setup captured before processing: court corners in image pixels, seed points for the players to track, and which of them is the user. Null when the user skipped setup, in which case the pipeline detects everything itself. See src/lib/db/setup.ts for the shape.';
