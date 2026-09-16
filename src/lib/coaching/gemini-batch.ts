/**
 * The same analysis, submitted to a queue instead of waited on.
 *
 * WHAT THIS BUYS AND WHAT IT COSTS. Batch requests are half price -- $0.375
 * per million input tokens against $0.75 -- for identical model, identical
 * frames, identical output. Nothing about the analysis is worse. What is worse
 * is the wait: jobs target a 24-hour turnaround and expire at 48. "Many
 * complete much faster" is the documented promise and it is not a guarantee.
 *
 * So this is not a cheaper way to do the same thing. It is a different product
 * for a different moment -- somebody clearing a backlog of five games from
 * last month does not need an answer while they stand on the court, and should
 * not be charged as though they did.
 *
 * THE ARCHITECTURAL CONSEQUENCE IS THE REAL WORK, and it is worth naming here
 * because it is invisible from the pricing page. A run currently lives in one
 * process's memory from upload to coaching read; a deploy kills it, and the
 * machine sleeps after twenty idle minutes. Nothing that might take six hours
 * can live there. So a batch run SUBMITS and exits, the job name is written to
 * the database, and something else picks the results up later. Every function
 * here is built for that split: submit returns a name, and collect takes a
 * name and knows nothing about the process that created it.
 */

import { GeminiError } from "./gemini";

const BASE = "https://generativelanguage.googleapis.com";

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new GeminiError("GEMINI_API_KEY is not set");
  return key;
}

/**
 * What a job is doing, in our words rather than Google's.
 *
 * Mapped rather than passed through: the API's states are an implementation
 * detail we would otherwise spread across the database, the poller and the UI,
 * and a new one appearing would then be an unhandled case in three places
 * instead of one.
 */
export type BatchState = "pending" | "running" | "done" | "failed" | "expired";

export interface BatchJob {
  /** The API's own name for the job, e.g. "batches/abc123". The handle we store. */
  name: string;
  state: BatchState;
  /** Set only when state is "done". One entry per submitted request, in order. */
  results?: Array<BatchResult>;
  /** Set when state is "failed", for the log and for the user-facing message. */
  error?: string;
}

export type BatchResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * State names the API can return, and what each means to us.
 *
 * UNKNOWN MAPS TO "running", NOT TO "failed". A state we do not recognise is a
 * state we have not seen yet, and the safe reading of that is "still going" --
 * treating it as failure would abandon a job that is about to succeed and bill
 * the user twice for the re-run. A job that is genuinely stuck is caught by
 * the expiry check instead, which is time-based and cannot be confused by a
 * name we do not know.
 */
const STATE_MAP: Record<string, BatchState> = {
  BATCH_STATE_PENDING: "pending",
  BATCH_STATE_RUNNING: "running",
  BATCH_STATE_SUCCEEDED: "done",
  BATCH_STATE_FAILED: "failed",
  BATCH_STATE_CANCELLED: "failed",
  BATCH_STATE_EXPIRED: "expired",
  JOB_STATE_PENDING: "pending",
  JOB_STATE_RUNNING: "running",
  JOB_STATE_SUCCEEDED: "done",
  JOB_STATE_FAILED: "failed",
  JOB_STATE_CANCELLED: "failed",
  JOB_STATE_EXPIRED: "expired",
};

export function mapState(raw: string | undefined | null): BatchState {
  if (!raw) return "running";
  return STATE_MAP[raw] ?? "running";
}

/**
 * Jobs older than this are treated as lost regardless of what the API says.
 *
 * The documented expiry is 48 hours. This sits past it on purpose: the point
 * is not to race the API to a verdict, it is to make sure a job that somehow
 * never reaches a terminal state cannot leave an analysis saying "processing"
 * forever. A run this old has failed whatever its state field claims.
 */
export const BATCH_ABANDON_AFTER_MS = 50 * 60 * 60 * 1000;

export function isAbandoned(submittedAtMs: number, nowMs = Date.now()): boolean {
  if (!Number.isFinite(submittedAtMs)) return false;
  return nowMs - submittedAtMs > BATCH_ABANDON_AFTER_MS;
}

