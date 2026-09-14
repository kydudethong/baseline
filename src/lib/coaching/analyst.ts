/**
 * The analyst: one Gemini call over the overlay video plus what was measured,
 * producing everything the coaching layer used to take two Claude calls and a
 * rally segmenter to produce.
 *
 * WHY ONE CALL AND NOT THREE. The old shape was a coaching read, then a
 * tagging pass over the same facts plus that read, so the two could not
 * contradict each other. A single call cannot contradict itself, and the
 * rallies, shot types and ratings now come out of the same reading of the
 * same video as the prose about them.
 *
 * WHAT IT IS GIVEN, AND WHY THAT MATTERS. Measured facts go in alongside the
 * video, and that is the whole design. Asked from video alone this model
 * invented two rallies past the end of a 101-second clip and missed two real
 * ones; asked to work over an overlay with contact timings supplied it got all
 * seven right. It gets timings it can trust and body measurements it could
 * never take by eye, and decides what they MEAN.
 *
 * WHAT IT IS NOT GIVEN: any rally boundary or shot type this app derived.
 * Those are the answers now being asked for, and the overlay it watches is
 * rendered with --hide-rallies so they are not written across the frame
 * either.
 */

import { generateJSON, uploadVideo, analystModel, deleteFile } from "./gemini";
import { SKILLS, COACHING_DIMENSIONS, type CoachingDimension } from "./types";

const SHOT_TYPES = [
  "serve", "return", "third_shot_drop", "third_shot_drive", "dink", "drop",
  "reset", "drive", "volley", "speed_up", "overhead", "lob", "block", "unknown",
] as const;

/** A contact the CV layer measured: when it happened, and what the body did. */
export interface MeasuredContact {
  t: number;
  player: string | null;
  hit_from?: { x_ft: number; y_ft: number };
  landed_at?: { x_ft: number; y_ft: number };
  speed_mps?: number | null;
  body?: Record<string, number | string>;
}

export interface AnalystInput {
  clipSeconds: number;
  subjectPlayerId: string | null;
  ballCoverage: number | null;
  courtConfidence: number | null;
  contacts: MeasuredContact[];
  skillLevel: string | null;
  focusArea: string | null;
  /** Slugs that exist, so a cited drill resolves to a real one. */
  drillCatalogue: Array<{ slug: string; name: string; skill: string }>;
  knownLimitations: string[];
}

export interface AnalystOutput {
  rallies: Array<{
    idx: number; start_s: number; end_s: number;
    end_reason: string; winner: string | null; confidence: number;
  }>;
  shots: Array<{
    t: number; rally_idx: number; player: string;
    type: typeof SHOT_TYPES[number]; confidence: number;
    /** Roughly where the ball landed. Null when it was not seen to land. */
    landing_depth?: string | null;
    landing_side?: string | null;
  }>;
  playstyle: { summary: string; tendencies: string[]; under_pressure: string };
  /** rating is 1-5, matching coaching_skill_ratings.raw — NOT 1-10. */
  skills: Array<{ skill_key: string; rating: number; basis: string }>;
  coaching: {
    headline: string;
    summary: string;
    strengths: string[];
    top_priority_fix: { issue: string; why_it_matters: string; evidence: string };
    secondary: Array<{ issue: string; evidence: string }>;
  };
  observations: Array<{
    rally_idx: number | null;
    shot_t: number | null;
    skill_key: string;
    coaching_dimension: CoachingDimension;
    valence: "strength" | "weakness";
    title: string;
    detail: string;
    severity: number;
    why_it_matters: string | null;
    what_to_change: string | null;
    drill_slug: string | null;
  }>;
  drills: Array<{ slug: string | null; name: string; targets: string; reps_or_duration: string }>;
  data_gaps: string | null;
}

