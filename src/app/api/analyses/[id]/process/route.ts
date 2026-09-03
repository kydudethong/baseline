import { NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getAnalysisForUser } from "@/lib/db/analyses";
import { runPipeline } from "@/lib/analysis/pipeline";
import { kickOffPipelineV2 } from "@/lib/analysis/pipeline-v2";

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
  if (analysis.status === "processing" || analysis.status === "queued") {
    return NextResponse.json({ error: "Already processing." }, { status: 409 });
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
