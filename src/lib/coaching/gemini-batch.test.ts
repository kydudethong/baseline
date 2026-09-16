import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapState, parseBatchJob, isAbandoned, BATCH_ABANDON_AFTER_MS,
} from "./gemini-batch";

test("an unrecognised state reads as still running, never as failed", () => {
  // THE EXPENSIVE MISTAKE THIS PREVENTS. Calling an unknown state a failure
  // abandons a job that may be minutes from succeeding, and bills the user a
  // second time for the re-run. A genuinely stuck job is caught by the
  // time-based abandon check instead, which no new state name can confuse.
  assert.equal(mapState("BATCH_STATE_SOMETHING_NEW"), "running");
  assert.equal(mapState(undefined), "running");
  assert.equal(mapState(""), "running");
});

test("the states we do know map the way they read", () => {
  assert.equal(mapState("BATCH_STATE_PENDING"), "pending");
  assert.equal(mapState("BATCH_STATE_SUCCEEDED"), "done");
  assert.equal(mapState("BATCH_STATE_FAILED"), "failed");
  assert.equal(mapState("BATCH_STATE_EXPIRED"), "expired");
  // Cancelled is a failure to us: there is no result and none is coming.
  assert.equal(mapState("BATCH_STATE_CANCELLED"), "failed");
  // Both naming conventions the API has used.
  assert.equal(mapState("JOB_STATE_SUCCEEDED"), "done");
});

test("a job still running carries no results", () => {
  const job = parseBatchJob("batches/x", JSON.stringify({
    metadata: { state: "BATCH_STATE_RUNNING" },
  }));
  assert.equal(job.state, "running");
  assert.equal(job.results, undefined);
});

test("a finished job yields one result per request, in order", () => {
  const job = parseBatchJob("batches/x", JSON.stringify({
    metadata: { state: "BATCH_STATE_SUCCEEDED" },
    response: {
      inlinedResponses: {
        inlinedResponses: [
          { response: { candidates: [{ content: { parts: [{ text: '{"seg":1}' }] } }] } },
          { response: { candidates: [{ content: { parts: [{ text: '{"seg":2}' }] } }] } },
        ],
      },
    },
  }));
  assert.equal(job.state, "done");
  assert.equal(job.results?.length, 2);
  assert.deepEqual(job.results?.map((r) => (r.ok ? r.text : null)), ['{"seg":1}', '{"seg":2}']);
});

test("one refused segment does not throw the other four away", () => {
  // After a six-hour wait, a partial answer is worth far more than none. The
  // caller decides what a missing segment costs; this must not decide for it.
  const job = parseBatchJob("batches/x", JSON.stringify({
    metadata: { state: "BATCH_STATE_SUCCEEDED" },
    response: {
      inlinedResponses: {
        inlinedResponses: [
          { response: { candidates: [{ content: { parts: [{ text: '{"seg":1}' }] } }] } },
          { error: { message: "blocked" } },
          { response: { candidates: [{ content: { parts: [{ text: '{"seg":3}' }] } }] } },
        ],
      },
    },
  }));
  assert.equal(job.results?.length, 3);
  assert.equal(job.results?.[0].ok, true);
  assert.equal(job.results?.[2].ok, true);

  // AND THE REASON SURVIVES, which is the half that needs asserting. Dropping
  // the per-request error entirely still produces ok:false -- the empty-text
  // path catches it and reports "no text returned" -- so checking only the
  // flag passes against code that has thrown the diagnosis away. What the
  // segment was refused FOR is the whole value of the field.
  const bad = job.results![1];
  assert.equal(bad.ok, false);
  assert.equal(bad.ok ? "" : bad.error, "blocked");
});

test("a candidate with no text names why, rather than reporting an empty answer", () => {
  // MAX_TOKENS with no text is a failure this pipeline has hit before, and it
  // took a long time to diagnose precisely because it looked like an answer.
  const job = parseBatchJob("batches/x", JSON.stringify({
    metadata: { state: "BATCH_STATE_SUCCEEDED" },
    response: {
      inlinedResponses: { inlinedResponses: [{ response: { candidates: [{ finishReason: "MAX_TOKENS" }] } }] },
    },
  }));
  const r = job.results![0];
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /MAX_TOKENS/);
});

test("a job-level error beats whatever the state says", () => {
  const job = parseBatchJob("batches/x", JSON.stringify({
    metadata: { state: "BATCH_STATE_SUCCEEDED" },
    error: { message: "quota exhausted" },
  }));
  assert.equal(job.state, "failed");
  assert.equal(job.error, "quota exhausted");
});

test("both spellings of the inlined-response field are read", () => {
  // The API has used camelCase and snake_case in different places, and a job
  // whose results silently read as empty would look exactly like a job that
  // returned nothing.
  const snake = parseBatchJob("batches/x", JSON.stringify({
    metadata: { state: "BATCH_STATE_SUCCEEDED" },
    response: {
      inlined_responses: {
        inlined_responses: [{ response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } }],
      },
    },
  }));
  assert.equal(snake.results?.length, 1);
  assert.equal(snake.results?.[0].ok, true);
});

test("non-JSON from the poll is an error, not a silent empty job", () => {
  assert.throws(() => parseBatchJob("batches/x", "<html>502 Bad Gateway</html>"));
});

test("a job older than the expiry window is abandoned whatever its state", () => {
  const now = Date.now();
  assert.equal(isAbandoned(now - 1000, now), false);
  assert.equal(isAbandoned(now - BATCH_ABANDON_AFTER_MS + 60_000, now), false);
  assert.equal(isAbandoned(now - BATCH_ABANDON_AFTER_MS - 60_000, now), true);
  // A missing submit time must not abandon the run.
  assert.equal(isAbandoned(NaN, now), false);
});
