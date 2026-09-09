import { SKILLS, BASE_COACHING_DIMENSIONS, SHOT_COACHING_DIMENSIONS } from "./types";
import type { Schema } from "./claude";
import type { CoachingFacts } from "./facts";
import type { CoachingRead } from "./types";

const SKILL_LIST = SKILLS.map((s) => `${s.key} (${s.name})`).join(", ");

/**
 * Two tiers of dimensions — see types.ts. The shot tier is appended only
 * when the facts carry a shot_summary (the ball was tracked), so the coach
 * is never invited to judge shots it can't see.
 */
const SHOT_FRAMEWORK = `
4. KITCHEN GAME
   - shot_sequence per rally names every contact (Dink, Volley, Speed-up,
     Block, Reset...) with who hit it, where from, where it landed and its
     speed. shot_summary.self.dinks and kitchen_exchanges say how often this
     player dinks, how many land in the kitchen, and how long they can hold
     an exchange.

5. SERVE & RETURN
   - shot_summary.self.serves / returns / thirdShot: serves in vs out,
     returns landing deep, third-shot drops vs drives and how many drops
     actually landed in the kitchen.

6. OFFENSE
   - Drives, speed-ups and overheads: counts, average drive speed, and which
     rally-ending shots were winners vs errors (shot_summary.self.endings).

7. DEFENSE
   - Resets, blocks and lobs: how the player answers a fast ball
     (look for "Reset"/"Block" following an opponent Drive in shot_sequence)
     and how often that answer lands in the kitchen.

8. SHOT SELECTION
   - Read shot_sequence across rallies for choices, not mechanics: driving
     from the back court into players already at the line, speeding up a
     ball from below the net, dinking when a put-away was there. Cite the
     rally and the shot number.

Every shot carries a confidence. Prefer patterns that repeat across several
shots with confidence >= 0.5; say "the tracking suggests" for anything
resting on lower-confidence shots. shot_summary.ball_seen_fraction tells
you how much of the ball the camera actually saw.`;

const COACHING_FRAMEWORK = `
COACHING ANALYSIS FRAMEWORK

You are an expert pickleball coach analyzing measured/heuristic data extracted
from video by computer vision (court detection, player tracking, pose
estimation, ball-movement contact detection). Comment ONLY on what the data
below actually supports — never guess or invent a detail it doesn't contain.

1. READY POSITION & SPLIT STEP
   - self_stance below gives, per rally, the fraction of tracked poses where
     this player's knees were bent below a "ready" threshold — a genuine
     geometric measurement of stance, not a judgment.

2. PADDLE POSITION (proxy)
   - self_paddle_proxy gives, per rally, the fraction of tracked poses where
     this player's most-raised wrist sat clearly above vs. below shoulder
     height. This is an explicit PROXY for paddle readiness — no paddle is
     ever detected — so phrase anything you say about it as inferred from
     hand position, not as a direct paddle observation.

3. FOOTWORK & COURT MOVEMENT
   - movement_summary gives this player's total distance covered, average
     and max speed, and court-coverage bounds for the whole clip.

4. SWING MECHANICS, PER SHOT (only where "mechanics" is present)
   - A shot_sequence entry may carry a "mechanics" object. It is measured
     from body pose sampled densely around that one contact, so unlike
     self_stance it describes THAT shot rather than a rally average.
   - Units, and they matter: angles in degrees, where knee_angle_at_contact_deg
     of 180 is a straight leg and 140 is a real bend. Everything spatial is in
     the player's OWN body — shoulder widths, or torsos for height — never
     pixels, so a shot at the far baseline is directly comparable with one at
     the near baseline. contact_height_torsos is 0 at the shoulder line and
     negative below it, so a dink contact is expected to be strongly negative.
   - What each field licenses you to say: knee angle -> whether they loaded
     their legs on that ball. contact_height_torsos and contact_reach_shoulders
     -> whether they took it high or low, close in or reaching. backswing and
     follow_through (shoulder widths) -> whether it was a compact stroke or a
     big one. wrist_speed_into_contact -> how hard they swung, relative to
     their own body. shoulder_rotation_deg -> whether they turned or armed it.
   - "mechanics" is ABSENT whenever the measurement could not be made. An
     absent object means unknown; it never means "average" or "fine". Never
     write about the mechanics of a shot that does not carry one.
   - This is WRIST-derived. You may discuss swing size, speed, contact height
     and body position. You may NOT claim anything about the PADDLE itself —
     its face angle, its path through the ball, spin, or where on the face
     contact was made. No paddle is detected. Phrase mechanics as what the
     body did.
   - Prefer patterns over single shots: three dinks all taken with straight
     legs is a coaching point; one is noise. Say which rally and shot number.

DO NOT attempt to assess paddle face, paddle path, spin, or contact point on
the paddle — nothing below sees the paddle. Shot TYPE and shot SELECTION may
be discussed only when a shot_summary is present (the ball was tracked);
without it, limit yourself to what the contacts array gives you: count,
timing and (low-confidence) which side produced them — never what kind of
shot they were.`;

