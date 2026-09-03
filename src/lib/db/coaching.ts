import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CoachingObservationRow,
  CoachingRallyRow,
  CoachingReadRow,
  CoachingSkillRatingRow,
  Database,
} from "./types";

type Client = SupabaseClient<Database>;

export interface CoachingData {
  read: CoachingReadRow | null;
  observations: CoachingObservationRow[];
  skills: CoachingSkillRatingRow[];
  rallies: CoachingRallyRow[];
}

/**
 * Everything the analysis page's coaching section needs, in one round trip
 * per table — mirrors getPhase2Data's shape in vision.ts. Read via the
 * caller's own session client; RLS (0005_coaching_layer.sql) scopes all
 * four tables to "an analysis this user owns", same pattern as Phase 2's
 * tables, so this never needs the service-role client run-coaching.ts uses
 * to write these rows.
 */
export async function getCoachingData(supabase: Client, analysisId: string): Promise<CoachingData> {
  const [readRes, obsRes, skillsRes, ralliesRes] = await Promise.all([
    supabase.from("coaching_reads").select("*").eq("analysis_id", analysisId).maybeSingle(),
    supabase
      .from("coaching_observations")
      .select("*")
      .eq("analysis_id", analysisId)
      .eq("dismissed", false)
      .order("severity", { ascending: false }),
    supabase.from("coaching_skill_ratings").select("*").eq("analysis_id", analysisId),
    supabase.from("coaching_rallies").select("*").eq("analysis_id", analysisId).order("idx"),
  ]);
  if (readRes.error) throw readRes.error;
  if (obsRes.error) throw obsRes.error;
  if (skillsRes.error) throw skillsRes.error;
  if (ralliesRes.error) throw ralliesRes.error;

  return {
    read: (readRes.data as CoachingReadRow | null) ?? null,
    observations: (obsRes.data as CoachingObservationRow[] | null) ?? [],
    skills: (skillsRes.data as CoachingSkillRatingRow[] | null) ?? [],
    rallies: (ralliesRes.data as CoachingRallyRow[] | null) ?? [],
  };
}
