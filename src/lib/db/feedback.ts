import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoachingFeedbackRow, Database, FeedbackVerdict } from "./types";

type Client = SupabaseClient<Database>;

/**
 * This user's existing verdicts for one analysis, keyed by target id.
 *
 * WHY THE CONTROL MUST SHOW WHAT THEY ALREADY SAID. A rating control that
 * resets to blank on every page load asks the same question again, which
 * reads as the app not having listened — and the second answer is then given
 * with less care than the first. Showing the previous answer also makes
 * changing it an obvious, cheap action, which is where the good corrections
 * come from: somebody re-reads a point a week later and decides they were
 * wrong about it.
 *
 * Returns an empty map when the table is not there yet (migration 0018 not
 * run), because a page that 500s over a missing feedback table would be a
 * spectacular own goal.
 */
export async function feedbackForAnalysis(
  supabase: Client,
  analysisId: string
): Promise<Map<string, FeedbackVerdict>> {
  const { data, error } = await supabase
    .from("coaching_feedback")
    .select("target_id, verdict")
    .eq("analysis_id", analysisId);
  if (error) {
    if ((error as { code?: string }).code === "42P01") return new Map();
    throw error;
  }
  return new Map(
    ((data ?? []) as Pick<CoachingFeedbackRow, "target_id" | "verdict">[])
      .map((r) => [r.target_id, r.verdict])
  );
}