function frameworkFor(facts: CoachingFacts): string {
  return facts.shot_summary ? COACHING_FRAMEWORK + SHOT_FRAMEWORK : COACHING_FRAMEWORK;
}

function measuredFacts(facts: CoachingFacts): string {
  return JSON.stringify({
    rallies: facts.rallies,
    movement_summary: facts.movement_summary,
    ...(facts.shot_summary ? { shot_summary: facts.shot_summary } : {}),
  });
}

/* ------------------------------------------------------------------ */
/* Claude — call 1: the coaching read itself. Adapted from Baseline's    */
/* original coaching prompt — same voice and output shape, rewritten to  */
/* read this app's CoachingFacts instead of Twelve Labs' rally/shot      */
/* extraction, and to never imply shot-type or shot-selection judgment.  */
/* ------------------------------------------------------------------ */

export const COACHING_READ_SCHEMA: Schema = {
  type: "object",
  properties: {
    strengths: {
      type: "array",
      items: { type: "string" },
      description: "1-2 specific, evidence-based observations of what's working.",
    },
    top_priority_fix: {
      type: "object",
      properties: {
        issue: { type: "string", description: "The single most impactful pattern to work on." },
        why_it_matters: { type: "string", description: "Plain-language explanation of the consequence." },
        evidence: { type: "string", description: "The specific pattern/frequency from the data that supports this." },
      },
      required: ["issue", "why_it_matters", "evidence"],
    },
    secondary_observations: {
      type: "array",
      items: {
        type: "object",
        properties: { issue: { type: "string" }, evidence: { type: "string" } },
        required: ["issue", "evidence"],
      },
      description: "1-2 items.",
    },
    drill_recommendation: {
      type: "object",
      properties: {
        name: { type: "string" },
        target: { type: "string", description: "Which issue this drill addresses." },
        reps_duration: { type: "string" },
      },
      required: ["name", "target", "reps_duration"],
    },
    data_gaps: {
      type: ["string", "null"],
      description: "Aspects the data didn't provide enough visibility to assess confidently, or null if none.",
    },
  },
  required: ["strengths", "top_priority_fix", "secondary_observations", "drill_recommendation", "data_gaps"],
};

