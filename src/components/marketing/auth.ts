import { createClient } from "@/lib/supabase/server";

/** Whether somebody is signed in, and where "start" should take them. */
export async function marketingAuth(): Promise<{ isAuthed: boolean; startHref: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return { isAuthed: Boolean(user), startHref: user ? "/dashboard/new" : "/signup" };
}