/**
 * Submit every segment of a run as ONE job.
 *
 * One job rather than one per segment, because the unit anybody cares about is
 * the analysis: five segments that finish at five different times are five
 * chances to have half a coaching read, and the collector would have to
 * reassemble them anyway. One name in the database, one answer.
 */
export async function submitBatch(opts: {
  model: string;
  /** Bodies from buildGenerateBody, in the order their results are wanted. */
  requests: Array<Record<string, unknown>>;
  displayName: string;
}): Promise<string> {
  if (opts.requests.length === 0) throw new GeminiError("batch: nothing to submit");

  const res = await fetch(
    `${BASE}/v1beta/models/${opts.model}:batchGenerateContent?key=${apiKey()}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        batch: {
          display_name: opts.displayName,
          input_config: {
            requests: {
              requests: opts.requests.map((request, i) => ({
                request,
                metadata: { key: `req-${i}` },
              })),
            },
          },
        },
      }),
    }
  );

  const text = await res.text();
  if (!res.ok) {
    throw new GeminiError(`batch submit failed (${res.status}): ${text.slice(0, 400)}`);
  }
  let parsed: { name?: string };
  try {
    parsed = JSON.parse(text) as { name?: string };
  } catch {
    throw new GeminiError(`batch submit returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!parsed.name) {
    throw new GeminiError(`batch submit returned no job name: ${text.slice(0, 200)}`);
  }
  return parsed.name;
}

/** Ask what a job is doing, and collect its results when it is finished. */
export async function collectBatch(name: string): Promise<BatchJob> {
  const res = await fetch(`${BASE}/v1beta/${name}?key=${apiKey()}`, { method: "GET" });
  const text = await res.text();
  if (!res.ok) {
    // A 404 is a job that no longer exists -- expired and swept, or a name
    // from a different key. Either way it is never coming back, and calling it
    // "running" would leave the analysis waiting forever.
    if (res.status === 404) return { name, state: "expired", error: "job not found" };
    throw new GeminiError(`batch poll failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return parseBatchJob(name, text);
}

/**
 * The poll response, turned into a BatchJob.
 *
 * Exported and pure so the shape can be tested without the network, which is
 * the only way this gets tested at all: a real job takes hours.
 */
export function parseBatchJob(name: string, raw: string): BatchJob {
  let body: {
    metadata?: { state?: string };
    state?: string;
    done?: boolean;
    error?: { message?: string };
    response?: {
      inlinedResponses?: { inlinedResponses?: unknown[] };
      inlined_responses?: { inlined_responses?: unknown[] };
    };
  };
  try {
    body = JSON.parse(raw);
  } catch {
    throw new GeminiError(`batch poll returned non-JSON: ${raw.slice(0, 200)}`);
  }

  const state = mapState(body.metadata?.state ?? body.state);
  if (body.error?.message) {
    return { name, state: "failed", error: body.error.message };
  }
  if (state !== "done") return { name, state };

  const inlined =
    body.response?.inlinedResponses?.inlinedResponses
    ?? body.response?.inlined_responses?.inlined_responses
    ?? [];
  return { name, state: "done", results: inlined.map(oneResult) };
}

/**
 * One response out of the batch, as text or as a reason there is none.
 *
 * A PER-REQUEST FAILURE IS NOT A JOB FAILURE. One segment can be refused for
 * its own reasons -- a safety block, a token overflow -- while the other four
 * are perfectly good, and throwing the lot away because of it would turn a
 * partial answer into no answer after a six-hour wait. The caller decides what
 * a missing segment is worth.
 */
function oneResult(entry: unknown): BatchResult {
  const e = entry as {
    error?: { message?: string };
    response?: {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
    };
  };
  if (e?.error?.message) return { ok: false, error: e.error.message };

  const cand = e?.response?.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) {
    // MAX_TOKENS with no text is the failure this pipeline has hit before, and
    // it is worth naming rather than reporting as an empty answer.
    const why = cand?.finishReason
      ? `no text returned (finishReason: ${cand.finishReason})`
      : "no text returned";
    return { ok: false, error: why };
  }
  return { ok: true, text };
}