export function coachingReadPrompt(opts: {
  skillLevel: string | null;
  focusArea: string | null;
  facts: CoachingFacts;
}): string {
  const skillLevel = opts.skillLevel ?? "not stated";
  const focusArea = opts.focusArea ?? "none stated";
  return `You are an expert pickleball coach analyzing measured/heuristic data extracted
from video by computer vision, to give a player specific, actionable feedback.
You will receive JSON data with one or more rallies, each with: a contact
timeline (count, timing, and a low-confidence guess at which side produced
each contact), this player's stance (knee-bend) samples, and this player's
paddle-height-proxy samples. A separate movement_summary covers distance/
speed/coverage for the whole clip.${
    opts.facts.shot_summary
      ? `
The ball was tracked for this clip, so each rally also carries a
shot_sequence (every contact classified — serve, return, third-shot drop,
dink, drive, reset, speed-up, lob... — with who hit it, where from, where it
landed, its speed and a confidence), and a shot_summary aggregates this
player's kitchen game, serve & return, offense and defense. Use it: this is
the data a real coach would build a lesson around.`
      : ""
  }
This data is measured or explicitly
confidence-scored — your job is to interpret it and translate patterns into
coaching insight, never to add certainty it doesn't have.
ANALYSIS INSTRUCTIONS:
- Look across ALL rallies provided, not just one — identify recurring
  patterns, not isolated incidents.
- Quantify patterns where the data supports it (e.g. "knees were bent in
  only 3 of 9 rallies" is stronger and more useful than "sometimes you stood
  upright").
- Only comment on patterns actually supported by the data provided. If a
  field is null/missing across most rallies, do not speculate — note that
  the footage didn't provide enough visibility on that aspect rather than
  guessing.
${
    opts.facts.shot_summary
      ? `- Shot types are classified from ball tracking with a per-shot confidence.
  Build claims on patterns across several shots with confidence >= 0.5, and
  hedge ("the tracking suggests") on anything resting on lower-confidence
  shots. Never comment on swing mechanics — the paddle is not seen.`
      : `- Do NOT comment on shot type, shot mechanics, or shot selection — this data
  cannot distinguish a drive from a dink from a drop, and does not attempt
  to. Stick to stance, paddle-height proxy, and movement/footwork.`
  }
- Contact-side attribution (self vs. opponent) is a rough heuristic, not a
  verified fact — treat a low-confidence split (values near 0.3) as
  unreliable and don't build claims on it alone.
- Prioritize by IMPACT, not by what's easiest to describe.
- Do not restate the raw data back at the player (they don't want a data
  dump) — synthesize it into a coach's read on their game.
OUTPUT FORMAT — return valid JSON in exactly this shape, no markdown, no
extra prose outside the JSON:
{
  "strengths": [
    "specific, evidence-based observation of what's working"
  ],
  "top_priority_fix": {
    "issue": "the single most impactful pattern to work on",
    "why_it_matters": "plain-language explanation of the consequence",
    "evidence": "the specific pattern/frequency from the data that supports this"
  },
  "secondary_observations": [
    {
      "issue": "",
      "evidence": ""
    }
  ],
  "drill_recommendation": {
    "name": "",
    "target": "which issue this drill addresses",
    "reps_duration": ""
  },
  "data_gaps": "note any aspects the data didn't provide enough
    visibility to assess confidently, or null if none"
}
Keep the tone encouraging but honest — like a good coach, not a hype
machine. Avoid jargon without a plain-language explanation alongside it.
Limit strengths to 1-2 items and secondary_observations to 1-2 items —
this should read as focused coaching, not an exhaustive report.
Player's self-reported skill level: ${skillLevel}
Focus area requested (if any): ${focusArea}
KNOWN DATA LIMITATIONS FOR THIS ANALYSIS:
${opts.facts.known_limitations.map((l) => `- ${l}`).join("\n")}
${opts.facts.shot_summary ? frameworkFor(opts.facts) : ""}
MEASURED FACTS:
${measuredFacts(opts.facts)}`;
}

/* ------------------------------------------------------------------ */
/* Claude — call 2: turns the same facts (plus call 1's read, so the    */
/* two stay consistent) into the tagged, per-skill records Progress,     */
/* skill trends and auto-suggested practice plans read from.             */
/* ------------------------------------------------------------------ */

