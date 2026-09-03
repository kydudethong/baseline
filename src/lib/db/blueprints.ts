import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoachingBlueprintRow, CoachingBlueprintStepRow, Database } from "./types";

type Client = SupabaseClient<Database>;

export interface BlueprintWithSteps {
  blueprint: CoachingBlueprintRow;
  steps: CoachingBlueprintStepRow[];
}

/** Practice plans generated from this analysis specifically — a blueprint can outlive the analysis that prompted it (analysis_id is nullable, set null on delete), but this page only shows the ones tied to the one you're looking at. */
export async function getBlueprintsForAnalysis(supabase: Client, analysisId: string): Promise<BlueprintWithSteps[]> {
  const { data: blueprints, error: blueprintsError } = await supabase
    .from("coaching_blueprints")
    .select("*")
    .eq("analysis_id", analysisId)
    .order("created_at", { ascending: false });
  if (blueprintsError) throw blueprintsError;
  const rows = (blueprints as CoachingBlueprintRow[] | null) ?? [];
  if (rows.length === 0) return [];

  const { data: steps, error: stepsError } = await supabase
    .from("coaching_blueprint_steps")
    .select("*")
    .in(
      "blueprint_id",
      rows.map((b) => b.id)
    )
    .order("idx");
  if (stepsError) throw stepsError;
  const stepsByBlueprint = new Map<string, CoachingBlueprintStepRow[]>();
  for (const s of (steps as CoachingBlueprintStepRow[] | null) ?? []) {
    const list = stepsByBlueprint.get(s.blueprint_id) ?? [];
    list.push(s);
    stepsByBlueprint.set(s.blueprint_id, list);
  }

  return rows.map((blueprint) => ({ blueprint, steps: stepsByBlueprint.get(blueprint.id) ?? [] }));
}
