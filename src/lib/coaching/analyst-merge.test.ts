import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeAnalystOutputs } from "./analyst-merge";
import type { AnalystOutput } from "./analyst";

const base = (over: Partial<AnalystOutput> = {}): AnalystOutput => ({
  rallies: [], shots: [], observations: [], skills: [], drills: [],
  playstyle: { summary: "s", tendencies: [], under_pressure: "u" },
  coaching: {
    headline: "h", summary: "s", strengths: [],
    top_priority_fix: { issue: "i", why_it_matters: "w", evidence: "e" }, secondary: [],
  },
  data_gaps: null,
  ...over,
});

const rally = (idx: number, start_s: number, end_s: number) => ({
  idx, start_s, end_s, end_reason: "winner", winner: null, confidence: 0.8,
});
const shot = (t: number, rally_idx: number) => ({
  t, rally_idx, player: "Player 3", type: "dink" as const, confidence: 0.8,
});

test("a single segment passes through untouched", () => {
  const one = base({ rallies: [rally(1, 0, 10)], shots: [shot(3, 1)] });
  assert.deepEqual(mergeAnalystOutputs([one]), one);
});

test("every segment's 'rally 1' becomes a different rally", () => {
  // THE bug this file exists to prevent: three segments each number from 1, so
  // a naive merge collapses three points into one.
  const a = base({ rallies: [rally(1, 5, 15)], shots: [shot(7, 1)] });
  const b = base({ rallies: [rally(1, 205, 215)], shots: [shot(208, 1)] });
  const c = base({ rallies: [rally(1, 405, 415)], shots: [shot(409, 1)] });
  const got = mergeAnalystOutputs([a, b, c]);
  assert.equal(got.rallies.length, 3);
  assert.deepEqual(got.rallies.map((r) => r.idx), [1, 2, 3]);
});

test("rallies come out in clip order even when segments arrive out of order", () => {
  const late = base({ rallies: [rally(1, 400, 410)] });
  const early = base({ rallies: [rally(1, 10, 20)] });
  const got = mergeAnalystOutputs([late, early]);
  assert.deepEqual(got.rallies.map((r) => r.start_s), [10, 400]);
  assert.deepEqual(got.rallies.map((r) => r.idx), [1, 2]);
});

test("shots are re-pointed at the renumbered rally by TIME, not by the index they carried", () => {
  const a = base({ rallies: [rally(1, 0, 10)], shots: [shot(5, 1)] });
  const b = base({ rallies: [rally(1, 100, 110)], shots: [shot(105, 1)] });
  const got = mergeAnalystOutputs([a, b]);
  assert.equal(got.shots.find((s) => s.t === 5)!.rally_idx, 1);
  assert.equal(got.shots.find((s) => s.t === 105)!.rally_idx, 2);
});

test("a shot inside no rally is kept, with rally 0 — it is still a contact", () => {
  const a = base({ rallies: [rally(1, 0, 10)], shots: [shot(5, 1), shot(50, 1)] });
  const b = base({ rallies: [rally(1, 100, 110)] });
  const got = mergeAnalystOutputs([a, b]);
  assert.equal(got.shots.length, 2);
  assert.equal(got.shots.find((s) => s.t === 50)!.rally_idx, 0);
});

test("shots come out in time order", () => {
  const a = base({ rallies: [rally(1, 0, 200)], shots: [shot(90, 1), shot(10, 1)] });
  const b = base({ rallies: [rally(1, 201, 400)], shots: [shot(300, 1)] });
  assert.deepEqual(mergeAnalystOutputs([a, b]).shots.map((s) => s.t), [10, 90, 300]);
});

