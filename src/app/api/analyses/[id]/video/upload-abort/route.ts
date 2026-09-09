import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getAnalysisForUser } from "@/lib/db/analyses";
import { abortMultipartUpload } from "@/lib/storage/r2";

const AbortSchema = z.object({
  storagePath: z.string().trim().min(1),
  uploadId: z.string().trim().min(1),
});

/**
 * Best-effort cleanup when the user cancels an in-progress upload — R2
 * (like S3) keeps charging for uploaded-but-never-completed parts until
 * the multipart upload is explicitly aborted or a lifecycle rule sweeps it.
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
  const parsed = AbortSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: true }); // nothing to clean up

  if (!parsed.data.storagePath.startsWith(`${user.id}/`)) {
    return NextResponse.json({ error: "Invalid storage path." }, { status: 400 });
  }

  await abortMultipartUpload(parsed.data.storagePath, parsed.data.uploadId);
  return NextResponse.json({ ok: true });
}