export const TAGGING_SCHEMA: Schema = {
  type: "object",
  properties: {
    headline: {
      type: "string",
      description: "One specific sentence naming the through-line of this session. "
        + "NOT a restatement of the first observation — the player sees both at once.",
    },
    summary: {
      type: "string",
      description: "2–4 sentences of context the individual observations cannot give: "
        + "how the session went overall, how readable the footage was, the pattern "
        + "underneath the separate points. Never a précis of the observations.",
    },
    footage_quality: {
      type: "object",
      properties: {
        usable: { type: "boolean" },
        issues: { type: "array", items: { type: "string" } },
      },
      required: ["usable", "issues"],
    },
    observations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rally_idx: { type: "integer", description: "Rally this was seen in." },
          skill_key: { type: "string" },
          coaching_dimension: {
            type: "string",
            enum: [...BASE_COACHING_DIMENSIONS, ...SHOT_COACHING_DIMENSIONS],
          },
          valence: { type: "string", enum: ["strength", "weakness"] },
          title: { type: "string", description: "Short, concrete. Under 60 characters." },
          detail: {
            type: "string",
            description: "WHAT HAPPENED, from the data. The observable fact only — "
              + "save the consequence and the fix for the fields below.",
          },
          severity: { type: "integer", description: "1 minor to 5 match-losing." },
          shot_idx: {
            type: "integer",
            description: "Position in the rally (0 = serve) when this is about one "
              + "specific shot. OMIT for anything broader — never guess a number.",
          },
          why_it_matters: {
            type: "string",
            description: "WHY IT MATTERS: the consequence in a point. What it let the "
              + "opponent do, or cost this player. Omit rather than pad.",
          },
          what_to_change: {
            type: "string",
            description: "WHAT TO DO DIFFERENTLY: one concrete, physical change. "
              + "Not 'be more consistent' — something they could do on the next ball.",
          },
          drill_slug: {
            type: "string",
            description: "HOW TO PRACTISE IT: the slug of a drill from the list given "
              + "in the prompt. Must be one of those exact slugs, or omitted.",
          },
        },
        required: ["rally_idx", "skill_key", "coaching_dimension", "valence", "title", "detail", "severity"],
      },
    },
    skills: {
      type: "array",
      items: {
        type: "object",
        properties: {
          skill_key: { type: "string" },
          rating: { type: "integer", description: "1–5." },
          basis: {
            type: "string",
            description: "The EVIDENCE for the rating — the numbers or the count that "
              + "justify it. Not a restatement of an observation.",
          },
        },
        required: ["skill_key", "rating", "basis"],
      },
    },
    rally_verdicts: {
      type: "array",
      description: "How each rally went for this player. Include ONLY rallies you can "
        + "actually judge from the shot sequence — omitting a rally is correct and "
        + "expected. Never guess to fill the list.",
      items: {
        type: "object",
        properties: {
          rally_number: { type: "integer", description: "The rally_number from the facts." },
          verdict: {
            type: "string",
            enum: ["won", "lost", "unforced_error", "neutral", "unknown"],
            description: "won/lost = the point ended that way for THIS player. "
              + "unforced_error = they ended it themselves with nobody forcing them. "
              + "neutral = it ended without either side clearly deciding it. "
              + "unknown = the data does not say, which is a real and common answer.",
          },
          reason: { type: "string", description: "One short sentence, citing the shot that decided it." },
          confidence: { type: "number", description: "0-1. Be honest; low is fine." },
        },
        required: ["rally_number", "verdict", "confidence"],
      },
    },
  },
  required: ["headline", "summary", "footage_quality", "observations", "skills"],
};

