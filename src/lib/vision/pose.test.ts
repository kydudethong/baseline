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

test("there is no cap by default, because pose is the detector now", () => {
  // Capping this pass used to thin out skeletons on a long clip, which was a
  // fair trade. It would now thin out TRACKING -- a player sampled twice a
  // second instead of five times is a player the tracker loses at every
  // occlusion. The lever for a run that is too heavy is VISION_FPS.
  assert.equal(POSE_MAX_FRAMES, 0);
  assert.equal(poseMaxFrames(), 0);
});
