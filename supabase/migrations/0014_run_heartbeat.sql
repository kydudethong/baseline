-- ---------------------------------------------------------------------------
-- A pulse, so "still working" and "died" stop looking identical.
--
-- THE PROBLEM THIS SOLVES, three times over. `updated_at` moves only when the
-- STAGE changes, so a run that dies inside a stage looks exactly like one
-- grinding through it. That ambiguity produced a run stuck on "Tracking the
-- ball" for 10 hr 26 min, and another on "Finding the court" for 32 minutes --
-- a stage with an 8-minute internal timeout, so it could not possibly still
-- have been running. In both cases the page showed a spinner and the honest
-- answer was "the process is gone", which nothing could say.
--
-- Timeouts do not fix this and cannot. CV_STEP_TIMEOUT_MS, the rally_seg
-- bound, the proxy bound -- every one of them catches a process that is HUNG.
-- None catches one that is GONE, because there is nothing left running to fire
-- the timer. A machine that OOMs or is replaced by a deploy leaves a row
-- marked 'processing' with no process behind it, and only something the LIVE
-- process was actively writing can distinguish that.
--
-- Hence a pulse rather than a longer timeout: the running pipeline touches
-- this column every few seconds, and a reader treats a pulse older than a
-- couple of minutes as dead. Silence is the signal.
--
-- Nullable, and null means "unknown, fall back to updated_at" -- every row
-- written before this migration, and any run from an older build.
-- ---------------------------------------------------------------------------

alter table public.analyses
  add column if not exists heartbeat_at timestamptz;

comment on column public.analyses.heartbeat_at is
  'Touched every few seconds by the process running this analysis. A ''processing'' row whose heartbeat has gone quiet is dead, not busy. Null for runs from before 0014.';

-- The staleness sweep asks one question: which processing rows have gone
-- quiet. Partial, because rows in every other status are never asked about.
create index if not exists analyses_heartbeat_idx
  on public.analyses (heartbeat_at)
  where status = 'processing';
