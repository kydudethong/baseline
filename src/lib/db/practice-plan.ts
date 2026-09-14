import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoachingPracticeBlockRow, CoachingPracticePlanRow, Database } from "./types";

type Client = SupabaseClient<Database>;

export interface PracticePlanWithBlocks {
  plan: CoachingPracticePlanRow;
  blocks: CoachingPracticeBlockRow[];
}

/**
 * The session plan for one analysis, blocks in running order.
 *
 * Two round trips rather than a nested select because the blocks table has no
 * declared FK relationship in `Database` (see types.ts — `Relationships: []`),
 * so PostgREST's embedding syntax has nothing to resolve and the typed client
 * would reject it. Two indexed lookups on one analysis is not a cost worth
 * hand-writing a relationship type to avoid.
 *
 * Returns null when there is no plan. That is the ordinary case for every
 * analysis run before 0015 and for any run where the final optional step
 * failed, so it is a state the UI must render, not an error.
 */
export async function getPracticePlan(
  supabase: Client,
  analysisId: string
): Promise<PracticePlanWithBlocks | null> {
  const { data: plan, error } = await supabase
    .from("coaching_practice_plans")
    .select("*")
    .eq("analysis_id", analysisId)
    .maybeSingle();
  // A missing table (migration not run yet) must not take the whole analysis
  // page down with it — the coaching read above this is the thing the user
  // came for. PostgREST answers 42P01 for an undefined table.
  if (error) {
    if (error.code === "42P01") return null;
    throw error;
  }
  if (!plan) return null;

  const { data: blocks, error: blockErr } = await supabase
    .from("coaching_practice_blocks")
    .select("*")
    .eq("plan_id", (plan as CoachingPracticePlanRow).id)
    .order("idx");
  if (blockErr) throw blockErr;

  return {
    plan: plan as CoachingPracticePlanRow,
    blocks: (blocks as CoachingPracticeBlockRow[] | null) ?? [],
  };
}
