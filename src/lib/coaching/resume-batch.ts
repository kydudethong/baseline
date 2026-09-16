/**
 * Finishing an overnight run with an answer it did not wait for.
 *
 * The live path asks the model and writes the result in one process. This does
 * the second half alone, hours later, in a process that knows nothing except
 * an analysis id and some JSON that came back from a queue.
 *
 * IT REBUILDS THE INPUTS RATHER THAN TRUSTING A SNAPSHOT. Everything
 * persistCoachingOutput needs -- the analysis row, the shots, the drills, the
 * facts the analyst was given -- is re-derived from the database here. The
 * alternative was serialising all of it alongside the job at submit time, and
 * that is a copy of the pipeline's inputs that can be stale, partial, or from
 * a version of the code that no longer exists. The rows are the truth; reading
 * them again costs a few queries and removes a whole category of bug.
 *
 * It writes through persistCoachingOutput, the same function the live path
 * uses, because two writers is how two paths quietly produce different
 * analyses from the same footage.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";

import { mergeAnalystOutputs } from "./analyst-merge";
import { parseSegments } from "./batch-collect";
import { auditAnalysis } from "./analyst";
import { persistCoachingOutput, rebuildAnalystContext } from "./run-coaching";

type Client = SupabaseClient<Database>;

export async function resumeFromBatch(opts: {
  supabase: Client;
  analysisId: string;
  texts: string[];
  /** Segments the queue refused. Recorded as a limitation, not hidden. */
  missing: number;
  onLog?: (line: string) => void;
}): Promise<void> {
  const log = opts.onLog ?? ((l: string) => console.error(`[batch] ${l}`));

  const parts = parseSegments(opts.texts, log);
  if (parts.length === 0) {
    throw new Error("the overnight queue returned nothing this run could read");
  }

  const ctx = await rebuildAnalystContext(opts.supabase, opts.analysisId);
  const out = mergeAnalystOutputs(parts, ctx.analystInput.clipSeconds, log);
  const problems = auditAnalysis(out, ctx.analystInput);
  for (const p of problems) log(`audit: ${p}`);

  // SAID OUT LOUD ON THE ANALYSIS, not left for someone to notice. A read
  // built from four segments of five is a real read with a real hole in it,
  // and the person looking at it has no other way to know which it is.
  const dropped = opts.missing + (opts.texts.length - parts.length);
  if (dropped > 0) {
    ctx.analystInput.knownLimitations.push(
      `${dropped} segment${dropped === 1 ? "" : "s"} of this clip could not be read, `
      + `so rallies and shots in those stretches are missing.`
    );
  }

  await persistCoachingOutput({
    supabase: opts.supabase,
    analysisId: opts.analysisId,
    analysis: ctx.analysis,
    out,
    model: ctx.model,
    problems,
    analystInput: ctx.analystInput,
    allDrills: ctx.allDrills,
    shots: ctx.shots,
    // The uploaded video belongs to the job, and the job is finished with it.
    // Released by the collector rather than here, so a failure to tidy up
    // cannot lose an analysis that is otherwise complete.
    file: null,
  });

  // The run is no longer waiting on anything.
  // Cast because the generated Database types predate migration 0021 and do
  // not know these columns yet. Narrow and deliberate: the shape is asserted
  // by the migration, not guessed here.
  await opts.supabase.from("analyses").update({
    batch_job_name: null,
    finished_at: new Date().toISOString(),
  } as never).eq("id", opts.analysisId);
}
