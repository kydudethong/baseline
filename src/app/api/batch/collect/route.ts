import { NextResponse } from "next/server";

import { createServiceRoleClient } from "@/lib/supabase/server";
import { collectBatch } from "@/lib/coaching/gemini-batch";
import { decideCollect, COLLECT_BATCH_SIZE } from "@/lib/coaching/batch-collect";
import { describeError } from "@/lib/analysis/describe-error";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Pick up overnight analyses whose jobs have finished.
 *
 * WHY A ROUTE AND NOT A TIMER IN THE PROCESS. This runs on a machine that
 * sleeps after twenty idle minutes and is replaced by every deploy -- the two
 * things an in-process timer cannot survive, and the exact pair of failures
 * that made the idle watchdog kill every long run earlier. A URL something
 * else calls on a schedule has no such problem: it does not care which process
 * answers it, or whether the last one is still alive.
 *
 * SAFE TO CALL AS OFTEN AS ANYONE LIKES. Every sweep re-reads the rows, so
 * two overlapping calls do the same harmless work twice; the write that
 * finishes a run clears batch_job_name, so the second one finds nothing to do.
 *
 * AUTHENTICATED BY A SHARED SECRET rather than a user session, because the
 * caller is a scheduler and not a person. Without BATCH_COLLECT_SECRET set the
 * route refuses everything: an open endpoint that spends money on the Gemini
 * API is not something to leave unlocked by default.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.BATCH_COLLECT_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      { error: "BATCH_COLLECT_SECRET is not set, so this endpoint is disabled." },
      { status: 503 }
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("analyses")
    .select("id, batch_job_name, batch_submitted_at")
    .not("batch_job_name", "is", null)
    // Oldest first, so a backlog drains in the order people started waiting.
    .order("batch_submitted_at", { ascending: true })
    .limit(COLLECT_BATCH_SIZE);
  if (error) {
    return NextResponse.json({ error: describeError(error) }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{
    id: string; batch_job_name: string | null; batch_submitted_at: string | null;
  }>;
  let waiting = 0, resumed = 0, failed = 0, errored = 0;

  for (const row of rows) {
    if (!row.batch_job_name) continue;
    try {
      const job = await collectBatch(row.batch_job_name);
      const decision = decideCollect({
        job,
        submittedAtMs: row.batch_submitted_at ? Date.parse(row.batch_submitted_at) : NaN,
      });

      if (decision.action === "wait") { waiting += 1; continue; }

      if (decision.action === "fail") {
        failed += 1;
        await supabase.from("analyses").update({
          status: "failed",
          error_message: decision.reason,
          // CLEARED ON THE WAY OUT. A failed row that keeps its job name is a
          // row this sweep picks up again every five minutes forever.
          batch_job_name: null,
          finished_at: new Date().toISOString(),
          // Cast: the generated Database types predate migration 0021.
        } as never).eq("id", row.id);
        continue;
      }

      // resume: the answer is in hand and the rest of the run -- merging
      // segments, writing rallies and shots, the coaching read -- is the same
      // work the live path does. Handing it back rather than duplicating it
      // here is what keeps the two paths from producing different analyses.
      resumed += 1;
      const { resumeFromBatch } = await import("@/lib/coaching/resume-batch");
      await resumeFromBatch({
        supabase, analysisId: row.id, texts: decision.texts, missing: decision.missing,
      });
    } catch (err) {
      // ONE BAD ROW MUST NOT STOP THE SWEEP. The next call is five minutes
      // away and everything behind this row would wait for it.
      errored += 1;
      console.error(`[batch] ${row.id}: ${describeError(err)}`);
    }
  }

  return NextResponse.json({ checked: rows.length, waiting, resumed, failed, errored });
}
