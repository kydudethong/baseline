import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyBetween, applyBounceRule, EXCHANGE_PARAMS, newBounceTrimStats,
  type PairKind,
} from "./ball-exchange";
import type { BallTrackPoint } from "./ball";

/** Ball points whose net distance is given directly, so the geometry under
 * test is the rule and not the homography. */
function track(ds: number[], t0 = 0, dt = 0.05, interpolated = false): BallTrackPoint[] {
  return ds.map((d, i) => ({
    t: t0 + i * dt,
    x: 0.5,
    // y carries the net distance for the fake netDistance() below.
    y: d,
    conf: 0.9,
    interpolated,
  }));
}
const netDistance = (p: BallTrackPoint) => p.y;

test("a ball seen clearly on both sides of the net crossed it", () => {
  const pts = track([-0.2, -0.1, 0.05, 0.18, 0.25]);
  assert.equal(classifyBetween(pts, 0, 1, netDistance), "crossed");
});

test("a ball bouncing well clear of the net on one side is a bounce", () => {
  // Floor (far from the net) up to the top of the bounce and back down.
  const pts = track([-0.30, -0.22, -0.14, -0.11, -0.17, -0.26, -0.31]);
  assert.equal(classifyBetween(pts, 0, 1, netDistance), "same-side-bounce");
});

test("a kitchen dink near the net is never called a bounce", () => {
  // The case rally-keepalive.ts exists for: the ball never leaves the band, so
  // it has no side. Calling this a bounce would re-break kitchen play.
  const pts = track([-0.03, -0.015, 0.01, 0.015, -0.005, -0.02]);
  const kind = classifyBetween(pts, 0, 1, netDistance);
  assert.notEqual(kind, "same-side-bounce");
});

test("a ball travelling away from the net without returning is not a bounce", () => {
  // Monotonic: one ball going away, not somebody bouncing it.
  const pts = track([-0.10, -0.15, -0.20, -0.26, -0.32]);
  assert.equal(classifyBetween(pts, 0, 1, netDistance), "unclear");
});

test("too few real points claims nothing", () => {
  const pts = track([-0.30, -0.14]);
  assert.equal(classifyBetween(pts, 0, 1, netDistance), "unclear");
});

test("interpolated points cannot manufacture a verdict", () => {
  // The same swing that reads as a bounce above, but every point invented.
  const pts = track([-0.30, -0.22, -0.14, -0.11, -0.17, -0.26, -0.31], 0, 0.05, true);
  assert.equal(classifyBetween(pts, 0, 1, netDistance), "unclear");
});

test("a ball with no computable net distance claims nothing", () => {
  const pts = track([-0.30, -0.22, -0.14, -0.11, -0.17, -0.26]);
  assert.equal(classifyBetween(pts, 0, 1, () => null), "unclear");
});

test("points outside the two contacts are ignored", () => {
  // A crossing that happened AFTER tB must not make this leg look live.
  const pts = [...track([-0.30, -0.22, -0.14, -0.11, -0.17, -0.26]), ...track([0.3, 0.35], 1.5)];
  assert.equal(classifyBetween(pts, 0, 0.3, netDistance), "same-side-bounce");
});

/* ---- the rally-level rule ---------------------------------------------- */

function kindsFrom(map: Record<string, PairKind>) {
  return (a: number, b: number): PairKind => map[`${a}-${b}`] ?? "unclear";
}

test("a group that never crossed the net and was bouncing is not a rally", () => {
  const rallies = [{ startS: 0, endS: 10, contacts: [1, 2, 3] }];
  const { rallies: out, stats } = applyBounceRule(
    rallies, kindsFrom({ "1-2": "same-side-bounce", "2-3": "same-side-bounce" }), 1.5
  );
  assert.equal(out.length, 0);
  assert.equal(stats.dropped, 1);
});

test("a real rally that ends in bouncing is cut back to the last exchange", () => {
  const rallies = [{ startS: 0, endS: 20, contacts: [1, 2, 3, 4, 5] }];
  const { rallies: out, stats } = applyBounceRule(
    rallies,
    kindsFrom({
      "1-2": "crossed", "2-3": "crossed",
      "3-4": "same-side-bounce", "4-5": "same-side-bounce",
    }),
    1.5
  );
  assert.equal(out.length, 1);
  // Ends just before the bouncing starts, not a tail's width into it.
  assert.equal(out[0].endS, 3.95);
  assert.deepEqual(out[0].contacts, [1, 2, 3]);
  assert.equal(stats.trimmed, 1);
});

test("a rally with no bounce evidence is left exactly as it was", () => {
  const rally = { startS: 0, endS: 20, contacts: [1, 2, 3] };
  const { rallies: out, stats } = applyBounceRule([rally], () => "unclear", 1.5);
  assert.deepEqual(out, [rally]);
  assert.equal(stats.dropped, 0);
  assert.equal(stats.trimmed, 0);
});

