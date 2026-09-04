import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CoachingBlueprintStepRow } from "@/lib/db/types";

export const runtime = "nodejs";

interface StepRequestBody {
  done?: boolean;
}

/**
 * Marks one practice-plan step done/not-done. coaching_blueprint_steps'
 * update_own RLS policy (0005_coaching_layer.sql) scopes this to steps
 * whose parent blueprint belongs to the caller — no ownership check needed
 * here beyond "is this the signed-in user's own session client", since an
 * update against someone else's step simply matches zero rows.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; stepId: string }> }
) {
  const { stepId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: StepRequestBody;
  try {
    body = (await request.json()) as StepRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const doneAt = body.done ? new Date().toISOString() : null;

  const { data, error } = await supabase
    .from("coaching_blueprint_steps")
    .update({ done_at: doneAt })
    .eq("id", stepId)
    .select()
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Step not found." }, { status: 404 });

  return NextResponse.json(data as CoachingBlueprintStepRow);
}
