/**
 * The prompts that survived the move to Gemini.
 *
 * prompts.ts was 598 lines built around two Claude calls -- a coaching read
 * and a tagging pass -- both of which are now one call in analyst.ts, with
 * its prompt living next to the schema it fills. These two are what is left:
 * the practice blueprint, and the ask-a-coach chat.
 *
 * coachPrompt's "never claim to know a shot type" rule is DELIBERATELY kept.
 * Shot types exist per analysis now, but this prompt answers from a history
 * that may span sessions recorded before they did, and a confident shot-type
 * claim about a session that never had one is exactly the kind of quiet
 * fiction the rest of this layer is built to avoid.
 */
import type { Schema } from "./gemini-schema";

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
