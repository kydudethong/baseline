"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { ProfileUpdate } from "@/lib/db/types";

export interface ProfileFormState {
  error?: string;
  message?: string;
}

/** Skill levels this app understands, as the setup screens already use them. */
const SKILL_LEVELS = ["2.5", "3.0", "3.5", "4.0", "4.5", "5.0+"];
const HANDS = ["right", "left"];

/**
 * Update the things about a player that are theirs to set.
 *
 * NAME, SKILL LEVEL, PADDLE HAND, and nothing else. Email and password belong
 * to the auth provider and changing either has consequences (a confirmation
 * mail, a lost session) that a dropdown is the wrong place to start; they are
 * shown here and changed elsewhere.
 *
 * EVERY FIELD IS OPTIONAL AND AN ABSENT ONE IS LEFT ALONE, rather than written
 * as null. The menu submits the whole form, so a player who opens it to fix a
 * typo in their name would otherwise clear a skill level they set months ago
 * and never notice.
 *
 * Validated against the same lists the setup screens offer, because these
 * values are read by the coaching prompt: a skill level of "pretty good" would
 * reach the model as a fact about the player.
 */
export async function updateProfile(
  _prev: ProfileFormState,
  formData: FormData
): Promise<ProfileFormState> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "You are signed out. Sign in and try again." };

  // Typed as the table's own Update shape rather than a loose record, so a
  // field name typo is a compile error instead of a silent no-op.
  const patch: ProfileUpdate = {};

  const rawName = formData.get("display_name");
  if (typeof rawName === "string") {
    const name = rawName.trim();
    if (name.length > 60) return { error: "That name is too long — 60 characters at most." };
    // An empty box means "no name", which is a real choice: the app falls back
    // to the readable part of the email and greets them with that.
    patch.display_name = name || null;
  }

  const rawSkill = formData.get("skill_level");
  if (typeof rawSkill === "string" && rawSkill !== "") {
    if (!SKILL_LEVELS.includes(rawSkill)) return { error: "That is not a skill level I know." };
    patch.skill_level = rawSkill;
  }

  const rawHand = formData.get("paddle_hand");
  if (typeof rawHand === "string" && rawHand !== "") {
    if (!HANDS.includes(rawHand)) return { error: "Paddle hand has to be left or right." };
    patch.paddle_hand = rawHand;
  }

  if (Object.keys(patch).length === 0) return { message: "Nothing to change." };

  const { error } = await supabase.from("profiles").update(patch).eq("id", user.id);
  if (error) return { error: error.message };

  // The name appears in the rail, on Home and in the coaching read, so the
  // whole shell is revalidated rather than one route.
  revalidatePath("/", "layout");
  return { message: "Saved." };
}
