import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CocoKeypointName, PlayerPoseFrame } from "./phase2-types";
import {
  contactAt, measureShot, preparationAt, readyAfter, stanceAt, MIN_KP_CONFIDENCE,
} from "./body-angles";

/**
 * Skeletons built by hand, where the right answer is known before the code
 * runs. A test that asserts whatever the function returned would pass just as
 * happily on a function measuring the wrong thing.
 *
 * Coordinates are normalized with y DOWN, and every fixture is drawn on a
 * SQUARE frame (aspect 1) so the numbers in the assertions are the numbers a
 * protractor would give. There is a separate test for the aspect correction.
 */

/**
 * Degrees and ratios do not come out of trigonometry exactly, so every
 * assertion here names the tolerance it accepts. `places` is decimal places,
 * matching the convention the rest of the suite uses.
 */
function assertClose(actual: number | null, expected: number, places: number): void {
  assert.ok(actual !== null, `expected a number near ${expected}, got null`);
  const tol = Math.pow(10, -places) / 2;
  assert.ok(
    Math.abs((actual as number) - expected) <= Math.max(tol, 0.5 * Math.pow(10, -places) * 10),
    `expected ${actual} to be within ${places} places of ${expected}`
  );
}

type KP = Partial<Record<CocoKeypointName, [number, number] | [number, number, number]>>;

function frame(t: number, kp: KP, playerId = "p1"): PlayerPoseFrame {
  const names: CocoKeypointName[] = [
    "nose", "left_eye", "right_eye", "left_ear", "right_ear",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle",
  ];
  return {
    playerId,
    timestampSeconds: t,
    detectionConfidence: 0.9,
    modelSource: "yolov8n-pose",
    keypoints: names.map((name) => {
      const v = kp[name];
      if (!v) return { name, xNorm: null, yNorm: null, confidence: 0 };
      return { name, xNorm: v[0], yNorm: v[1], confidence: v[2] ?? 0.9 };
    }),
  };
}

/** Shoulders square to a level net, hips square, standing tall. */
const SQUARE: KP = {
  left_shoulder: [0.40, 0.30], right_shoulder: [0.60, 0.30],
  left_hip: [0.43, 0.50], right_hip: [0.57, 0.50],
  left_knee: [0.43, 0.70], right_knee: [0.57, 0.70],
  left_ankle: [0.43, 0.90], right_ankle: [0.57, 0.90],
  left_wrist: [0.40, 0.50], right_wrist: [0.60, 0.50],
  left_elbow: [0.40, 0.40], right_elbow: [0.60, 0.40],
};

