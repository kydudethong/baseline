/**
 * The speed floor in detectHits is a physical claim measured in image units,
 * and the image is a projection. These tests pin the correction that makes
 * one threshold mean the same physical speed at both ends of the court.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { courtForeshorteningAt } from "./court";
import { detectHits, newHitScanStats, STRICT_HIT_PARAMS } from "./ball";
import type { CourtCalibration } from "./phase2-types";
import type { BallTrackPoint } from "./ball";

const FRAME_H = 720;

/** A typical foreshortened court: far baseline half the width of the near one. */
const cal: CourtCalibration = {
  method: "manual",
  confidence: 0.9,
  cornersImagePx: {
    bottomLeft: [200, 700], bottomRight: [1080, 700],
    topLeft: [420, 300], topRight: [860, 300],
  },
  quadKind: "full",
  frameTimestampSeconds: 0,
  diagnostics: {},
} as CourtCalibration;

test("is 1.0 at the near baseline", () => {
  assert.equal(courtForeshorteningAt(cal, 700), 1);
});

test("is the width ratio at the far baseline", () => {
  // (860-420)/(1080-200) = 440/880 = 0.5
  assert.ok(Math.abs(courtForeshorteningAt(cal, 300)! - 0.5) < 1e-9);
});

test("falls monotonically from near to far", () => {
  const rows = [700, 600, 500, 400, 300];
  const vals = rows.map((y) => courtForeshorteningAt(cal, y)!);
  for (let i = 1; i < vals.length; i++) assert.ok(vals[i] < vals[i - 1], `${vals}`);
});

test("does not keep shrinking above the far baseline", () => {
  // A lob is high in the frame but must not get a free pass: t is clamped.
  assert.equal(courtForeshorteningAt(cal, 100), courtForeshorteningAt(cal, 300));
});

test("is 1.0 everywhere for a head-on, unforeshortened quad", () => {
  const flat = { ...cal, cornersImagePx: {
    bottomLeft: [200, 700], bottomRight: [1080, 700],
    topLeft: [200, 300], topRight: [1080, 300],
  } } as CourtCalibration;
  for (const y of [700, 500, 300]) assert.equal(courtForeshorteningAt(flat, y), 1);
});

test("returns null without a usable calibration", () => {
  assert.equal(courtForeshorteningAt(null, 500), null);
  assert.equal(courtForeshorteningAt({ ...cal, confidence: 0 } as CourtCalibration, 500), null);
  assert.equal(courtForeshorteningAt({ ...cal, cornersImagePx: null } as CourtCalibration, 500), null);
});

/** A V-shaped path: straight in, sharp turn at `apex`, straight out. */
function vPath(yNorm: number, speed: number): BallTrackPoint[] {
  const pts: BallTrackPoint[] = [];
  const dt = 1 / 24;
  for (let i = -4; i <= 4; i++) {
    const k = Math.abs(i);
    pts.push({
      t: 1 + i * dt,
      x: 0.5 + k * speed * dt,          // out and back: a 180-degree turn
      y: yNorm + i * 0.0005,
      conf: 0.9,
      interpolated: false,
    });
  }
  return pts;
}

test("a far-court contact is rejected by a flat threshold and kept by the scaled one", () => {
  // Fast enough to be a real strike where it is, too slow for the near-court
  // number: 0.20 image-units/s against a 0.35 floor that scales to ~0.175 up there.
  const far = vPath(300 / FRAME_H, 0.20);
  const scaler = (yN: number) => courtForeshorteningAt(cal, yN * FRAME_H);

  const flat = newHitScanStats();
  assert.equal(detectHits(far, [], undefined, flat, STRICT_HIT_PARAMS).length, 0);
  assert.ok(flat.rejectedSlow > 0, "should have been rejected for speed");

  // The apex is now accepted. Points either side of it still have one
  // near-stationary leg by construction, so some slow-rejects remain and a
  // count of zero would be the wrong thing to assert.
  const scaled = newHitScanStats();
  const hits = detectHits(far, [], undefined, scaled, STRICT_HIT_PARAMS, scaler);
  assert.equal(hits.length, 1);
  assert.ok(Math.abs(hits[0].t - 1) < 1e-9, `contact should be at the apex, was ${hits[0].t}`);
  assert.ok(scaled.rejectedSlow < flat.rejectedSlow,
    `scaling should reject fewer: ${scaled.rejectedSlow} vs ${flat.rejectedSlow}`);
});

test("near-court behaviour is unchanged by the correction", () => {
  const scaler = (yN: number) => courtForeshorteningAt(cal, yN * FRAME_H);
  for (const speed of [0.20, 0.34, 0.36, 0.8]) {
    const near = vPath(700 / FRAME_H, speed);
    const a = detectHits(near, [], undefined, undefined, STRICT_HIT_PARAMS).length;
    const b = detectHits(near, [], undefined, undefined, STRICT_HIT_PARAMS, scaler).length;
    assert.equal(a, b, `speed ${speed}: ${a} vs ${b}`);
  }
});

test("a genuinely stationary ball is still rejected anywhere on the court", () => {
  const scaler = (yN: number) => courtForeshorteningAt(cal, yN * FRAME_H);
  for (const row of [700, 500, 300]) {
    const still = vPath(row / FRAME_H, 0.01);
    assert.equal(detectHits(still, [], undefined, undefined, STRICT_HIT_PARAMS, scaler).length, 0,
      `row ${row} should not produce a contact`);
  }
});
