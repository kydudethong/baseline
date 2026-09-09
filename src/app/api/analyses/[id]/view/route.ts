import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAnalysisForUser } from "@/lib/db/analyses";
import { getAnalysisView } from "@/lib/db/analysis-view";
import { recentRunSamples } from "@/lib/db/run-history";
import { estimateRuntime } from "@/lib/analysis/eta";

export const runtime = "nodejs";

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

    return NextResponse.json({
      status: analysis.status,
      errorMessage: analysis.error_message,
      progress: analysis.progress ?? null,
      updatedAt: analysis.updated_at,
      startedAt: analysis.started_at ?? null,
      eta,
    }, { headers: { "Cache-Control": "no-store" } });
  }

  const view = await getAnalysisView(supabase, analysis);
  return NextResponse.json({ view }, { headers: { "Cache-Control": "no-store" } });
}