describe("preparation", () => {
  it("reads a square stance as no turn at all", () => {
    const m = preparationAt([frame(1, SQUARE)], 1, 1);
    assertClose(m.shoulderTurnDeg, 0, 1);
  });

  it("measures a 45-degree shoulder turn as 45 degrees", () => {
    // A shoulder line running down-right at exactly 45 degrees.
    const turned = { ...SQUARE, left_shoulder: [0.40, 0.25] as [number, number], right_shoulder: [0.60, 0.45] as [number, number] };
    const m = preparationAt([frame(1, turned)], 1, 1);
    assertClose(m.shoulderTurnDeg, 45, 0);
  });

  it("separates a coil from a whole-body turn", () => {
    // Shoulders turned 45, hips still level: 45 degrees of separation.
    const coiled = { ...SQUARE, left_shoulder: [0.40, 0.25] as [number, number], right_shoulder: [0.60, 0.45] as [number, number] };
    assertClose(preparationAt([frame(1, coiled)], 1, 1).hipShoulderSeparationDeg, 45, 0);
    // Shoulders AND hips both turned 45: no coil, the player rotated as a unit.
    const unified = {
      ...coiled,
      left_hip: [0.43, 0.45] as [number, number], right_hip: [0.57, 0.59] as [number, number],
    };
    assert.ok((preparationAt([frame(1, unified)], 1, 1).hipShoulderSeparationDeg!) < 5, `expected ${preparationAt([frame(1, unified)], 1, 1).hipShoulderSeparationDeg!} < 5`);
  });

  it("ignores a net that is not level in the frame", () => {
    // Shoulders parallel to a net tilted 20 degrees: square to THAT net.
    const along = { ...SQUARE, left_shoulder: [0.40, 0.30] as [number, number], right_shoulder: [0.60, 0.372] as [number, number] };
    const m = preparationAt([frame(1, along)], 1, 1, 20);
    assert.ok((m.shoulderTurnDeg!) < 2, `expected ${m.shoulderTurnDeg!} < 2`);
    // The same body against a level net reads as a real turn.
    assert.ok((preparationAt([frame(1, along)], 1, 1, 0).shoulderTurnDeg!) > 15, `expected ${preparationAt([frame(1, along)], 1, 1, 0).shoulderTurnDeg!} > 15`);
  });

  it("finds when the turn started, and stops at the quiet frames", () => {
    // Still for three frames, then rotating hard into contact at t=1.0.
    const still = (t: number) => frame(t, SQUARE);
    const turning = (t: number, deg: number) => frame(t, {
      ...SQUARE,
      left_shoulder: [0.5 - 0.1 * Math.cos(deg * Math.PI / 180), 0.30 - 0.1 * Math.sin(deg * Math.PI / 180)],
      right_shoulder: [0.5 + 0.1 * Math.cos(deg * Math.PI / 180), 0.30 + 0.1 * Math.sin(deg * Math.PI / 180)],
    });
    const frames = [still(0.4), still(0.5), still(0.6), turning(0.7, 15), turning(0.8, 30), turning(0.9, 45), turning(1.0, 60)];
    const m = preparationAt(frames, 1.0, 1);
    // The wind-up began at 0.6 -> 0.7, so the lead is measured from 0.6.
    assertClose(m.rotationLeadSeconds, 0.4, 2);
  });

  it("returns null rather than guessing when the shoulders are not visible", () => {
    const hidden = { ...SQUARE, left_shoulder: [0.4, 0.3, 0.1] as [number, number, number] };
    const m = preparationAt([frame(1, hidden)], 1, 1);
    assert.equal(m.shoulderTurnDeg, null);
    assert.equal(m.hipShoulderSeparationDeg, null);
  });
});

describe("contact", () => {
  it("puts a hand at the hip at 0 and at the shoulder at 1", () => {
    const atHip = { ...SQUARE, right_wrist: [0.75, 0.50] as [number, number] };
    assertClose(contactAt([frame(1, atHip)], 1, 1).contactHeightRatio, 0, 1);
    const atShoulder = { ...SQUARE, right_wrist: [0.75, 0.30] as [number, number] };
    assertClose(contactAt([frame(1, atShoulder)], 1, 1).contactHeightRatio, 1, 1);
  });

  it("reads a dink below the hip as negative", () => {
    const low = { ...SQUARE, right_wrist: [0.75, 0.60] as [number, number] };
    assert.ok((contactAt([frame(1, low)], 1, 1).contactHeightRatio!) < 0, `expected ${contactAt([frame(1, low)], 1, 1).contactHeightRatio!} < 0`);
  });

  it("reads an overhead as above 1", () => {
    const high = { ...SQUARE, right_wrist: [0.62, 0.10] as [number, number] };
    assert.ok((contactAt([frame(1, high)], 1, 1).contactHeightRatio!) > 1, `expected ${contactAt([frame(1, high)], 1, 1).contactHeightRatio!} > 1`);
  });

  it("picks the extended arm as the paddle hand", () => {
    const reaching = { ...SQUARE, right_wrist: [0.85, 0.45] as [number, number], left_wrist: [0.48, 0.50] as [number, number] };
    assert.equal(contactAt([frame(1, reaching)], 1, 1).paddleSide, "right");
  });

  it("calls contact behind the lead foot negative", () => {
    // Lead ankle up the frame at y=0.85; hand BELOW it at y=0.92 is behind.
    const behind = {
      ...SQUARE,
      left_ankle: [0.43, 0.85] as [number, number], right_ankle: [0.57, 0.95] as [number, number],
      right_wrist: [0.75, 0.92] as [number, number],
    };
    assert.ok((contactAt([frame(1, behind)], 1, 1).contactAheadShoulderWidths!) < 0, `expected ${contactAt([frame(1, behind)], 1, 1).contactAheadShoulderWidths!} < 0`);
    // And the same hand well up the frame is out in front.
    const ahead = { ...behind, right_wrist: [0.75, 0.50] as [number, number] };
    assert.ok((contactAt([frame(1, ahead)], 1, 1).contactAheadShoulderWidths!) > 0, `expected ${contactAt([frame(1, ahead)], 1, 1).contactAheadShoulderWidths!} > 0`);
  });

  it("measures a straight paddle arm at about 180 degrees", () => {
    const straight = {
      ...SQUARE,
      right_shoulder: [0.60, 0.30] as [number, number],
      right_elbow: [0.70, 0.40] as [number, number],
      right_wrist: [0.80, 0.50] as [number, number],
    };
    assertClose(contactAt([frame(1, straight)], 1, 1).paddleElbowDeg, 180, 0);
  });

  it("measures a bent elbow at about 90 degrees", () => {
    const bent = {
      ...SQUARE,
      // The left hand tucked in, so the right is unambiguously the paddle arm.
      left_wrist: [0.50, 0.50] as [number, number],
      right_shoulder: [0.60, 0.30] as [number, number],
      right_elbow: [0.70, 0.40] as [number, number],
      right_wrist: [0.60, 0.50] as [number, number],
    };
    assertClose(contactAt([frame(1, bent)], 1, 1).paddleElbowDeg, 90, 0);
  });
});

