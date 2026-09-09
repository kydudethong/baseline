import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getAnalysisForUser } from "@/lib/db/analyses";
import { completeMultipartUpload } from "@/lib/storage/r2";

const CompleteSchema = z.object({
  storagePath: z.string().trim().min(1),
  uploadId: z.string().trim().min(1),
  parts: z
    .array(z.object({ ETag: z.string().trim().min(1), PartNumber: z.number().int().min(1) }))
    .min(1),
});

/** Finalizes a direct-to-R2 multipart upload once every part has succeeded. */
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
  const parsed = CompleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid upload." },
      { status: 400 }
    );
  }

  // storagePath must live under this user's own folder — reject anything
  // that tries to point at another user's objects.
  if (!parsed.data.storagePath.startsWith(`${user.id}/`)) {
    return NextResponse.json({ error: "Invalid storage path." }, { status: 400 });
  }

  try {
    await completeMultipartUpload(parsed.data.storagePath, parsed.data.uploadId, parsed.data.parts);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not finish the upload.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