export function analystSchema(): Record<string, unknown> {
  const num = { type: "number" };
  const str = { type: "string" };
  return {
    type: "object",
    properties: {
      rallies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            idx: { type: "integer" }, start_s: num, end_s: num,
            end_reason: str, winner: { type: "string", nullable: true }, confidence: num,
          },
          required: ["idx", "start_s", "end_s", "end_reason", "confidence"],
        },
      },
      shots: {
        type: "array",
        items: {
          type: "object",
          properties: {
            t: num, rally_idx: { type: "integer" }, player: str,
            type: { type: "string", enum: [...SHOT_TYPES] }, confidence: num,
            // Zones, not coordinates. A model asked for a landing POINT will
            // produce a decimal that looks like a measurement and is not one;
            // a model asked which third of the court it landed in is being
            // asked something it can actually see, and "kitchen / mid / deep"
            // is the resolution coaching is written at anyway.
            landing_depth: {
              type: "string", nullable: true,
              description: "kitchen | mid | deep | out | net — where the ball landed, or null if not seen to land",
            },
            landing_side: {
              type: "string", nullable: true,
              description: "left | middle | right from the hitter's view, or null",
            },
          },
          required: ["t", "rally_idx", "player", "type", "confidence"],
        },
      },
      playstyle: {
        type: "object",
        properties: {
          summary: str, tendencies: { type: "array", items: str }, under_pressure: str,
        },
        required: ["summary", "tendencies", "under_pressure"],
      },
      skills: {
        type: "array",
        items: {
          type: "object",
          properties: {
            skill_key: { type: "string", enum: SKILLS.map((s) => s.key) },
            rating: num, basis: str,
          },
          required: ["skill_key", "rating", "basis"],
        },
      },
      coaching: {
        type: "object",
        properties: {
          headline: str, summary: str,
          strengths: { type: "array", items: str },
          top_priority_fix: {
            type: "object",
            properties: { issue: str, why_it_matters: str, evidence: str },
            required: ["issue", "why_it_matters", "evidence"],
          },
          secondary: {
            type: "array",
            items: {
              type: "object",
              properties: { issue: str, evidence: str },
              required: ["issue", "evidence"],
            },
          },
        },
        required: ["headline", "summary", "strengths", "top_priority_fix", "secondary"],
      },
      observations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            rally_idx: { type: "integer", nullable: true },
            shot_t: { type: "number", nullable: true },
            skill_key: { type: "string", enum: SKILLS.map((s) => s.key) },
            coaching_dimension: { type: "string", enum: COACHING_DIMENSIONS },
            valence: { type: "string", enum: ["strength", "weakness"] },
            title: str, detail: str, severity: num,
            why_it_matters: { type: "string", nullable: true },
            what_to_change: { type: "string", nullable: true },
            drill_slug: { type: "string", nullable: true },
          },
          required: ["skill_key", "coaching_dimension", "valence", "title", "detail", "severity"],
        },
      },
      drills: {
        type: "array",
        items: {
          type: "object",
          properties: {
            slug: { type: "string", nullable: true },
            name: str, targets: str, reps_or_duration: str,
          },
          required: ["name", "targets", "reps_or_duration"],
        },
      },
      data_gaps: { type: "string", nullable: true },
    },
    required: ["rallies", "shots", "playstyle", "skills", "coaching", "observations", "drills"],
  };
}