describe("stance", () => {
  it("reads straight legs at about 180 degrees and a deep bend as far less", () => {
    assertClose(stanceAt([frame(1, SQUARE)], 1, 1).kneeFlexionDeg, 180, 0);
    const bent = {
      ...SQUARE,
      left_knee: [0.35, 0.70] as [number, number], left_ankle: [0.43, 0.85] as [number, number],
    };
    assert.ok((stanceAt([frame(1, bent)], 1, 1).kneeFlexionDeg!) < 150, `expected ${stanceAt([frame(1, bent)], 1, 1).kneeFlexionDeg!} < 150`);
  });

  it("reports the MORE bent leg, not the average", () => {
    const lunge = {
      ...SQUARE,
      left_knee: [0.30, 0.70] as [number, number], left_ankle: [0.43, 0.82] as [number, number],
    };
    const m = stanceAt([frame(1, lunge)], 1, 1);
    // The right leg is straight at 180; the answer must be the bent left one.
    assert.ok((m.kneeFlexionDeg!) < 140, `expected ${m.kneeFlexionDeg!} < 140`);
  });

  it("measures stance width in shoulder widths", () => {
    // Ankles 0.14 apart, shoulders 0.20 apart -> 0.7.
    assertClose(stanceAt([frame(1, SQUARE)], 1, 1).stanceWidthRatio, 0.7, 1);
  });

  it("calls movement up the frame positive drift and movement back negative", () => {
    // A frame AT contact too: without a stance there is nothing to attach a
    // drift to, and stanceAt correctly refuses rather than reporting movement
    // for a player it cannot see.
    const forward = [
      frame(0.7, SQUARE),
      frame(1.0, { ...SQUARE, left_hip: [0.43, 0.45], right_hip: [0.57, 0.45] }),
      frame(1.3, { ...SQUARE, left_hip: [0.43, 0.40], right_hip: [0.57, 0.40] }),
    ];
    assert.ok((stanceAt(forward, 1.0, 1).driftTowardNetTorsosPerSecond!) > 0, `expected ${stanceAt(forward, 1.0, 1).driftTowardNetTorsosPerSecond!} > 0`);
    const backward = [
      frame(0.7, SQUARE),
      frame(1.0, { ...SQUARE, left_hip: [0.43, 0.55], right_hip: [0.57, 0.55] }),
      frame(1.3, { ...SQUARE, left_hip: [0.43, 0.60], right_hip: [0.57, 0.60] }),
    ];
    assert.ok((stanceAt(backward, 1.0, 1).driftTowardNetTorsosPerSecond!) < 0, `expected ${stanceAt(backward, 1.0, 1).driftTowardNetTorsosPerSecond!} < 0`);
  });
});

