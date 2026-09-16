/**
 * Finishing the runs that nobody stayed around for.
 *
 * A batch analysis submits its job and exits. Minutes or hours later the
 * answer is sitting in a queue and the process that asked for it is long gone
 * -- the machine may have slept, been redeployed, or never handled that
 * request at all. This is the other half: find the rows waiting on a job, ask
 * whether it is finished, and carry on.
 *
 * DECIDING, NOT DOING. Everything here is a pure decision about one row --
 * keep waiting, resume with these results, or fail with this reason -- so it
 * can be tested without a database, a network, or a job that takes six hours
 * to reach the state being tested. The route does the fetching and the writing
 * and holds no judgement of its own.
 */

import { isAbandoned, type BatchJob } from "./gemini-batch";
import type { AnalystOutput } from "./analyst";

export type CollectDecision =
  | { action: "wait"; reason: string }
  | { action: "resume"; texts: string[]; missing: number }
  | { action: "fail"; reason: string };

/**
 * What to do about one analysis waiting on one job.
 *
 * `submittedAt` is the row's own record rather than anything the job reports,
 * because the case this has to survive is a job that reports nothing useful at
 * all.
 */
export function decideCollect(opts: {
  job: BatchJob;
  submittedAtMs: number;
  now?: number;
}): CollectDecision {
  const now = opts.now ?? Date.now();
  const { job } = opts;

  // AGE BEATS STATE. A job stuck in "running" past the documented expiry is
  // not running, whatever it says, and the alternative to deciding that is an
  // analysis that reads "processing" for the rest of its life. Checked first,
  // so no state can talk its way out of it.
  if (isAbandoned(opts.submittedAtMs, now)) {
    return {
      action: "fail",
      reason: "The overnight queue did not return this analysis within two days. "
        + "Re-running it will start a fresh one.",
    };
  }

  if (job.state === "pending" || job.state === "running") {
    return { action: "wait", reason: job.state };
  }

  if (job.state === "failed") {
    return {
      action: "fail",
      reason: job.error
        ? `The overnight queue could not finish this analysis: ${job.error}`
        : "The overnight queue could not finish this analysis.",
    };
  }

  if (job.state === "expired") {
    return {
      action: "fail",
      reason: "The overnight queue dropped this analysis before it finished. "
        + "Re-running it will start a fresh one.",
    };
  }

  // state === "done"
  const results = job.results ?? [];
  const texts = results.filter((r) => r.ok).map((r) => (r.ok ? r.text : ""));
  const missing = results.length - texts.length;

  // A JOB THAT FINISHED WITH NOTHING IS A FAILURE, not an empty analysis. The
  // distinction matters because the two look identical in the database and
  // completely different to a person: "no rallies found in your clip" is a
  // statement about their footage, and this is a statement about our queue.
  if (texts.length === 0) {
    return {
      action: "fail",
      reason: results.length === 0
        ? "The overnight queue returned nothing for this analysis."
        : `Every segment of this analysis was refused: ${firstError(job)}`,
    };
  }

  return { action: "resume", texts, missing };
}

function firstError(job: BatchJob): string {
  for (const r of job.results ?? []) if (!r.ok) return r.error;
  return "no reason given";
}

/**
 * How long a row may sit unchecked before the collector looks at it again.
 *
 * Five minutes. A poll is one cheap GET and the jobs take hours, so there is
 * nothing to gain from hammering it -- but a finished job that sits uncollected
 * is indistinguishable, to the person waiting, from one that never finished.
 */
export const COLLECT_EVERY_MS = 5 * 60 * 1000;

/**
 * How many pending jobs one sweep will look at.
 *
 * Bounded because this runs on a schedule on a box that has other work, and an
 * unbounded sweep after an outage would be a thundering herd of its own making.
 * Oldest first, so a backlog drains in the order people are waiting.
 */
export const COLLECT_BATCH_SIZE = 25;

/**
 * A segment's JSON, or nothing.
 *
 * A SEGMENT THAT WILL NOT PARSE IS DROPPED, NOT THROWN. One malformed answer
 * out of five should cost a fifth of the analysis, not all of it -- after an
 * overnight wait, the difference between four segments and starting again is
 * another day.
 */
export function parseSegments(texts: string[], onLog?: (l: string) => void): AnalystOutput[] {
  const out: AnalystOutput[] = [];
  texts.forEach((t, i) => {
    try {
      out.push(JSON.parse(t) as AnalystOutput);
    } catch (err) {
      onLog?.(`segment ${i + 1} was not JSON and has been dropped: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return out;
}
