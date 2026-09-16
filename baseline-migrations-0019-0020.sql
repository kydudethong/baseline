-- Baseline: the two migrations the current build needs (0019 + 0020).
-- SAFE TO RUN MORE THAN ONCE. Every statement is 'add column if not exists',
-- so if these already ran, running them again changes nothing and errors nothing.

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


-- ---------------------------------------------------------------------------
-- Every criticism shows its footage.
--
-- 0019 gave an observation somewhere to put a clip. It did not guarantee there
-- would be one: the clip was cut around t_s, and t_s is whatever the model
-- chose to name. When it named nothing the UI fell back to a sentence -- "what
-- happened at several points in the clip" -- which is the exact thing the
-- evidence work existed to get rid of. A claim pointing at "several points" is
-- a claim you still cannot check.
--
-- So an observation with no moment of its own now borrows one: the middle of
-- the rally it is about. That is a real second of real footage from the rally
-- the claim is describing, and it is worth far more than a sentence. But it is
-- NOT the model pointing at a moment, and the page must not pretend it is --
-- a caption that says "at 1:23" about a timestamp we picked ourselves would be
-- the system inventing its own evidence.
--
-- Hence one boolean. It is the difference between "here is the moment" and
-- "here is the rally", and the page says whichever is true.
-- ---------------------------------------------------------------------------

alter table public.coaching_observations
  --: True when t_s was derived (the midpoint of rally_idx) rather than named
  --: by the model. The page captions these as the rally rather than the
  --: moment, so borrowed footage is never presented as a cited instant.
  add column if not exists t_is_approx boolean not null default false;
