import assert from "node:assert/strict";
import { test } from "node:test";

import { HEARTBEAT_DEAD_AFTER_MS, livenessOf } from "./heartbeat";

const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const agoMs = (ms: number) => new Date(NOW - ms).toISOString();

test("a fresh pulse means alive", () => {
  const l = livenessOf("processing", agoMs(5_000), NOW);
  assert.equal(l.looksDead, false);
  assert.equal(l.quietForSeconds, 5);
});

test("a long silence on a processing row means dead", () => {
  // The 32-minute "Finding the court" case: a stage with an 8-minute internal
  // timeout, so it could not still have been running.
  const l = livenessOf("processing", agoMs(32 * 60_000), NOW);
  assert.equal(l.looksDead, true);
  assert.equal(l.quietForSeconds, 32 * 60);
});

test("the window is generous — being slow to notice beats crying wolf", () => {
  // Calling a LIVE run dead is the worse error: it tells someone their
  // analysis failed while it is still working, and invites a second run on
  // top of the first.
  assert.equal(livenessOf("processing", agoMs(HEARTBEAT_DEAD_AFTER_MS - 1), NOW).looksDead, false);
  assert.equal(livenessOf("processing", agoMs(HEARTBEAT_DEAD_AFTER_MS + 1), NOW).looksDead, true);
});

test("a run with NO heartbeat is never called dead", () => {
  // Pre-0014 rows and older builds. Inventing a verdict from missing data is
  // how you tell someone a working run has failed.
  const l = livenessOf("processing", null, NOW);
  assert.equal(l.looksDead, false);
  assert.equal(l.quietForSeconds, null);
});

test("an unparseable timestamp is treated as unknown, not as dead", () => {
  assert.equal(livenessOf("processing", "not a date", NOW).looksDead, false);
});

test("finished runs are never dead, however old", () => {
  for (const status of ["completed", "failed", "uploaded"]) {
    const l = livenessOf(status, agoMs(10 * 3600_000), NOW);
    assert.equal(l.looksDead, false, status);
    assert.equal(l.quietForSeconds, null, status);
  }
});

test("queued counts as a run that should be pulsing", () => {
  assert.equal(livenessOf("queued", agoMs(32 * 60_000), NOW).looksDead, true);
});

test("a clock skewed into the future reads as quiet-for-zero, not negative", () => {
  const l = livenessOf("processing", new Date(NOW + 30_000).toISOString(), NOW);
  assert.equal(l.quietForSeconds, 0);
  assert.equal(l.looksDead, false);
});

test("a run waiting on a batch job is never called dead", () => {
  // THE ONE THAT COULD HAVE COST REAL MONEY. An overnight run is silent by
  // design -- it submitted its job and exited, which is the whole point of the
  // mode. Without this guard the sweeper calls it dead two minutes later and
  // restarts it, and a restart means submitting and paying for a SECOND job.
  // Every two minutes. For up to a day.
  const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const waiting = livenessOf("processing", longAgo, Date.now(), undefined, "batches/abc123");
  assert.equal(waiting.looksDead, false, "a batch run was called dead");

  // And the guard must not make every run immortal: the same row with no job
  // to wait on is still dead.
  const orphan = livenessOf("processing", longAgo, Date.now(), undefined, null);
  assert.equal(orphan.looksDead, true, "a genuinely dead run stopped being reported");
});
