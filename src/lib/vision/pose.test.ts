import { test } from "node:test";
import assert from "node:assert/strict";
import { poseMaxFrames, POSE_MAX_FRAMES } from "./pose";

test("the frame budget is overridable, and 0 means no cap", () => {
  const before = process.env.POSE_MAX_FRAMES;
  try {
    delete process.env.POSE_MAX_FRAMES;
    assert.equal(poseMaxFrames(), POSE_MAX_FRAMES);
    process.env.POSE_MAX_FRAMES = "500";
    assert.equal(poseMaxFrames(), 500);
    // A box that can afford the whole clip should be able to say so.
    process.env.POSE_MAX_FRAMES = "0";
    assert.equal(poseMaxFrames(), 0);
    // Nonsense falls back rather than disabling pose by accident.
    process.env.POSE_MAX_FRAMES = "nope";
    assert.equal(poseMaxFrames(), POSE_MAX_FRAMES);
  } finally {
    if (before === undefined) delete process.env.POSE_MAX_FRAMES;
    else process.env.POSE_MAX_FRAMES = before;
  }
});

test("the budget is large enough to cover a normal clip untouched", () => {
  // The failure this guards against is capping something that did not need it:
  // a 5-minute clip at VISION_FPS=5 is 1,500 frames, and those should all be
  // read. The cap is for the 14-minute case that was dying.
  assert.ok(POSE_MAX_FRAMES >= 1500, "a five-minute clip should not be sampled");
});
