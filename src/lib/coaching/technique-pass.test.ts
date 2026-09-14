import { test } from "node:test";
import assert from "node:assert/strict";
import { burstWindows, LEAD_S, TRAIL_S, MERGE_GAP_S } from "./technique-pass";

test("a window contains its own shot, with the lead-in before it", () => {
  const [w] = burstWindows([40], 120);
  assert.ok(w.startSeconds < 40, "no lead-in: the backswing would be cut off");
  assert.ok(w.endSeconds > 40, "no follow-through");
  assert.ok(Math.abs(w.startSeconds - (40 - LEAD_S)) < 0.01);
  assert.ok(Math.abs(w.endSeconds - (40 + TRAIL_S)) < 0.01);
});

test("shots in the same rally merge into one burst", () => {
  // Three contacts two seconds apart is one exchange, not three requests.
  const got = burstWindows([20, 22, 24], 120);
  assert.equal(got.length, 1);
  assert.ok(got[0].startSeconds < 20 && got[0].endSeconds > 24);
});

test("shots far apart stay separate rather than bridging dead time", () => {
  const got = burstWindows([10, 90], 120);
  assert.equal(got.length, 2);
});

test("the merge gap is the boundary, and either side of it behaves", () => {
  const near = burstWindows([10, 10 + TRAIL_S + MERGE_GAP_S - 0.5], 120);
  const far = burstWindows([10, 10 + TRAIL_S + MERGE_GAP_S + LEAD_S + 2], 120);
  assert.equal(near.length, 1);
  assert.equal(far.length, 2);
});

test("windows never overlap and never run past the clip", () => {
  const got = burstWindows([0, 1, 30, 31, 119.9], 120);
  for (let i = 0; i < got.length; i++) {
    assert.ok(got[i].startSeconds >= 0);
    assert.ok(got[i].endSeconds <= 120);
    assert.ok(got[i].endSeconds > got[i].startSeconds);
    if (i > 0) assert.ok(got[i].startSeconds >= got[i - 1].endSeconds, "windows overlap — billed twice");
  }
});

test("over the cap, the busiest windows win — not an even spread", () => {
  // Four contacts together are worth four times one stray shot, and an even
  // spread would have kept the stray one.
  const busy = [100, 102, 104, 106];
  const strays = [10, 30, 50, 70, 90];
  const got = burstWindows([...strays, ...busy], 200, 2);
  assert.equal(got.length, 2);
  assert.ok(
    got.some((w) => w.startSeconds <= 100 && w.endSeconds >= 106),
    "the busiest window was dropped"
  );
});

test("no shots means no bursts, and no cost", () => {
  assert.deepEqual(burstWindows([], 120), []);
});

test("times outside the clip are dropped rather than clamped", () => {
  const got = burstWindows([-5, 9999, 60], 120);
  assert.equal(got.length, 1);
  assert.ok(got[0].startSeconds < 60 && got[0].endSeconds > 60);
});

test("a shot at the very start still gets a window inside the clip", () => {
  const [w] = burstWindows([0.1], 120);
  assert.equal(w.startSeconds, 0);
  assert.ok(w.endSeconds > 0.1);
});

test("the bursts cost a small fraction of the clip", () => {
  // The whole point: fifteen shots across a 20-minute match should be tens of
  // seconds of high-resolution video, not twenty minutes of it.
  const shots = Array.from({ length: 15 }, (_, i) => 40 + i * 37);
  const got = burstWindows(shots, 1200);
  const watched = got.reduce((s, w) => s + (w.endSeconds - w.startSeconds), 0);
  assert.ok(watched < 120, `${watched}s of 1200s is not a saving`);
});
