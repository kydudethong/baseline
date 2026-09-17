import { test } from "node:test";
import assert from "node:assert/strict";
import { pickReferenceFrame, boxesAtTimestamp } from "./reference-frame";

const box = (x: number) => ({ x, y: 0.6, width: 0.05, height: 0.2 });
const track = (label: string, times: number[], x = 0.4) => ({
  player_label: label,
  points: times.map((t) => ({ timestampSeconds: t, boxImageNorm: box(x) })),
});
const frames = (times: number[]) =>
  times.map((t) => ({ timestamp_s: t, debug_storage_path: `frames/${t}.jpg` }));

test("the frame with the most players wins, not the first or the middle", () => {
  // WHICH FRAME IS THE WHOLE POINT. One frame is shown, and a player hidden
  // behind their partner at that instant has no box, so they cannot be tagged
  // and the read has no subject at all.
  const got = pickReferenceFrame(frames([0, 1, 2, 3, 4]), [
    track("player_1", [0, 1, 2, 3, 4]),
    track("player_2", [0, 1, 2, 3, 4]),
    track("player_3", [3]),           // only visible at t=3
    track("player_4", [3]),
  ]);
  assert.equal(got?.frame.timestamp_s, 3);
  assert.equal(got?.boxes.length, 4);
});

test("ties break toward the middle of the clip, not toward the start", () => {
  // The ends are people walking on and warming up, where the four on court may
  // not be the four who play. Picking the first of an equal set would reliably
  // choose the warm-up.
  const got = pickReferenceFrame(frames([0, 1, 2, 3, 4]), [
    track("player_1", [0, 1, 2, 3, 4]),
    track("player_2", [0, 1, 2, 3, 4]),
  ]);
  assert.equal(got?.frame.timestamp_s, 2);
});

test("a frame with no rendered image is never chosen", () => {
  // A frame row without a debug image cannot be shown to anybody, so picking
  // it on player count would produce a tag screen with nothing on it.
  const withGaps = [
    { timestamp_s: 0, debug_storage_path: null },      // would win on count
    { timestamp_s: 1, debug_storage_path: "frames/1.jpg" },
  ];
  const got = pickReferenceFrame(withGaps, [
    track("player_1", [0, 1]), track("player_2", [0, 1]),
    track("player_3", [0]), track("player_4", [0]),
  ]);
  assert.equal(got?.frame.timestamp_s, 1);
});

test("a box is matched to the frame it belongs to, not the one next door", () => {
  // Tracks are sampled at 5fps, so points sit 0.2s apart. Matching loosely
  // would mark the subject where they were two frames ago — and on a still
  // whose only job is to say "this person", near is wrong.
  const at = boxesAtTimestamp([track("player_1", [1.0], 0.1), track("player_2", [1.2], 0.9)], 1.0);
  assert.deepEqual(at.map((b) => b.playerLabel), ["player_1"]);
  assert.equal(at[0].box.x, 0.1);
});

test("no frames is null; a frame with nobody on it is still a frame", () => {
  // The two cases are different and the callers treat them differently. No
  // rendered frame means the analysis has nothing to show and the coaching run
  // proceeds with no subject; a frame where the tracker found nobody is a real
  // frame that simply cannot be tagged, and saying so beats showing nothing.
  assert.equal(pickReferenceFrame([], [track("player_1", [0])]), null);
  const empty = pickReferenceFrame(frames([0]), []);
  assert.equal(empty?.frame.timestamp_s, 0);
  assert.equal(empty?.boxes.length, 0);
});
