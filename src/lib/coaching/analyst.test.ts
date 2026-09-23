import assert from "node:assert/strict";
import test from "node:test";

import { OVERLAY_LEGEND } from "./overlay-legend";
import { ANALYST_FPS, auditAnalysis, analystSchema, analystPrompt, PARTNERSHIP_DIMENSIONS, type AnalystInput, type AnalystOutput, analystOutputBudget, THINKING_ALLOWANCE, MAX_OUTPUT_TOKENS } from "./analyst";
import { sanitiseSchema } from "./gemini";
import { COACHING_DIMENSIONS, COACHING_DIMENSION_LABELS } from "./types";

function input(over: Partial<AnalystInput> = {}): AnalystInput {
  return {
    clipSeconds: 101.3,
    subjectPlayerId: "player_2",
    partnerPlayerId: null,
    partnerTagged: false,
    subjectSide: "near",
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

test("with a still attached, the still is the only source of who the subject is", () => {
  // There used to be two sources -- the still and a "You" box -- and the box
  // drifted onto a bystander. Now every box says "Player" and the prompt must
  // say so, or the model goes looking for a "You" box that is not drawn.
  const p = analystPrompt(input(), "LEGEND", null, true);
  assert.match(p, /TRUST THE STILL/);
  assert.match(p, /ALL labelled "Player"/);
  assert.doesNotMatch(p, /labelled "You"/);
});

test("with no still, the boxes are presented as a guess rather than an answer", () => {
  // Nobody has confirmed who the subject is, so the label on the box is the
  // pipeline's opinion. A read that says "you" as though that were settled is
  // indistinguishable from one where somebody actually confirmed it.
  const p = analystPrompt(input(), "LEGEND", null, false);
  assert.match(p, /NO STILL WAS SUPPLIED/);
  assert.match(p, /not a substitute for knowing/i);
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
  assert.match(OVERLAY_LEGEND, /Green box labelled "Player"/);
  // NO ROLE ON ANY BOX. Identity comes from the still alone; a "You" box that
  // drifted onto a bystander is what this replaced.
  assert.doesNotMatch(OVERLAY_LEGEND, /labelled "You"/);
  assert.match(OVERLAY_LEGEND, /outside the court/i);
  // The tie-break, which is the only instruction that makes two sources of
  // truth better than one. Without it the model picks, silently, in exactly
  // the frames where the tracker is least reliable.
  assert.match(OVERLAY_LEGEND, /Only the still tells you/i);
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

test("the prompt forbids the things the footage cannot show", () => {
  // QUALITATIVE ONLY, by decision. A pickleball forty feet away in compressed
  // video does not show a grip change or ball rotation, and a number the
  // pipeline never measured is a number the model invented. The danger is not
  // that these are wrong — it is that they sound exactly like the measured
  // claims sitting beside them, so one invented figure discredits the lot.
  const p = analystPrompt(input(), "LEGEND", null, true);
  assert.match(p, /the GRIP/);
  assert.match(p, /SPIN of any kind/);
  assert.match(p, /MILES PER HOUR/);
  assert.match(p, /never in figures/);
});

test("the prompt asks for the breadth a read is supposed to have", () => {
  // The fix for "every point is about knee angle" is not only deduplication —
  // it is telling the model what else there is to look at. Each of these is a
  // dimension an observation can be tagged with, so a prompt that never
  // mentions them produces a taxonomy nothing populates.
  const p = analystPrompt(input(), "LEGEND", null, true);
  for (const topic of [
    /Body mechanics —/, /Ball quality —/, /Shot selection —/,
    /Court IQ and decisions —/, /Positioning and footwork —/,
    /Defense —/, /Offense —/, /Kitchen game —/,
  ]) {
    assert.match(p, topic);
  }
});

test("shot selection is asked to say what the better option was", () => {
  // "You drove that ball" is a scoreboard. The coaching is in what they should
  // have hit instead, which is the part a player can act on.
  const p = analystPrompt(input(), "LEGEND", null, true);
  assert.match(p, /what the better option was/);
});

test("every coaching dimension has a label", () => {
  // The dimension is stored as a bare string, so a new one added to the enum
  // without a label renders as "body_mechanics" on the page.
  for (const d of COACHING_DIMENSIONS) {
    assert.ok(COACHING_DIMENSION_LABELS[d], `no label for ${d}`);
    assert.doesNotMatch(COACHING_DIMENSION_LABELS[d], /_/, `${d}'s label is the raw key`);
  }
});

// ---------------------------------------------------------------------------
// The partnership section.
// ---------------------------------------------------------------------------

const withPartner = () => input({ partnerPlayerId: "player_3", partnerTagged: true });

test("no partner tagged means the model is told to omit the section, not to guess", () => {
  // The worst available outcome is a confident partnership read about an
  // opponent: on a doubles court, guessing the partner is a one-in-three shot.
  const p = analystPrompt(input(), "LEGEND", null, true, false);
  assert.match(p, /NO PARTNER WAS TAGGED/);
  assert.match(p, /OMIT/);
  assert.doesNotMatch(p, /THE PARTNERSHIP SECTION/);
});

test("a tagged partner gets the brief, and every dimension is named in it", () => {
  const p = analystPrompt(withPartner(), "LEGEND", null, true, true);
  assert.match(p, /THE PARTNERSHIP SECTION/);
  for (const key of PARTNERSHIP_DIMENSIONS) {
    assert.ok(p.includes(key), `${key} is in the schema enum but never explained to the model`);
  }
});

test("the cyan mark is described only when it was actually drawn", () => {
  // The gold-box mistake, exactly: the prompt described a mark that had been
  // removed, so the model hunted for it and reported the absence as a finding
  // about the video. Tagging a partner is NOT the same as their being visible
  // on the one frame that got marked.
  const drawn = analystPrompt(withPartner(), "LEGEND", null, true, true);
  assert.match(drawn, /CYAN/);
  const notDrawn = analystPrompt(withPartner(), "LEGEND", null, true, false);
  assert.doesNotMatch(notDrawn, /CYAN/);
  assert.match(notDrawn, /THE PARTNERSHIP SECTION/,
    "the section is still wanted — the partner is tagged, just not on this still");
});

test("the model is told to follow the people, not the side they stood on", () => {
  // A stacked pair swap sides constantly. A still is one instant.
  const p = analystPrompt(withPartner(), "LEGEND", null, true, true);
  assert.match(p, /follow the PEOPLE/);
});

test("the partnership brief forbids writing about what it cannot hear", () => {
  // "Good communication" is the single most tempting thing to write about a
  // doubles pair and the one thing a silent overlay cannot support.
  const p = analystPrompt(withPartner(), "LEGEND", null, true, true);
  assert.match(p, /do not\s*\n?write about talking/);
});

test("partnership is not a required field in the schema", () => {
  // Most clips have no tagged partner. Requiring it would make a singles read
  // invent a teammate rather than leave the field out.
  const schema = analystSchema() as { required: string[]; properties: Record<string, unknown> };
  assert.ok(schema.properties.partnership, "the field has to exist to be fillable");
  assert.ok(!schema.required.includes("partnership"));
});

test("every partnership dimension the schema accepts is one the prompt defines", () => {
  // The enum and the brief are two lists of the same thing in two places. A
  // key in the schema that the prompt never explains gets rated on a guess at
  // what its name means.
  const schema = analystSchema() as {
    properties: { partnership: { properties: { dimensions: { items: {
      properties: { key: { enum: string[] } } } } } } };
  };
  assert.deepEqual(
    schema.properties.partnership.properties.dimensions.items.properties.key.enum,
    [...PARTNERSHIP_DIMENSIONS]
  );
});

test("the partnership schema survives Gemini's schema sanitiser", () => {
  // nullable and nested objects are where sanitiseSchema has bitten before.
  const clean = sanitiseSchema(analystSchema()) as {
    properties: { partnership?: { properties?: Record<string, unknown> } };
  };
  assert.ok(clean.properties.partnership?.properties?.dimensions);
  assert.ok(clean.properties.partnership?.properties?.friction);
});

const partnership = (): NonNullable<AnalystOutput["partnership"]> => ({
  compatibility: 6.5,
  summary: "You cover the middle; they hold the line.",
  dimensions: [
    { key: "spacing", rating: 7, basis: "held about nine feet apart through rally 1" },
    { key: "middle_balls", rating: 4, basis: "both left the middle at 12.4s" },
  ],
  works_well: [{ pattern: "You both reset after a speed-up", why_it_works: "", evidence: "", at_s: 9.0 }],
  friction: [{ pattern: "Middle ball left", cost: "", fix: "", evidence: "", at_s: 12.4 }],
  role_split: { you: "covers middle", partner: "holds line", imbalance: null },
  fix_together: { change: "Call the middle by default", how_to_practise: "", at_s: 12.4 },
});

const withPship = () => {
  const out = structuredClone(clean);
  out.partnership = partnership();
  return out;
};

test("a well-formed partnership read produces no problems", () => {
  assert.deepEqual(auditAnalysis(withPship(), withPartner()), []);
});

test("a partnership read with nobody tagged as the partner is called out", () => {
  // The model picked the teammate itself, out of three candidates on court.
  // The section may be fluent and about entirely the wrong person.
  const problems = auditAnalysis(withPship(), input());
  assert.ok(problems.some((p) => /nobody was tagged as your partner/.test(p)));
});

test("a partnership anchored outside the clip is caught like a rally is", () => {
  const out = withPship();
  out.partnership!.friction[0].at_s = 400;
  assert.ok(auditAnalysis(out, withPartner()).some((p) => /outside a 101.3s clip/.test(p)));
});

test("fix_together is anchored too, not just the lists", () => {
  // Easy to miss: it is the one anchor that is not inside an array.
  const out = withPship();
  out.partnership!.fix_together.at_s = -5;
  assert.ok(auditAnalysis(out, withPartner()).some((p) => /fix_together/.test(p)));
});

test("a null anchor is allowed — it says so rather than pointing nowhere", () => {
  const out = withPship();
  out.partnership!.works_well[0].at_s = null;
  out.partnership!.friction[0].at_s = null;
  out.partnership!.fix_together.at_s = null;
  assert.deepEqual(auditAnalysis(out, withPartner()), []);
});

test("a rating off the 0-10 scale is caught, for the overall and per dimension", () => {
  const overall = withPship();
  overall.partnership!.compatibility = 87;
  assert.ok(auditAnalysis(overall, withPartner()).some((p) => /compatibility is 87/.test(p)));

  const dim = withPship();
  dim.partnership!.dimensions[0].rating = -2;
  assert.ok(auditAnalysis(dim, withPartner()).some((p) => /spacing is -2/.test(p)));
});

test("rating the same dimension twice is caught", () => {
  // Two ratings for one thing: whichever the UI draws second silently wins.
  const out = withPship();
  out.partnership!.dimensions.push({ key: "spacing", rating: 2, basis: "" });
  assert.ok(auditAnalysis(out, withPartner()).some((p) => /rates "spacing" twice/.test(p)));
});

test("claims about what the pair SAID are caught — the footage is silent", () => {
  // The most tempting sentence in doubles coaching, and unsupportable twice
  // over: the overlay never had audio and the upload now strips the track.
  for (const phrase of ["communication broke down", "you called it late", "you shouted"]) {
    const out = withPship();
    out.partnership!.summary = phrase;
    assert.ok(
      auditAnalysis(out, withPartner()).some((p) => /no sound/.test(p)),
      `"${phrase}" should be flagged`
    );
  }
});

test("no partnership section at all is not a problem", () => {
  // The normal case: most clips have no tagged partner.
  assert.deepEqual(auditAnalysis(clean, input()), []);
});

test("ADVICE to call the ball is not mistaken for a claim about hearing one", () => {
  // The sharpest edge in the audio check, and one this got wrong first time.
  // "Call the middle by default" is the most useful sentence a partnership fix
  // can contain; "you called it late" is a claim about a sound nobody
  // recorded. Flagging the first would fire the audit on the best advice in
  // the section.
  const out = withPship();
  out.partnership!.fix_together.change = "Call the middle by default — say it before the ball crosses";
  out.partnership!.friction[0].fix = "Whoever is cross-court calls the ball";
  assert.deepEqual(auditAnalysis(out, withPartner()), []);
});

test("but a claim that they DID talk is still caught", () => {
  const out = withPship();
  out.partnership!.summary = "Their communication was excellent all match";
  assert.ok(auditAnalysis(out, withPartner()).some((p) => /no sound/.test(p)));
});

// ---------------------------------------------------------------------------
// Technique. The read was thin on it because the prompt said a separate pass
// wrote technique notes -- a pass that was never wired in -- and forbade
// "contact height or swing size" while handing over measurements of both.
// ---------------------------------------------------------------------------

test("the prompt no longer hands technique to a pass that does not run", () => {
  const p = analystPrompt(input(), "LEGEND", null, true);
  assert.doesNotMatch(p, /separate pass re-watches/i,
    "technique-pass.ts is not wired in; telling the model it is means nobody writes technique");
  assert.match(p, /Nobody else writes technique/);
});

test("every swing measurement the model receives is defined for it", () => {
  // A number with no definition is a number the model guesses the meaning of.
  // These reach the model via COACHABLE_MECHANICS and were previously undefined.
  const p = analystPrompt(input(), "LEGEND", null, true);
  for (const field of [
    "backswingShoulders", "wristSpeedIntoContact", "followThroughShoulders",
    "shoulderRotationDeg", "contactHeightTorsos", "contactReachShoulders",
  ]) {
    assert.ok(p.includes(field), `${field} is sent to the model but never explained`);
  }
});

test("follow-through is named as something to coach, with the number", () => {
  const p = analystPrompt(input(), "LEGEND", null, true);
  assert.match(p, /follow-through/i);
  assert.match(p, /quotes the measurement/);
});

test("the paddle itself is still off limits — the measurements are of the body", () => {
  // Loosening technique must not loosen this: at 10fps the paddle face, angle
  // and spin are not visible, and the audit still flags them.
  const p = analystPrompt(input(), "LEGEND", null, true);
  assert.match(p, /never describe the\s+paddle.s face, its angle, its\s+path or spin/);
  const out = structuredClone(clean);
  out.coaching.summary = "Your paddle face was open on every drop.";
  assert.ok(auditAnalysis(out, input()).some((pr) => /paddle face/.test(pr)));
});

test("technique talk about the follow-through is not mistaken for paddle talk", () => {
  const out = structuredClone(clean);
  out.coaching.summary = "Your follow-through on drives stopped at the ball — 0.4 shoulder widths.";
  assert.deepEqual(auditAnalysis(out, input()), []);
});

test("with no contacts measured, the prompt stops describing measurements it does not have", () => {
  // THE PIPELINE NO LONGER MEASURES CONTACTS. A prompt that keeps explaining
  // what shoulderTurnDeg means, and tells the model to "USE THE NUMBER", is
  // inviting it to produce a number from a video — which is the one thing
  // that makes every real sentence beside it unreadable.
  const none = analystPrompt(input({ contacts: [] }), "LEGEND", null, true);
  assert.doesNotMatch(none, /shoulderTurnDeg/);
  assert.doesNotMatch(none, /MEASURED, NOT ESTIMATED/);
  assert.match(none, /Do not invent a number/);
  assert.match(none, /Technique is worth a good share/, "technique is still expected, just not by quota");

  // And when there ARE measurements, it still says to use them.
  const some = analystPrompt(input(), "LEGEND", null, true);
  assert.match(some, /shoulderTurnDeg/);
  assert.match(some, /USE\nTHE NUMBER|USE THE NUMBER/);
});


test("the subject's half of the court is a rule about attribution", () => {
  // REPORTED: a read criticised the subject for flicking a ball into the net
  // that the player ACROSS THE NET hit. Four people in a kitchen exchange look
  // alike on a phone; which half a shot came from does not.
  const near = analystPrompt(input({ subjectSide: "near" }), "LEGEND", null, true);
  assert.match(near, /NEAR HALF/);
  assert.match(near, /A ball hit from the far half is never theirs/);
  const far = analystPrompt(input({ subjectSide: "far" }), "LEGEND", null, true);
  assert.match(far, /A ball hit from the near half is never theirs/);
  // No court, no claim: a side asserted without a court is a guess.
  const none = analystPrompt(input({ subjectSide: null }), "LEGEND", null, true);
  assert.doesNotMatch(none, /HALF — the half/);
  assert.doesNotMatch(none, /never theirs/);
});

test("the prompt asks for clock times in the prose and raw seconds in the fields", () => {
  // Both, because they are read by different things: the app parses at_s, a
  // person reads the sentence. "at 766.1s" in a sentence is a stopwatch
  // reading, and it is what the page kept showing.
  const p = analystPrompt(input(), "LEGEND", null, true);
  assert.match(p, /never "at 766\.1s"/);
  assert.match(p, /stays a number of seconds/);
});

test("the prompt says the criticisms are checked, and does not set a quota", () => {
  // THE QUOTAS WERE PRESSURE TO FABRICATE. "At least a third of your
  // observations" and "three or more families" are demands for volume, made
  // of a model reading a compressed stream — so it wrote specifics it could
  // not see: a dink called a speed-up, a hinge called an upright stance.
  const p = analystPrompt(input(), "LEGEND", null, true);
  assert.match(p, /re-watched afterwards on its own/);
  assert.match(p, /DELETED, not softened/);
  assert.doesNotMatch(p, /at least a THIRD/);
  assert.doesNotMatch(p, /three or more different families/);
});


test("tagging a partner is enough for the partnership section, matched or not", () => {
  // THE BUG: the section was gated on partnerPlayerId, a TRACK label from
  // matching the tap to a tracked player at the setup frame. When that match
  // failed the prompt said "NO PARTNER WAS TAGGED, omit partnership" — while
  // the still in the same request had a cyan ring round the partner. Reported
  // three times as "I still don't see the partner analysis".
  const tappedOnly = analystPrompt(
    input({ partnerPlayerId: null, partnerTagged: true }), "LEGEND", null, true, true);
  assert.match(tappedOnly, /THE PARTNERSHIP SECTION/);
  assert.doesNotMatch(tappedOnly, /NO PARTNER WAS TAGGED/);

  // And nobody tagged means nobody tagged: no section, no guessing which of
  // the three other players it is about.
  const neither = analystPrompt(
    input({ partnerPlayerId: null, partnerTagged: false }), "LEGEND", null, true);
  assert.match(neither, /NO PARTNER WAS TAGGED/);
  assert.doesNotMatch(neither, /THE PARTNERSHIP SECTION/);
});

test("the partnership section says which player it is about, three ways", () => {
  // A section about "your partner" that cannot point at them is how a
  // confident report about an opponent gets written.
  const ringed = analystPrompt(withPartner(), "LEGEND", null, true, true);
  assert.match(ringed, /ringed in CYAN/);

  // No ring, no matched track, but we know which half they play in: on a
  // doubles court that leaves exactly one other player. Not a guess.
  const bySide = analystPrompt(
    input({ partnerPlayerId: null, partnerTagged: true, subjectSide: "near" }),
    "LEGEND", null, true, false);
  assert.match(bySide, /THE PARTNERSHIP SECTION/);
  assert.match(bySide, /OTHER player in the near half/);

  // Nothing to point with: no ring, no track, no court. One in three is a
  // guess, and the section is dropped rather than guessed.
  const blind = analystPrompt(
    input({ partnerPlayerId: null, partnerTagged: true, subjectSide: null }),
    "LEGEND", null, true, false);
  assert.doesNotMatch(blind, /THE PARTNERSHIP SECTION/);
});
