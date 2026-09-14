import { test } from "node:test";
import assert from "node:assert/strict";
import { __testing } from "./month-plan";

const { assignTypes } = __testing;

import type { PlannedDrill } from "./month-plan";

const drill = (over: Partial<PlannedDrill> = {}): PlannedDrill => ({
  idx: 0, drillSlug: null, name: "drill", minutes: 20, how: "x", success: null, targets: null, ...over,
});

const type = (title: string, weight: number, kind = "practice") => ({
  title, kind: kind as "practice" | "match" | "rest" | "assessment",
  focus: null as string | null, weight,
  drills: [drill({ name: `${title} drill` })] as PlannedDrill[],
});

const dates = (n: number) => Array.from({ length: n }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);

test("every date gets exactly one session", () => {
  const got = assignTypes(dates(10), [type("A", 2), type("B", 1)]);
  assert.equal(got.length, 10);
  assert.deepEqual(got.map((s) => s.scheduledOn), dates(10));
});

test("weight decides how often a type recurs", () => {
  const got = assignTypes(dates(12), [type("Drops", 3), type("Hands", 1)]);
  const drops = got.filter((s) => s.title === "Drops").length;
  const hands = got.filter((s) => s.title === "Hands").length;
  assert.ok(drops > hands * 2, `expected drops to dominate, got ${drops} vs ${hands}`);
});

test("types are interleaved, not blocked — the second weakness is not ignored until week three", () => {
  const got = assignTypes(dates(12), [type("Drops", 3), type("Hands", 1)]);
  const firstHands = got.findIndex((s) => s.title === "Hands");
  assert.ok(firstHands >= 0 && firstHands < 5, `the second type first appears at session ${firstHands + 1}`);
});

test("an assessment is pinned to the last date, whatever its weight", () => {
  const got = assignTypes(dates(8), [type("Drops", 5), type("Test yourself", 1, "assessment")]);
  assert.equal(got[got.length - 1].kind, "assessment");
  assert.equal(got.filter((s) => s.kind === "assessment").length, 1,
    "an assessment must not also appear mid-month");
});

test("with a single date there is no room to pin an assessment at the end", () => {
  const got = assignTypes(dates(1), [type("Drops", 1), type("Test", 1, "assessment")]);
  assert.equal(got.length, 1);
});

test("an assessment-only plan still produces sessions rather than nothing", () => {
  const got = assignTypes(dates(3), [type("Test", 1, "assessment")]);
  assert.equal(got.length, 3);
});

test("session minutes are the sum of their drills", () => {
  const t = type("A", 1);
  t.drills = [drill({ minutes: 10 }), drill({ idx: 1, minutes: 15 })];
  assert.equal(assignTypes(dates(1), [t])[0].minutes, 25);
});

test("drills with no minutes give a null total, not a misleading zero", () => {
  const t = type("A", 1);
  t.drills = [drill({ minutes: null })];
  assert.equal(assignTypes(dates(1), [t])[0].minutes, null);
});

test("no dates means no sessions", () => {
  assert.deepEqual(assignTypes([], [type("A", 1)]), []);
});
