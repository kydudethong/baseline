// Generates a five-session practice progression for one ranked weakness —
// the practice-plan half of the coaching layer, separate from
// run-coaching.ts's per-session read. Drills are always retrieved from
// coaching_drills (see drills.ts) and handed to the model as a closed list;
// blueprintPrompt.ts's prompt already says "you may ONLY use these", and
// this module re-validates that on the way back out rather than trusting
// it, since an invalid drill_slug would otherwise fail the insert on
// coaching_blueprint_steps' foreign key with a much less useful error.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CoachingBlueprintRow,
  CoachingBlueprintStepRow,
  CoachingDrillRow,
  Database,
} from "@/lib/db/types";
import { generateJSON, textPart } from "./claude";
import { getDrillsForSkill } from "./drills";
import { BLUEPRINT_SCHEMA, blueprintPrompt } from "./prompts";
import { skillName } from "./types";

type Client = SupabaseClient<Database>;

export class BlueprintPipelineError extends Error {}

interface BlueprintPlan {
  title: string;
  goal: string;
  target: string;
  steps: Array<{ focus: string; drill_slug: string; target: string }>;
}

export interface BlueprintWithSteps {
  blueprint: CoachingBlueprintRow;
  steps: CoachingBlueprintStepRow[];
}

export async function generateBlueprint(
  supabase: Client,
  opts: {
    userId: string;
    analysisId: string | null;
    skillKey: string;
    weaknessTitle: string;
    weaknessDetail: string;
    level: string | null;
  }
): Promise<BlueprintWithSteps> {
  const drills = await getDrillsForSkill(supabase, opts.skillKey);
  if (drills.length === 0) {
    throw new BlueprintPipelineError(
      `The drill library doesn't have anything for ${skillName(opts.skillKey)} yet, so there's nothing to build a practice plan from.`
    );
  }
  const drillsBySlug = new Map(drills.map((d) => [d.slug, d]));

  const plan = await generateJSON<BlueprintPlan>(
    [
      textPart(
        blueprintPrompt({
          weaknessTitle: opts.weaknessTitle,
          weaknessDetail: opts.weaknessDetail,
          skillName: skillName(opts.skillKey),
          level: opts.level,
          drills: drills.map((d) => ({ slug: d.slug, name: d.name, skill: d.skill_key, difficulty: d.difficulty, purpose: d.purpose })),
        })
      ),
    ],
    BLUEPRINT_SCHEMA,
    0.4
  );

  const { data: blueprintRow, error: blueprintError } = await supabase
    .from("coaching_blueprints")
    .insert({
      user_id: opts.userId,
      analysis_id: opts.analysisId,
      skill_key: opts.skillKey,
      title: plan.title,
      goal: plan.goal,
      target: plan.target,
      status: "active",
    })
    .select()
    .single();
  if (blueprintError) throw blueprintError;
  const blueprint = blueprintRow as CoachingBlueprintRow;

  const stepRows = plan.steps.map((s, i) => resolveStep(s, i, drillsBySlug));
  const { data: insertedSteps, error: stepsError } = await supabase
    .from("coaching_blueprint_steps")
    .insert(stepRows.map((s) => ({ ...s, blueprint_id: blueprint.id })))
    .select()
    .order("idx");
  if (stepsError) throw stepsError;

  return { blueprint, steps: (insertedSteps as CoachingBlueprintStepRow[] | null) ?? [] };
}

/** A step with a blank drill_slug is the re-test step by design (see blueprintPrompt's RULES); any other blank or unrecognized slug is a model mistake, not invented content — fall back to "Re-test" rather than inserting a name/slug pair that doesn't trace back to the library. */
function resolveStep(
  step: { focus: string; drill_slug: string; target: string },
  idx: number,
  drillsBySlug: Map<string, CoachingDrillRow>
): Omit<CoachingBlueprintStepRow, "id" | "blueprint_id"> {
  const drill = step.drill_slug ? drillsBySlug.get(step.drill_slug) : undefined;
  const isRetestStep = idx === 4 && !step.drill_slug;
  return {
    idx,
    focus: step.focus,
    drill_slug: drill?.slug ?? null,
    drill_name: drill?.name ?? (isRetestStep ? "Re-test" : "Re-test (unrecognized drill)"),
    target: step.target,
    done_at: null,
  };
}
