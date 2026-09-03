import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoachingDrillRow, Database } from "@/lib/db/types";
import { SKILLS } from "./types";

type Client = SupabaseClient<Database>;

/**
 * The seeded drill library (0005_coaching_layer.sql) only covers 9 of the
 * 15 skill keys in SKILLS — there's no "positioning" drill, for instance,
 * even though positioning is one of the few skills this pipeline can
 * realistically rate (see prompts.ts's coachingReadPrompt/taggingPrompt
 * commentary). Falling straight back to "no drills, no blueprint" for
 * every uncovered skill would make the practice-plan feature unusable for
 * exactly the skills real weaknesses are most likely to land on, so this
 * widens to the skill's SKILLS group (e.g. positioning → transition, both
 * "Movement") before giving up. blueprint.ts still only ever hands the
 * model drills this function actually returned — never a skill_key that
 * doesn't match, and never an invented one.
 */
export async function getDrillsForSkill(supabase: Client, skillKey: string): Promise<CoachingDrillRow[]> {
  const exact = await queryDrills(supabase, [skillKey]);
  if (exact.length > 0) return exact;

  const group = SKILLS.find((s) => s.key === skillKey)?.group;
  if (!group) return [];
  const siblingKeys = SKILLS.filter((s) => s.group === group && s.key !== skillKey).map((s) => s.key);
  if (siblingKeys.length === 0) return [];
  return queryDrills(supabase, siblingKeys);
}

async function queryDrills(supabase: Client, skillKeys: string[]): Promise<CoachingDrillRow[]> {
  const { data, error } = await supabase.from("coaching_drills").select("*").in("skill_key", skillKeys);
  if (error) throw error;
  return (data as CoachingDrillRow[] | null) ?? [];
}
