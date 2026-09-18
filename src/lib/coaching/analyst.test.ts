import assert from "node:assert/strict";
import test from "node:test";

import { OVERLAY_LEGEND } from "./overlay-legend";
import { ANALYST_FPS, auditAnalysis, analystSchema, analystPrompt, type AnalystInput, type AnalystOutput, analystOutputBudget, THINKING_ALLOWANCE, MAX_OUTPUT_TOKENS } from "./analyst";
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
    top_priority_fix: { issue: "straight legs on dinks", why_it_matters: "", evidence: "172° at 12.4s", at_s: 12.4 },
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

test("overlapping rallies are caught — a ball cannot be in two points at once", () => {
  const out = structuredClone(clean);
  out.rallies.push({ idx: 2, start_s: 10.0, end_s: 20.0, end_reason: "out", winner: null, confidence: 0.5 });
  assert.ok(auditAnalysis(out, input()).some((p) => /overlap/.test(p)));
});

test("two rallies a heartbeat apart are flagged as one rally split", () => {
  // Between points somebody retrieves the ball, walks back and serves. Under a
  // second and a half is not that — it is one point cut in half where the ball
  // left frame, which inflates the rally count and every per-rally average.
  const out = structuredClone(clean);
  out.rallies.push({ idx: 2, start_s: 14.3, end_s: 20.0, end_reason: "out", winner: null, confidence: 0.5 });
  assert.ok(auditAnalysis(out, input()).some((p) => /may be one rally split in two/.test(p)));
});

test("a normal gap between points is not flagged", () => {
  // The guard. An audit that fires on ordinary footage trains the reader to
  // ignore it, which is worse than having no audit at all.
  const out = structuredClone(clean);
  out.rallies.push({ idx: 2, start_s: 22.0, end_s: 30.0, end_reason: "out", winner: null, confidence: 0.5 });
  const withContacts = input({
    clipSeconds: 40,
    contacts: [...clean.shots.map((sh) => ({ t: sh.t, player: sh.player, hit_from: undefined })),
               { t: 24.0, player: "player_1", hit_from: undefined }],
  });
  assert.deepEqual(auditAnalysis(out, withContacts).filter((p) => /rally/.test(p)), []);
});

test("swings measured where the model saw no rally are reported", () => {
  // THE ONE INDEPENDENT CHECK ON RALLY BOUNDARIES. Wrist-speed contacts come
  // out of the pose stream before the model sees the clip, and the model is
  // told their timing is loose and that fakes appear in them — so it does not
  // place boundaries from them. Arms swinging through a stretch it called dead
  // time is therefore real evidence that a point was missed, not an echo.
  const out = structuredClone(clean);
  const busy = input({
    contacts: [
      { t: 3.96, player: "player_1", hit_from: undefined },
      { t: 40.0, player: "player_2", hit_from: undefined },
      { t: 42.0, player: "player_1", hit_from: undefined },
      { t: 44.0, player: "player_2", hit_from: undefined },
      { t: 46.0, player: "player_1", hit_from: undefined },
    ],
    clipSeconds: 60,
  });
  assert.ok(auditAnalysis(out, busy).some((p) => /fall outside every rally/.test(p)),
    "a whole point's worth of swings outside the rallies went unreported");
});

test("a few stray swings between points are NOT reported", () => {
  // Practice swings in dead time are exactly what a wrist-speed detector
  // finds, and flagging them would fire on every clip.
  const out = structuredClone(clean);
  const normal = input({
    contacts: [
      { t: 4.0, player: "player_1", hit_from: undefined },
      { t: 6.0, player: "player_2", hit_from: undefined },
      { t: 8.0, player: "player_1", hit_from: undefined },
      { t: 10.0, player: "player_2", hit_from: undefined },
      { t: 19.0, player: "player_1", hit_from: undefined },
    ],
    clipSeconds: 30,
  });
  assert.deepEqual(auditAnalysis(out, normal).filter((p) => /outside every rally/.test(p)), []);
});