export function analystPrompt(input: AnalystInput, legend: string): string {
  const contacts = input.contacts.length;
  const withBody = input.contacts.filter((c) => c.body).length;
  return `${legend}

You are an expert pickleball coach with a computer-vision assistant.

You have the assistant's overlay drawn on the footage, and a JSON record of
what it MEASURED. The gold box labelled YOU is the player you are coaching.

WHAT THE MEASUREMENTS ARE

${contacts === 0
  ? "NO contacts were measured for this clip, and that is the normal case: nothing in this pipeline\ntracks the ball. Every contact in your answer comes from you watching the footage. Do not treat\nthe empty list as evidence that nothing was hit."
  : `${contacts} contacts, ${withBody} of them with body measurements. A contact is a moment the\nball visibly changed direction against a player — a timed observation, not a guess.`}
Positions are in court FEET: x runs 0-20 across, y runs away from the
camera with 0 at the near baseline, 22 at the net, 44 at the far baseline. The
kitchen lines are at y=15 and y=29. Body measurements are in the player's own
shoulder widths, so a shot at the far baseline compares directly with one near
the camera; knee angle is degrees, where 180 is a straight leg.

The assistant did NOT decide which rally a contact belongs to, or what kind of
shot it was, and the overlay does not show rallies or net crossings. Those are
your judgments to make, and they are why you have the video.

YOUR JOB

1. RALLIES — points actually being played, serve to the moment the ball stops
   being played. Walking about and retrieving the ball between points is not a
   rally. Number them from 1.
2. SHOTS — every paddle contact in the clip: WHEN it happened, WHO hit it,
   what kind of shot it was, and roughly where it landed. You find these by
   watching. Nothing else in this pipeline detects the ball, so a contact you
   do not report is a contact that does not exist as far as this product is
   concerned — the rally lengths, the shot counts and the contact totals shown
   to the player are all counted from this list.
   Report EVERY contact by both players' sides, not only the subject's: a
   rally of nine shots where you list four reads to the player as a four-shot
   rally. "unknown" is a correct answer for a type you cannot tell, and a
   wrong label is not.
3. PLAYSTYLE of the subject — how they actually play, where they win and lose
   points, what they reach for under pressure. Describe, do not flatter.
4. SKILL RATINGS 1-5, only for skills this clip supports. 1 is a clear
   weakness, 3 is competent, 5 is a strength at this player's level. Omit a
   skill rather than inventing a number, and say what the rating rests on.
5. COACHING — a headline, a short summary, 1-2 strengths, one priority fix,
   1-2 secondary points. Every one cites a rally, a time, or a measured number.
6. OBSERVATIONS — the same findings as structured records, one per finding,
   each tagged with a skill and a coaching dimension, severity 1-5 (5 being
   the most costly), and where it is about one identifiable moment, the
   shot_t of that contact -- which must be one of the contact timestamps you
   were given, not a time you chose.
7. DRILLS — what to practise, tied to the priority fix. Where one of the
   catalogue drills fits, cite its slug; otherwise leave slug null and name it.

RULES THAT MATTER MORE THAN COMPLETENESS

- Nothing here sees the PADDLE. You may discuss where the arm was, how big the
  swing was, how high the contact was. You may NOT claim anything about the
  paddle's face angle, its path through the ball, spin, or where on the face
  contact was made.
- Prefer patterns over single shots. Three dinks taken with straight legs is a
  coaching point; one is noise.
- Use the measured numbers where they support you. "Knees at 172° on all four
  of those dinks" beats "you stood too upright".
- Where the footage does not support something, say so in data_gaps rather
  than filling the space.

Player's stated level: ${input.skillLevel ?? "not stated"}
Focus they asked for: ${input.focusArea ?? "none stated"}
${input.knownLimitations.length ? `\nKNOWN LIMITATIONS OF THIS DATA:\n${input.knownLimitations.map((l) => `- ${l}`).join("\n")}` : ""}

DRILL CATALOGUE (cite slugs from here only):
${input.drillCatalogue.map((d) => `${d.slug} — ${d.name} (${d.skill})`).join("\n") || "(none available)"}

MEASURED FACTS:
${JSON.stringify({
  clip_seconds: input.clipSeconds,
  subject_player: input.subjectPlayerId,
  ball_coverage: input.ballCoverage,
  court_confidence: input.courtConfidence,
  contacts: input.contacts,
})}`;
}

/** Phrases describing something nothing in this pipeline can observe. */
const FORBIDDEN = [
  "paddle face", "face was open", "face is open", "paddle angle", "paddle path",
  "topspin", "top spin", "backspin", "back spin", "sidespin", "slice",
  "sweet spot", "continental grip",
];

