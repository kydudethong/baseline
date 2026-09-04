import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnalysisResult, AnalysisRow, AnalysisStatus, Database, VideoRow } from "./types";

type Client = SupabaseClient<Database>;

/** `videos.analysis_id` is unique, so this is genuinely a 1:1 embed, not an array. */
export type AnalysisWithVideo = AnalysisRow & { video: VideoRow | null };

export async function listAnalysesForUser(supabase: Client, userId: string) {
  const { data, error } = await supabase
    .from("analyses")
    .select("*, video:videos(*)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

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
  const { error } = await supabase
    .from("analyses")
    .update({
      status,
      error_message: extra.errorMessage ?? null,
      ...(extra.result !== undefined ? { result: extra.result } : {}),
    })
    .eq("id", analysisId);

  if (error) throw error;
}
