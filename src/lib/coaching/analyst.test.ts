import assert from "node:assert/strict";
import test from "node:test";

import { OVERLAY_LEGEND } from "./overlay-legend";
import { auditAnalysis, analystSchema, analystPrompt, type AnalystInput, type AnalystOutput, analystOutputBudget, THINKING_ALLOWANCE, MAX_OUTPUT_TOKENS } from "./analyst";
import { sanitiseSchema } from "./gemini";

function input(over: Partial<AnalystInput> = {}): AnalystInput {
  return {
    clipSeconds: 101.3,
    subjectPlayerId: "player_2",
    ballCoverage: 0.28,
    courtConfidence: 0.735,
    contacts: [
      { t: 3.96, player: "player_1", hit_from: { x_ft: 5.5, y_ft: 9.3 } },
      { t: 12.4, player: "player_2", hit_from: { x_ft: 11.0, y_ft: 16.2 },
        body: { kneeAngleAtContactDeg: 172 } },
    ],
    skillLevel: "3.5",
    focusArea: null,
    drillCatalogue: [{ slug: "dink-cross", name: "Cross-court dinks", skill: "dinking" }],
    knownLimitations: [],
    ...over,
  };
}

const clean: AnalystOutput = {
  rallies: [{ idx: 1, start_s: 3.5, end_s: 14.0, end_reason: "into the net", winner: null, confidence: 0.8 }],
  shots: [
    { t: 3.96, rally_idx: 1, player: "player_1", type: "serve", confidence: 0.7 },
    { t: 12.4, rally_idx: 1, player: "player_2", type: "dink", confidence: 0.6 },
  ],
  playstyle: { summary: "patient", tendencies: [], under_pressure: "resets" },
  skills: [{ skill_key: "dinking", rating: 6, basis: "four dinks in rally 1" }],
  coaching: {
    headline: "Bend more on dinks", summary: "", strengths: [],
    top_priority_fix: { issue: "straight legs on dinks", why_it_matters: "", evidence: "172° at 12.4s" },
    secondary: [],
  },
  observations: [{
    rally_idx: 1, shot_t: 12.4, skill_key: "dinking",
    coaching_dimension: "kitchen_game", valence: "weakness",
    title: "Straight legs", detail: "", severity: 0.6,
    why_it_matters: null, what_to_change: null, drill_slug: "dink-cross",
  }],
  drills: [{ slug: "dink-cross", name: "Cross-court dinks", targets: "dinking", reps_or_duration: "10 min" }],
  data_gaps: null,
};

test("a well-formed analysis produces no problems", () => {
  assert.deepEqual(auditAnalysis(clean, input()), []);
});

test("a rally outside the clip is caught", () => {
  // The real failure this exists for: on ky-720p the model returned rallies at
  // 119s and 131s in a 101.3s clip. Inventing time is not a fuzzy boundary,
  // it means the model lost track of where it was.
  const out = structuredClone(clean);
  out.rallies.push({ idx: 2, start_s: 119, end_s: 124, end_reason: "out", winner: null, confidence: 0.5 });
  const problems = auditAnalysis(out, input());
  assert.equal(problems.length, 1);
  assert.match(problems[0], /outside a 101.3s clip/);
});

test("a shot nowhere near any measured contact is caught", () => {
  const out = structuredClone(clean);
  out.shots.push({ t: 55.5, rally_idx: 1, player: "player_2", type: "drive", confidence: 0.4 });
  assert.ok(auditAnalysis(out, input()).some((p) => /from any measured contact/.test(p)));
});

test("a shot a frame away from a measured contact is NOT caught", () => {
  // THE TOLERANCE IS THE POINT. Contacts come from wrist-speed peaks in pose
  // sampled at 5fps, so a contact between two samples is reported up to a
  // tenth of a second out before anything else goes wrong, while the model
  // reads the shot off the video. Demanding they agree to 10ms -- which the
  // exact-equality version of this check did -- would flag nearly every
  // correct shot, and an audit that cries wolf is worse than no audit.
  const near = structuredClone(clean);
  near.shots = [{ ...clean.shots[0], t: clean.shots[0].t + 0.12 }];
  assert.deepEqual(
    auditAnalysis(near, input()).filter((p) => /measured contact/.test(p)),
    []
  );
});

test("a contact the model gave no shot type is NOT a problem", () => {
  // It used to be, and it was right to be when contacts came from a tracked
  // ball: a contact with no shot against it meant the model skipped something
  // it was shown. From wrist speed it usually means a hard fake, a practice
  // swing between points, or one stroke sampled either side of its peak.
  const out = structuredClone(clean);
  out.shots = [out.shots[0]];
  assert.deepEqual(auditAnalysis(out, input()).filter((p) => /no shot type/.test(p)), []);
});

test("a drill slug that does not exist is caught, in both places it can appear", () => {
  // The catalogue is passed in precisely so a cited slug resolves. An invented
  // one would be dropped silently on persist, and the coaching would reference
  // a drill the user cannot open.
  const out = structuredClone(clean);
  out.drills[0].slug = "made-up-drill";
  out.observations[0].drill_slug = "also-made-up";
  const problems = auditAnalysis(out, input());
  assert.ok(problems.some((p) => p.includes("made-up-drill")));
  assert.ok(problems.some((p) => p.includes("also-made-up")));
});

test("claims about the paddle are caught wherever they appear", () => {
  const out = structuredClone(clean);
  out.playstyle.summary = "keeps the paddle face open through contact";
  assert.ok(auditAnalysis(out, input()).some((p) => /paddle face/.test(p)));
});

