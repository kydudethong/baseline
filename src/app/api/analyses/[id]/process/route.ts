import { NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getAnalysisForUser } from "@/lib/db/analyses";
import { runPipeline } from "@/lib/analysis/pipeline";
import { kickOffPipelineV2 } from "@/lib/analysis/pipeline-v2";
import { livenessOf } from "@/lib/analysis/heartbeat";
import { runningCount } from "@/lib/analysis/run-registry";

// Uses fs/child_process (ffmpeg, python) — must run on the Node.js runtime, not Edge.
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Kicks off processing for one analysis.
 *
 * PIPELINE_VERSION=v2 (default) runs the real Phase 2 CV pipeline
 * (court/players/tracking/pose/movement/events — see pipeline-v2.ts) and
 * returns as soon as it's queued; the run continues in the background (see
 * kickOffPipelineV2's doc comment for exactly what "async-capable" means
 * here and its real limitation on a serverless deploy).
 *
 * PIPELINE_VERSION=v1 falls back to the original synchronous Phase 1 mock
 * pipeline (src/lib/analysis/pipeline.ts) — kept selectable for comparison/
 * rollback, not because Phase 1 is still the intended default.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const analysis = await getAnalysisForUser(supabase, user.id, id);
  if (!analysis) return NextResponse.json({ error: "Analysis not found" }, { status: 404 });
  if (!analysis.video) {
    return NextResponse.json({ error: "Upload a video before processing." }, { status: 400 });
  }
  // A run lives only in this Node process's event loop, so a dev-server
  // recompile, a deploy or an OOM kill leaves the row at "processing" with
  // nothing left to finish it. Without a staleness window the row is stuck
  // forever: the page polls a spinner that will never resolve and this route
  // answers 409 to every retry. Anything older than the window is presumed
  // dead and may be restarted.
  const STALE_AFTER_MS = Number(process.env.PROCESSING_STALE_MS || 30 * 60 * 1000);
  if (analysis.status === "processing" || analysis.status === "queued") {
    // A quiet heartbeat is a far better answer than the 30-minute window, and
    // it arrives ~28 minutes sooner. The window stays as the fallback for rows
    // written before 0014 and by older builds, which have no heartbeat at all
    // and must not be presumed dead on missing data.
    const { looksDead, quietForSeconds } = livenessOf(analysis.status, analysis.heartbeat_at ?? null);
    if (looksDead) {
      console.warn(`[process] restarting ${id}: no heartbeat for ${quietForSeconds}s — its process is gone`);
    } else {
      const startedAt = Date.parse(analysis.updated_at ?? analysis.created_at ?? "");
      const age = Number.isFinite(startedAt) ? Date.now() - startedAt : Infinity;
      if (age < STALE_AFTER_MS) {
        return NextResponse.json({ error: "Already processing." }, { status: 409 });
      }
      console.warn(`[process] restarting analysis ${id}, stuck in ${analysis.status} for ${Math.round(age / 60000)} min`);
    }
  }

  // ONE RUN PER MACHINE. Refused rather than queued, because a second
  // concurrent run does not just halve the cores -- it used to corrupt the
  // first one, since the abort signal was process-wide and the later run took
  // ownership of it. That specific bug is fixed (run-registry uses
  // AsyncLocalStorage now), but two analyses sharing 8 cores still means both
  // take twice as long and the machine is twice as likely to run out of
  // memory, and neither is what anyone wants from pressing Analyse.
  if (runningCount() > 0) {
    return NextResponse.json(
      {
        error: "Another analysis is already running on this server. "
          + "Wait for it to finish and try again — running two at once makes both slower.",
      },
      { status: 409 }
    );
  }

  const useV2 = (process.env.PIPELINE_VERSION ?? "v2") !== "v1";

  if (useV2) {
    // Service-role client: the background run outlives this request/user
    // session and needs to keep writing to the analysis after the request
    // that started it has returned. See supabase/server.ts.
    const serviceClient = createServiceRoleClient();
    kickOffPipelineV2(serviceClient, user.id, id);
    const queued = await getAnalysisForUser(supabase, user.id, id);
    return NextResponse.json({ analysis: queued, async: true }, { status: 202 });
  }

  try {
    await runPipeline(supabase, user.id, id);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Processing failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const updated = await getAnalysisForUser(supabase, user.id, id);
  return NextResponse.json({ analysis: updated });
}
