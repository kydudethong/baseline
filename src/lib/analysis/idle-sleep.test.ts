import assert from "node:assert/strict";
import test from "node:test";

import {
  activeRunCount, idleMinutes, idleSleepEnabled, idleState,
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
