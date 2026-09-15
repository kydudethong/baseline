-- ---------------------------------------------------------------------------
-- Evidence: what the model saw, and the clip that shows it.
--
-- The argument for this migration, in one sentence a 4.0 player might say:
-- "my positioning is not poor". They may well be right, and until now the
-- product had no answer -- the read asserted a rating and kept its reasons to
-- itself. A claim a player cannot check is a claim they are entitled to
-- dismiss, and an AI coach that cannot show its work is a worse coach than a
-- friend with a phone.
--
-- Two additions, both small, both in service of that:
--   1. The technique read already described the paddle and the contact. It did
--      not describe the body, which is where a late preparation actually shows
--      -- the shoulders and the feet are the evidence for the most common
--      correction in the sport.
--   2. An observation names a moment (t_s). Nothing pointed at the footage OF
--      that moment, so the timestamp was a number rather than something to
--      watch.
-- ---------------------------------------------------------------------------

alter table public.coaching_shot_technique
  --: Where the shoulders were before contact: turned, square, opening early.
  --: The single most diagnostic thing about preparation, and the thing a
  --: player can feel once it has been named.
  add column if not exists shoulder_rotation text,
  --: Stance and weight at contact: set, moving, reaching, off-balance.
  add column if not exists foot_position    text;

alter table public.coaching_observations
  --: The rendered clip that shows this moment, stored beside the overlay it
  --: was cut from. Null when no clip could be cut -- the observation is still
  --: worth showing, just without the video.
  add column if not exists clip_path   text,
  --: Which bucket clip_path lives in, mirroring analyses.debug_video_bucket.
  --: Written together, so a clip can never be looked for in the wrong place.
  add column if not exists clip_bucket text;

-- Clips are cut around a timestamp, so finding the ones for an analysis is the
-- only lookup that matters and it is already covered by the analysis index.
