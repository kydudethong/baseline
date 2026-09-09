import test from "node:test";
import assert from "node:assert/strict";
import { paddleFromPose, paddlesFromPoses, PADDLE_LENGTHS_FROM_WRIST, ESTIMATE_MAX_CONFIDENCE } from "./paddle-from-pose";
import type { PlayerPoseFrame, CocoKeypointName } from "./phase2-types";

type P = [number, number] | null;

function pose(parts: Partial<Record<CocoKeypointName, P>>, t = 1.0, id = "p1"): PlayerPoseFrame {
  return {
    playerId: id,
    timestampSeconds: t,
    detectionConfidence: 0.9,
    modelSource: "yolov8n-pose",
    keypoints: Object.entries(parts).map(([name, v]) => ({
      name: name as CocoKeypointName,
      xNorm: v ? v[0] : null,
      yNorm: v ? v[1] : null,
      confidence: v ? 0.9 : 0.0,
    })),
  };
}

/** Shoulders 0.1 apart; right arm extended to the right, forearm horizontal. */
const SWINGING = {
  left_shoulder: [0.50, 0.40] as P,
  right_shoulder: [0.60, 0.40] as P,
  right_elbow: [0.68, 0.45] as P,
  right_wrist: [0.76, 0.45] as P,
  left_elbow: [0.52, 0.46] as P,
  left_wrist: [0.54, 0.50] as P,
};

test("the paddle sits one paddle length past the wrist, along the forearm", () => {
  const p = paddleFromPose(pose(SWINGING))!;
  assert.ok(p, "should produce an estimate");
  // Forearm points +x; shoulder width 0.1; one paddle length = 1.0 shoulder
  // widths, so the marker lands 0.1 beyond the wrist.
  assert.ok(Math.abs(p.x - (0.76 + 0.10)) < 1e-3, `x was ${p.x}`);
  assert.ok(Math.abs(p.y - 0.45) < 1e-3, `y was ${p.y}`);
});

test("the offset scales with the player, not with pixels", () => {
  // Same pose, far player: everything half the size. The paddle must land
  // half as far past the wrist, or the far player's paddle is placed off court.
  const near = paddleFromPose(pose(SWINGING))!;
  const far = paddleFromPose(pose({
    left_shoulder: [0.50, 0.40], right_shoulder: [0.55, 0.40],
    right_elbow: [0.59, 0.42], right_wrist: [0.63, 0.42],
  }))!;
  const nearOffset = near.x - 0.76;
  const farOffset = far.x - 0.63;
  assert.ok(Math.abs(nearOffset / farOffset - 2) < 0.05,
    `near offset ${nearOffset} should be ~2x far offset ${farOffset}`);
});

test("it picks the extended arm, not the tucked one", () => {
  const p = paddleFromPose(pose(SWINGING))!;
  // The right wrist is far from body centre (0.55); the left is close.
  // A paddle derived from the LEFT arm would land left of centre.
  assert.ok(p.x > 0.6, `estimate at ${p.x} should be on the extended (right) side`);
});

test("two arms equally extended is a stance, and gets no estimate", () => {
  // Refusing beats guessing: the wrong arm puts the paddle on the wrong side
  // of the body, which is worse for attribution than having nothing.
  const p = paddleFromPose(pose({
    left_shoulder: [0.50, 0.40], right_shoulder: [0.60, 0.40],
    left_elbow: [0.46, 0.46], left_wrist: [0.42, 0.50],
    right_elbow: [0.64, 0.46], right_wrist: [0.68, 0.50],
  }));
  assert.equal(p, null);
});

test("a missing elbow means no direction, so no estimate", () => {
  const p = paddleFromPose(pose({
    left_shoulder: [0.50, 0.40], right_shoulder: [0.60, 0.40],
    right_wrist: [0.76, 0.45],
  }));
  assert.equal(p, null);
});

test("low-confidence keypoints are ignored, not used", () => {
  const f = pose(SWINGING);
  for (const k of f.keypoints) if (k.name === "right_elbow") k.confidence = 0.05;
  assert.equal(paddleFromPose(f), null);
});

test("missing shoulders means no scale, so no estimate", () => {
  const p = paddleFromPose(pose({
    right_elbow: [0.68, 0.45], right_wrist: [0.76, 0.45],
  }));
  assert.equal(p, null);
});

test("elbow and wrist on the same point is a pose failure, not a paddle", () => {
  const p = paddleFromPose(pose({
    left_shoulder: [0.50, 0.40], right_shoulder: [0.60, 0.40],
    right_elbow: [0.76, 0.45], right_wrist: [0.76, 0.45],
  }));
  assert.equal(p, null);
});

