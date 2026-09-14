/**
 * A month of practice, built from the weaknesses the analyses found.
 *
 * DIVISION OF LABOUR. This file asks the model for a SESSION LIBRARY -- a
 * handful of distinct session designs aimed at the player's actual weaknesses
 * -- and then lays those sessions onto real dates itself, using schedule.ts.
 * The model is never asked for a date. It is bad at calendars in a way that is
 * hard to notice (a Tuesday that is a Wednesday, a 31st of November) and good
 * at "what should someone with a weak third-shot drop actually hit", which is
 * the part worth paying for.
 *
 * WHY A LIBRARY RATHER THAN N SESSIONS. Asking for twelve sessions gets twelve
 * variations of one idea, or twelve unrelated ideas. Asking for four designs
 * and repeating them across the month is what a coach actually does: you do not
 * invent a new session every Tuesday, you run the drop session until the drop
 * is better. Repetition is the mechanism, not a shortcut.
 */
import { generateJSONFromText } from "../coaching/gemini";
import type { CoachingDrillRow } from "../db/types";
import { sessionDates, type SchedulePrefs } from "./schedule";

export interface PlannedDrill {
  idx: number;
  drillSlug: string | null;
  name: string;
  minutes: number | null;
  how: string | null;
  success: string | null;
  targets: string | null;
}

export interface PlannedSession {
  scheduledOn: string;
  kind: "practice" | "match" | "rest" | "assessment";
  title: string;
  focus: string | null;
  minutes: number | null;
  drills: PlannedDrill[];
}

export interface MonthPlan {
  focus: string;
  targets: string[];
  sessions: PlannedSession[];
}

const SCHEMA = {
  type: "object",
  properties: {
    focus: { type: "string", description: "One line: what this MONTH is for." },
    targets: {
      type: "array", items: { type: "string" },
      description: "The weaknesses this month is answering, shortest useful phrasing.",
    },
    session_types: {
      type: "array",
      description: "3 to 5 distinct session designs, to be repeated across the month.",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          kind: { type: "string", description: "practice | match | assessment" },
          focus: { type: "string", nullable: true },
          weight: {
            type: "integer",
            description: "How many of the month's sessions should be this type, relative to the others.",
          },
          drills: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                drill_slug: { type: "string", nullable: true },
                minutes: { type: "integer", nullable: true },
                how: { type: "string", description: "Step by step, second person." },
                success: { type: "string", nullable: true, description: "A measurable stop condition." },
                targets: { type: "string", nullable: true },
              },
              required: ["name", "how"],
            },
          },
        },
        required: ["title", "kind", "weight", "drills"],
      },
    },
  },
  required: ["focus", "session_types"],
};

function prompt(weaknesses: string[], strengths: string[], drills: CoachingDrillRow[], sessions: number): string {
  const library = drills
    .map((d) => `- ${d.slug} — ${d.name} (${d.skill_key}, ${d.players} player(s), ${d.equipment}): ${d.purpose}`)
    .join("\n");

  return [
    `Design a month of pickleball practice for one player: ${sessions} sessions.`,
    "",
    "## What their games showed",
    weaknesses.length ? `Weaknesses, most costly first:\n${weaknesses.map((w) => `- ${w}`).join("\n")}` : "No weaknesses recorded.",
    strengths.length ? `\nStrengths to keep sharp:\n${strengths.map((s) => `- ${s}`).join("\n")}` : "",
    "",
    "## Drill library — prefer these, and use the slug exactly",
    library || "(empty — write your own drills and set drill_slug to null)",
    "",
    "## Rules",
    "- Return 3 to 5 SESSION TYPES, not one per date. A month of practice is a few",
    "  designs repeated, because repetition is how a stroke changes — you do not invent",
    "  a new session every week, you run the drop session until the drop is better.",
    "- `weight` decides how often each type recurs. Put the most weight on the top",
    "  weakness. A month that touches six things equally fixes none of them.",
    "- Include ONE assessment session, late in the month: the same drills as the main",
    "  practice type, scored, so they can tell whether the month worked.",
    "- Every drill needs a `success` the player can check themselves, in counts or a",
    "  ratio. Not 'feel more balanced' — something they can score.",
    "- `how` is instructions, not description: where to stand, what to hit, where it",
    "  should land, what to watch for. Say if a partner is needed.",
    "- Only use drill_slug values from the library above. Invent a drill by all means,",
    "  then set drill_slug to null rather than guessing at a slug.",
  ].filter(Boolean).join("\n");
}

/**
 * Build the month. Returns null rather than throwing.
 *
 * `today` is threaded through rather than read from the clock so the result is
 * testable and so a plan generated mid-month does not open with sessions the
 * player has already missed.
 */
