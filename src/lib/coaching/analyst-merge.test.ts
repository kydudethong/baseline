import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeAnalystOutputs } from "./analyst-merge";
import type { AnalystOutput } from "./analyst";

const base = (over: Partial<AnalystOutput> = {}): AnalystOutput => ({
  rallies: [], shots: [], observations: [], skills: [], drills: [],
  playstyle: { summary: "s", tendencies: [], under_pressure: "u" },
  coaching: {
    headline: "h", summary: "s", strengths: [],
    top_priority_fix: { issue: "i", why_it_matters: "w", evidence: "e", at_s: null }, secondary: [],
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

test("a rally cut in half by a segment boundary is rejoined", () => {
  // THE CAUSE OF "RALLIES ARE GETTING CUT SHORT". A long match is watched in
  // segments; a point straddling a boundary comes back as two rallies, the
  // first ending where the footage ran out and the second starting mid-point.
  // Nothing put them back together, so the rally count came out one too high
  // per boundary and every per-rally average with it.
  const a = base({ rallies: [
    { idx: 1, start_s: 10, end_s: 30, end_reason: "segment ended", winner: null, confidence: 0.4 },
  ]});
  const b = base({ rallies: [
    { idx: 1, start_s: 30.2, end_s: 38, end_reason: "into the net", winner: "player_2", confidence: 0.9 },
  ]});
  const out = mergeAnalystOutputs([a, b], 60);
  assert.equal(out.rallies.length, 1, "the two halves were kept as two points");
  assert.equal(out.rallies[0].start_s, 10);
  assert.equal(out.rallies[0].end_s, 38);
  // The later half is the one that saw the point end; "segment ended" is not
  // a thing that happens in pickleball.
  assert.equal(out.rallies[0].end_reason, "into the net");
  assert.equal(out.rallies[0].confidence, 0.4, "a point seen in halves was seen clearly by neither");
});

test("two genuinely separate points are left alone", () => {
  // The guard. Joining everything would be worse than joining nothing: the
  // rally count would collapse and long "rallies" would swallow the dead time
  // between points.
  const a = base({ rallies: [
    { idx: 1, start_s: 10, end_s: 20, end_reason: "out", winner: null, confidence: 0.8 },
    { idx: 2, start_s: 26, end_s: 34, end_reason: "net", winner: null, confidence: 0.8 },
  ]});
  const out = mergeAnalystOutputs([a], 60);
  assert.equal(out.rallies.length, 2);
  assert.deepEqual(out.rallies.map((r) => r.idx), [1, 2]);
});

test("shots follow the rally they were rejoined into", () => {
  // Renumbering after stitching, not before: a shot pointing at rally 2 in a
  // world where rally 2 no longer exists is worse than an unnumbered one.
  const a = base({
    rallies: [{ idx: 1, start_s: 10, end_s: 30, end_reason: "cut", winner: null, confidence: 0.5 }],
    shots: [{ t: 12, rally_idx: 1, player: "player_1", type: "serve", confidence: 0.8 }],
  });
  const b = base({
    rallies: [{ idx: 1, start_s: 30.4, end_s: 38, end_reason: "out", winner: null, confidence: 0.8 }],
    shots: [{ t: 35, rally_idx: 1, player: "player_2", type: "drive", confidence: 0.8 }],
  });
  const out = mergeAnalystOutputs([a, b], 60);
  assert.equal(out.rallies.length, 1);
  assert.deepEqual(out.shots.map((sh) => sh.rally_idx), [1, 1]);
});

const obs = (over: Partial<AnalystOutput["observations"][number]> = {}) => ({
  rally_idx: null, shot_t: null, skill_key: "dinking",
  coaching_dimension: "kitchen_game" as const, valence: "weakness" as const,
  title: "t", detail: "", severity: 3,
  why_it_matters: null, what_to_change: null, drill_slug: null,
  ...over,
});

test("one fault written up by four segments becomes one observation", () => {
  // REPORTED FROM A REAL READ. Four observations came back, all of them "knees
  // too straight, bend to 125-140 degrees" in different words. Segments are
  // blind to each other — a postural habit is visible in every two-minute
  // stretch — and merging was a flatMap, so every copy reached the page.
  const parts = [
    base({ observations: [obs({ title: "Knees standing too tall during kitchen exchanges",
      what_to_change: "Hinge at the hips and lower your knees to roughly 130-140 degrees", severity: 3 })] }),
    base({ observations: [obs({ title: "Straight-leg posture on low kitchen contact",
      what_to_change: "Drop your hips into an athletic crouch with knees bent around 125 to 135", severity: 4 })] }),
    base({ observations: [obs({ title: "Straight-legged kitchen exchanges",
      what_to_change: "Hinge at the hips and bend knees under 140 degrees", severity: 2 })] }),
  ];
  const out = mergeAnalystOutputs(parts, 600);
  assert.equal(out.observations.length, 1, `kept ${out.observations.length}: `
    + out.observations.map((o) => o.title).join(" | "));
  // The clearest sighting wins, so the reader gets the strongest wording.
  assert.equal(out.observations[0].severity, 4);
});

test("two different faults about the same skill both survive", () => {
  // THE GUARD, and the reason tags alone are not enough to dedupe on. Standing
  // too tall and reaching instead of moving your feet are both dinking, both
  // kitchen_game, both weaknesses — and they are two corrections a player can
  // act on separately.
  const parts = [base({ observations: [
    obs({ title: "Knees too straight at the kitchen",
      what_to_change: "Bend your knees to 130 degrees and stay compressed" }),
    obs({ title: "Reaching for wide dinks instead of moving",
      what_to_change: "Take a side step so the ball stays in front of your body" }),
  ] })];
  const out = mergeAnalystOutputs(parts, 600);
  assert.equal(out.observations.length, 2);
});

test("a strength and a weakness about one skill are never merged", () => {
  const parts = [base({ observations: [
    obs({ title: "Soft hands at the kitchen", valence: "strength",
      what_to_change: "Keep the paddle face open on low contact" }),
    obs({ title: "Soft hands at the kitchen", valence: "weakness",
      what_to_change: "Keep the paddle face open on low contact" }),
  ] })];
  assert.equal(mergeAnalystOutputs(parts, 600).observations.length, 2);
});

test("two real findings that happen to share words are not merged", () => {
  // THE BOUNDARY THIS SITS ON, and the reason the threshold cannot simply be
  // lowered until the duplicates disappear. These two are different
  // corrections — posture, and how hard the dinks are hit — and they score
  // 0.25 against each other, which is EXACTLY what two of the four real
  // duplicates scored. The chain is what tells them apart: paraphrases of one
  // fault are linked through a third phrasing, and these two are not linked to
  // anything.
  const parts = [
    base({ observations: [obs({ title: "Knees too straight during kitchen exchanges",
      what_to_change: "Bend your knees to 130 degrees at the kitchen line" })] }),
    base({ observations: [obs({ title: "Kitchen dinks floating above net height",
      what_to_change: "Take pace off so the ball lands below their knees" })] }),
  ];
  const out = mergeAnalystOutputs(parts, 600);
  assert.equal(out.observations.length, 2,
    "two separate corrections were collapsed into one — the threshold is too loose");
});

test("five straight-leg findings filed under five skills become one", () => {
  // REPORTED FROM A REAL READ, verbatim titles. Each carried a different skill
  // key, so the wording pass could never touch them: it only compares findings
  // within one skill. The family is what says these are one correction.
  const titles = [
    "Straight-leg contact on return of serve",
    "Straight-Legged Third Shot Drop",
    "Straight-Legged Posture on Low Dink Contacts",
    "Straight-Legged Posture on Low Contact",
    "Stiff-Legged Kitchen Ready Position",
  ];
  const skills = ["return", "third_shot", "dinking", "net_play", "ready_position"];
  const parts = [base({ observations: titles.map((title, i) => obs({
    title, skill_key: skills[i], fault_family: "posture_and_base",
    severity: i === 1 ? 5 : 3, detail: `${title} detail`,
  })) })];
  const out = mergeAnalystOutputs(parts);
  assert.equal(out.observations.length, 1, out.observations.map((o) => o.title).join(" | "));
  assert.equal(out.observations[0].title, "Straight-Legged Third Shot Drop", "the costliest one leads");
  // And the others are not simply lost: where else it happened is the useful part.
  assert.match(out.observations[0].detail, /same fault showed up elsewhere/i);
  assert.match(out.observations[0].detail, /return of serve/i);
});

test("different families stay, even when they share a skill", () => {
  const parts = [base({ observations: [
    obs({ title: "Straight legs on low dinks", skill_key: "dinking", fault_family: "posture_and_base" }),
    obs({ title: "Driving balls that should be reset", skill_key: "dinking", fault_family: "shot_selection" }),
    obs({ title: "Standing a metre off the kitchen line", skill_key: "dinking", fault_family: "court_position" }),
  ] })];
  const out = mergeAnalystOutputs(parts);
  assert.equal(out.observations.length, 3);
});

test("strengths in one family are not collapsed into each other", () => {
  // Two good things about the same part of the game are two good things.
  const parts = [base({ observations: [
    obs({ title: "Balanced at contact on drives", valence: "strength", skill_key: "drives", fault_family: "posture_and_base" }),
    obs({ title: "Low and steady through dink exchanges", valence: "strength", skill_key: "dinking", fault_family: "posture_and_base" }),
  ] })];
  assert.equal(mergeAnalystOutputs(parts).observations.length, 2);
});
