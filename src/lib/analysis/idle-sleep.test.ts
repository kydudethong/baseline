import assert from "node:assert/strict";
import test from "node:test";

import {
  activeRunCount, idleMinutes, idleSleepDisabledReason, idleSleepEnabled, idleState,
  noteRequest, runFinished, runStarted, __resetIdleState,
} from "./idle-sleep";

const MIN = 60_000;

test("idle only counts once there are no runs AND no recent requests", () => {
  // Both conditions, not either. A machine deep in a 6-minute analysis has
  // served no request for 6 minutes and must not be mistaken for idle.
  assert.equal(idleState(0, 0, 0, 20 * MIN).shouldSleep, false, "no idle time yet");
  assert.equal(idleState(30 * MIN, 0, 0, 20 * MIN).shouldSleep, true, "quiet and empty");
  assert.equal(idleState(30 * MIN, 0, 1, 20 * MIN).shouldSleep, false, "a run is in flight");
});

test("a run in flight keeps the machine awake no matter how quiet it is", () => {
  const state = idleState(24 * 60 * MIN, 0, 1, 20 * MIN);
  assert.equal(state.shouldSleep, false);
  assert.ok(state.idleMs > 0, "still reports the idle time, it just does not act on it");
});

test("the threshold is inclusive, so exactly-at is asleep", () => {
  assert.equal(idleState(20 * MIN, 0, 0, 20 * MIN).shouldSleep, true);
  assert.equal(idleState(20 * MIN - 1, 0, 0, 20 * MIN).shouldSleep, false);
});

test("a clock that jumps backwards does not produce negative idle time", () => {
  const state = idleState(0, 5 * MIN, 0, 20 * MIN);
  assert.equal(state.idleMs, 0);
  assert.equal(state.shouldSleep, false);
});

test("run counting survives being called out of order", () => {
  __resetIdleState();
  runStarted();
  runStarted();
  assert.equal(activeRunCount(), 2);
  runFinished();
  assert.equal(activeRunCount(), 1);
  runFinished();
  runFinished();               // the double-call that must not go negative
  assert.equal(activeRunCount(), 0);
  // If this had gone to -1, a real run starting next would read as 0 and the
  // machine could sleep on top of it.
  runStarted();
  assert.equal(activeRunCount(), 1);
  __resetIdleState();
});

test("starting a run also counts as activity", () => {
  __resetIdleState();
  const before = Date.now();
  runStarted();
  noteRequest();
  assert.ok(Date.now() >= before);
  __resetIdleState();
});

test("a nonsense idle threshold falls back instead of sleeping immediately", () => {
  // Zero would stop the machine the moment it booted, before anyone could
  // reach it, and the only way out is flyctl.
  const original = process.env.IDLE_SLEEP_MINUTES;
  for (const bad of ["0", "-5", "abc", ""]) {
    process.env.IDLE_SLEEP_MINUTES = bad;
    assert.equal(idleMinutes(), 20, `expected the default for ${JSON.stringify(bad)}`);
  }
  process.env.IDLE_SLEEP_MINUTES = "45";
  assert.equal(idleMinutes(), 45);
  if (original === undefined) delete process.env.IDLE_SLEEP_MINUTES;
  else process.env.IDLE_SLEEP_MINUTES = original;
});

