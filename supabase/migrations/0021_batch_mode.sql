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
