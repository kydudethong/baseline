import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnalysisResult, AnalysisRow, AnalysisStatus, Database, VideoRow } from "./types";
import { env } from "@/lib/env";

type Client = SupabaseClient<Database>;

/** `videos.analysis_id` is unique, so this is genuinely a 1:1 embed, not an array. */
export type AnalysisWithVideo = AnalysisRow & { video: VideoRow | null };

/**
 * The player's analyses, newest first.
 *
 * Archived rows are excluded by default rather than filtered by each caller.
 * That direction matters: a caller that forgets the filter shows the player
 * something they removed, which is the failure that makes archiving feel
 * broken. A caller that wants them has to ask, and there is exactly one --
 * the archive view itself.
 */
export async function listAnalysesForUser(
  supabase: Client,
  userId: string,
  opts: { include?: "active" | "archived" | "all" } = {}
) {
  let query = supabase
    .from("analyses")
    .select("*, video:videos(*)")
    .eq("user_id", userId);
  if (opts.include === "archived") query = query.not("archived_at", "is", null);
  else if (opts.include !== "all") query = query.is("archived_at", null);

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as AnalysisWithVideo[];
}

/** Trimmed projection of listAnalysesForUser for views that only need status/recency (Home's counts and "most recent" card) — skips the video join and the `result` JSON blob neither of them render. */
export interface AnalysisSummary {
  id: string;
  title: string;
  status: AnalysisStatus;
  created_at: string;
}

export async function listAnalysisSummariesForUser(supabase: Client, userId: string): Promise<AnalysisSummary[]> {
  const { data, error } = await supabase
    .from("analyses")
    .select("id, title, status, created_at")
    .eq("user_id", userId)
    .is("archived_at", null)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []) as AnalysisSummary[];
}

export async function getAnalysisForUser(
  supabase: Client,
  userId: string,
  analysisId: string
) {
  const { data, error } = await supabase
    .from("analyses")
    .select("*, video:videos(*)")
    .eq("user_id", userId)
    .eq("id", analysisId)
    .maybeSingle();

  if (error) throw error;
  return data as AnalysisWithVideo | null;
}

export async function createAnalysis(supabase: Client, userId: string, title: string) {
  const { data, error } = await supabase
    .from("analyses")
    .insert({ user_id: userId, title, status: "uploaded" })
    .select()
    .single();

  if (error) throw error;
  return data as AnalysisRow;
}

export async function attachVideo(
  supabase: Client,
  video: {
    analysisId: string;
    userId: string;
    storagePath: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
  }
) {
  const { data, error } = await supabase
    .from("videos")
    .insert({
      analysis_id: video.analysisId,
      user_id: video.userId,
      // Historical column name from the Supabase-Storage era; now records
      // which R2 bucket the bytes actually live in, for debugging.
      storage_bucket: env.r2Bucket,
      storage_path: video.storagePath,
      original_filename: video.originalFilename,
      mime_type: video.mimeType,
      size_bytes: video.sizeBytes,
    })
    .select()
    .single();

  if (error) throw error;
  return data as VideoRow;
}

export async function updateVideoMetadata(
  supabase: Client,
  videoId: string,
  metadata: Partial<
    Pick<VideoRow, "duration_seconds" | "width" | "height" | "fps" | "codec" | "probe_metadata">
  >
) {
  const { error } = await supabase.from("videos").update(metadata).eq("id", videoId);
  if (error) throw error;
}

export async function updateAnalysisStatus(
  supabase: Client,
  analysisId: string,
  status: AnalysisStatus,
  extra: { errorMessage?: string | null; result?: AnalysisResult | null } = {}
) {
  // Run timing is stamped here rather than at the call sites because this is
  // the one place every status transition passes through, and an ETA built on
  // history that is only sometimes recorded is worse than none.
  //
  // started_at is rewritten on every entry to 'processing', not written once.
  // A re-run of the same analysis is a new run and should be timed as one; a
  // first-write-wins rule would silently measure the re-run from the original
  // upload and report a wildly long duration ever after.
  const timing =
    status === "processing" ? { started_at: new Date().toISOString(), finished_at: null }
    : status === "completed" || status === "failed" ? { finished_at: new Date().toISOString() }
    : {};

  const { error } = await supabase
    .from("analyses")
    .update({
      status,
      error_message: extra.errorMessage ?? null,
      ...(extra.result !== undefined ? { result: extra.result } : {}),
      ...timing,
    })
    .eq("id", analysisId);

  if (error) throw error;
}