test("an observation with a shot time is re-pointed; one without loses its rally rather than guessing", () => {
  const obs = (shot_t: number | null, rally_idx: number | null) => ({
    rally_idx, shot_t, skill_key: "dinking", coaching_dimension: "technique" as never,
    valence: "weakness" as const, title: "t", detail: "d", severity: 3,
    why_it_matters: null, what_to_change: null, drill_slug: null,
  });
  const a = base({ rallies: [rally(1, 0, 10)], observations: [obs(5, 1)] });
  const b = base({ rallies: [rally(1, 100, 110)], observations: [obs(null, 1)] });
  const got = mergeAnalystOutputs([a, b]);
  assert.equal(got.observations.find((o) => o.shot_t === 5)!.rally_idx, 1);
  assert.equal(got.observations.find((o) => o.shot_t === null)!.rally_idx, null,
    "a rally index from another segment must not be trusted");
});

test("the same skill rated in two segments is averaged, not overwritten", () => {
  const a = base({ skills: [{ skill_key: "dinking", rating: 4, basis: "early" }] });
  const b = base({ skills: [{ skill_key: "dinking", rating: 2, basis: "late" }] });
  const got = mergeAnalystOutputs([a, b]);
  assert.equal(got.skills.length, 1);
  assert.equal(got.skills[0].rating, 3);
  assert.match(got.skills[0].basis, /early/);
  assert.match(got.skills[0].basis, /late/);
});

test("drills are de-duplicated by slug so the same one is not suggested twice", () => {
  const d = { slug: "dink-cross", name: "Cross dinks", targets: "dinking", reps_or_duration: "10 min" };
  const got = mergeAnalystOutputs([base({ drills: [d] }), base({ drills: [d] })]);
  assert.equal(got.drills.length, 1);
});

test("inverted or non-finite rallies are dropped rather than renumbered", () => {
  const a = base({ rallies: [rally(1, 10, 5), rally(2, 20, 30)] });
  const b = base({ rallies: [rally(1, 100, 110)] });
  const got = mergeAnalystOutputs([a, b]);
  assert.equal(got.rallies.length, 2);
  assert.ok(got.rallies.every((r) => r.end_s > r.start_s));
});

test("data gaps from every segment survive", () => {
  const got = mergeAnalystOutputs([base({ data_gaps: "far court dark" }), base({ data_gaps: "net obscured" })]);
  assert.match(got.data_gaps!, /far court dark/);
  assert.match(got.data_gaps!, /net obscured/);
});

test("merging nothing is an error, not a silently empty analysis", () => {
  assert.throws(() => mergeAnalystOutputs([]));
});

test("rallies past the end of the clip are dropped, not renumbered", () => {
  // The real failure: one run returned seven rallies between 506s and 725s of
  // a 446-second video. The audit reported them and they were stored anyway.
  const one = base({
    rallies: [rally(1, 10, 20), rally(2, 506, 512), rally(3, 620, 634)],
    shots: [shot(15, 1), shot(508, 2)],
  });
  const got = mergeAnalystOutputs([one], 446);
  assert.equal(got.rallies.length, 1);
  assert.equal(got.rallies[0].start_s, 10);
});

test("a single segment is still filtered — it hallucinates too", () => {
  const one = base({ rallies: [rally(1, 900, 910)] });
  assert.equal(mergeAnalystOutputs([one], 446).rallies.length, 0);
});

test("a rally ending exactly at the final second survives", () => {
  const one = base({ rallies: [rally(1, 440, 446)] });
  assert.equal(mergeAnalystOutputs([one], 446).rallies.length, 1);
});

test("with no clip length given, nothing is filtered on time", () => {
  const one = base({ rallies: [rally(1, 900, 910)] });
  assert.equal(mergeAnalystOutputs([one]).rallies.length, 1);
});

test("a shot whose rally was dropped keeps counting as a contact", () => {
  const one = base({ rallies: [rally(1, 10, 20)], shots: [shot(15, 1), shot(508, 2)] });
  const got = mergeAnalystOutputs([one], 446);
  assert.equal(got.shots.length, 2, "a contact is still a contact");
  assert.equal(got.shots.find((s) => s.t === 508)!.rally_idx, 0);
});
