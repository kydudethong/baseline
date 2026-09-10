import assert from "node:assert/strict";
import test from "node:test";

import {
  RunCancelledError, activeRunSignal, beginRun, cancelRun, clearActiveRunSignal,
  endRun, isCancellation, isRunning, runningCount, setActiveRunSignal,
  __resetRunRegistry,
} from "./run-registry";

test("a registered run can be cancelled and its signal aborts", () => {
  __resetRunRegistry();
  const c = beginRun("a1");
  assert.equal(c.signal.aborted, false);
  assert.equal(cancelRun("a1"), true);
  assert.equal(c.signal.aborted, true);
  assert.ok(isCancellation(c.signal.reason));
  __resetRunRegistry();
});

test("cancelling something that is not running is false, not an error", () => {
  // Not an error case. The run already finished, or it belonged to a machine
  // that has since restarted; either way "it is not running any more" is the
  // honest reply and the caller should say that rather than fail.
  __resetRunRegistry();
  assert.equal(cancelRun("nope"), false);
  __resetRunRegistry();
});

test("cancelling twice is false the second time", () => {
  __resetRunRegistry();
  beginRun("a1");
  assert.equal(cancelRun("a1"), true);
  assert.equal(cancelRun("a1"), false);
  __resetRunRegistry();
});

test("runs are tracked independently", () => {
  __resetRunRegistry();
  const a = beginRun("a1");
  const b = beginRun("b1");
  cancelRun("a1");
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, false, "cancelling one must not touch the other");
  assert.equal(runningCount(), 1);
  __resetRunRegistry();
});

test("ending a run releases its slot", () => {
  __resetRunRegistry();
  const c = beginRun("a1");
  assert.equal(isRunning("a1"), true);
  endRun("a1", c);
  assert.equal(isRunning("a1"), false);
  assert.equal(cancelRun("a1"), false);
  __resetRunRegistry();
});

test("a replaced run does not delete its successor's registration", () => {
  // The subtle one. If endRun cleared by id alone, the OLD run unwinding
  // after being replaced would deregister the NEW run, leaving it running
  // and impossible to cancel.
  __resetRunRegistry();
  const first = beginRun("a1");
  const second = beginRun("a1");
  assert.equal(first.signal.aborted, true, "starting again aborts the old run");
  assert.equal(second.signal.aborted, false);

  endRun("a1", first);          // the old run finally unwinds
  assert.equal(isRunning("a1"), true, "the new run must still be registered");
  assert.equal(cancelRun("a1"), true);
  assert.equal(second.signal.aborted, true);
  __resetRunRegistry();
});

test("endRun without a controller still clears, for callers that have none", () => {
  __resetRunRegistry();
  beginRun("a1");
  endRun("a1");
  assert.equal(isRunning("a1"), false);
  __resetRunRegistry();
});

test("cancellation is recognised however it is wrapped", () => {
  assert.equal(isCancellation(new RunCancelledError()), true);
  // Node rejects an aborted child process with this shape.
  assert.equal(isCancellation({ name: "AbortError" }), true);
  assert.equal(isCancellation({ cancelled: true }), true);
  assert.equal(isCancellation(new Error("ball detection failed")), false);
  assert.equal(isCancellation(null), false);
  assert.equal(isCancellation(undefined), false);
});

test("the cancellation reason reaches the signal", () => {
  __resetRunRegistry();
  const c = beginRun("a1");
  cancelRun("a1", "Stopped by you.");
  assert.equal((c.signal.reason as Error).message, "Stopped by you.");
  __resetRunRegistry();
});

test("a late finally does not strip the signal off the run that replaced it", () => {
  // The same trap endRun guards, one layer down. If clearing were
  // unconditional, the old run unwinding would leave the new run's
  // subprocesses spawning with no signal — unkillable, which is the one
  // outcome this whole mechanism exists to prevent.
  __resetRunRegistry();
  const first = beginRun("a1");
  setActiveRunSignal(first.signal);

  const second = beginRun("a1");
  setActiveRunSignal(second.signal);

  clearActiveRunSignal(first.signal);           // the old run finally exits
  assert.equal(activeRunSignal(), second.signal, "the new run keeps its signal");

  clearActiveRunSignal(second.signal);
  assert.equal(activeRunSignal(), undefined);
  __resetRunRegistry();
});

test("the active signal is what subprocesses would be spawned with", () => {
  __resetRunRegistry();
  assert.equal(activeRunSignal(), undefined, "nothing running, nothing to honour");
  const c = beginRun("a1");
  setActiveRunSignal(c.signal);
  assert.equal(activeRunSignal(), c.signal);
  cancelRun("a1");
  assert.equal(activeRunSignal()?.aborted, true, "an in-flight spawn sees the abort");
  __resetRunRegistry();
});
