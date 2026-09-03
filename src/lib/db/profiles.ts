import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ProfileRow } from "./types";

type Client = SupabaseClient<Database>;

/**
 * profiles.id === auth.users.id; handle_new_user() (0001_init.sql) creates
 * the row on signup, but skill_level/paddle_hand start out null until the
 * player fills them in — maybeSingle() rather than single() just in case
 * that trigger predates a given account.
 */
export async function getProfile(supabase: Client, userId: string): Promise<ProfileRow | null> {
  const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (error) throw error;
  return data as ProfileRow | null;
}
