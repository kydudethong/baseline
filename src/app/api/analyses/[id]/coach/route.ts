import { NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getAnalysisForUser } from "@/lib/db/analyses";
import { CoachingPipelineError, runCoachingPipeline } from "@/lib/coaching/run-coaching";

// Calls the Claude REST API directly (see lib/coaching/claude.ts) — no
// fs/child_process dependency, but kept on the Node runtime for parity with
// the rest of this app's server routes and consistent env var handling.
export const runtime = "nodejs";
export const maxDuration = 120;

interface CoachRequestBody {
  /**
   * A real player can span several player_N track labels — Rally IQ's
   * tracker has no re-identification, so an occlusion or missed detection
   * can resume the same person under a new ID (see facts.ts's
   * mergeSelfFragments()). Accepts a single label or a list; stored
   * comma-separated in analyses.self_player_label either way.
   */
  selfPlayerLabel?: string | string[];
  skillLevel?: string | null;
  paddleHand?: string | null;
  coachingKind?: string;
  notes?: string | null;
}

/**
 * Sets who "you" are for this analysis (the self-tag picker — see task
 * #41) and runs the coaching-narrative pipeline (facts.ts + the two Claude
 * calls in run-coaching.ts) against it. Separate from /process on purpose:
 * the CV pipeline has to finish and produce real player tracks before
 * there's anything to tag as "you", and the coaching read needs that tag
 * before it can score a specific player rather than the whole court.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const analysis = await getAnalysisForUser(supabase, user.id, id);
  if (!analysis) return NextResponse.json({ error: "Analysis not found" }, { status: 404 });
  if (analysis.status !== "completed") {
    return NextResponse.json({ error: "This analysis hasn't finished processing yet." }, { status: 409 });
  }

  let body: CoachRequestBody;
  try {
    body = (await request.json()) as CoachRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const requestedLabels = (Array.isArray(body.selfPlayerLabel) ? body.selfPlayerLabel : body.selfPlayerLabel ? [body.selfPlayerLabel] : [])
    .map((l) => l.trim())
    .filter(Boolean);
  const selfPlayerLabel = requestedLabels.length > 0 ? requestedLabels.join(",") : analysis.self_player_label;
  if (!selfPlayerLabel) {
    return NextResponse.json({ error: "selfPlayerLabel is required the first time you tag this analysis." }, { status: 400 });
  }

  const { error: updateAnalysisError } = await supabase
    .from("analyses")
    .update({
      self_player_label: selfPlayerLabel,
      ...(body.coachingKind !== undefined ? { coaching_kind: body.coachingKind } : {}),
      ...(body.notes !== undefined ? { coaching_notes: body.notes } : {}),
    })
    .eq("id", id)
    .eq("user_id", user.id);
  if (updateAnalysisError) {
    return NextResponse.json({ error: updateAnalysisError.message }, { status: 500 });
  }

  if (body.skillLevel !== undefined || body.paddleHand !== undefined) {
    const { error: updateProfileError } = await supabase
      .from("profiles")
      .update({
        ...(body.skillLevel !== undefined ? { skill_level: body.skillLevel } : {}),
        ...(body.paddleHand !== undefined ? { paddle_hand: body.paddleHand } : {}),
      })
      .eq("id", user.id);
    if (updateProfileError) {
      return NextResponse.json({ error: updateProfileError.message }, { status: 500 });
    }
  }

  // coaching_* tables only grant write access to the service role (see
  // 0005_coaching_layer.sql's RLS policies) — the user's own session can
  // only ever read them back.
  const serviceClient = createServiceRoleClient();
  try {
    await runCoachingPipeline(serviceClient, user.id, id);
  } catch (err) {
    if (err instanceof CoachingPipelineError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : "Coaching analysis failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const { data: read, error: readError } = await serviceClient
    .from("coaching_reads")
    .select("*")
    .eq("analysis_id", id)
    .maybeSingle();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });

  return NextResponse.json({ coachingRead: read });
}
