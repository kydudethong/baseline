import { test } from "node:test";
import assert from "node:assert/strict";
import { shotRowsFromAnalyst } from "./shot-rows";

const shot = (over: Partial<Parameters<typeof shotRowsFromAnalyst>[1][number]> = {}) => ({
  t: 1, rally_idx: 1, player: "Player 3", type: "dink", confidence: 0.8, ...over,
});

test("shot_idx is dense and ordered within each rally", () => {
  const rows = shotRowsFromAnalyst("a", [
    shot({ t: 9, rally_idx: 2 }), shot({ t: 1, rally_idx: 1 }),
    shot({ t: 5, rally_idx: 1 }), shot({ t: 12, rally_idx: 2 }),
  ]);
  const r1 = rows.filter((r) => r.rally_idx === 1).map((r) => r.shot_idx);
  const r2 = rows.filter((r) => r.rally_idx === 2).map((r) => r.shot_idx);
  assert.deepEqual(r1, [0, 1]);
  assert.deepEqual(r2, [0, 1]);
});

test("rows come out in time order regardless of input order", () => {
  const rows = shotRowsFromAnalyst("a", [shot({ t: 9 }), shot({ t: 2 }), shot({ t: 5 })]);
  assert.deepEqual(rows.map((r) => r.timestamp_s), [2, 5, 9]);
});

test("every shot type maps to a category the constraint allows", () => {
  const types = ["serve", "return", "third_shot_drop", "third_shot_drive", "dink", "drop",
    "reset", "drive", "volley", "speed_up", "overhead", "lob", "block", "unknown"];
  const allowed = new Set(["serve_return", "kitchen", "offense", "defense", "transition", "unknown"]);
  for (const t of types) {
    const [row] = shotRowsFromAnalyst("a", [shot({ type: t })]);
    assert.ok(allowed.has(row.category), `${t} produced category ${row.category}`);
  }
});

test("an unknown landing becomes 'unknown', never an invalid value", () => {
  const [row] = shotRowsFromAnalyst("a", [shot({ landing_depth: "somewhere near the fence" })]);
  assert.equal(row.landing_zone, "unknown");
});

test("'net' is an outcome, not a landing zone — the column would reject it", () => {
  const [row] = shotRowsFromAnalyst("a", [shot({ landing_depth: "net" })]);
  assert.equal(row.landing_zone, "unknown");
  assert.equal(row.outcome, "net");
});

test("'out' lands in both, because it is both", () => {
  const [row] = shotRowsFromAnalyst("a", [shot({ landing_depth: "out" })]);
  assert.equal(row.landing_zone, "out");
  assert.equal(row.outcome, "out");
});

test("confidence is clamped into 0-1 rather than failing the insert", () => {
  assert.equal(shotRowsFromAnalyst("a", [shot({ confidence: 7 })])[0].confidence, 1);
  assert.equal(shotRowsFromAnalyst("a", [shot({ confidence: -3 })])[0].confidence, 0);
  assert.equal(shotRowsFromAnalyst("a", [shot({ confidence: NaN })])[0].confidence, 0.5);
});

test("landing side is kept in features rather than invented into a column", () => {
  const [row] = shotRowsFromAnalyst("a", [shot({ landing_side: "left" })]);
  assert.deepEqual(row.features, { landing_side: "left" });
});

test("shots with a nonsense timestamp are dropped, not stored at zero", () => {
  const rows = shotRowsFromAnalyst("a", [shot({ t: NaN }), shot({ t: -5 }), shot({ t: 3 })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].timestamp_s, 3);
});

test("hit_zone is 'unknown' because nothing asks the model where the hitter stood", () => {
  assert.equal(shotRowsFromAnalyst("a", [shot()])[0].hit_zone, "unknown");
});
