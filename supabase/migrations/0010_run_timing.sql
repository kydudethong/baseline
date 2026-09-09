-- ---------------------------------------------------------------------------
-- Run timing, so the processing screen can give an estimate that is measured
-- rather than invented.
--
-- The screen deliberately has no percentage bar: the pipeline genuinely does
-- not know how far through it is, and a bar that made a number up would be
-- the exact dishonesty this product is built against. An ETA is a different
-- claim. "Clips like this one have taken 4-7 minutes" is a statement about
-- observed history, it can be checked, and it can be wrong in a way the user
-- can see. That is only true if the history is actually recorded, which is
-- what these two columns are for.
--
-- Both are nullable and stay null for every run that happened before this
-- migration. The estimator treats a missing pair as no data rather than as a
-- zero-length run, which would drag the median toward nonsense.
-- ---------------------------------------------------------------------------

alter table public.analyses
  add column if not exists started_at  timestamptz,
  add column if not exists finished_at timestamptz;

comment on column public.analyses.started_at is
  'When the run entered ''processing''. Null for runs recorded before 0010, and for analyses that never started.';
comment on column public.analyses.finished_at is
  'When the run reached ''completed'' or ''failed''. Null while running.';

-- The estimator asks one question: "recent finished runs for this user, with
-- their video duration". Ordering by finished_at descending over a user is
-- the whole access pattern.
create index if not exists analyses_user_finished_idx
  on public.analyses (user_id, finished_at desc)
  where finished_at is not null;
