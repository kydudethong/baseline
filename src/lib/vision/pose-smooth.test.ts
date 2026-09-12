import assert from "node:assert/strict";
import { test } from "node:test";

import { smoothPoseFrames } from "./pose-smooth";
import type { PlayerPoseFrame, PoseKeypoint } from "./phase2-types";

const kp = (x: number | null, y: number | null, c = 0.9): PoseKeypoint =>
  ({ name: "right_wrist", xNorm: x, yNorm: y, confidence: c });

const frame = (t: number, k: PoseKeypoint, playerId = "p1"): PlayerPoseFrame => ({
  playerId, timestampSeconds: t, detectionConfidence: 0.9,
  keypoints: [k], modelSource: "yolov8n-pose",
});

const wristOf = (f: PlayerPoseFrame) => f.keypoints[0];

test("a single bad frame inside a burst is discarded", () => {
  // 30fps burst: a wrist travelling smoothly, with one frame flung away.
  const out = smoothPoseFrames([
    frame(0.00, kp(0.50, 0.50)),
    frame(0.033, kp(0.52, 0.50)),
    frame(0.066, kp(0.90, 0.10)), // the glitch
    frame(0.099, kp(0.56, 0.50)),
    frame(0.132, kp(0.58, 0.50)),
  ]);
  const glitch = out.find((f) => Math.abs(f.timestampSeconds - 0.066) < 1e-9)!;
  assert.equal(wristOf(glitch).xNorm, 0.56, "x should take the median, not the outlier");
  assert.equal(wristOf(glitch).yNorm, 0.50, "y should take the median, not the outlier");
});

test("real motion inside a burst is preserved, not flattened", () => {
  // A wrist moving steadily is already its own median at every step.
  const xs = [0.10, 0.20, 0.30, 0.40, 0.50];
  const out = smoothPoseFrames(xs.map((x, i) => frame(i * 0.033, kp(x, 0.5))));
  const got = out.map((f) => wristOf(f).xNorm);
  assert.deepEqual(got, xs);
});

test("the 5fps baseline is left alone — 200ms apart is not a neighbour", () => {
  // Smoothing across these would erase a swing rather than denoise it: a real
  // swing happens BETWEEN two baseline samples.
  const out = smoothPoseFrames([
    frame(0.0, kp(0.50, 0.50)),
    frame(0.2, kp(0.90, 0.10)),
    frame(0.4, kp(0.52, 0.50)),
  ]);
  const mid = out.find((f) => Math.abs(f.timestampSeconds - 0.2) < 1e-9)!;
  assert.equal(wristOf(mid).xNorm, 0.90, "untouched");
  assert.equal(wristOf(mid).yNorm, 0.10, "untouched");
});

test("edge frames pass through untouched", () => {
  const out = smoothPoseFrames([
    frame(0.0, kp(0.90, 0.10)),
    frame(0.033, kp(0.50, 0.50)),
    frame(0.066, kp(0.52, 0.50)),
  ]);
  const first = out[0];
  assert.equal(wristOf(first).xNorm, 0.90, "nothing before it to vote");
});

test("a low-confidence neighbour does not get a vote", () => {
  const out = smoothPoseFrames([
    frame(0.00, kp(0.10, 0.10, 0.05)), // model says it does not know
    frame(0.033, kp(0.50, 0.50)),
    frame(0.066, kp(0.52, 0.50)),
  ]);
  const mid = out.find((f) => Math.abs(f.timestampSeconds - 0.033) < 1e-9)!;
  assert.equal(wristOf(mid).xNorm, 0.50, "kept its own value");
});

test("a low-confidence keypoint is not smoothed into looking real", () => {
  const out = smoothPoseFrames([
    frame(0.00, kp(0.50, 0.50)),
    frame(0.033, kp(0.90, 0.10, 0.05)),
    frame(0.066, kp(0.52, 0.50)),
  ]);
  const mid = out.find((f) => Math.abs(f.timestampSeconds - 0.033) < 1e-9)!;
  assert.equal(wristOf(mid).confidence, 0.05);
  assert.equal(wristOf(mid).xNorm, 0.90, "left as the model reported it");
});

test("null coordinates survive", () => {
  const out = smoothPoseFrames([
    frame(0.00, kp(0.50, 0.50)),
    frame(0.033, kp(null, null)),
    frame(0.066, kp(0.52, 0.50)),
  ]);
  const mid = out.find((f) => Math.abs(f.timestampSeconds - 0.033) < 1e-9)!;
  assert.equal(wristOf(mid).xNorm, null);
});

test("players never smooth each other", () => {
  // Interleaved in time, so a player-blind implementation would mix them.
  const out = smoothPoseFrames([
    frame(0.00, kp(0.10, 0.10), "p1"),
    frame(0.01, kp(0.90, 0.90), "p2"),
    frame(0.033, kp(0.12, 0.10), "p1"),
    frame(0.04, kp(0.92, 0.90), "p2"),
    frame(0.066, kp(0.14, 0.10), "p1"),
    frame(0.07, kp(0.94, 0.90), "p2"),
  ]);
  const p1mid = out.find((f) => f.playerId === "p1" && Math.abs(f.timestampSeconds - 0.033) < 1e-9)!;
  assert.equal(wristOf(p1mid).xNorm, 0.12, "p2's values must not reach p1");
});

test("input frames are not mutated", () => {
  const input = [
    frame(0.00, kp(0.50, 0.50)),
    frame(0.033, kp(0.90, 0.10)),
    frame(0.066, kp(0.52, 0.50)),
  ];
  smoothPoseFrames(input);
  assert.equal(wristOf(input[1]).xNorm, 0.90, "caller's array is untouched");
});

test("an empty list is fine", () => {
  assert.deepEqual(smoothPoseFrames([]), []);
});
