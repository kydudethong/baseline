import type { SupabaseClient } from "@supabase/supabase-js";
import type { RunSample } from "@/lib/analysis/eta";

type Client = SupabaseClient;

/**
 * Recent finished runs for one user, as (clip length, wall time) pairs.
 *
 * Scoped to the user rather than global on purpose. Runtime depends on the
 * box, the clip's resolution and how hard the ball is to see in their gym —
 * all of which are far more consistent within one person's uploads than
 * across everyone's. A shared median would be a worse prediction for
 * everybody.
 *
 * Failed runs are excluded. A run that died forty seconds in did not take
 * forty seconds to analyse a clip; including it would pull the estimate down
 * and make the screen promise a speed it cannot deliver.
 */
export async function recentRunSamples(
  supabase: Client,
  userId: string,
  limit = 12
): Promise<RunSample[]> {
  const { data, error } = await supabase
    .from("analyses")
    .select("started_at, finished_at, videos(duration_seconds)")
    .eq("user_id", userId)
    .eq("status", "completed")
    .not("started_at", "is", null)
    .not("finished_at", "is", null)
    .order("finished_at", { ascending: false })
    .limit(limit);

  // History is a nicety. If this query fails the estimate falls back to the
  // constant and the screen still works, so it is not worth throwing over.
  if (error || !data) return [];

  const samples: RunSample[] = [];
  for (const row of data as unknown as Array<{
    started_at: string; finished_at: string;
    videos: { duration_seconds: number | null } | Array<{ duration_seconds: number | null }> | null;
  }>) {
    // PostgREST returns an embedded one-to-one as an object or a single-element
    // array depending on how it inferred the relationship; handle both rather
    // than depend on which.
    const v = Array.isArray(row.videos) ? row.videos[0] : row.videos;
    const videoSeconds = v?.duration_seconds ?? 0;
    const wallSeconds =
      (new Date(row.finished_at).getTime() - new Date(row.started_at).getTime()) / 1000;
    if (videoSeconds > 0 && wallSeconds > 0) samples.push({ videoSeconds, wallSeconds });
  }
  return samples;
}
