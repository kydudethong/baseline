/**
 * Where the annotated overlay lives, behind one function.
 *
 * The renderer writes to `public/rally-debug/<id>.mp4` and the debug page
 * checked for it with `fs.existsSync`. That works in dev and breaks the moment
 * this is deployed: on serverless there is no persistent local disk, and even
 * on a long-lived box the web process and the worker that rendered the file are
 * not guaranteed to be the same machine.
 *
 * So the analysis row records a storage KEY and a BUCKET, and resolving a key
 * to something a browser can play happens here. Today every bucket is "local"
 * and this returns the same /rally-debug URL as before — nothing has moved yet.
 * When the renderer starts uploading to R2, only this file changes; no page
 * that renders a debug video needs to know.
 *
 * The frontend never sees a filesystem path, which was the actual problem.
 */
import fs from "node:fs";
import path from "node:path";
import type { AnalysisRow } from "@/lib/db/types";

/** Marks a file still sitting on the box that rendered it. */
export const LOCAL_BUCKET = "local";
/** Marks a file that was uploaded to object storage and survives a redeploy. */
export const R2_BUCKET = "r2";

/**
 * The key an overlay is stored under in R2.
 *
 * Namespaced under debug/ so a lifecycle rule can expire overlays on their own
 * schedule without touching the source videos. An overlay is a derivative --
 * re-running the analysis regenerates it -- and it is ~35 MB per clip, so it
 * is the first thing that should age out when the bucket gets expensive.
 */
export function debugVideoObjectKey(analysisId: string): string {
  return `debug/${analysisId}.mp4`;
}

/**
 * The overlay DATA for an analysis, kept beside the video.
 *
 * Persisted rather than thrown away with the temp dir, because a coaching clip
 * is rendered from it long after the run finished. It is small -- a few
 * hundred KB of rounded coordinates -- next to a ~35MB overlay video.
 */
export function overlayDataKey(analysisId: string): string {
  return `${analysisId}.overlay.json`;
}

/**
 * A clip of the overlay around one moment, named by its own timestamp.
 *
 * Deterministic on purpose: the frontend can work out the URL for a coaching
 * point's shot from data it already has, so no column has to be added to
 * coaching_observations to record it, and no migration has to be run before
 * the feature works.
 */
export function shotClipKey(analysisId: string, atSeconds: number): string {
  return `${analysisId}-shot-${Math.round(atSeconds * 1000)}.mp4`;
}

export function debugVideoDir(): string {
  return process.env.RALLY_SEG_DEBUG_DIR || path.join(process.cwd(), "public", "rally-debug");
}

/** The storage key for an analysis's overlay. Not a path, not a URL. */
export function debugVideoKey(analysisId: string): string {
  return `${analysisId}.mp4`;
}

/**
 * A URL a browser can play, or null when there is no overlay for this analysis.
 *
 * Falls back to looking on disk when the row has no recorded key, so the
 * overlays rendered before this column existed still play. That fallback is the
 * only place a filesystem check remains, and it disappears once every analysis
 * has been re-run.
 */
export async function debugVideoUrl(
  analysis: Pick<AnalysisRow, "id" | "debug_video_path" | "debug_video_bucket">
): Promise<string | null> {
  const key = analysis.debug_video_path ?? debugVideoKey(analysis.id);
  const bucket = analysis.debug_video_bucket ?? LOCAL_BUCKET;

  if (bucket === LOCAL_BUCKET) {
    // Next serves public/ at the web root, so the key IS the path under it.
    const onDisk = path.join(debugVideoDir(), key);
    return fs.existsSync(onDisk) ? `/rally-debug/${key}` : null;
  }

  // Object storage. Signed rather than public: an overlay shows a real person's
  // game, and the bucket holding it should not be world-readable.
  const { getSignedDownloadUrl } = await import("@/lib/storage/r2");
  try {
    return await getSignedDownloadUrl(key);
  } catch {
    return null;
  }
}

/**
 * A URL for one evidence clip, or null when there is nothing to play.
 *
 * Same two-bucket resolution as the overlay, and deliberately a separate
 * function rather than a flag on debugVideoUrl: a missing overlay is a broken
 * analysis, while a missing clip is an ordinary absence -- an observation
 * about the clip as a whole has no single moment to cut. Sharing one code path
 * would mean sharing one meaning for null, and they are not the same thing.
 */
export async function evidenceClipUrl(
  clipPath: string | null,
  clipBucket: string | null
): Promise<string | null> {
  if (!clipPath) return null;
  if ((clipBucket ?? LOCAL_BUCKET) === LOCAL_BUCKET) {
    const onDisk = path.join(debugVideoDir(), clipPath);
    return fs.existsSync(onDisk) ? `/rally-debug/${clipPath}` : null;
  }
  const { getSignedDownloadUrl } = await import("@/lib/storage/r2");
  try {
    return await getSignedDownloadUrl(clipPath);
  } catch {
    return null;
  }
}
