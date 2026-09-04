import { NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getAnalysisForUser } from "@/lib/db/analyses";
import { recomputeFromStored } from "@/lib/vision/recompute";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Corner {
  x: number;
  y: number;
}
interface CalibrationBody {
  /** Image-pixel corners of the FULL court: far baseline (top) and near baseline (bottom). */
  corners?: { topLeft: Corner; topRight: Corner; bottomLeft: Corner; bottomRight: Corner };
}

/**
 * Manual court calibration. The user drags the four baseline corners onto
 * the painted lines; this stores them as a `manual` calibration of the full
 * court (quadKind "full", confidence 1 — a person put the corners on the
 * lines) and rebuilds movement metrics and shot classification from the
 * tracks and ball data already in the database. No video is reprocessed.
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

  let body: CalibrationBody;
  try {
    body = (await request.json()) as CalibrationBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const c = body.corners;
  const ok = (p?: Corner) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
  if (!c || !ok(c.topLeft) || !ok(c.topRight) || !ok(c.bottomLeft) || !ok(c.bottomRight)) {
    return NextResponse.json({ error: "Four corners are required." }, { status: 400 });
  }

  const service = createServiceRoleClient();
  const { data: existing } = await service.from("court_calibrations").select("*").eq("analysis_id", id).maybeSingle();
  const { error: upsertError } = await service.from("court_calibrations").upsert(
    {
      analysis_id: id,
      method: "manual",
      confidence: 1,
      corners_image_px: {
        topLeft: [c.topLeft.x, c.topLeft.y],
        topRight: [c.topRight.x, c.topRight.y],
        bottomLeft: [c.bottomLeft.x, c.bottomLeft.y],
        bottomRight: [c.bottomRight.x, c.bottomRight.y],
      },
      frame_timestamp_s: existing?.frame_timestamp_s ?? 0,
      diagnostics: { quadKind: "full", source: "manual", previous: existing?.diagnostics ?? null },
    },
    { onConflict: "analysis_id" }
  );
  if (upsertError) return NextResponse.json({ error: upsertError.message }, { status: 500 });

  try {
    const result = await recomputeFromStored(service, id);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Recompute failed." }, { status: 500 });
  }
}
