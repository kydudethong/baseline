"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { LoginSchema, SignupSchema, type AuthFormState } from "@/lib/auth/schema";
import { env } from "@/lib/env";

export async function signup(
  _prevState: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const parsed = SignupSchema.safeParse({
    displayName: formData.get("displayName"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { display_name: parsed.data.displayName },
      emailRedirectTo: `${env.siteUrl}/auth/callback`,
    },
  });

  if (error) {
    return { error: error.message };
  }

  // If email confirmation is required (the default for a new Supabase
  // project), there is no session yet — tell the user to check their inbox
  // instead of redirecting into a dashboard they can't access yet.
  if (!data.session) {
    return {
      message: "Check your email to confirm your account before signing in.",
    };
  }

  revalidatePath("/", "layout");
  redirect("/dashboard");
}

export async function login(
  _prevState: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const parsed = LoginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    return { error: error.message };
  }

  const next = formData.get("next");
  revalidatePath("/", "layout");
  redirect(typeof next === "string" && next.startsWith("/") ? next : "/dashboard");
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/");
}
