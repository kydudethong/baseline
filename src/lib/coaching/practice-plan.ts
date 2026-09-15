/**
 * Turn a diagnosis into a session you can actually run.
 *
 * The analyst already returns drill suggestions, and a list of drills is not a
 * plan. A player standing on court with forty minutes and a bucket of balls
 * needs to know what to hit first, for how long, what good looks like, and
 * when to stop. "Work on your third shot drop" is a diagnosis; "ten minutes of
 * this, then fifteen of that, stop when you hit eight in ten" is a plan.
 *
 * TEXT-ONLY, and that is the point of doing it as a separate call. The video
 * has already been watched twice -- once whole at 1fps, once per shot at 15fps
 * -- and everything this needs is in the coaching output those produced. A
 * text call costs a fraction of a cent and a couple of seconds, so the plan is
 * not competing for the analyst's attention or its context window.
 */
import { generateJSONFromText } from "./gemini";
import type { AnalystOutput } from "./analyst";
import type { CoachingDrillRow } from "@/lib/db/types";

export interface PracticeBlock {
  idx: number;
  kind: "warmup" | "drill" | "game" | "cooldown";
  name: string;
  drillSlug: string | null;
  minutes: number | null;
  how: string;
  success: string | null;
  targets: string | null;
}

export interface PracticePlan {
  focus: string;
  totalMinutes: number | null;
  successLooksLike: string | null;
  blocks: PracticeBlock[];
}

const SCHEMA = {
  type: "object",
  properties: {
    focus: { type: "string", description: "One line: what this session is for." },
    success_looks_like: {
      type: "string",
      description: "What should be measurably different by the next upload.",
    },
    blocks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", description: "warmup | drill | game | cooldown" },
          name: { type: "string" },
          drill_slug: {
            type: "string",
            nullable: true,
            description: "A slug from the drill library, or null if this is not a library drill.",
          },
          minutes: { type: "integer", nullable: true },
          how: {
            type: "string",
            description: "Step by step, second person, as a coach standing courtside would say it.",
          },
          success: {
            type: "string",
            nullable: true,
            description: "A measurable stop condition, e.g. '8 of 10 land in the kitchen'.",
          },
          targets: { type: "string", nullable: true, description: "Which weakness this answers." },
        },
        required: ["kind", "name", "how"],
      },
    },
  },
  required: ["focus", "blocks"],
};

function prompt(out: AnalystOutput, drills: CoachingDrillRow[]): string {
  const library = drills
    .map((d) => `- ${d.slug} — ${d.name} (${d.skill_key}, ${d.players} player(s), ${d.equipment}): ${d.purpose}`)
    .join("\n");

  return [
    "Build ONE practice session for this player, from the analysis below.",
    "",
    "## What the analysis found",
    `Top priority: ${out.coaching.top_priority_fix.issue} — ${out.coaching.top_priority_fix.why_it_matters}`,
    out.coaching.secondary.length
      ? `Also: ${out.coaching.secondary.map((x) => x.issue).join("; ")}`
      : "",
    `Strengths to keep sharp: ${out.coaching.strengths.join("; ") || "none recorded"}`,
    `Playstyle: ${out.playstyle.summary}`,
    out.skills.length
      ? `Skill ratings (1-5): ${out.skills.map((s) => `${s.skill_key} ${s.rating}`).join(", ")}`
      : "",
    "",
    "## Drill library — prefer these, and use the slug exactly",
    library || "(empty — write your own drills and set drill_slug to null)",
    "",
    "## Rules",
    "- 45 to 60 minutes total. A session nobody has time for is a session nobody does.",
    "- Start with a warm-up block. Put the HARDEST work second, while they are fresh",
    "  and before fatigue makes them practise a worse version of the stroke.",
    "- Spend most of the session on the top priority. One session that fixes one",
    "  thing beats six blocks that touch six things.",
    "- Every drill block needs a `success` a player can check themselves, in counts",
    "  or a ratio. Not 'feel more balanced' — something they can score.",
    "- `how` is instructions, not description: where to stand, what to hit, where it",
    "  should land, what to watch for. Assume they are alone unless the drill needs a",
    "  partner, and say so if it does.",
    "- Finish with a game or play block that puts the fix under pressure. A stroke",
    "  that only works in a drill has not been fixed.",
    "- Only use drill_slug values from the library above. Invent a drill by all means,",
    "  but then set drill_slug to null rather than guessing at a slug.",
  ].filter(Boolean).join("\n");
}

/**
 * Build the plan. Returns null rather than throwing.
 *
 * A missing practice plan is a missing nice-to-have; the coaching read, the
 * ratings and the technique notes are already written by the time this runs.
 * Failing the whole analysis over the last optional step would be a bad trade.
 */
export async function buildPracticePlan(opts: {
  model: string;
  analyst: AnalystOutput;
  drills: CoachingDrillRow[];
  onLog?: (line: string) => void;
}): Promise<PracticePlan | null> {
  try {
    const raw = await generateJSONFromText<{
      focus?: string;
      success_looks_like?: string;
      blocks?: Array<{
        kind?: string; name?: string; drill_slug?: string | null;
        minutes?: number | null; how?: string; success?: string | null; targets?: string | null;
      }>;
    }>({
      model: opts.model,
      prompt: prompt(opts.analyst, opts.drills),
      schema: SCHEMA,
      // 4,000 could not have worked: a single measured run spent 9,473 tokens
      // thinking before writing anything, and thinking counts against this.
      maxOutputTokens: 20_000,
    });

    const valid = new Set(opts.drills.map((d) => d.slug));
    const kinds = new Set(["warmup", "drill", "game", "cooldown"]);

    const blocks: PracticeBlock[] = (raw.blocks ?? [])
      .filter((b) => b.name && b.how)
      .map((b, i) => ({
        idx: i,
        // An unrecognised kind becomes "drill" rather than failing the insert:
        // the check constraint would reject it, and losing a whole plan over a
        // label the player never sees would be absurd.
        kind: (kinds.has(String(b.kind)) ? b.kind : "drill") as PracticeBlock["kind"],
        name: String(b.name),
        // A slug that is not in the library is dropped, not stored. A dangling
        // reference would render as a broken link to a drill page that does
        // not exist -- worse than a block with no link at all.
        drillSlug: b.drill_slug && valid.has(b.drill_slug) ? b.drill_slug : null,
        minutes: typeof b.minutes === "number" && b.minutes > 0 ? Math.round(b.minutes) : null,
        how: String(b.how),
        success: b.success ?? null,
        targets: b.targets ?? null,
      }));

    if (blocks.length === 0) {
      opts.onLog?.("practice plan: the model returned no usable blocks");
      return null;
    }

    const totalMinutes = blocks.reduce((sum, b) => sum + (b.minutes ?? 0), 0) || null;
    opts.onLog?.(`practice plan: ${blocks.length} block(s), ~${totalMinutes ?? "?"} min`);

    return {
      focus: raw.focus ?? "Practice session",
      totalMinutes,
      successLooksLike: raw.success_looks_like ?? null,
      blocks,
    };
  } catch (err) {
    opts.onLog?.(`practice plan skipped: ${(err as Error).message.split("\n")[0]}`);
    return null;
  }
}