/**
 * What a program can check. Not "is the coaching good" — that needs a person —
 * but "is it talking about this clip". Returns problems, empty when clean.
 */
export function auditAnalysis(out: AnalystOutput, input: AnalystInput): string[] {
  const problems: string[] = [];

  for (const r of out.rallies ?? []) {
    if (r.start_s < 0 || r.end_s > input.clipSeconds + 0.5 || r.end_s <= r.start_s) {
      problems.push(
        `rally ${r.idx} at ${r.start_s.toFixed(1)}-${r.end_s.toFixed(1)}s is outside a ${input.clipSeconds.toFixed(1)}s clip`
      );
    }
  }

  // Shots must land on measured contacts -- ONLY when there are measured
  // contacts to land on.
  //
  // This check was written when the ball detector found contacts and the model
  // only had to label them: a shot at a time nothing observed was invented.
  // With ball tracking removed there are no measured contacts at all, so the
  // check inverted itself -- every shot the model correctly FOUND was flagged
  // as invented, and the "contacts given no shot type" count became the size
  // of an empty set. Auditing a claim against evidence that no longer exists
  // does not make the claim wrong; it makes the audit meaningless, and a
  // grounding report full of false alarms is worse than none because it
  // trains you to ignore real ones.
  const times = new Set(input.contacts.map((c) => Math.round(c.t * 100)));
  if (times.size > 0) {
    const invented = (out.shots ?? []).filter((s) => !times.has(Math.round(s.t * 100)));
    if (invented.length) {
      problems.push(`${invented.length} shot(s) at times that are not measured contacts (e.g. ${invented[0].t}s)`);
    }
    const labelled = (out.shots ?? []).length - invented.length;
    if (labelled < times.size) {
      problems.push(`${times.size - labelled} measured contact(s) were given no shot type`);
    }
  }

  const slugs = new Set(input.drillCatalogue.map((d) => d.slug));
  for (const d of out.drills ?? []) {
    if (d.slug && !slugs.has(d.slug)) problems.push(`drill slug "${d.slug}" is not in the catalogue`);
  }
  for (const o of out.observations ?? []) {
    if (o.drill_slug && !slugs.has(o.drill_slug)) {
      problems.push(`observation cites drill slug "${o.drill_slug}", which does not exist`);
    }
  }

  // Phrased for a reader, not a log line. "claims something nothing here can
  // see: \"paddle face\"" is precise and meaningless to the person it is shown
  // to; it reads like an internal assertion leaking into the product, which is
  // what it was. The fact worth conveying is WHY the claim cannot be checked.
  const blob = JSON.stringify(out).toLowerCase();
  for (const phrase of FORBIDDEN) {
    if (blob.includes(phrase)) {
      problems.push(
        `The read mentions "${phrase}". This pass watches the clip at one frame per second, and a ` +
          "pickleball stroke lasts about a third of a second — so the paddle itself is never visible in a " +
          "sampled frame. Take that part as a guess rather than something observed."
      );
    }
  }
  return problems;
}

export async function runAnalyst(opts: {
  videoBytes: Uint8Array;
  videoName: string;
  input: AnalystInput;
  legend: string;
  onLog?: (line: string) => void;
}): Promise<{ output: AnalystOutput; problems: string[]; model: string }> {
  const model = analystModel();
  const file = await uploadVideo(opts.videoBytes, opts.videoName, "video/mp4", opts.onLog);
  try {
    const output = await generateJSON<AnalystOutput>({
      model,
      file,
      prompt: analystPrompt(opts.input, opts.legend),
      schema: analystSchema(),
      onLog: opts.onLog,
    });
    const problems = auditAnalysis(output, opts.input);
    for (const p of problems) opts.onLog?.(`analyst audit: ${p}`);
    return { output, problems, model };
  } finally {
    // The handle is worth releasing, but a leaked one expires in 48h and must
    // never fail an analysis that otherwise worked.
    await deleteFile(file.name).catch(() => {});
  }
}
