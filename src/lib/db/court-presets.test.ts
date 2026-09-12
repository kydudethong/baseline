import assert from "node:assert/strict";
import { test } from "node:test";

import { isCourtCorners, scaleCorners, type CourtCorners } from "./court-presets";

const CORNERS: CourtCorners = {
  nearLeft: [100, 200],
  farLeft: [500, 200],
  nearRight: [40, 600],
  farRight: [560, 600],
};

test("scaling to the same size is the identity", () => {
  const out = scaleCorners(CORNERS, { width: 640, height: 720 }, { width: 640, height: 720 });
  assert.deepEqual(out, CORNERS);
});

test("a uniform resize scales both axes together", () => {
  const out = scaleCorners(CORNERS, { width: 640, height: 720 }, { width: 1280, height: 1440 });
  assert.deepEqual(out!.nearLeft, [200, 400]);
  assert.deepEqual(out!.farRight, [1120, 1200]);
});

test("axes scale INDEPENDENTLY when the aspect ratio changes", () => {
  // The case a single uniform scale factor would get wrong: x doubles while y
  // is unchanged. Corners are four samples of where things are in an image,
  // not a rigid shape being placed into a frame.
  const out = scaleCorners(CORNERS, { width: 640, height: 720 }, { width: 1280, height: 720 });
  assert.deepEqual(out!.nearLeft, [200, 200]);
  assert.deepEqual(out!.farRight, [1120, 600]);
});

test("results are whole pixels", () => {
  const out = scaleCorners(CORNERS, { width: 640, height: 720 }, { width: 1000, height: 1000 });
  for (const p of Object.values(out!)) {
    for (const v of p) assert.equal(v, Math.round(v), `${v} is not a whole pixel`);
  }
});

test("an unusable frame size returns null rather than a court at the origin", () => {
  assert.equal(scaleCorners(CORNERS, { width: 0, height: 720 }, { width: 1280, height: 720 }), null);
  assert.equal(scaleCorners(CORNERS, { width: 640, height: 720 }, { width: 1280, height: 0 }), null);
  assert.equal(scaleCorners(CORNERS, { width: -1, height: 720 }, { width: 1280, height: 720 }), null);
});

test("isCourtCorners rejects the shapes jsonb will happily store", () => {
  assert.equal(isCourtCorners(CORNERS), true);
  assert.equal(isCourtCorners(null), false);
  assert.equal(isCourtCorners("nearLeft"), false);
  assert.equal(isCourtCorners({ nearLeft: [1, 2], farLeft: [3, 4] }), false, "missing corners");
  assert.equal(isCourtCorners({ ...CORNERS, farRight: [1] }), false, "short point");
  assert.equal(isCourtCorners({ ...CORNERS, farRight: ["1", "2"] }), false, "strings");
  // NaN is the one that matters: it passes typeof === "number", survives every
  // arithmetic step, and turns the whole homography into NaN silently.
  assert.equal(isCourtCorners({ ...CORNERS, nearLeft: [NaN, 200] }), false, "NaN");
  assert.equal(isCourtCorners({ ...CORNERS, nearLeft: [Infinity, 200] }), false, "Infinity");
});
