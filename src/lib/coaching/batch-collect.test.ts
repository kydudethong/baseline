import { test } from "node:test";
import assert from "node:assert/strict";
import { decideCollect } from "./batch-collect";
import { BATCH_ABANDON_AFTER_MS, type BatchJob } from "./gemini-batch";

const now = Date.now();
const fresh = now - 60_000;
const job = (j: Partial<BatchJob>): BatchJob => ({ name: "batches/x", state: "running", ...j });

test("a running job is waited on", () => {
  const d = decideCollect({ job: job({ state: "running" }), submittedAtMs: fresh, now });
  assert.equal(d.action, "wait");
});

test("a finished job resumes the run with its texts, in order", () => {
  const d = decideCollect({
    job: job({ state: "done", results: [
      { ok: true, text: "a" }, { ok: true, text: "b" },
    ]}),
    submittedAtMs: fresh, now,
  });
  assert.equal(d.action, "resume");
  assert.deepEqual(d.action === "resume" ? d.texts : null, ["a", "b"]);
  assert.equal(d.action === "resume" ? d.missing : null, 0);
});

test("a partly refused job still resumes, and says how much is missing", () => {
  // After six hours of waiting, four segments out of five is worth far more
  // than starting again.
  const d = decideCollect({
    job: job({ state: "done", results: [
      { ok: true, text: "a" }, { ok: false, error: "blocked" }, { ok: true, text: "c" },
    ]}),
    submittedAtMs: fresh, now,
  });
  assert.equal(d.action, "resume");
  assert.deepEqual(d.action === "resume" ? d.texts : null, ["a", "c"]);
  assert.equal(d.action === "resume" ? d.missing : null, 1);
});

test("a job that finished with nothing is a failure, not an empty analysis", () => {
  // These look identical in the database and completely different to a person:
  // "no rallies found in your clip" is about their footage, this is about our
  // queue. Reporting the wrong one sends someone off to re-film for no reason.
  const d = decideCollect({
    job: job({ state: "done", results: [{ ok: false, error: "blocked" }] }),
    submittedAtMs: fresh, now,
  });
  assert.equal(d.action, "fail");
  assert.match(d.action === "fail" ? d.reason : "", /refused|blocked/i);
});

test("age beats state: a job stuck past the expiry is abandoned", () => {
  // The alternative is an analysis that reads "processing" for the rest of its
  // life because a job never reached a terminal state.
  const d = decideCollect({
    job: job({ state: "running" }),
    submittedAtMs: now - BATCH_ABANDON_AFTER_MS - 60_000,
    now,
  });
  assert.equal(d.action, "fail");
  assert.match(d.action === "fail" ? d.reason : "", /two days|did not return/i);
});

test("a job that fails reports the queue's own reason", () => {
  const d = decideCollect({
    job: job({ state: "failed", error: "quota exhausted" }),
    submittedAtMs: fresh, now,
  });
  assert.equal(d.action, "fail");
  assert.match(d.action === "fail" ? d.reason : "", /quota exhausted/);
});

test("an expired job tells the player a re-run starts fresh", () => {
  const d = decideCollect({ job: job({ state: "expired" }), submittedAtMs: fresh, now });
  assert.equal(d.action, "fail");
  assert.match(d.action === "fail" ? d.reason : "", /re-running/i);
});

test("every failure reason is written for a player, not for a log", () => {
  // Nothing here should leak "BATCH_STATE_EXPIRED" or a job name at somebody
  // who just wants to know whether to upload it again.
  const cases = [
    decideCollect({ job: job({ state: "expired" }), submittedAtMs: fresh, now }),
    decideCollect({ job: job({ state: "failed" }), submittedAtMs: fresh, now }),
    decideCollect({ job: job({ state: "running" }), submittedAtMs: now - BATCH_ABANDON_AFTER_MS - 1, now }),
    decideCollect({ job: job({ state: "done", results: [] }), submittedAtMs: fresh, now }),
  ];
  for (const c of cases) {
    if (c.action !== "fail") continue;
    assert.doesNotMatch(c.reason, /BATCH_STATE|JOB_STATE|batches\//,
      `leaked an internal name: ${c.reason}`);
    assert.ok(c.reason.length > 20, `too terse to act on: ${c.reason}`);
  }
});
