import assert from "node:assert/strict";
import { test } from "node:test";

import { courtFrameFor } from "./shots";
import {
  feetFromNet, majoritySide, partnerGap, partnerOf, sideOfCourt,
  timeToKitchenAfter, zoneAt, zoneBreakdown, type PositionSample,
} from "./positioning";

const FULL = courtFrameFor("full");
const NEAR_HALF = courtFrameFor("near-half");
const NEAR_INPLAY = courtFrameFor("near-inplay");

const at = (t: number, y: number, x = 0.5): PositionSample =>
  ({ timestampSeconds: t, courtX: x, courtY: y });

test("feet from the net agrees across every quad kind", () => {
  // The near baseline is 22 ft from the net, whatever the frame calls y=there.
  assert.equal(Math.round(feetFromNet(1, FULL)), 22);
  assert.equal(Math.round(feetFromNet(1, NEAR_HALF)), 22);
  assert.equal(Math.round(feetFromNet(1, NEAR_INPLAY)), 22);
  // And the net itself is zero in all three.
  assert.equal(Math.round(feetFromNet(FULL.netY, FULL)), 0);
  assert.equal(Math.round(feetFromNet(NEAR_HALF.netY, NEAR_HALF)), 0);
  assert.equal(Math.round(feetFromNet(NEAR_INPLAY.netY, NEAR_INPLAY)), 0);
});

test("the far side is measured from the net too, not from the near baseline", () => {
  // y=0 on a full court is the FAR baseline: 22 ft the other way.
  assert.equal(Math.round(feetFromNet(0, FULL)), 22);
  assert.equal(sideOfCourt(0, FULL), "far");
  assert.equal(sideOfCourt(1, FULL), "near");
});

test("zones land where a coach would put them", () => {
  const yAt = (ft: number) => FULL.netY + ft / 44;  // near side, ft from net
  assert.equal(zoneAt(yAt(7), FULL), "kitchen", "on the line");
  assert.equal(zoneAt(yAt(8.5), FULL), "kitchen", "a step behind it");
  assert.equal(zoneAt(yAt(14), FULL), "transition", "no-man's land");
  assert.equal(zoneAt(yAt(21), FULL), "back", "at the baseline");
});

test("kitchen time is the fraction of samples at the line", () => {
  const yAt = (ft: number) => FULL.netY + ft / 44;
  const b = zoneBreakdown(
    [at(0, yAt(8)), at(1, yAt(8)), at(2, yAt(15)), at(3, yAt(21))], FULL
  );
  assert.equal(b.kitchen, 0.5);
  assert.equal(b.transition, 0.25);
  assert.equal(b.back, 0.25);
  assert.equal(b.samples, 4);
});

test("no samples is not a zero score", () => {
  const b = zoneBreakdown([], FULL);
  assert.equal(b.samples, 0);
  assert.equal(b.kitchen, 0);
});

test("time-to-kitchen measures the approach", () => {
  const yAt = (ft: number) => FULL.netY + ft / 44;
  const samples = [
    at(0.0, yAt(21)), at(1.0, yAt(16)), at(2.0, yAt(11)), at(3.0, yAt(8)), at(4.0, yAt(8)),
  ];
  const r = timeToKitchenAfter(samples, [0.0], FULL);
  assert.deepEqual(r.secondsToKitchen, [3]);
  assert.equal(r.medianSeconds, 3);
  assert.equal(r.neverArrived, 0);
});

test("a player already at the kitchen is not counted as instant", () => {
  // Counting them 0.0s would drag the median toward "instant" for exactly the
  // players who never had to make the move.
  const yAt = (ft: number) => FULL.netY + ft / 44;
  const r = timeToKitchenAfter([at(0, yAt(8)), at(1, yAt(8))], [0], FULL);
  assert.deepEqual(r.secondsToKitchen, []);
  assert.equal(r.neverArrived, 0);
  assert.equal(r.medianSeconds, null);
});

test("never getting there is recorded, not silently dropped", () => {
  const yAt = (ft: number) => FULL.netY + ft / 44;
  const r = timeToKitchenAfter(
    [at(0, yAt(21)), at(1, yAt(21)), at(2, yAt(20))], [0], FULL, 8
  );
  assert.equal(r.neverArrived, 1);
  assert.deepEqual(r.secondsToKitchen, []);
});

test("arriving after the window does not count", () => {
  const yAt = (ft: number) => FULL.netY + ft / 44;
  const r = timeToKitchenAfter([at(0, yAt(21)), at(20, yAt(8))], [0], FULL, 8);
  assert.equal(r.neverArrived, 1);
});

test("partner gap is measured in feet", () => {
  // Same depth, opposite thirds of a 20 ft court: 10 ft apart.
  const a = [at(0, 0.8, 0.25), at(1, 0.8, 0.25)];
  const b = [at(0, 0.8, 0.75), at(1, 0.8, 0.75)];
  const g = partnerGap(a, b, FULL);
  assert.equal(g.meanFeet, 10);
  assert.equal(g.maxFeet, 10);
  assert.equal(g.samples, 2);
});

test("gap counts depth as well as width", () => {
  // 11 ft apart down the court (0.25 of 44), same x.
  const g = partnerGap([at(0, 0.9, 0.5)], [at(0, 0.65, 0.5)], FULL);
  assert.equal(g.meanFeet, 11);
});

test("samples are paired by TIME, not by index", () => {
  // b is missing the middle sample. Index pairing would compare a@1 with b@2
  // and report a gap that never existed.
  const a = [at(0, 0.8, 0.2), at(1, 0.8, 0.2), at(2, 0.8, 0.9)];
  const b = [at(0, 0.8, 0.3), at(2, 0.8, 0.9)];
  const g = partnerGap(a, b, FULL);
  assert.equal(g.samples, 2, "only the two shared instants");
  assert.equal(g.maxFeet, 2, "0.1 of 20ft — never the phantom wide gap");
});

test("a wide gap is counted", () => {
  const a = [at(0, 0.8, 0.05), at(1, 0.8, 0.5)];
  const b = [at(0, 0.8, 0.95), at(1, 0.8, 0.5)];
  const g = partnerGap(a, b, FULL, { wideFeet: 12 });
  assert.equal(g.fractionWide, 0.5);
});

test("no shared samples reports nothing rather than zero", () => {
  const g = partnerGap([at(0, 0.8)], [at(50, 0.8)], FULL);
  assert.equal(g.meanFeet, null);
  assert.equal(g.samples, 0);
});

test("partners are found on the same side", () => {
  const players = [
    { playerId: "me", samples: [at(0, 0.9), at(1, 0.85)] },
    { playerId: "partner", samples: [at(0, 0.7), at(1, 0.75)] },
    { playerId: "opp", samples: [at(0, 0.1), at(1, 0.15)] },
  ];
  assert.equal(partnerOf("me", players, FULL)?.playerId, "partner");
});

test("three players on one side means we do not guess", () => {
  // A spectator picked up by the tracker, or a split track. Attributing
  // someone else's positioning to the player would be worse than no answer.
  const players = [
    { playerId: "me", samples: [at(0, 0.9)] },
    { playerId: "maybe", samples: [at(0, 0.7)] },
    { playerId: "also", samples: [at(0, 0.6)] },
  ];
  assert.equal(partnerOf("me", players, FULL), null);
});

test("majority side survives a stray sample", () => {
  const s = [at(0, 0.9), at(1, 0.9), at(2, 0.1), at(3, 0.9)];
  assert.equal(majoritySide(s, FULL), "near");
});
