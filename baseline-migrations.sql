-- Baseline: the migrations the current build needs (0019, 0020, 0021).
-- SAFE TO RUN MORE THAN ONCE. Every statement is guarded with IF NOT EXISTS,
-- so if some of these already ran, running them again changes nothing.

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


-- ---------------------------------------------------------------------------
-- Analyses that nobody is waiting on.
--
-- Batch requests cost half: $0.375 per million input tokens against $0.75, for
-- the same model reading the same frames and returning the same answer. The
-- price of that is the clock -- jobs target a 24-hour turnaround and expire at
-- 48 -- so it is not a setting to flip for everyone. Somebody who has just
-- walked off the court wants their read now; somebody uploading five games
-- from last month does not, and should not pay as if they did.
--
-- SO THE MODE IS A PROPERTY OF THE ANALYSIS, chosen at upload, not a global.
--
-- The two other columns exist because of what batch does to the shape of a
-- run. Today a run lives in one process's memory from upload to coaching read:
-- a deploy kills it, and the machine sleeps after twenty idle minutes. Nothing
-- that might take six hours can live there. So a batch run submits its job,
-- writes the name here, and exits -- and something else, later, in a different
-- process, finds the row and collects the result. The job name is the handle
-- that makes a run survive the process that started it.
-- ---------------------------------------------------------------------------

alter table public.analyses
  --: 'now' (default) reads the clip immediately at full price. 'overnight'
  --: submits it to the batch queue at half price and comes back for it later.
  --: Defaulted to 'now' so every existing row keeps the behaviour it had.
  add column if not exists analysis_mode text not null default 'now',
  --: The batch job this analysis is waiting on, e.g. "batches/abc123". Null
  --: whenever the run is not waiting on one, which is every 'now' run and
  --: every batch run that has already been collected.
  add column if not exists batch_job_name text,
  --: When the job was submitted. The collector abandons a job that is older
  --: than the documented expiry regardless of what its state field says, so an
  --: analysis can never sit at 'processing' forever because a job got lost.
  add column if not exists batch_submitted_at timestamptz;

--: Only the rows the collector cares about. A partial index rather than a
--: whole-table one: at any moment almost every analysis has no pending job,
--: and an index over all of them would be mostly empty rows to skip.
create index if not exists analyses_pending_batch_idx
  on public.analyses (batch_submitted_at)
  where batch_job_name is not null;

alter table public.analyses
  drop constraint if exists analyses_analysis_mode_check;
alter table public.analyses
  add constraint analyses_analysis_mode_check
  check (analysis_mode in ('now', 'overnight'));


