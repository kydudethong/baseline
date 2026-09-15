/**
 * Record what the model was asked and what it said.
 *
 * THE ASSET, stated plainly. Every judgement Baseline makes comes from an API
 * anybody can call. The only thing that can ever be uniquely ours is a record
 * of what that API said about real pickleball, at known settings, with real
 * players' corrections attached. Storage is the cheap half and it has to
 * happen first, because a correction filed in six months is worthless unless
 * the output it corrects — and the exact configuration that produced it — was
 * kept at the time.
 *
 * CONFIG IS NOT OPTIONAL and is the part most likely to be skipped. fps, media
 * resolution, model and the windows watched all change what the model could
 * physically see. Without them, "the model said the drop was late and the
 * player says it wasn't" is an anecdote; with them it is evidence about 5fps
 * low-resolution scanning specifically, which is a thing that can be fixed.
 *
 * NEVER THROWS, and never blocks the run. This is a side effect of doing the
 * work, not part of it: an analysis that failed because its telemetry failed
 * would be a bad trade in every direction.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CapturePass, Database } from "@/lib/db/types";

type Client = SupabaseClient<Database>;

export interface CaptureInput {
  analysisId: string;
  pass: CapturePass;
  model: string;
  /** Everything that changed what the model could see. */
  config?: Record<string, unknown>;
  prompt?: string | null;
  output?: unknown;
  usage?: Record<string, unknown>;
  durationMs?: number;
}

/** Prompts are kept whole, but a runaway one must not bloat a row. */
const MAX_PROMPT_CHARS = 60_000;

export async function recordCapture(supabase: Client, input: CaptureInput): Promise<void> {
  try {
    const { error } = await supabase.from("analysis_captures").insert({
      analysis_id: input.analysisId,
      pass: input.pass,
      model: input.model,
      config: input.config ?? null,
      prompt: input.prompt ? input.prompt.slice(0, MAX_PROMPT_CHARS) : null,
      output: (input.output ?? null) as never,
      usage: (input.usage ?? null) as never,
      duration_ms: input.durationMs ?? null,
    });
    if (error) throw error;
  } catch (err) {
    // A missing table (migration not run) is the ordinary case on a fresh
    // deploy and must be silent-ish rather than noisy on every run.
    const code = (err as { code?: string })?.code;
    if (code === "42P01") return;
    console.warn(`[capture] not recorded: ${(err as Error).message?.split("\n")[0] ?? String(err)}`);
  }
}
