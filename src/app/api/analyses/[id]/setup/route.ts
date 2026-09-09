import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { getAnalysisForUser } from "@/lib/db/analyses";
import { getSetup, saveSetup, type PreAnalysisSetup, type SetupPlayer } from "@/lib/db/setup";

export const runtime = "nodejs";

/**
 * Read and write the setup a user does before processing: court corners on the
 * painted lines, and which people on screen are actually playing.
 *
 * Validation here is deliberately strict about *shape* and permissive about
 * *values*. A corner outside the frame is legitimate -- filmed from close
 * behind the baseline, the near court corners genuinely fall off the edge of
 * the picture, and rejecting those would make the tool unusable on exactly the
 * footage that needs it most.
 */

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const analysis = await getAnalysisForUser(supabase, user.id, id);
  if (!analysis) return NextResponse.json({ error: "Analysis not found" }, { status: 404 });

  return NextResponse.json({ setup: await getSetup(supabase, id) });
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const analysis = await getAnalysisForUser(supabase, user.id, id);
  if (!analysis) return NextResponse.json({ error: "Analysis not found" }, { status: 404 });

  let body: Partial<PreAnalysisSetup>;
  try {
    body = (await request.json()) as Partial<PreAnalysisSetup>;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const point = (p: unknown): p is { x: number; y: number } =>
    Boolean(p) && num((p as { x: unknown }).x) && num((p as { y: unknown }).y);

  if (!num(body.frameWidthPx) || !num(body.frameHeightPx) || !num(body.frameTimestampSeconds)) {
    return NextResponse.json({ error: "frame dimensions and timestamp are required" }, { status: 400 });
  }

  const c = body.court;
  if (c) {
    const corners = [c.nearLeft, c.nearRight, c.farRight, c.farLeft];
    if (!corners.every(point)) {
      return NextResponse.json({ error: "All four court corners are required." }, { status: 400 });
    }
    if (c.quadKind !== "full" && c.quadKind !== "near-half") {
      return NextResponse.json({ error: "quadKind must be 'full' or 'near-half'." }, { status: 400 });
    }
  }

  const players: SetupPlayer[] = Array.isArray(body.players) ? body.players.filter(point) : [];
  if (players.filter((p) => p.isSelf).length > 1) {
    return NextResponse.json({ error: "Only one player can be marked as you." }, { status: 400 });
  }

  const setup: PreAnalysisSetup = {
    frameTimestampSeconds: body.frameTimestampSeconds!,
    frameWidthPx: body.frameWidthPx!,
    frameHeightPx: body.frameHeightPx!,
    court: c ?? null,
    players,
    savedAt: new Date().toISOString(),
  };

  try {
    await saveSetup(supabase, id, setup);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
  return NextResponse.json({ setup });
}
