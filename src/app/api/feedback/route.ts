import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { describeError } from "@/lib/analysis/describe-error";
import type { FeedbackTargetKind, FeedbackVerdict } from "@/lib/db/types";

export const runtime = "nodejs";

const KINDS: FeedbackTargetKind[] = [
  "observation", "technique", "rally", "shot", "read", "practice_session",
];
const VERDICTS: FeedbackVerdict[] = ["right", "wrong", "unsure"];

/**
 * "That's wrong" — one verdict on one claim.
 *
 * UPSERT, NOT INSERT. Somebody changing their mind must replace their verdict
 * rather than add a second one, or the same disagreement is counted twice and
 * the loudest user quietly outvotes everyone. The unique index in 0018 is what
 * enforces it; this just names the conflict target.
 *
 * The target is not a foreign key and is not checked for existence, on
 * purpose. A correction about a coaching point that has since been regenerated
 * is still evidence about the model that produced it — the row it referred to
 * may legitimately be gone, and dropping the correction because of that would
 * throw away exactly the labels a re-run is meant to improve on.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: {
    analysisId?: string; targetKind?: string; targetId?: string;
    verdict?: string; reason?: string | null; note?: string | null;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.analysisId || !body.targetId) {
    return NextResponse.json({ error: "analysisId and targetId are required." }, { status: 400 });
  }
  if (!KINDS.includes(body.targetKind as FeedbackTargetKind)) {
    return NextResponse.json({ error: `Unknown targetKind "${body.targetKind}".` }, { status: 400 });
  }
  if (!VERDICTS.includes(body.verdict as FeedbackVerdict)) {
    return NextResponse.json({ error: `Unknown verdict "${body.verdict}".` }, { status: 400 });
  }

  const { error } = await supabase
    .from("coaching_feedback")
    .upsert(
      {
        user_id: user.id,
        analysis_id: body.analysisId,
        target_kind: body.targetKind as FeedbackTargetKind,
        target_id: body.targetId,
        verdict: body.verdict as FeedbackVerdict,
        reason: body.reason ?? null,
        // Trimmed rather than rejected: somebody typing a paragraph about what
        // is wrong is the most valuable thing this endpoint receives, and
        // refusing it over length would be perverse.
        note: body.note ? body.note.slice(0, 2000) : null,
      },
      { onConflict: "user_id,target_kind,target_id" }
    );
  if (error) {
    if ((error as { code?: string }).code === "42P01") {
      return NextResponse.json(
        { error: "Feedback isn't set up on this database yet — migration 0018 hasn't been run." },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: describeError(error) }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
