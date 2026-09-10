import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { getAnalysisForUser, updateAnalysisStatus } from "@/lib/db/analyses";
import { cancelRun } from "@/lib/analysis/run-registry";

export const runtime = "nodejs";

/**
 * Stop an analysis that is running.
 *
 * The run lives in this server process's memory, so cancelling is aborting a
 * signal every one of its Python subprocesses was spawned with. The pipeline
 * then unwinds through its normal error path within a second or two and puts
 * the analysis back to "uploaded" -- the state it would have been in if nobody
 * had pressed analyse. Nothing about the video is touched.
 *
 * There are two ways to arrive here with nothing to abort, and they are not
 * errors:
 *
 *   The run already finished between the click and this request.
 *   The run belonged to a machine that has since restarted, which leaves a row
 *   marked "processing" with no process behind it. Those rows are exactly what
 *   the stale-run window exists to clear, and a user who has been staring at a
 *   stuck "processing" for twenty minutes pressing stop should be released
 *   from it rather than told there was nothing to stop.
 *
 * So a missing run still resets the row, and the response says which happened.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const analysis = await getAnalysisForUser(supabase, user.id, id);
  if (!analysis) return NextResponse.json({ error: "Analysis not found" }, { status: 404 });

  if (analysis.status !== "processing" && analysis.status !== "queued") {
    return NextResponse.json(
      { error: `This analysis is ${analysis.status}, so there is nothing to stop.` },
      { status: 409 }
    );
  }

  const wasRunning = cancelRun(id, "Stopped by you.");

  // Reset the row even when nothing was aborted. The pipeline resets it too on
  // its way out, and doing it twice is harmless -- where NOT doing it leaves a
  // stranded row stuck at "processing" with no process to ever clear it.
  try {
    await updateAnalysisStatus(supabase, id, "uploaded", { errorMessage: null });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  return NextResponse.json({
    stopped: true,
    wasRunning,
    message: wasRunning
      ? "Analysis stopped."
      : "That run was no longer active — its machine had restarted. The analysis is ready to run again.",
  });
}
