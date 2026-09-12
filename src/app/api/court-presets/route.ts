import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import {
  deleteCourtPreset, isCourtCorners, listCourtPresets, saveCourtPreset,
} from "@/lib/db/court-presets";
import { normaliseLineColor } from "@/lib/db/setup";
import { describeError } from "@/lib/analysis/describe-error";

export const runtime = "nodejs";

async function requireUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return { supabase, user };
}

export async function GET() {
  const { supabase, user } = await requireUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  try {
    return NextResponse.json({ presets: await listCourtPresets(supabase, user.id) });
  } catch (err) {
    return NextResponse.json({ error: describeError(err) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const { supabase, user } = await requireUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const { name, corners, frameWidthPx, frameHeightPx, lineColorHex, matchMode } = body as Record<string, unknown>;

  // Validated here rather than trusted, because these corners become the
  // homography for every future analysis at this venue: a bad one is not a
  // bad row, it is months of wrong distances.
  if (typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Give this court a name." }, { status: 400 });
  }
  if (name.trim().length > 80) {
    return NextResponse.json({ error: "That name is too long (80 characters max)." }, { status: 400 });
  }
  if (!isCourtCorners(corners)) {
    return NextResponse.json({ error: "Four complete corners are required to save a court." }, { status: 400 });
  }
  if (!(typeof frameWidthPx === "number" && frameWidthPx > 0)
      || !(typeof frameHeightPx === "number" && frameHeightPx > 0)) {
    return NextResponse.json(
      { error: "The frame size the corners were marked in is required — without it they cannot be reused." },
      { status: 400 }
    );
  }

  try {
    const preset = await saveCourtPreset(supabase, user.id, {
      name: name.trim(),
      corners,
      frameWidthPx,
      frameHeightPx,
      lineColorHex: normaliseLineColor(typeof lineColorHex === "string" ? lineColorHex : null),
      matchMode: matchMode === "singles" ? "singles" : "doubles",
    });
    return NextResponse.json({ preset });
  } catch (err) {
    return NextResponse.json({ error: describeError(err) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const { supabase, user } = await requireUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Which preset?" }, { status: 400 });
  try {
    await deleteCourtPreset(supabase, user.id, id);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return NextResponse.json({ error: describeError(err) }, { status: 500 });
  }
}
