/**
 * The property that matters most here is scale invariance: the same swing
 * performed at the far baseline is half the size on screen, and must measure
 * the same. Getting that wrong is what made the hit detector deaf to half the
 * court.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { measureSwing } from "./swing";
import type { PlayerPoseFrame } from "./phase2-types";

type P = { name: string; x: number; y: number };

function frame(t: number, pts: P[], conf = 0.9): PlayerPoseFrame {
  return {
    playerId: "p1",
    timestampSeconds: t,
    detectionConfidence: 0.9,
    keypoints: pts.map((p) => ({ name: p.name, xNorm: p.x, yNorm: p.y, confidence: conf })),
    modelSource: "yolov8n-pose",
  } as PlayerPoseFrame;
}

/**
 * A right-handed swing: wrist starts back and low, comes through to contact,
 * follows through. `scale` shrinks the whole body about `cx,cy` — a player
 * further from the camera. `fps` is the sampling rate.
 */
function swing(opts: { scale?: number; cx?: number; cy?: number; fps?: number; contactAt?: number } = {}): PlayerPoseFrame[] {
  const { scale = 1, cx = 0.5, cy = 0.5, fps = 24, contactAt = 10 } = opts;
  const S = (x: number, y: number) => ({ x: cx + (x - 0.5) * scale, y: cy + (y - 0.5) * scale });
  const out: PlayerPoseFrame[] = [];
  const n = Math.round(fps * 1.0); // one second, centred on contact
  for (let i = 0; i <= n; i++) {
    const t = contactAt - 0.5 + i / fps;
    const u = (t - contactAt); // negative before contact
    // wrist sweeps from behind (x small) through the body to in front
    const wx = 0.5 + 0.22 * Math.tanh(u * 8);
    const wy = 0.52 - 0.10 * Math.exp(-Math.pow(u * 6, 2));
    const sh = { l: S(0.44, 0.40), r: S(0.56, 0.40) };
    out.push(frame(Math.round(t * 1000) / 1000, [
      { name: "left_shoulder", ...sh.l }, { name: "right_shoulder", ...sh.r },
      { name: "left_hip", ...S(0.46, 0.58) }, { name: "right_hip", ...S(0.54, 0.58) },
      { name: "left_knee", ...S(0.46, 0.72) }, { name: "right_knee", ...S(0.54, 0.72) },
      { name: "left_ankle", ...S(0.46, 0.88) }, { name: "right_ankle", ...S(0.54, 0.88) },
      { name: "right_wrist", ...S(wx, wy) },
      { name: "left_wrist", ...S(0.47, 0.55) },
    ]));
  }
  return out;
}

test("finds the swinging arm", () => {
  assert.equal(measureSwing(swing(), 10).hand, "right");
});

test("the same swing measures the same at the far end of the court", () => {
  const near = measureSwing(swing({ scale: 1.0, cy: 0.7 }), 10);
  const far = measureSwing(swing({ scale: 0.5, cy: 0.35 }), 10);
  const fields = ["contactReachShoulders", "backswingShoulders",
                  "followThroughShoulders", "wristSpeedIntoContact"] as const;
  for (const f of fields) {
    assert.notEqual(near[f], null, `${f} should be measurable near`);
    assert.ok(Math.abs((near[f] as number) - (far[f] as number)) < 0.05,
      `${f}: near ${near[f]} vs far ${far[f]} — must not depend on distance from camera`);
  }
  assert.equal(near.kneeAngleAtContactDeg, far.kneeAngleAtContactDeg);
});

test("straight legs read near 180 degrees", () => {
  const m = measureSwing(swing(), 10);
  assert.ok(m.kneeAngleAtContactDeg! > 170, `got ${m.kneeAngleAtContactDeg}`);
});

test("a bent knee reads well below straight", () => {
  const bent = swing().map((f) => ({
    ...f,
    keypoints: f.keypoints.map((k) =>
      k.name === "right_knee" ? { ...k, xNorm: 0.60, yNorm: 0.70 } : k),
  })) as PlayerPoseFrame[];
  const m = measureSwing(bent, 10);
  assert.ok(m.kneeAngleAtContactDeg! < 160, `got ${m.kneeAngleAtContactDeg}`);
});

test("a low contact reads below the shoulders and an overhead above", () => {
  const low = measureSwing(swing(), 10);
  assert.ok(low.contactHeightTorsos! < 0, `waist-height contact should be below shoulders, got ${low.contactHeightTorsos}`);

  const high = swing().map((f) => ({
    ...f,
    keypoints: f.keypoints.map((k) => k.name === "right_wrist" ? { ...k, yNorm: 0.28 } : k),
  })) as PlayerPoseFrame[];
  assert.ok(measureSwing(high, 10).contactHeightTorsos! > 0);
});

test("5 fps cannot measure a swing; 24 fps can", () => {
  const slow = measureSwing(swing({ fps: 5 }), 10);
  const fast = measureSwing(swing({ fps: 24 }), 10);
  assert.ok(slow.samples <= 6, `got ${slow.samples}`);
  assert.ok(fast.samples >= 20, `got ${fast.samples}`);
  assert.ok(fast.confidence > slow.confidence,
    `denser sampling must report higher confidence: ${fast.confidence} vs ${slow.confidence}`);
});

test("reports what is missing instead of inventing it", () => {
  const noLegs = swing().map((f) => ({
    ...f, keypoints: f.keypoints.filter((k) => !k.name.includes("knee") && !k.name.includes("ankle")),
  })) as PlayerPoseFrame[];
  const m = measureSwing(noLegs, 10);
  assert.equal(m.kneeAngleAtContactDeg, null);
  assert.ok(m.missing.some((s) => s.includes("legs")), m.missing.join("; "));
  // The absolute number is not the claim; the claim is that a measurement
  // with a field missing is reported as less certain than the complete one.
  assert.ok(m.confidence < measureSwing(swing(), 10).confidence,
    `incomplete ${m.confidence} should be under complete ${measureSwing(swing(), 10).confidence}`);
});

test("an empty window is honest rather than zero-valued", () => {
  const m = measureSwing(swing(), 40);
  assert.equal(m.samples, 0);
  assert.equal(m.confidence, 0);
  assert.equal(m.wristSpeedIntoContact, null);
  assert.ok(m.missing.length > 0);
});

test("low-confidence keypoints are ignored, not trusted", () => {
  const faint = swing().map((f) => ({
    ...f, keypoints: f.keypoints.map((k) => ({ ...k, confidence: 0.05 })),
  })) as PlayerPoseFrame[];
  const m = measureSwing(faint, 10);
  assert.equal(m.contactReachShoulders, null);
  assert.equal(m.hand, "unknown");
});
