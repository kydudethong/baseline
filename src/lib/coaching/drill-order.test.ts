import test from "node:test";
import assert from "node:assert/strict";
import { prescribedDrills } from "../../components/analysis/DrillCards";
import type { CoachingObservationRow } from "../db/types";

const obs = (title: string, drill_slug: string | null, severity: number) =>
  ({ id: title, title, drill_slug, severity } as unknown as CoachingObservationRow);

test("drill 1 is the fix for the most severe problem", () => {
  const d = prescribedDrills([obs("minor", "a", 0.2), obs("major", "b", 0.9)]);
  assert.equal(d[0].slug, "b");
});

test("one drill that fixes two things is listed once, with both reasons", () => {
  const d = prescribedDrills([obs("straight legs", "dink-low", 0.8), obs("popping up dinks", "dink-low", 0.6)]);
  assert.equal(d.length, 1);
  assert.deepEqual(d[0].fixes, ["straight legs", "popping up dinks"]);
});

test("a strength with no drill is not a drill", () => {
  assert.deepEqual(prescribedDrills([obs("great resets", null, 0.1)]), []);
});