export function taggingPrompt(opts: {
  skillLevel: string | null;
  paddleHand: string | null;
  coachingKind: string;
  notes: string | null;
  facts: CoachingFacts;
  coaching: CoachingRead;
  /** The real drill catalogue. An observation may only cite a slug from here. */
  drills: Array<{ slug: string; name: string; skill: string }>;
}): string {
  return `You already wrote the coaching read below for this player, from the same
measured facts you can see further down. Your job now is narrower: turn
that same read into the structured records this app tracks across sessions —
a one-line headline, a short summary, and individually tagged observations
plus skill ratings. Stay consistent with what you already said; do not
introduce new opinions or contradict the read below.

THE PLAYER
${opts.skillLevel ? `Self-reported level: ${opts.skillLevel}` : "Level: not stated"}
Handedness: ${opts.paddleHand ?? "unknown"}
Session type: ${opts.coachingKind}
${opts.notes ? `What they said about this session: ${opts.notes}` : ""}
All facts below are already scoped to this player (self_player_labels) — do
not attempt to score anyone else.

GROUND RULES
1. NEVER invent a statistic or an event. Everything must trace back to a
   field in the data below, or to the coaching read you already wrote.
2. Every observation must cite the rally it came from, by its rally_number.
   If you cannot point to a specific rally_number, do not make the claim.
3. ${
    opts.facts.shot_summary
      ? `Shot types ARE available for this clip (shot_sequence / shot_summary).
   coaching_dimension may be any of: ${[...BASE_COACHING_DIMENSIONS, ...SHOT_COACHING_DIMENSIONS].join(", ")}.
   Never produce an observation about swing mechanics — the paddle is not seen.`
      : `NEVER produce an observation about shot type, shot mechanics, or shot
   selection — no data below supports any of those. coaching_dimension must
   be one of: ${BASE_COACHING_DIMENSIONS.join(", ")}.`
  }
4. Prefer few sharp observations over many vague ones. Six good ones beat twenty.
5. Write to the player, in second person, plainly. No hype, no filler openers.
6. Every observation has FOUR parts, and they are different things:
     detail          WHAT HAPPENED — the observable fact, from the data.
     why_it_matters  WHY IT MATTERS — the consequence in a point.
     what_to_change  WHAT TO DO DIFFERENTLY — one concrete physical change.
     drill_slug      HOW TO PRACTISE IT — a slug from the drill list below.
   OMIT any of the last three you cannot answer honestly from the data. An
   observation with two real parts is worth more than one with four where two
   are padding. Never write "focus on consistency" to fill what_to_change.

   NO PART MAY RESTATE ANOTHER. Each field must add information the previous
   one does not contain. If why_it_matters is detail with "which means" in
   front of it, or what_to_change is why_it_matters phrased as an
   instruction, you have written one part, not three — cut it to the parts
   that are actually different. Concretely:
     BAD  detail: "You let the ball drop below your waist on most dinks."
          why_it_matters: "Contacting below the waist on dinks hurts you."
          what_to_change: "Stop letting the ball drop below your waist."
     GOOD detail: "On 6 of 9 dinks you contacted the ball below waist height."
          why_it_matters: "From down there the only safe ball is a high one,
                           which is what your opponent kept attacking."
          what_to_change: "Split-step earlier and meet it out in front, level
                           with your hip."
   The player reads all three in a row. Repetition reads as padding and makes
   the specific parts harder to find.

9. The headline and the summary are NOT a précis of the observations. The
   player sees them on the same screen as every observation, so a headline
   that restates observation 1 is the same sentence printed twice. The
   headline names the through-line — the one thing that connects what you
   found. The summary gives the context the individual observations cannot:
   how the session went overall, how much of it was readable, what pattern
   sits underneath the separate points. If your summary can be deleted with
   nothing lost, delete it down to the sentence that would be lost.

10. skills[].basis is the EVIDENCE for a rating — the numbers or the count
   that justify it. It is not a third copy of the observation text. "3 of 9
   dinks contacted below the waist" is a basis; "dinking needs work, as
   noted above" is not.
7. drill_slug must be one of the exact slugs listed below, or omitted. A slug
   you invent will not resolve and the recommendation will be dropped.
8. shot_idx only when the observation is about ONE identifiable shot in the
   rally's shot_sequence. Omit it for anything broader — a guessed index points
   the player at the wrong ball.

${frameworkFor(opts.facts)}

THE COACHING READ YOU ALREADY WROTE
${JSON.stringify(opts.coaching)}

THE MEASURED FACTS (one entry per rally)
${measuredFacts(opts.facts)}

AVAILABLE DRILLS — the ONLY valid values for drill_slug. Do not invent one.
${opts.drills.map((d) => `- ${d.slug} — ${d.name} (${d.skill})`).join("\n")}

KNOWN DATA LIMITATIONS FOR THIS ANALYSIS
${opts.facts.known_limitations.map((l) => `- ${l}`).join("\n")}

RALLY VERDICTS
Also judge each rally, but only where the shot sequence actually shows you how
it ended. A rally whose last shot has outcome "unknown", or which has too few
classified shots to read, gets verdict "unknown" or is left out entirely —
both are correct. There is no penalty for judging three rallies out of twelve,
and a fabricated verdict is worse than no verdict, because the timeline will
show it as fact. "unforced_error" specifically means this player ended it
themselves with nobody forcing them.

YOUR TASK
Produce a small set of tagged observations covering the same ground as the
read above — the top priority fix becomes your highest-severity weakness
observation, the secondary issues become the rest, and the strengths become
your strength observations.

Write them in your own words, at the level of specificity the observation
fields allow. These observations are what the player actually reads: the
narrative read above is NOT shown alongside them, so do not write as though
it were, do not refer back to it ("as mentioned above"), and do not preserve
its phrasing for its own sake. Where the read was vague and the data lets you
be exact, be exact. Rate skills only where the data actually
supports it, on this scale:
  1 = a clear liability at their level
  2 = below the level they are playing at
  3 = at level, unremarkable
  4 = a strength
  5 = a weapon
Available skill keys: ${SKILL_LIST}
${
    opts.facts.shot_summary
      ? `With shot data present you may rate serve, return, thirdshot, dinking,
kitchen, hands, volleys, resets, defense, offense, selection and consistency —
but only from shots this player actually hit (shot_summary.self, and
shot_sequence entries with by = "self"), and only where several shots
support the rating. Cite counts in the basis ("4 of 6 third-shot drops landed
in the kitchen").`
      : `Most of these skills (serve, return, third shot, hands, volleys, offense,
shot selection) require shot-type or ball-tracking data this clip does not
have — rate those ONLY if you have genuine, citable evidence, which will be
rare. The data realistically supports positioning, transition, and, via the
paddle-height and stance proxies, dinking/kitchen readiness.`
  }

If the facts are too sparse or ambiguous to responsibly judge something,
say so in footage_quality and leave it out rather than guessing.

The headline is one sentence naming the single most important thing about
this session — it should match the top priority fix above, or a genuine
strength if the data doesn't support a fix.`;
}

