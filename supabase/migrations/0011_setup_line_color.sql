-- ---------------------------------------------------------------------------
-- Two more things the user settles before the run, both stored in the existing
-- pre_analysis_setup JSONB. No column is added: the document is read once per
-- analysis and never queried into, which is why it was JSONB to begin with.
-- This migration exists to keep the column's comment honest.
--
--   lineColorHex  The colour of the painted lines, sampled off the setup frame.
--                 Null means white. The court fitter's mask tested for "bright
--                 and unsaturated", which excludes a blue, yellow or black line
--                 by construction rather than by degree -- so on those courts
--                 it found no lines at all, and no retry or threshold change
--                 could have helped. Sampled from the footage rather than
--                 picked from a palette because paint fades, gyms are lit
--                 green, and a phone white-balances the whole frame.
--
--   matchMode     singles | doubles. NOT geometry: pickleball singles and
--                 doubles use the same 20x44 court with the same lines, unlike
--                 tennis. It sets how many players the tracker expects.
--
-- Rows written before this have neither key. getSetup() fills the defaults on
-- read (white, doubles), so nothing backfills and nothing needs to.
-- ---------------------------------------------------------------------------

comment on column public.analyses.pre_analysis_setup is
  'User-supplied setup captured before processing: court corners in image pixels, seed points for the players to track, which of them is the user, the sampled colour of the court lines (null = white), and singles/doubles. Null when the user skipped setup, in which case the pipeline detects everything itself. See src/lib/db/setup.ts for the shape.';
