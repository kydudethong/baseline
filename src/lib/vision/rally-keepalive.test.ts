/**
 * The two failure modes pull against each other: a rally that dies the moment
 * play settles into dinking, and a rally that swallows the dead time after it.
 * Every test here pins one or the other.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extendRalliesWhileLive, KEEP_ALIVE_PARAMS, type KeepAliveContact } from "./rally-keepalive";
import type { ClusteredRally } from "./rallies";

const rally = (idx: number, startS: number, endS: number): ClusteredRally =>
  ({ idx, startS, endS, contacts: [] });

/** Alternating contacts, one per second, as a kitchen exchange looks. */
function dinks(from: number, count: number, every = 1.0): KeepAliveContact[] {
  return Array.from({ length: count }, (_, i) => ({
    t: from + i * every,
    side: (i % 2 === 0 ? "near" : "far") as "near" | "far",
  }));
}

test("holds a rally open through a dink exchange", () => {
  // Crossings stopped at 10s; the players dinked until 20s.
  const r = extendRalliesWhileLive([rally(1, 2, 10)], dinks(10.8, 10), 60);
  assert.equal(r.extended, 1);
  assert.ok(r.rallies[0].endS > 19, `expected to reach ~20s, got ${r.rallies[0].endS}`);
});

test("does NOT hold it open for one player bouncing the ball", () => {
  // Same rhythm, same count — but every contact is on one side.
  const oneSided: KeepAliveContact[] = Array.from({ length: 10 }, (_, i) => ({
    t: 10.8 + i, side: "near" as const,
  }));
  const r = extendRalliesWhileLive([rally(1, 2, 10)], oneSided, 60);
  assert.equal(r.extended, 0);
  assert.equal(r.rallies[0].endS, 10);
});

test("stops once the alternation stops", () => {
  const contacts = [...dinks(10.8, 4), { t: 30, side: "far" as const }];
  const r = extendRalliesWhileLive([rally(1, 2, 10)], contacts, 60);
  // Last alternating contact ~13.8s, plus the 1.0s tail.
  assert.ok(r.rallies[0].endS > 14 && r.rallies[0].endS < 15.5, `got ${r.rallies[0].endS}`);
});

test("a gap longer than quietS ends it, even with alternation after", () => {
  const contacts = [
    { t: 10.5, side: "far" as const },
    { t: 20.0, side: "near" as const },   // 9.5s later — a different point
    { t: 21.0, side: "far" as const },
  ];
  const r = extendRalliesWhileLive([rally(1, 2, 10)], contacts, 60);
  assert.ok(r.rallies[0].endS < 13, `should not have jumped the gap, got ${r.rallies[0].endS}`);
});

test("never extends into the next rally", () => {
  const r = extendRalliesWhileLive(
    [rally(1, 2, 10), rally(2, 14, 25)],
    dinks(10.5, 20),      // alternating contacts straight through rally 2
    60
  );
  assert.ok(r.rallies[0].endS < r.rallies[1].startS,
    `${r.rallies[0].endS} must stay before ${r.rallies[1].startS}`);
  assert.equal(r.rallies.length, 2, "two points must not be merged into one");
});

test("is capped however long the alternation runs", () => {
  const r = extendRalliesWhileLive([rally(1, 2, 10)], dinks(10.5, 120), 300);
  assert.ok(r.rallies[0].endS <= 10 + KEEP_ALIVE_PARAMS.maxExtendS + 1e-6,
    `got ${r.rallies[0].endS}`);
});

test("never runs past the end of the clip", () => {
  const r = extendRalliesWhileLive([rally(1, 2, 10)], dinks(10.5, 40), 14);
  assert.ok(r.rallies[0].endS <= 14, `got ${r.rallies[0].endS}`);
});

test("contacts with no known side neither extend nor break the run", () => {
  const contacts: KeepAliveContact[] = [
    { t: 10.5, side: "far" },
    { t: 11.0, side: null },
    { t: 11.5, side: "near" },
    { t: 12.0, side: "far" },
  ];
  const r = extendRalliesWhileLive([rally(1, 2, 10)], contacts, 60);
  assert.ok(r.rallies[0].endS > 12.5, `got ${r.rallies[0].endS}`);
});

test("leaves a rally alone when nothing follows it", () => {
  const r = extendRalliesWhileLive([rally(1, 2, 10)], [], 60);
  assert.equal(r.extended, 0);
  assert.equal(r.addedSeconds, 0);
  assert.equal(r.rallies[0].endS, 10);
});

test("attaches the contacts that fall inside the extended window", () => {
  const r = extendRalliesWhileLive([rally(1, 2, 10)], dinks(10.8, 6), 60);
  assert.ok(r.rallies[0].contacts.length >= 6,
    `contacts should follow the new boundary, got ${r.rallies[0].contacts.length}`);
});