export async function buildMonthPlan(opts: {
  model: string;
  month: Date;
  prefs: SchedulePrefs;
  weaknesses: string[];
  strengths: string[];
  drills: CoachingDrillRow[];
  today?: Date;
  onLog?: (line: string) => void;
}): Promise<MonthPlan | null> {
  const dates = sessionDates(opts.month, opts.prefs, opts.today);
  if (dates.length === 0) {
    opts.onLog?.("month plan: no dates left in this month to schedule");
    return null;
  }

  try {
    const raw = await generateJSONFromText<{
      focus?: string;
      targets?: string[];
      session_types?: Array<{
        title?: string; kind?: string; focus?: string | null; weight?: number;
        drills?: Array<{
          name?: string; drill_slug?: string | null; minutes?: number | null;
          how?: string; success?: string | null; targets?: string | null;
        }>;
      }>;
    }>({
      model: opts.model,
      prompt: prompt(opts.weaknesses, opts.strengths, opts.drills, dates.length),
      schema: SCHEMA,
      maxOutputTokens: 6000,
    });

    const valid = new Set(opts.drills.map((d) => d.slug));
    const kinds = new Set(["practice", "match", "rest", "assessment"]);
    const types = (raw.session_types ?? [])
      .filter((t) => t.title && (t.drills ?? []).length > 0)
      .map((t) => ({
        title: String(t.title),
        kind: (kinds.has(String(t.kind)) ? t.kind : "practice") as PlannedSession["kind"],
        focus: t.focus ?? null,
        weight: Math.max(1, Math.round(t.weight ?? 1)),
        drills: (t.drills ?? [])
          .filter((d) => d.name && d.how)
          .map((d, i) => ({
            idx: i,
            // A slug not in the library is dropped, not stored: a dangling
            // reference renders as a link to a drill page that does not exist.
            drillSlug: d.drill_slug && valid.has(d.drill_slug) ? d.drill_slug : null,
            name: String(d.name),
            minutes: typeof d.minutes === "number" && d.minutes > 0 ? Math.round(d.minutes) : null,
            how: d.how ?? null,
            success: d.success ?? null,
            targets: d.targets ?? null,
          })),
      }))
      .filter((t) => t.drills.length > 0);

    if (types.length === 0) {
      opts.onLog?.("month plan: the model returned no usable session types");
      return null;
    }

    const sessions = assignTypes(dates, types);
    opts.onLog?.(`month plan: ${types.length} session type(s) across ${sessions.length} date(s)`);
    return {
      focus: raw.focus ?? "Practice month",
      targets: (raw.targets ?? []).map(String).filter(Boolean),
      sessions,
    };
  } catch (err) {
    opts.onLog?.(`month plan skipped: ${(err as Error).message.split("\n")[0]}`);
    return null;
  }
}

type SessionType = {
  title: string;
  kind: PlannedSession["kind"];
  focus: string | null;
  weight: number;
  drills: PlannedDrill[];
};

/**
 * Lay the session types onto the dates.
 *
 * Interleaved by weight rather than blocked, so the month reads
 * drop / drop / hands / drop / drop / hands rather than eight drop sessions
 * followed by four hands sessions. Blocking would mean the second weakness
 * gets no attention until week three, by which point the player has stopped
 * looking at the calendar.
 *
 * An assessment type is pulled out of the rotation and pinned to the LAST
 * date, wherever the weights would otherwise have put it -- an assessment in
 * week one measures nothing.
 */
function assignTypes(dates: string[], types: SessionType[]): PlannedSession[] {
  const assessment = types.find((t) => t.kind === "assessment");
  const rotation = types.filter((t) => t !== assessment);
  const pool = rotation.length > 0 ? rotation : types;

  // Expand by weight, then interleave by taking each type in turn: a type with
  // weight 3 appears three times in the cycle, spread through it.
  const cycle: SessionType[] = [];
  const remaining = pool.map((t) => ({ type: t, left: t.weight }));
  while (remaining.some((r) => r.left > 0)) {
    for (const r of remaining) {
      if (r.left > 0) {
        cycle.push(r.type);
        r.left--;
      }
    }
  }

  const lastIsAssessment = Boolean(assessment) && dates.length > 1;
  const bodyDates = lastIsAssessment ? dates.slice(0, -1) : dates;

  const sessions: PlannedSession[] = bodyDates.map((date, i) => {
    const t = cycle[i % cycle.length];
    return {
      scheduledOn: date,
      kind: t.kind,
      title: t.title,
      focus: t.focus,
      minutes: totalMinutes(t.drills),
      drills: t.drills,
    };
  });

  if (lastIsAssessment && assessment) {
    sessions.push({
      scheduledOn: dates[dates.length - 1],
      kind: "assessment",
      title: assessment.title,
      focus: assessment.focus,
      minutes: totalMinutes(assessment.drills),
      drills: assessment.drills,
    });
  }
  return sessions;
}

function totalMinutes(drills: PlannedDrill[]): number | null {
  const sum = drills.reduce((acc, d) => acc + (d.minutes ?? 0), 0);
  return sum > 0 ? sum : null;
}

/**
 * Exported for tests only.
 *
 * assignTypes is the part of this file worth testing -- it is pure, it decides
 * the shape of the whole month, and its failures (an assessment in week one,
 * one weakness ignored until week three) are invisible in a screenshot.
 * buildMonthPlan around it is a network call and a schema, which a unit test
 * can only re-describe.
 */
export const __testing = { assignTypes };
