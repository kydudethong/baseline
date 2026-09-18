import { test } from "node:test";
import assert from "node:assert/strict";
import { imageScale, scaleBox, scalePoint } from "./image-space";

test("a 1280-wide measurement is stretched onto a 1920-wide video", () => {
  // THE BUG THIS EXISTS FOR, reported twice: marks drawn at two-thirds of
  // their real position, bunched toward the top-left, which reads as random
  // placement rather than as a scaling error.
  const s = imageScale([1280, 720], 1920, 1080);
  assert.deepEqual(s, { sx: 1.5, sy: 1.5 });
  assert.deepEqual(scaleBox([100, 200, 140, 320], s), [150, 300, 210, 480]);
  assert.deepEqual(scalePoint([120, 240], s), [180, 360]);
});

test("an unknown size means 1:1, not a guess", () => {
  // On a fresh upload the video's true dimensions are still null and the
  // server falls back to its own frame, so the spaces already agree. Inventing
  // a ratio from a missing number would break the case that works.
  assert.deepEqual(imageScale(null, 1920, 1080), { sx: 1, sy: 1 });
  assert.deepEqual(imageScale([1280, 720], 0, 0), { sx: 1, sy: 1 });
  assert.deepEqual(imageScale([0, 0], 1920, 1080), { sx: 1, sy: 1 });
});

test("a non-square scale is applied per axis", () => {
  // A letterboxed or oddly-cropped source scales differently across than down,
  // and using one factor for both would shear every mark.
  const s = imageScale([1280, 960], 1920, 1080);
  assert.equal(s.sx, 1.5);
  assert.equal(s.sy, 1.125);
  assert.deepEqual(scalePoint([100, 100], s), [150, 112.5]);
});