test("a rally in which nobody's arm moved is reported", () => {
  const out = structuredClone(clean);
  out.rallies.push({ idx: 2, start_s: 40.0, end_s: 50.0, end_reason: "out", winner: null, confidence: 0.5 });
  const withContacts = input({ clipSeconds: 60 });
  assert.ok(auditAnalysis(out, withContacts).some((p) => /no measured swing at all/.test(p)));
});

test("a rally longer than a rec point usually lasts is questioned", () => {
  const out = structuredClone(clean);
  out.rallies = [{ idx: 1, start_s: 3.5, end_s: 90.0, end_reason: "out", winner: null, confidence: 0.4 }];
  assert.ok(auditAnalysis(out, input({ clipSeconds: 120 })).some((p) => /two points merged/.test(p)));
});

test("a rally outside the clip is caught", () => {
  // The real failure this exists for: on ky-720p the model returned rallies at
  // 119s and 131s in a 101.3s clip. Inventing time is not a fuzzy boundary,
  // it means the model lost track of where it was.
  const out = structuredClone(clean);
  out.rallies.push({ idx: 2, start_s: 119, end_s: 124, end_reason: "out", winner: null, confidence: 0.5 });
  const problems = auditAnalysis(out, input());
  // It also, correctly, has no measured swing in it — a rally invented outside
  // the clip cannot. Assert the finding that matters rather than the count.
  assert.ok(problems.some((p) => /outside a 101.3s clip/.test(p)));
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

test("the prompt tells the model the rate it is actually being shown", () => {
  // IT SAID 5 AND LOW RESOLUTION for a long time while the run was sending 8
  // and high — a number typed into the prose beside a constant that moved
  // without it. What the model believes about its own sampling rate decides
  // how much it is willing to claim from the footage, so a stale figure here
  // makes it either over- or under-confident for reasons nobody can see.
  const p = analystPrompt(input(), "LEGEND", null, true);
  assert.match(p, new RegExp(`watching at ${ANALYST_FPS}\\s*\\n?\\s*frames per second`));
  assert.doesNotMatch(p, /watching at 5\b/);
});

test("a criticism citing a moment where nothing happened is caught", () => {
  // THE POINT OF CITING A MOMENT AT ALL. The seconds named here are played
  // back to the player beside the sentence. Four seconds showing nothing makes
  // a correct criticism look invented, and the reasonable conclusion from
  // that is that the whole read is guesswork.
  const out = structuredClone(clean);
  out.coaching.top_priority_fix.at_s = 55.0;
  assert.ok(auditAnalysis(out, input()).some((p) => /the priority fix cites 55.0s, where no swing was measured/.test(p)));
});

test("a criticism citing a real swing passes", () => {
  const out = structuredClone(clean);
  out.coaching.top_priority_fix.at_s = 12.4;
  assert.deepEqual(auditAnalysis(out, input()).filter((p) => /priority fix/.test(p)), []);
});

test("a criticism about a passage rather than an instant is allowed", () => {
  // "You backed off the kitchen line here" covers a couple of seconds of
  // movement, not one contact. Demanding contact-level precision would flag
  // the positional criticism that is often the most useful kind.
  const out = structuredClone(clean);
  out.coaching.top_priority_fix.at_s = 10.8; // 1.6s from the 12.4s contact
  assert.deepEqual(auditAnalysis(out, input()).filter((p) => /priority fix/.test(p)), []);
});

test("a criticism that honestly places nothing is not punished", () => {
  // Null is an allowed, honest answer — better than a number that sends
  // somebody to the wrong four seconds. Flagging it would push the model to
  // invent a timestamp to satisfy the audit.
  const out = structuredClone(clean);
  out.coaching.top_priority_fix.at_s = null;
  assert.deepEqual(auditAnalysis(out, input()).filter((p) => /priority fix/.test(p)), []);
});

test("secondary points are checked too, and named individually", () => {
  const out = structuredClone(clean);
  out.coaching.secondary = [
    { issue: "ok", evidence: "", at_s: 3.96 },
    { issue: "bad", evidence: "", at_s: 80.0 },
  ];
  const problems = auditAnalysis(out, input());
  assert.ok(problems.some((p) => /secondary point 2/.test(p)),
    "the bad one was not named, so nobody can tell which to look at");
  assert.ok(!problems.some((p) => /secondary point 1/.test(p)));
});
