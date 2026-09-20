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
  /**
   * An upload already in progress, from a browser picking up where a dropped
   * connection or a locked screen left off.
   *
   * Not trusted as anything but a token. The object key is recomputed from the
   * session and the analysis below exactly as it is for a fresh upload, so a
   * borrowed id can only ever address the borrower's own key -- where R2 will
   * not recognise it, and the part PUTs fail. That is the correct outcome: the
   * client drops its record and starts clean.
   */
  resumeUploadId: z.string().trim().min(1).max(512).optional(),
  /**
   * Which parts still need a URL. Absent means all of them.
   *
   * A resumed 2 GB upload may have four parts left out of two hundred, and
   * presigning the other 196 is 196 signatures computed to be thrown away.
   */
  partNumbers: z.array(z.number().int().positive()).max(10_000).optional(),
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
    // Reusing the id rather than creating a second multipart upload is the
    // whole of resume: the parts R2 has already accepted stay accepted, and
    // only the missing ones are sent again. Creating a fresh one here would
    // silently abandon them -- they would sit in the bucket unreferenced until
    // the lifecycle rule swept them, having cost the user their upload twice.
    const uploadId = parsed.data.resumeUploadId
      ?? (await createMultipartUpload(storagePath, parsed.data.mimeType));

    const partCount = partCountFor(parsed.data.sizeBytes);
    // Clamped to the parts this file actually has. A client asking for part
    // 900 of a 40-part upload is confused or malicious; either way, signing it
    // would produce a URL that writes a part no completion can ever reference.
    const wanted = parsed.data.partNumbers?.filter((n) => n >= 1 && n <= partCount)
      ?? Array.from({ length: partCount }, (_, i) => i + 1);

    const parts = await Promise.all(
      wanted.map(async (partNumber) => ({
        partNumber,
        url: await presignUploadPart(storagePath, uploadId, partNumber),
      }))
    );
    return NextResponse.json({ storagePath, uploadId, parts, partCount });
  } catch (err) {
    console.error("upload-init: R2 multipart create failed:", err);
    const message = err instanceof Error ? err.message : "Could not start the upload.";
    return NextResponse.json({ error: `Storage error: ${message}` }, { status: 500 });
  }
}