/* ------------------------------------------------------------------ */
/* Practice-plan blueprints and the in-app coach chat — unchanged in     */
/* substance from Baseline's original prompts.                           */
/* ------------------------------------------------------------------ */

export const BLUEPRINT_SCHEMA: Schema = {
  type: "object",
  properties: {
    title: { type: "string" },
    goal: { type: "string", description: "What good looks like, in one sentence." },
    target: { type: "string", description: "The observable thing that closes this weakness." },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          focus: { type: "string", description: "2–3 words, e.g. 'Contact point'." },
          drill_slug: { type: "string", description: "Must be one of the supplied slugs, or empty for the re-test." },
          target: { type: "string", description: "A countable target for this session." },
        },
        required: ["focus", "drill_slug", "target"],
      },
    },
  },
  required: ["title", "goal", "target", "steps"],
};

export function blueprintPrompt(opts: {
  weaknessTitle: string;
  weaknessDetail: string;
  skillName: string;
  level: string | null;
  drills: Array<{ slug: string; name: string; skill: string; difficulty: string; purpose: string }>;
}): string {
  return `You are building a five-session practice progression for one pickleball weakness.

THE WEAKNESS
Skill area: ${opts.skillName}
${opts.weaknessTitle}
${opts.weaknessDetail}
Player level: ${opts.level ?? "unknown"}

AVAILABLE DRILLS — you may ONLY use these. Do not invent a drill.
${opts.drills.map((d) => `- ${d.slug} — ${d.name} (${d.skill}, ${d.difficulty}): ${d.purpose}`).join("\n")}

RULES
- Exactly five steps.
- Steps 1–4 each use one drill from the list above, ordered so each genuinely
  depends on the one before it. Isolate the mechanic first, add height or
  precision control, then add movement, then add live pressure.
- Step 5 is always the re-test: drill_slug must be an empty string, focus
  "Re-test", and the target states what should be true in the next uploaded match.
- Targets must be countable. "50 controlled repetitions" not "practise dinking".
- Do not repeat the same drill twice unless the progression genuinely calls for it.`;
}

export function coachPrompt(context: string, question: string): string {
  return `You are this player's pickleball coach. You have the record of all their
analyzed footage. Below is everything you know about them — their sessions,
what was measured or observed in each, their skill reads over time, and
their current practice plan.

${context}

RULES
- Answer from THIS player's history. If the answer is not in the record above,
  say so rather than giving generic pickleball advice.
- Do not invent statistics. Only cite numbers that appear above.
- Never claim to know a shot type (drive/dink/drop/volley) — this app does
  not classify shot type from any session.
- When you reference something, name the session and rally so they can go
  look at it.
- Be direct and brief. Three short paragraphs at most.
- If they ask something the data cannot answer, say what you would need.

THEIR QUESTION
${question}`;
}
