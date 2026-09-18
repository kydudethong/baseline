import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSignatureFrom, buildDistance, blendBuild } from "./build-signature";
import type { CocoKeypointName, PoseKeypoint } from "./phase2-types";

/** A standing figure, in normalised image coordinates. */
function figure(o: {
  shoulderY?: number; hipY?: number; ankleY?: number;
  shoulderHalfWidth?: number; noseY?: number; conf?: number; missing?: CocoKeypointName[];
} = {}): PoseKeypoint[] {
  const { shoulderY = 0.40, hipY = 0.58, ankleY = 0.92, shoulderHalfWidth = 0.035,
          noseY = 0.33, conf = 0.9, missing = [] } = o;
  const kp = (name: CocoKeypointName, x: number, y: number): PoseKeypoint =>
    ({ name, xNorm: x, yNorm: y, confidence: conf });
  return [
    kp("nose", 0.5, noseY),
    kp("left_shoulder", 0.5 - shoulderHalfWidth, shoulderY),
    kp("right_shoulder", 0.5 + shoulderHalfWidth, shoulderY),
    kp("left_hip", 0.5 - 0.02, hipY), kp("right_hip", 0.5 + 0.02, hipY),
    kp("left_ankle", 0.5 - 0.02, ankleY), kp("right_ankle", 0.5 + 0.02, ankleY),
  ].filter((k) => !missing.includes(k.name));
}

test("a broad short player and a narrow tall one are measurably different", () => {
  // THE WHOLE POINT. Two partners in matching kit are nearly invisible to a
  // colour signature. They are rarely the same proportions, and no shirt
  // changes that.
  const broad = buildSignatureFrom(figure({ shoulderHalfWidth: 0.055, hipY: 0.54 }))!;
  const narrow = buildSignatureFrom(figure({ shoulderHalfWidth: 0.025, hipY: 0.62 }))!;
  assert.ok(broad && narrow);
  assert.ok(buildDistance(broad, narrow) > 0.35,
    `two clearly different builds read as only ${buildDistance(broad, narrow).toFixed(2)} apart`);
});

test("the same player at two instants reads as the same build", () => {
  // Ratios, not pixels: the far player is a third the size of the near one on
  // screen and must not therefore be a different person.
  const near = buildSignatureFrom(figure({ shoulderY: 0.40, hipY: 0.58, ankleY: 0.92 }))!;
  const far = buildSignatureFrom(figure({
    shoulderY: 0.30, hipY: 0.36, ankleY: 0.475, shoulderHalfWidth: 0.0117, noseY: 0.277,
  }))!;
  assert.ok(near && far);
  assert.ok(buildDistance(near, far) < 0.15,
    `the same proportions at two distances read as ${buildDistance(near, far).toFixed(2)} apart`);
});

test("a body the model barely saw produces no reading at all", () => {
  // A GUESSED HIP MOVES A RATIO, and the ratio is being used to decide who
  // somebody is — so low confidence has to mean "no answer", not "an answer
  // built on a guess".
  assert.equal(buildSignatureFrom(figure({ conf: 0.2 })), null);
  assert.equal(buildSignatureFrom(figure({ missing: ["left_hip", "right_hip"] })), null);
});

test("one shoulder is not a width", () => {
  // Falling back to a midpoint that IS one of the two shoulders would measure
  // zero width and file a confident, meaningless 0.0 ratio.
  assert.equal(buildSignatureFrom(figure({ missing: ["left_shoulder"] })), null);
});

test("a player too far away to measure is skipped rather than guessed at", () => {
  // At the far baseline the joints are a few pixels apart and the ratios are
  // mostly quantisation noise — which matters precisely because the far pair
  // are the small ones.
  const tiny = buildSignatureFrom(figure({ shoulderY: 0.300, hipY: 0.315, ankleY: 0.345, shoulderHalfWidth: 0.004 }));
  assert.equal(tiny, null);
});

test("two skeletons merged into one are refused, not averaged in", () => {
  // During an overlap the model sometimes joins two people's joints into one
  // figure. That produces a body no human has, and one such reading dragged
  // into a running average is worse than none.
  const merged = buildSignatureFrom(figure({ shoulderHalfWidth: 0.30 }));
  assert.equal(merged, null, "a 8-shoulder-widths-wide torso was accepted as a build");
});

test("legs hidden behind the net means no reading, not a wrong one", () => {
  assert.equal(buildSignatureFrom(figure({ missing: ["left_ankle", "right_ankle"] })), null);
});

test("the running mean moves toward new readings without being ruled by one", () => {
  const a = buildSignatureFrom(figure({ shoulderHalfWidth: 0.030 }))!;
  const lunge = buildSignatureFrom(figure({ shoulderHalfWidth: 0.050 }))!;
  const after = blendBuild(a, lunge, 0.1);
  assert.ok(after.shoulderToTorso > a.shoulderToTorso, "it did not move at all");
  assert.ok(buildDistance(after, a) < buildDistance(after, lunge),
    "one odd frame pulled the average more than halfway");
});