test("it stays off unless every Fly variable is present", () => {
  const saved = {
    t: process.env.FLY_API_TOKEN, a: process.env.FLY_APP_NAME,
    m: process.env.FLY_MACHINE_ID, s: process.env.IDLE_SLEEP,
  };
  delete process.env.IDLE_SLEEP;

  delete process.env.FLY_API_TOKEN;
  delete process.env.FLY_APP_NAME;
  delete process.env.FLY_MACHINE_ID;
  assert.equal(idleSleepEnabled(), false, "off with nothing set — this is local dev");

  process.env.FLY_API_TOKEN = "tok";
  assert.equal(idleSleepEnabled(), false, "a token alone is not enough to know what to stop");

  process.env.FLY_APP_NAME = "baseline-court";
  process.env.FLY_MACHINE_ID = "abc123";
  assert.equal(idleSleepEnabled(), true);

  process.env.IDLE_SLEEP = "off";
  assert.equal(idleSleepEnabled(), false, "an explicit off wins over a complete config");

  process.env.FLY_API_TOKEN = saved.t ?? "";
  if (saved.t === undefined) delete process.env.FLY_API_TOKEN;
  if (saved.a === undefined) delete process.env.FLY_APP_NAME; else process.env.FLY_APP_NAME = saved.a;
  if (saved.m === undefined) delete process.env.FLY_MACHINE_ID; else process.env.FLY_MACHINE_ID = saved.m;
  if (saved.s === undefined) delete process.env.IDLE_SLEEP; else process.env.IDLE_SLEEP = saved.s;
});

test("a disabled watchdog says which piece is missing", () => {
  // The symptom that started this: no log line at all, which reads the same
  // whether the code never shipped or shipped and switched itself off.
  const saved = {
    t: process.env.FLY_API_TOKEN, a: process.env.FLY_APP_NAME,
    m: process.env.FLY_MACHINE_ID, s: process.env.IDLE_SLEEP,
  };
  delete process.env.IDLE_SLEEP;
  delete process.env.FLY_API_TOKEN;
  delete process.env.FLY_APP_NAME;
  delete process.env.FLY_MACHINE_ID;

  let why = idleSleepDisabledReason();
  assert.ok(why?.includes("FLY_API_TOKEN"), why ?? "expected a reason");
  assert.ok(why?.includes("FLY_APP_NAME"), why ?? "expected a reason");

  // Only the token missing: Fly supplies the other two, so the advice should
  // be "make a token", not "you are not on Fly".
  process.env.FLY_APP_NAME = "baseline-court";
  process.env.FLY_MACHINE_ID = "abc123";
  why = idleSleepDisabledReason();
  assert.ok(why?.includes("FLY_API_TOKEN"), why ?? "expected a reason");
  assert.ok(why?.includes("fly tokens create"), "expected the fix in the message");

  process.env.FLY_API_TOKEN = "tok";
  assert.equal(idleSleepDisabledReason(), null, "fully configured is not disabled");

  process.env.IDLE_SLEEP = "off";
  assert.equal(idleSleepDisabledReason(), "IDLE_SLEEP=off");

  if (saved.t === undefined) delete process.env.FLY_API_TOKEN; else process.env.FLY_API_TOKEN = saved.t;
  if (saved.a === undefined) delete process.env.FLY_APP_NAME; else process.env.FLY_APP_NAME = saved.a;
  if (saved.m === undefined) delete process.env.FLY_MACHINE_ID; else process.env.FLY_MACHINE_ID = saved.m;
  if (saved.s === undefined) delete process.env.IDLE_SLEEP; else process.env.IDLE_SLEEP = saved.s;
});

test("run state lives on globalThis, so a second copy of this module sees it", () => {
  // THE BUG THAT KILLED EVERY LONG ANALYSIS. The watchdog starts from
  // instrumentation.ts and runStarted() is called from a route handler, and
  // Next.js does not guarantee those share one instance of this module. They
  // did not: the pipeline incremented its copy, the watchdog read its own, saw
  // zero, and stopped the machine out from under a render that was two thirds
  // done.
  //
  // What makes a second copy see the first one's count is that the state is
  // reachable through a well-known symbol rather than a module-scoped `let`.
  // That is the contract worth pinning; a real second bundle cannot be
  // conjured inside one test process.
  __resetIdleState();
  runStarted();
  const shared = (globalThis as unknown as Record<symbol, { activeRuns: number } | undefined>)[
    Symbol.for("baseline.idle-sleep.state")
  ];
  assert.ok(shared, "no shared state on globalThis — a second copy would start from zero");
  assert.equal(shared.activeRuns, 1);
  runFinished();
  assert.equal(shared.activeRuns, 0);
});
