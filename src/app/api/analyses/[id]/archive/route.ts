import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAnalysisForUser } from "@/lib/db/analyses";
import { deleteObject } from "@/lib/storage/r2";
import { describeError } from "@/lib/analysis/describe-error";

export const runtime = "nodejs";

/**
 * Archive, un-archive, or permanently delete one analysis.
 *
 * THREE VERBS ON ONE ROUTE because they are one decision with three answers,
 * and splitting them across three endpoints would let the UI drift into
 * offering "delete" where it means "archive".
 *
 * WHY ARCHIVE IS THE DEFAULT AND DELETE IS NOT. This row anchors a coaching
 * read, skill ratings, a technique pass and a month of calendar entries. All
 * of it cost real compute; none of it survives a misclick. Archiving hides the
 * analysis from the library, the calendar and the trends immediately -- which
 * is the whole of what the player asked for when they said "remove this" --
 * while leaving "actually, put it back" a single update away.
 *
 * Permanent deletion is genuinely different and irreversible: the R2 object
 * goes, the row goes, and ON DELETE CASCADE takes the coaching read, the
 * observations, the ratings, the technique and the shots with it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let action: string;
  try {
    action = String(((await request.json()) as { action?: unknown }).action ?? "");
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!["archive", "restore", "delete"].includes(action)) {
    return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
  }

  const analysis = await getAnalysisForUser(supabase, user.id, id);
  if (!analysis) return NextResponse.json({ error: "Analysis not found" }, { status: 404 });

  if (action === "archive" || action === "restore") {
    const { error } = await supabase
      .from("analyses")
      .update({ archived_at: action === "archive" ? new Date().toISOString() : null })
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) return NextResponse.json({ error: describeError(error) }, { status: 500 });
    return NextResponse.json({ ok: true, archived: action === "archive" });
  }

  // Permanent. The video object first, then the row.
  //
  // THIS ORDER ON PURPOSE. Delete the row first and a failure on the object
  // leaves a file in R2 that nothing references and nobody will ever find --
  // it is billed forever and invisible. Object first means the worst case is
  // a row whose video is gone, which the UI already handles (it renders a
  // missing-video state) and which the player can delete again.
  const storagePath = analysis.video?.storage_path ?? null;
  if (storagePath) {
    try {
      await deleteObject(storagePath);
    } catch (err) {
      return NextResponse.json(
        { error: `Could not remove the video file: ${describeError(err)}. Nothing was deleted.` },
        { status: 500 }
      );
    }
  }

  const { error } = await supabase.from("analyses").delete().eq("id", id).eq("user_id", user.id);
  if (error) return NextResponse.json({ error: describeError(error) }, { status: 500 });
  return NextResponse.json({ ok: true, deleted: true });
}