test("an arm pointing out of frame yields nothing usable", () => {
  const p = paddleFromPose(pose({
    left_shoulder: [0.88, 0.40], right_shoulder: [0.98, 0.40],
    right_elbow: [0.99, 0.42], right_wrist: [0.999, 0.42],
  }));
  assert.equal(p, null, "a position outside the image helps nobody");
});

test("confidence is capped below a real detection's", () => {
  const p = paddleFromPose(pose(SWINGING))!;
  assert.equal(p.confidence, ESTIMATE_MAX_CONFIDENCE);
  assert.ok(p.confidence < 0.5, "an inference must not outrank a measurement");
});

test("the box is sized to the player so the overlay is honest", () => {
  const p = paddleFromPose(pose(SWINGING))!;
  assert.ok(Math.abs(p.w! - 0.05) < 1e-3, `w was ${p.w}`);   // 0.1 * 0.5
});

test("a longer paddle pushes the marker further out", () => {
  const short = paddleFromPose(pose(SWINGING), 0.3)!;
  const long = paddleFromPose(pose(SWINGING), 1.0)!;
  assert.ok(long.x > short.x);
});

test("batch keeps only frames that produced something, in time order", () => {
  const ok1 = pose(SWINGING, 2.0);
  const bad = pose({ left_shoulder: [0.5, 0.4] }, 1.0);
  const ok2 = pose(SWINGING, 0.5);
  const out = paddlesFromPoses([ok1, bad, ok2]);
  assert.equal(out.length, 2, "the unusable frame contributes nothing");
  assert.deepEqual(out.map((p) => p.t), [0.5, 2.0]);
});

test("the offset is one paddle length, derived from two real measurements", () => {
  // A ~40cm paddle over a ~40cm shoulder width is 1.0. If someone changes this,
  // the new number should still be traceable to lengths that exist.
  assert.equal(PADDLE_LENGTHS_FROM_WRIST, 1.0);
});

/* ---- the in-image angle ---------------------------------------------- */

test("the angle follows the forearm, not the frame", () => {
  // Forearm pointing +x (right): 0 degrees.
  const right = paddleFromPose(pose({
    left_shoulder: [0.50, 0.40], right_shoulder: [0.60, 0.40],
    right_elbow: [0.68, 0.45], right_wrist: [0.76, 0.45],
  }))!;
  assert.ok(Math.abs(right.angleDeg!) < 0.5, `expected ~0, got ${right.angleDeg}`);

  // Forearm pointing straight DOWN the image (+y): +90, since y grows down.
  const down = paddleFromPose(pose({
    left_shoulder: [0.50, 0.40], right_shoulder: [0.60, 0.40],
    right_elbow: [0.72, 0.40], right_wrist: [0.72, 0.50],
  }))!;
  assert.ok(Math.abs(down.angleDeg! - 90) < 0.5, `expected ~90, got ${down.angleDeg}`);
});

test("the angle and the position agree — both come off the same vector", () => {
  const p = paddleFromPose(pose({
    left_shoulder: [0.40, 0.40], right_shoulder: [0.50, 0.40],
    right_elbow: [0.55, 0.50], right_wrist: [0.62, 0.57],
  }))!;
  // Walking one paddle length from the wrist along the reported angle must
  // land on the reported position, or the overlay would draw a paddle
  // pointing somewhere other than where it says the paddle is.
  const rad = (p.angleDeg! * Math.PI) / 180;
  const sw = 0.10;
  assert.ok(Math.abs((0.62 + Math.cos(rad) * sw) - p.x) < 1e-3, `x mismatch: ${p.x}`);
  assert.ok(Math.abs((0.57 + Math.sin(rad) * sw) - p.y) < 1e-3, `y mismatch: ${p.y}`);
});

test("the angle is the long axis only — it says nothing about the face", () => {
  // Two poses with the same forearm direction but which would have opposite
  // face angles in reality (wrist rolled). Pose cannot tell them apart, and
  // this test exists so nobody later reads angleDeg as a face angle.
  const a = paddleFromPose(pose({
    left_shoulder: [0.50, 0.40], right_shoulder: [0.60, 0.40],
    right_elbow: [0.68, 0.45], right_wrist: [0.76, 0.45],
  }))!;
  const b = paddleFromPose(pose({
    left_shoulder: [0.50, 0.40], right_shoulder: [0.60, 0.40],
    right_elbow: [0.68, 0.45], right_wrist: [0.76, 0.45],
  }))!;
  assert.equal(a.angleDeg, b.angleDeg,
    "identical arms give identical angles regardless of wrist roll — that is the limit");
});
