/**
 * The three seconds that back up a sentence.
 *
 * WHY THIS EXISTS, in the words of the player it is for: "my positioning is
 * not poor". A 4.0 player told that it is will say exactly that, and they are
 * entitled to -- a claim you cannot check is a claim you can dismiss. Until
 * now an observation carried a timestamp, which is a number. This turns the
 * number into the footage.
 *
 * CUT FROM THE OVERLAY, NOT RE-RENDERED FROM IT. There is already a
 * renderShotClip() that re-runs the Python renderer over a window, and it
 * would work. This does not use it, for two reasons. It would re-derive
 * everything -- court, boxes, skeletons -- from the overlay DATA, so a clip
 * and the overlay it claims to come from could disagree about what happened,
 * which is the one thing evidence must never do. And trimming an existing mp4
 * costs a fraction of a second where a re-render costs the best part of one,
 * times a dozen observations.
 *
 * Never throws. Evidence is an addition to a coaching read; a read without it
 * is diminished, not broken, and a failed cut must never lose a finished
 * analysis.
 */

import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { isLocalDev } from "@/lib/deployment";
import { uploadFileFromDisk } from "@/lib/storage/r2";
import { debugVideoDir, LOCAL_BUCKET, R2_BUCKET } from "@/lib/vision/debug-video-store";
import { describeError } from "@/lib/analysis/describe-error";

const run = promisify(execFile);

/** How much of the approach to keep. A stroke reads as a stroke with its wind-up. */
export const LEAD_S = 2.0;
/** And the follow-through, which is half of what a correction is about. */
export const TRAIL_S = 1.5;

/**
 * How many clips one analysis will cut.
 *
 * Twelve, because that is more observations than a read produces on a normal
 * clip, and because the cost is bounded work on a box that has other things to
 * do. If a read ever returns thirty, the twelve most severe are the ones worth
 * watching anyway.
 */
export const MAX_CLIPS = 12;

export interface ClipRequest {
  /** The observation row this clip belongs to. */
  id: string;
  /** Seconds into the source clip. */
  tSeconds: number;
  /** Ranking for the MAX_CLIPS cut: higher is kept. */
  severity?: number;
}

export interface ClipResult {
  id: string;
  path: string;
  bucket: string;
}

/** The name a clip is stored under, deterministic so it can be found again. */
export function evidenceClipKey(analysisId: string, atSeconds: number): string {
  return `${analysisId}-ev-${Math.round(atSeconds * 1000)}.mp4`;
}

/**
 * Cut one window out of an mp4.
 *
 * -ss BEFORE -i seeks by keyframe and is fast; after -i it decodes from zero
 * and is not. The re-encode is deliberate rather than `-c copy`: a stream copy
 * can only cut on a keyframe, so a clip asked for at 41.2s silently starts at
 * 39s or 44s -- and a piece of evidence that shows the wrong moment is worse
 * than none. Three seconds of 720p at veryfast is a few hundred milliseconds.
 */
async function cut(src: string, out: string, startS: number, durationS: number): Promise<void> {
  await run("ffmpeg", [
    "-loglevel", "error", "-y",
    "-ss", startS.toFixed(3),
    "-i", src,
    "-t", durationS.toFixed(3),
    "-an",
    "-vcodec", "libx264", "-preset", "veryfast", "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    out,
  ], { timeout: 60_000 });
}

/**
 * Cuts a clip per request and stores it beside the overlay.
 *
 * Returns only the ones that worked. A caller writes what it gets and leaves
 * the rest null, which is the honest record: the observation stands, the
 * evidence for it is missing, and the UI says so by showing no play control
 * rather than a broken one.
 */
export async function cutEvidenceClips(opts: {
  analysisId: string;
  /** The rendered overlay, as bytes -- the same ones the model watched. */
  overlayBytes: Uint8Array;
  clipSeconds: number;
  requests: ClipRequest[];
  onLog?: (line: string) => void;
}): Promise<ClipResult[]> {
  const wanted = opts.requests
    .filter((r) => Number.isFinite(r.tSeconds) && r.tSeconds >= 0 && r.tSeconds <= opts.clipSeconds)
    // Most severe first, so the cap keeps the ones worth watching.
    .sort((a, b) => (b.severity ?? 3) - (a.severity ?? 3))
    .slice(0, MAX_CLIPS);
  if (wanted.length === 0) return [];

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "pb-evidence-"));
  const srcPath = path.join(tmp, "overlay.mp4");
  const results: ClipResult[] = [];
  const startedAt = Date.now();

  try {
    await fsp.writeFile(srcPath, opts.overlayBytes);
    const outDir = debugVideoDir();
    await fsp.mkdir(outDir, { recursive: true });

    for (const req of wanted) {
      // Clamped to the clip. ffmpeg given a negative -ss produces an empty
      // file, which plays as a broken video rather than as a shorter moment.
      const startS = Math.max(0, req.tSeconds - LEAD_S);
      const endS = Math.min(opts.clipSeconds, req.tSeconds + TRAIL_S);
      if (!(endS > startS)) continue;

      const name = evidenceClipKey(opts.analysisId, req.tSeconds);
      const localPath = path.join(outDir, name);
      try {
        await cut(srcPath, localPath, startS, endS - startS);
        if (isLocalDev()) {
          results.push({ id: req.id, path: name, bucket: LOCAL_BUCKET });
        } else {
          const objectKey = `debug/${name}`;
          await uploadFileFromDisk(objectKey, localPath, "video/mp4");
          await fsp.rm(localPath, { force: true }).catch(() => {});
          results.push({ id: req.id, path: objectKey, bucket: R2_BUCKET });
        }
      } catch (err) {
        // One bad window must not cost the other eleven.
        opts.onLog?.(`evidence clip at ${req.tSeconds.toFixed(1)}s not cut: ${describeError(err)}`);
      }
    }
  } catch (err) {
    opts.onLog?.(`evidence clips skipped: ${describeError(err)}`);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  opts.onLog?.(
    `evidence: ${results.length}/${wanted.length} clip(s) cut in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  );
  return results;
}
