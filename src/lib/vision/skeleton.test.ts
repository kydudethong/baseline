import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleBones } from "./skeleton";

const kp = (name: string, x: number, y: number, confidence = 0.9) =>
  ({ name, xNorm: x, yNorm: y, confidence });

test("a keypoint outside the frame is not a keypoint", () => {
  // The symptom: grey lines running from every player's head off the top-left
  // corner of the picture. YOLO's pose head regresses coordinates without
  // clamping them, so a joint it is unsure about lands outside the image --
  // and its confidence is not always low enough to filter it out. Joined to a
  // real ear, that draws a limb across the whole frame.
  const bones = visibleBones([
    kp("left_ear", -0.4, -0.3),
    kp("left_eye", 0.51, 0.22),
    kp("nose", 0.5, 0.23),
    kp("right_eye", 0.49, 0.22),
    kp("right_ear", 0.47, 0.22),
  ]);
  assert.ok(bones.length > 0, "the in-frame head bones should still be drawn");
  for (const b of bones) {
    for (const [x, y] of [b.from, b.to]) {
      assert.ok(x >= -0.02 && x <= 1.02 && y >= -0.02 && y <= 1.02,
        `a bone reached ${x},${y} — outside the frame`);
    }
  }
});

test("a joint right at the edge is still a joint", () => {
  // The margin matters: a player at the side of the court genuinely has an arm
  // on the boundary, and rejecting those would thin out exactly the poses
  // worth looking at.
  const bones = visibleBones([
    kp("left_shoulder", 0.0, 0.4),
    kp("left_elbow", 0.01, 0.5),
    kp("left_wrist", 1.0, 0.6),
  ]);
  assert.equal(bones.length, 2, "edge joints should survive");
});

test("low confidence is still rejected, frame or no frame", () => {
  const bones = visibleBones([
    kp("left_shoulder", 0.5, 0.4, 0.9),
    kp("left_elbow", 0.5, 0.5, 0.1),
  ]);
  assert.equal(bones.length, 0);
});
