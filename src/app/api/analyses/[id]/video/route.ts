import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { attachVideo, getAnalysisForUser } from "@/lib/db/analyses";
import { ALLOWED_VIDEO_MIME_TYPES, MAX_VIDEO_SIZE_BYTES, MIN_VIDEO_SIZE_BYTES } from "@/lib/video/validation";

const AttachSchema = z.object({
  storagePath: z.string().trim().min(1),
  originalFilename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1),
  sizeBytes: z
    .number()
    .int()
    .min(MIN_VIDEO_SIZE_BYTES, "File is too small.")
    .max(MAX_VIDEO_SIZE_BYTES, "File is too large."),
});

/**
 * Called by the client once a resumable upload to Supabase Storage finishes.
 * The bytes are already stored — this just records the metadata and links
 * it to the analysis. Re-validates type/size server-side even though the
 * client already checked, because the client is never trusted.
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

  const body = await request.json().catch(() => null);
  const parsed = AttachSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid video metadata." },
      { status: 400 }
    );
  }

  if (!ALLOWED_VIDEO_MIME_TYPES.includes(parsed.data.mimeType as (typeof ALLOWED_VIDEO_MIME_TYPES)[number])) {
    return NextResponse.json({ error: "Unsupported video type." }, { status: 400 });
  }

  // storagePath must live under this user's own folder — reject anything
  // that tries to point at another user's objects.
  if (!parsed.data.storagePath.startsWith(`${user.id}/`)) {
    return NextResponse.json({ error: "Invalid storage path." }, { status: 400 });
  }

  const video = await attachVideo(supabase, {
    analysisId: id,
    userId: user.id,
    storagePath: parsed.data.storagePath,
    originalFilename: parsed.data.originalFilename,
    mimeType: parsed.data.mimeType,
    sizeBytes: parsed.data.sizeBytes,
  });

  return NextResponse.json({ video }, { status: 201 });
}