describe("ready position", () => {
  it("times the reset against the player's own median, not an ideal", () => {
    // Hand at the hip most of the time; lifted for the shot at t=1.0.
    const frames = [
      frame(0.0, SQUARE), frame(0.5, SQUARE),
      frame(1.0, { ...SQUARE, right_wrist: [0.80, 0.20] }),
      frame(1.4, { ...SQUARE, right_wrist: [0.80, 0.25] }),
      frame(1.8, SQUARE),
      frame(2.2, SQUARE),
    ];
    const m = readyAfter(frames, 1.0, 1, 3.0);
    assertClose(m.resetSeconds, 0.8, 1);
  });

  it("reports no reset when the next ball arrives first", () => {
    // Six frames so the baseline is real, all with the hand at the hip, and
    // the player still up at the moment the next ball is struck.
    const frames = [
      frame(0.0, SQUARE), frame(0.2, SQUARE), frame(0.4, SQUARE),
      frame(0.6, SQUARE), frame(0.8, SQUARE),
      frame(1.0, { ...SQUARE, right_wrist: [0.80, 0.20] }),
      frame(1.2, { ...SQUARE, right_wrist: [0.80, 0.18] }),
    ];
    assert.equal(readyAfter(frames, 1.0, 1, 1.3).resetSeconds, null);
  });

  it("refuses to name a ready position from a couple of frames", () => {
    // Two frames, both mid-swing. A median of these is not a ready position,
    // and calling it one would report a flawless reset out of no evidence.
    const frames = [
      frame(1.0, { ...SQUARE, right_wrist: [0.80, 0.20] }),
      frame(1.2, { ...SQUARE, right_wrist: [0.80, 0.18] }),
    ];
    const m = readyAfter(frames, 1.0, 1, 3.0);
    assert.equal(m.readyPaddleHeightRatio, null);
    assert.equal(m.resetSeconds, null);
  });
});

describe("the aspect correction", () => {
  it("changes the answer, which is why it is required", () => {
    const diag = { ...SQUARE, left_shoulder: [0.40, 0.30] as [number, number], right_shoulder: [0.60, 0.50] as [number, number] };
    const square = preparationAt([frame(1, diag)], 1, 1).shoulderTurnDeg!;
    const wide = preparationAt([frame(1, diag)], 1, 16 / 9).shoulderTurnDeg!;
    assertClose(square, 45, 0);
    // On a 16:9 frame the same normalized points are a much shallower line.
    assert.ok((wide) < 35, `expected ${wide} < 35`);
  });
});

describe("measureShot", () => {
  it("reports completeness honestly when joints are missing", () => {
    const full = measureShot({ frames: [frame(1, SQUARE)], playerId: "p1", tSeconds: 1, aspect: 1 });
    const blind = measureShot({
      frames: [frame(1, { left_shoulder: [0.4, 0.3] })], playerId: "p1", tSeconds: 1, aspect: 1,
    });
    assert.ok((full.completeness) > blind.completeness, `expected ${full.completeness} > blind.completeness`);
    assert.ok((blind.completeness) < 0.3, `expected ${blind.completeness} < 0.3`);
  });

  it("only measures the player it was asked about", () => {
    const frames = [
      frame(1, SQUARE, "p1"),
      frame(1, { ...SQUARE, left_shoulder: [0.40, 0.10], right_shoulder: [0.60, 0.50] }, "p2"),
    ];
    const a = measureShot({ frames, playerId: "p1", tSeconds: 1, aspect: 1 });
    assertClose(a.shoulderTurnDeg, 0, 1);
  });

  it("drops a keypoint under the confidence floor", () => {
    const shaky = { ...SQUARE, right_wrist: [0.80, 0.20, MIN_KP_CONFIDENCE - 0.01] as [number, number, number] };
    const m = contactAt([frame(1, shaky)], 1, 1);
    // The left wrist is still real, so it becomes the paddle hand rather than
    // the measurement silently using an unreliable joint.
    assert.equal(m.paddleSide, "left");
  });
});
