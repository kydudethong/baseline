import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getAnalysisForUser } from "@/lib/db/analyses";
import {
  ALLOWED_VIDEO_MIME_TYPES,
  MAX_VIDEO_SIZE_BYTES,
  MIN_VIDEO_SIZE_BYTES,
  partCountFor,
} from "@/lib/video/validation";
import { createMultipartUpload, presignUploadPart } from "@/lib/storage/r2";

const InitSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1),
  sizeBytes: z
    .number()
    .int()
    .min(MIN_VIDEO_SIZE_BYTES, "File is too small.")
    .max(MAX_VIDEO_SIZE_BYTES, "File is too large."),
});

/**
 * Starts a direct-to-R2 multipart upload for this analysis's video and
 * hands back a presigned PUT URL per part. The browser uploads every part
 * straight to R2 — the bytes never touch this server — then calls
 * upload-complete once every part has succeeded.
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
  const parsed = InitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid upload request." },
      { status: 400 }
    );
  }

  if (!ALLOWED_VIDEO_MIME_TYPES.includes(parsed.data.mimeType as (typeof ALLOWED_VIDEO_MIME_TYPES)[number])) {
    return NextResponse.json({ error: "Unsupported video type." }, { status: 400 });
  }

  const safeName = parsed.data.filename.replace(/[^\w.-]/g, "_");
  const storagePath = `${user.id}/${id}/${safeName}`;

  // R2/S3 calls can fail (bad credentials, wrong bucket, network) — catch
  // that here so the client always gets JSON back to parse, instead of an
  // unhandled-exception page that fails uploadInit's res.json() with a
  // cryptic "Unexpected end of JSON input".
  try {
    const uploadId = await createMultipartUpload(storagePath, parsed.data.mimeType);
    const partCount = partCountFor(parsed.data.sizeBytes);
    const parts = await Promise.all(
      Array.from({ length: partCount }, (_, i) => i + 1).map(async (partNumber) => ({
        partNumber,
        url: await presignUploadPart(storagePath, uploadId, partNumber),
      }))
    );
    return NextResponse.json({ storagePath, uploadId, parts });
  } catch (err) {
    console.error("upload-init: R2 multipart create failed:", err);
    const message = err instanceof Error ? err.message : "Could not start the upload.";
    return NextResponse.json({ error: `Storage error: ${message}` }, { status: 500 });
  }
}
