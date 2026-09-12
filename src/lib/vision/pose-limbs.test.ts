import assert from "node:assert/strict";
import { test } from "node:test";

import { gateImplausibleLimbs } from "./pose-limbs";
import type { CocoKeypointName, PlayerPoseFrame, PoseKeypoint } from "./phase2-types";

const k = (name: CocoKeypointName, x: number | null, y: number | null, c = 0.9): PoseKeypoint =>
  ({ name, xNorm: x, yNorm: y, confidence: c });

/** An arm with a forearm of the given length, elbow at (0.5, 0.5). */
const armFrame = (t: number, forearm: number, playerId = "p1"): PlayerPoseFrame => ({
  playerId,
  timestampSeconds: t,
  detectionConfidence: 0.9,
  keypoints: [
    k("right_shoulder", 0.50, 0.40),
    k("right_elbow", 0.50, 0.50),
    k("right_wrist", 0.50 + forearm, 0.50),
  ],
  modelSource: "yolov8n-pose",
});

const wrist = (f: PlayerPoseFrame) => f.keypoints.find((x) => x.name === "right_wrist")!;

test("a wrist on the end of an impossible forearm is dropped", () => {
  // Ten normal frames establish the reference, then one with a 4x forearm.
  const frames = [
    ...Array.from({ length: 10 }, (_, i) => armFrame(i * 0.2, 0.10)),
    armFrame(2.0, 0.40),
  ];
  const { frames: out, stats } = gateImplausibleLimbs(frames);
  const bad = out.find((f) => f.timestampSeconds === 2.0)!;
  assert.equal(wrist(bad).xNorm, null);
  assert.equal(wrist(bad).confidence, 0);
  assert.equal(stats.dropped, 1);
});

test("a FORESHORTENED limb is kept — projection can only shorten", () => {
  // A forearm pointed at the camera is a few pixels long and entirely real.
  const frames = [
    ...Array.from({ length: 10 }, (_, i) => armFrame(i * 0.2, 0.10)),
    armFrame(2.0, 0.005),
  ];
  const { frames: out, stats } = gateImplausibleLimbs(frames);
  const short = out.find((f) => f.timestampSeconds === 2.0)!;
  assert.equal(wrist(short).xNorm, 0.505, "kept");
  assert.equal(stats.dropped, 0);
});

test("normal variation is not dropped", () => {
  const lengths = [0.10, 0.11, 0.09, 0.12, 0.10, 0.13, 0.10, 0.11, 0.12, 0.09];
  const { stats } = gateImplausibleLimbs(lengths.map((l, i) => armFrame(i * 0.2, l)));
  assert.equal(stats.dropped, 0);
});

test("works the same at 5fps as at 30fps — it never looks at time", () => {
  const slow = [...Array.from({ length: 10 }, (_, i) => armFrame(i * 0.2, 0.10)), armFrame(2.0, 0.40)];
  const fast = [...Array.from({ length: 10 }, (_, i) => armFrame(i * 0.033, 0.10)), armFrame(0.4, 0.40)];
  assert.equal(gateImplausibleLimbs(slow).stats.dropped, 1);
  assert.equal(gateImplausibleLimbs(fast).stats.dropped, 1);
});

test("too few observations means no judgement, not a guess", () => {
  const { stats, frames: out } = gateImplausibleLimbs([armFrame(0, 0.10), armFrame(0.2, 0.90)]);
  assert.equal(stats.dropped, 0, "cannot judge on 2 samples");
  assert.ok(stats.unmeasured > 0);
  assert.equal(wrist(out[1]).xNorm, 1.40, "left exactly as the model reported it");
});

test("one bad frame cannot inflate the budget that would excuse it", () => {
  // The reference is a percentile, not the max: a single huge frame must not
  // raise the bar high enough to make itself legal.
  const frames = [
    ...Array.from({ length: 20 }, (_, i) => armFrame(i * 0.2, 0.10)),
    armFrame(4.0, 0.60),
  ];
  assert.equal(gateImplausibleLimbs(frames).stats.dropped, 1);
});

test("players are measured separately", () => {
  // p2 is twice the size of p1 — a p2 forearm must not be judged against p1.
  const frames = [
    ...Array.from({ length: 10 }, (_, i) => armFrame(i * 0.2, 0.10, "p1")),
    ...Array.from({ length: 10 }, (_, i) => armFrame(i * 0.2, 0.20, "p2")),
  ];
  assert.equal(gateImplausibleLimbs(frames).stats.dropped, 0);
});

test("the proximal joint survives; only the distal one is disbelieved", () => {
  const frames = [
    ...Array.from({ length: 10 }, (_, i) => armFrame(i * 0.2, 0.10)),
    armFrame(2.0, 0.40),
  ];
  const bad = gateImplausibleLimbs(frames).frames.find((f) => f.timestampSeconds === 2.0)!;
  const elbow = bad.keypoints.find((x) => x.name === "right_elbow")!;
  assert.equal(elbow.xNorm, 0.50, "the elbow was never in question");
});

test("input is not mutated", () => {
  const frames = [
    ...Array.from({ length: 10 }, (_, i) => armFrame(i * 0.2, 0.10)),
    armFrame(2.0, 0.40),
  ];
  gateImplausibleLimbs(frames);
  assert.equal(wrist(frames[10]).xNorm, 0.90, "caller's frames untouched");
});
