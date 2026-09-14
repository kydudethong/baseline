import { NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getAnalysisForUser } from "@/lib/db/analyses";
import { kickOffCoachingPipeline } from "@/lib/coaching/run-coaching";
import { describeError } from "@/lib/analysis/describe-error";

// Coaching runs through Gemini now (lib/coaching/analyst.ts) — no
// fs/child_process dependency, but kept on the Node runtime for parity with
// the rest of this app's server routes and consistent env var handling.
export const runtime = "nodejs";
// No maxDuration: nothing long happens inside this request any more.

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
    return NextResponse.json({ error: describeError(updateAnalysisError) }, { status: 500 });
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
      return NextResponse.json({ error: describeError(updateProfileError) }, { status: 500 });
    }
  }

  // coaching_* tables only grant write access to the service role (see
  // 0005_coaching_layer.sql's RLS policies) — the user's own session can
  // only ever read them back.
  const serviceClient = createServiceRoleClient();

  // STARTED, NOT FINISHED — and that is the point of this route now.
  //
  // It used to await the entire pipeline: an upload, several segments of video
  // at 10fps, and a practice plan. Minutes, inside one HTTP request. Closing
  // the laptop killed the run, and any proxy in between could time out a
  // request that was working perfectly — which is exactly what "fetch failed"
  // looked like from the browser.
  //
  // The run now continues on the Node event loop after this response has gone
  // back, which is the whole reason this app is a long-lived container rather
  // than serverless, and it reports through analyses.progress. The page polls
  // that. A 202 is the honest status code for it.
  kickOffCoachingPipeline(serviceClient, user.id, id);
  return NextResponse.json({ started: true }, { status: 202 });
}