test("bouncing in the MIDDLE of a rally does not truncate what came after", () => {
  // A missed contact can make one leg look like a bounce. Only a bouncing TAIL
  // ends a rally; a later crossing proves play continued.
  const rallies = [{ startS: 0, endS: 20, contacts: [1, 2, 3, 4] }];
  const { rallies: out, stats } = applyBounceRule(
    rallies,
    kindsFrom({ "1-2": "crossed", "2-3": "same-side-bounce", "3-4": "crossed" }),
    1.5
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].endS, 20);
  assert.equal(stats.trimmed, 0);
});

test("trimming never lengthens a rally", () => {
  const rallies = [{ startS: 0, endS: 3, contacts: [1, 2, 3] }];
  const { rallies: out } = applyBounceRule(
    rallies, kindsFrom({ "1-2": "crossed", "2-3": "same-side-bounce" }), 1.5
  );
  assert.ok(out[0].endS <= 3);
});

test("a single-contact rally is untouched", () => {
  const rally = { startS: 0, endS: 5, contacts: [2] };
  const { rallies: out } = applyBounceRule([rally], () => "same-side-bounce", 1.5);
  assert.deepEqual(out, [rally]);
});

test("the shipped params keep a dink clear of the bounce verdict", () => {
  // Guards the one number that matters: a ball inside the band can never be
  // far enough from the net to be a bounce.
  assert.ok(EXCHANGE_PARAMS.minSideClearanceNorm > EXCHANGE_PARAMS.deadbandNorm * 3);
  assert.equal(newBounceTrimStats().dropped, 0);
});

/* ---- The double bounce: the actual rule of the game --------------------- */

import { findDoubleBounceEnd, applyDoubleBounceRule } from "./ball-exchange";
import type { BallBounce } from "./ball";

const bounce = (t: number, d: number): BallBounce => ({ t, x: 0.5, y: d, confidence: 0.8 });
const dOf = (p: { x: number; y: number }) => p.y;

test("two bounces on the same side with nobody hitting it ends the rally", () => {
  const hit = findDoubleBounceEnd([bounce(3.0, -0.2), bounce(3.8, -0.25)], [1.0, 2.0], dOf);
  assert.deepEqual(hit, { t: 3.8, side: "near" });
});

test("two bounces on OPPOSITE sides is just play", () => {
  assert.equal(findDoubleBounceEnd([bounce(3.0, -0.2), bounce(3.8, 0.2)], [], dOf), null);
});

test("a contact between the two bounces makes the second one a new ball", () => {
  assert.equal(
    findDoubleBounceEnd([bounce(3.0, -0.2), bounce(4.5, -0.25)], [3.6], dOf),
    null
  );
});

test("bounces inside the net band have no side and prove nothing", () => {
  assert.equal(findDoubleBounceEnd([bounce(3.0, -0.005), bounce(3.8, -0.004)], [], dOf), null);
});

test("the first double bounce wins, not the last", () => {
  const hit = findDoubleBounceEnd(
    [bounce(3.0, -0.2), bounce(3.8, -0.25), bounce(9.0, 0.2), bounce(9.6, 0.22)], [], dOf
  );
  assert.equal(hit?.t, 3.8);
});

test("a rally is cut at its double bounce and never lengthened", () => {
  const rallies = [{ startS: 0, endS: 30, contacts: [1, 2, 3] }];
  const { rallies: out, stats } = applyDoubleBounceRule(
    rallies,
    () => [bounce(5.0, -0.2), bounce(5.7, -0.24)],
    [1, 2, 3],
    dOf,
    1.5
  );
  assert.equal(out[0].endS, 7.2);
  assert.equal(stats.ended, 1);
  assert.ok(out[0].endS < 30);
});

test("a double bounce before the rally's first contact is the previous point's ball", () => {
  const rally = { startS: 0, endS: 30, contacts: [10, 12, 14] };
  const { rallies: out, stats } = applyDoubleBounceRule(
    [rally],
    () => [bounce(1.0, -0.2), bounce(1.7, -0.24)],   // before contact at 10s
    [10, 12, 14],
    dOf,
    1.5
  );
  assert.deepEqual(out, [rally]);
  assert.equal(stats.ended, 0);
});

test("no double bounce leaves the rally exactly as it was", () => {
  const rally = { startS: 0, endS: 30, contacts: [1, 2, 3] };
  const { rallies: out } = applyDoubleBounceRule([rally], () => [], [1, 2, 3], dOf, 1.5);
  assert.deepEqual(out, [rally]);
});
