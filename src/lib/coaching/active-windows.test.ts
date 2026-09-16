import { test } from "node:test";
import assert from "node:assert/strict";
import { activeWindows, MIN_COVERAGE, MIN_WINDOW_S } from "./active-windows";

/** A track that moves fast during `bursts` and sits still the rest of the time. */
function track(durationSeconds: number, bursts: Array<[number, number]>, hz = 5) {
  const out = [];
  let x = 0;
  for (let t = 0; t <= durationSeconds; t += 1 / hz) {
    const moving = bursts.some(([a, b]) => t >= a && t <= b);
    x += moving ? 1 : 0.001;
    out.push({ timestampSeconds: Math.round(t * 100) / 100, x, y: 0 });
  }
  return out;
}

test("dead time is skipped and play is kept", () => {
  const got = activeWindows([track(120, [[10, 25], [70, 90]])], 120);
  assert.ok(got.gated, "should have gated");
  assert.ok(got.coverage < 0.7, `coverage was ${got.coverage}, so little was skipped`);
  // Both bursts are covered.
  for (const t of [15, 20, 80, 85]) {
    assert.ok(got.windows.some((w) => t >= w.startSeconds && t <= w.endSeconds), `${t}s was dropped`);
  }
});

test("a window starts BEFORE the movement, so the serve is in frame", () => {
  const got = activeWindows([track(120, [[40, 60]])], 120);
  const w = got.windows.find((x) => x.endSeconds > 40)!;
  assert.ok(w.startSeconds < 40, "no lead-in: the serve would be cut off");
});

test("bursts close together are merged rather than left as slivers", () => {
  const got = activeWindows([track(120, [[20, 26], [28, 34]])], 120);
  const covering = got.windows.filter((w) => w.endSeconds > 18 && w.startSeconds < 36);
  assert.equal(covering.length, 1, "a 2s gap should not split a window");
});

test("the fastest player decides, not the average", () => {
  // One player sprints, three stand still. That is a rally.
  const still = track(120, []);
  const got = activeWindows([track(120, [[50, 70]]), still, still, still], 120);
  assert.ok(got.windows.some((w) => w.startSeconds < 60 && w.endSeconds > 60));
});

test("too few samples to judge means analyse everything", () => {
  const got = activeWindows([[{ timestampSeconds: 1, x: 0, y: 0 }]], 120);
  assert.equal(got.gated, false);
  assert.deepEqual(got.windows, [{ startSeconds: 0, endSeconds: 120 }]);
});

test("no tracks at all means analyse everything, not nothing", () => {
  // The dangerous failure: tracking died, motion looks like zero, and the pass
  // quietly analyses nothing while reporting confidently.
  const got = activeWindows([], 120);
  assert.equal(got.gated, false);
  assert.equal(got.windows.length, 1);
  assert.equal(got.windows[0].endSeconds, 120);
});

test("gating that would cut below the coverage floor is refused", () => {
  // A clip where almost nothing moves: gating would keep a few seconds of a
  // long clip, which is far more likely to be broken tracking than a real game.
  const got = activeWindows([track(600, [[100, 103]])], 600);
  assert.equal(got.gated, false, "should have refused to gate");
  assert.ok(got.coverage >= MIN_COVERAGE);
});

test("windows are in order, never overlap, and stay inside the clip", () => {
  const got = activeWindows([track(300, [[10, 20], [100, 130], [250, 280]])], 300);
  for (let i = 0; i < got.windows.length; i++) {
    const w = got.windows[i];
    assert.ok(w.endSeconds > w.startSeconds);
    assert.ok(w.startSeconds >= 0 && w.endSeconds <= 300);
    assert.ok(w.endSeconds - w.startSeconds >= MIN_WINDOW_S);
    if (i > 0) assert.ok(w.startSeconds >= got.windows[i - 1].endSeconds, "windows overlap");
  }
});

test("a clip with no duration plans nothing rather than dividing by zero", () => {
  assert.deepEqual(activeWindows([track(10, [[1, 2]])], 0).windows, []);
  assert.deepEqual(activeWindows([], NaN).windows, []);
});

test("constant motion throughout keeps the whole clip", () => {
  const got = activeWindows([track(120, [[0, 120]])], 120);
  const covered = got.windows.reduce((s, w) => s + (w.endSeconds - w.startSeconds), 0);
  assert.ok(covered > 110, `only ${covered}s of 120s kept when everything was busy`);
});

test("a dink rally is not split in half by its own quiet middle", () => {
  // THE FAILURE THIS PINS. A point where both pairs drive, then settle into a
  // five-second kitchen exchange where nobody's FEET move, then a speed-up to
  // finish. The exchange is the rally -- it is where the point is decided --
  // and a gap threshold shorter than the lull cuts it out and leaves two
  // windows with the important part missing between them.
  const got = activeWindows([track(120, [[40, 46], [51, 57]])], 120);
  for (const t of [41, 45, 48, 50, 53, 56]) {
    assert.ok(
      got.windows.some((w) => t >= w.startSeconds && t <= w.endSeconds),
      `${t}s was dropped — the quiet middle of the rally was cut out`
    );
  }
  const holding = got.windows.filter((w) => w.endSeconds > 40 && w.startSeconds < 57);
  assert.equal(holding.length, 1, `the rally was split across ${holding.length} windows`);
});

test("real dead time is still skipped, so the merge gap did not disable gating", () => {
  // The guard on the test above: a gap wide enough to keep a dink rally whole
  // must not be so wide that a minute of standing about also survives.
  //
  // Enough play to clear MIN_COVERAGE, or the function refuses to gate at all
  // and the assertion below passes for the wrong reason.
  const got = activeWindows([track(200, [[10, 40], [60, 90], [150, 180]])], 200);
  assert.ok(got.gated, "should still gate");
  assert.ok(
    got.windows.every((w) => !(w.startSeconds < 100 && w.endSeconds > 100)),
    "the two-minute gap between points was not skipped"
  );
});
