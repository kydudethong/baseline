import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAnalysisForUser } from "@/lib/db/analyses";
import { getAnalysisView } from "@/lib/db/analysis-view";
import { recentRunSamples } from "@/lib/db/run-history";
import { estimateRuntime } from "@/lib/analysis/eta";
import { livenessOf } from "@/lib/analysis/heartbeat";

export const runtime = "nodejs";

import { noteRequest } from "@/lib/analysis/idle-sleep";

/**
 * The whole analysis as one typed object — see getAnalysisView().
 *
 * Two modes, because they answer different questions at very different costs:
 *
 *   ?progress=1  status + stage only. This is what the page polls every few
 *                seconds while a run is in flight. The full view reads eleven
 *                tables; doing that on a 3-second timer for four minutes to
 *                learn one string would be absurd, and the previous approach
 *                (router.refresh() re-rendering the entire server tree) was
 *                doing exactly that.
 *   default      everything, for a completed analysis.
 *
 * Reads are still server-side in pages. This exists so CLIENT components can
 * follow a run without a full round-trip, not to move rendering to the browser.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // SOMEBODY IS WATCHING, so the machine is not idle.
  //
  // noteRequest() existed and nothing called it. The idle watchdog's "time
  // since the last request" was therefore only ever moved by a run starting or
  // finishing -- so a person sitting on the progress page, polling this route
  // every few seconds, counted for nothing. Twenty minutes after a run BEGAN,
  // the machine stopped itself with the run still going and the page still
  // open.
  //
  // This route is the poll. It runs on the Node runtime, which is where the
  // watchdog lives; proxy.ts would have been the obvious home and is on the
  // Edge runtime, which shares no state with it.
  noteRequest();
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const analysis = await getAnalysisForUser(supabase, user.id, id);
  if (!analysis) return NextResponse.json({ error: "Analysis not found" }, { status: 404 });

  if (new URL(request.url).searchParams.get("progress") === "1") {
    // The estimate is recomputed per poll rather than cached with the run.
    // It costs one indexed query, and it means a run that is already
    // overrunning gets a sentence that says so instead of repeating the
    // number it was given at the start.
    const running = analysis.status === "processing" || analysis.status === "queued";
    const clipS = analysis.video?.duration_seconds ?? null;
    const eta = running && clipS
      ? estimateRuntime(clipS, await recentRunSamples(supabase, user.id))
      : null;

    // Is there still a process behind this row? The stage label alone cannot
    // say: it is the last value written, so a run that died mid-stage shows
    // the same spinner as one working through it -- for 32 minutes on a stage
    // with an 8-minute timeout, or for ten hours.
    const liveness = livenessOf(analysis.status, analysis.heartbeat_at ?? null);

    // Whether a coaching read exists, so a client waiting on a BACKGROUND
    // coaching run has something definite to wait for. The analysis status
    // cannot answer this: it is "completed" the moment the CV run finishes,
    // long before any coaching happens, and it never changes again.
    const { count: readCount } = await supabase
      .from("coaching_reads")
      .select("analysis_id", { count: "exact", head: true })
      .eq("analysis_id", id);

    return NextResponse.json({
      status: analysis.status,
      errorMessage: analysis.error_message,
      progress: analysis.progress ?? null,
      hasCoachingRead: (readCount ?? 0) > 0,
      updatedAt: analysis.updated_at,
      startedAt: analysis.started_at ?? null,
      eta,
      looksDead: liveness.looksDead,
      quietForSeconds: liveness.quietForSeconds,
    }, { headers: { "Cache-Control": "no-store" } });
  }

  const view = await getAnalysisView(supabase, analysis);
  return NextResponse.json({ view }, { headers: { "Cache-Control": "no-store" } });
}
