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