test("the schema survives the Gemini dialect conversion", () => {
  // analystSchema uses nullable: true directly. If a future edit slips in a
  // ["string","null"] it must still reach the wire correctly — and nothing
  // may carry additionalProperties, which Gemini rejects outright.
  const sanitised = sanitiseSchema(analystSchema());
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    assert.ok(!Array.isArray(obj.type), `list-typed field at ${path}`);
    assert.ok(!("additionalProperties" in obj), `additionalProperties at ${path}`);
    for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`);
  };
  walk(sanitised, "$");
});

test("the prompt states the clip length and never leaks our rallies", () => {
  const p = analystPrompt(input(), "LEGEND", null, true);
  assert.ok(p.includes("LEGEND"), "the legend is part of the prompt");
  assert.ok(p.includes("2 contacts"), "says how much was measured");
  assert.ok(p.includes("dink-cross"), "the drill catalogue is included");
  // The answers under test must not be in there.
  assert.ok(!/rally_idx["\s:]*\d/.test(p), "no rally assignment leaked");
  assert.ok(!p.includes('"type":"dink"'), "no shot type leaked");
});

test("the prompt asks for the scales the database actually stores", () => {
  // coaching_skill_ratings.raw and coaching_observations.severity are both
  // clamped 1-5 on persist. Asking the model for 1-10 would have collapsed
  // every rating above 5 into "5" — turning a 6 and a 10 into the same
  // "strength", silently, forever.
  const p = analystPrompt(input(), "LEGEND", null, true);
  assert.match(p, /SKILL RATINGS 1-5/);
  assert.match(p, /severity 1-5/);
  assert.ok(!/1-10/.test(p), "no 1-10 scale anywhere in the prompt");
});

test("observations must cite a measured contact time, and the prompt says so", () => {
  const p = analystPrompt(input(), "LEGEND", null, true);
  assert.match(p, /not a time you chose/);
});

test("the output budget covers thinking as well as the answer", () => {
  // The measured failure: a fixed 16,000, of which 9,473 went on thinking
  // before a character of the answer was written. Anything at or below the
  // thinking cost cannot work, whatever the clip.
  assert.ok(THINKING_ALLOWANCE > 9473, "the allowance must clear a measured 9,473-token thought");
  for (const seconds of [10, 60, 120, 155, 600]) {
    const budget = analystOutputBudget(seconds);
    assert.ok(budget > THINKING_ALLOWANCE, `${seconds}s left no room for output`);
    assert.ok(budget <= MAX_OUTPUT_TOKENS, `${seconds}s exceeded the model's ceiling`);
  }
});

test("a longer segment gets more room than a shorter one", () => {
  assert.ok(analystOutputBudget(150) > analystOutputBudget(30));
});

test("a nonsense duration falls back rather than asking for zero room", () => {
  assert.ok(analystOutputBudget(0) > THINKING_ALLOWANCE);
  assert.ok(analystOutputBudget(Number.NaN) > THINKING_ALLOWANCE);
});

test("with a still attached, the prompt says which source wins", () => {
  // THE CONFLICT IS THE POINT. The model is told who the subject is twice —
  // by a fixed marked still and by per-frame boxes that can swap during an
  // overlap. Telling it both without saying which to believe leaves it to
  // pick, silently, exactly where the tracker is least reliable.
  const p = analystPrompt(input(), "LEGEND", null, true);
  assert.match(p, /TRUST THE STILL/);
  assert.match(p, /report the\nconflict/);
});

test("with no still, the boxes are presented as a guess rather than an answer", () => {
  // Nobody has confirmed who the subject is, so the label on the box is the
  // pipeline's opinion. A read that says "you" as though that were settled is
  // indistinguishable from one where somebody actually confirmed it.
  const p = analystPrompt(input(), "LEGEND", null, false);
  assert.match(p, /NO STILL WAS SUPPLIED/);
  assert.match(p, /best guess/i);
  assert.doesNotMatch(p, /TRUST THE STILL/);
});

test("the prompt and the renderer agree about what is drawn", () => {
  // THIS HAS GONE WRONG TWICE: the prompt described a ball path after ball
  // tracking was removed, and a gold YOU box after the boxes came off the
  // overlay. Each time the model hunted for an absent mark and reported the
  // absence as a finding about the footage. The boxes are drawn again now, so
  // what must not appear is the opposite claim.
  for (const has of [true, false]) {
    const p = analystPrompt(input(), "LEGEND", null, has);
    assert.doesNotMatch(p, /no boxes/i);
    assert.doesNotMatch(p, /ball path/i);
  }
});

test("the legend does not promise marks the renderer stopped drawing", () => {
  // The legend is a promise about pixels and has twice outlived the renderer.
  // These two claims were true for exactly one commit each.
  assert.doesNotMatch(OVERLAY_LEGEND, /no box, no id, no name/i);
  assert.doesNotMatch(OVERLAY_LEGEND, /Orange line.*ball's path/i);
  // And the things it SHOULD say now, since the boxes are back and the court
  // gate is what keeps spectators out of them.
  assert.match(OVERLAY_LEGEND, /Gold box labelled "You"/);
  assert.match(OVERLAY_LEGEND, /outside the court/i);
  // The tie-break, which is the only instruction that makes two sources of
  // truth better than one. Without it the model picks, silently, in exactly
  // the frames where the tracker is least reliable.
  assert.match(OVERLAY_LEGEND, /trust the still over the boxes/i);
});
