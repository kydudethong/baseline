-- ---------------------------------------------------------------------------
-- Where each player actually stood.
--
-- Kitchen-line time, time-to-kitchen after the return, and partner gap have
-- been COMPUTED on every run since they were built, and written only to a log
-- line. That was the right call while the question was "are these numbers even
-- right on real footage" -- reading them off a run answers that without
-- committing a schema. They have since been read off several runs and they are
-- right, so they get a column.
--
-- ONE JSONB COLUMN rather than six numeric ones. These are a summary of one
-- player in one clip, always read together, never queried across, and still
-- moving -- zone thresholds and the partner-gap definition have both changed
-- once already. Six columns would be six migrations the next time.
-- ---------------------------------------------------------------------------

alter table public.movement_metrics
  add column if not exists positioning jsonb;

comment on column public.movement_metrics.positioning is
  'Court positioning summary: zone fractions, seconds at the kitchen line, time to the kitchen after the return, and partner gap. Null when the court was not calibrated, because none of it is computable without court coordinates.';
