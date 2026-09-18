/**
 * The three seconds that back up a sentence.
 *
 * WHY THIS EXISTS, in the words of the player it is for: "my positioning is
 * not poor". A 4.0 player told that it is will say exactly that, and they are
 * entitled to -- a claim you cannot check is a claim you can dismiss. Until
 * now an observation carried a timestamp, which is a number. This turns the
 * number into the footage.
 *
 * CUT FROM THE SOURCE VIDEO, NOT THE OVERLAY.
 *
 * It used to cut from the overlay, and the argument was good: that is the
 * exact footage the model watched, so the clip was evidence rather than an
 * illustration. In front of an actual player it was wrong. Somebody told
 * their contact point is late wants to see THEMSELVES hit the ball -- they
 * recognise their own swing, their own shoes, the moment they remember. A
 * wireframe skeleton over a downscaled 720p re-encode is the machine showing
 * its working, and the working is not what makes a player believe it.
 *
 * So the clip is their own footage, at their own resolution, with nothing
 * drawn on it. The skeletons still exist on the full overlay for anyone who
 * wants to see what the system saw; they are just not what gets put in front
 * of a criticism.
 *
 * Trimming an existing mp4 costs a fraction of a second where re-rendering
 * costs the best part of one, times a dozen observations -- which is why this
 * still trims rather than calling renderShotClip().
 *
 * Never throws. Evidence is an addition to a coaching read; a read without it
 * is diminished, not broken, and a failed cut must never lose a finished
 * analysis.
 */

import { clipWindow } from "./evidence-window";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { isLocalDev } from "@/lib/deployment";
import { uploadFileFromDisk } from "@/lib/storage/r2";
import { debugVideoDir, LOCAL_BUCKET, R2_BUCKET } from "@/lib/vision/debug-video-store";
import { describeError } from "@/lib/analysis/describe-error";

const run = promisify(execFile);

/** How much of the approach to keep. A stroke reads as a stroke with its wind-up. */
export { clipWindow };
export const LEAD_S = 2.0;
/** And the follow-through, which is half of what a correction is about. */
export const TRAIL_S = 1.5;

/**
 * How many clips one analysis will cut.
 *
 * TWENTY-FOUR, raised from twelve when every criticism started showing its
 * footage. Twelve was chosen as "more than a read produces", which was true of
 * the observations that named a moment and false once the ones that borrow
 * their rally's midpoint joined them. A cap that silently drops the thirteenth
 * observation's evidence turns a guarantee into a usually.
 *
 * The cost is bounded and small: a cut is an ffmpeg trim of a few seconds out
 * of a file already on local disk, measured in fractions of a second, and it
 * happens once per analysis after the read is already written. Twenty-four of
 * them is still under the time the overlay render takes.
 *
 * The severity sort stays. If a read ever returns fifty, the ones that get cut
 * should be the ones worth watching.
 */
export const MAX_CLIPS = 24;

export interface ClipRequest {
  /** The observation row this clip belongs to. */
  id: string;
  /** Seconds into the source clip. */
  tSeconds: number;
  /** Ranking for the MAX_CLIPS cut: higher is kept. */
  severity?: number;
  /**
   * An explicit window, for a claim about a whole point rather than a shot.
   *
   * WITHOUT THIS EVERY CLIP WAS SHOT-SHAPED -- two seconds before the moment
   * and one and a half after -- including the ones whose "moment" was picked
   * by the pipeline because the model never named one. Four seconds cut around
   * a fabricated instant is not weaker evidence, it is different evidence: a
   * criticism about kitchen exchanges came back over footage of a serve.
   *
   * When the claim is about a rally, the clip is the rally.
   */
  endSeconds?: number;
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
  /**
   * The SOURCE video on local disk -- the player's own footage, undrawn-on.
   *
   * A path rather than bytes: the source is the full-resolution original and
   * can be hundreds of megabytes, where the overlay this used to take was a
   * downscaled re-encode. Holding that in memory to write it straight back to
   * a temp file was pointless even then.
   */
  sourcePath: string;
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

  const srcPath = opts.sourcePath;
  const results: ClipResult[] = [];
  const startedAt = Date.now();

  try {
    const outDir = debugVideoDir();
    await fsp.mkdir(outDir, { recursive: true });

    for (const req of wanted) {
      // Clamped to the clip. ffmpeg given a negative -ss produces an empty
      // file, which plays as a broken video rather than as a shorter moment.
      const { startSeconds: startS, endSeconds: endS } = clipWindow(req, opts.clipSeconds);
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
  }
  // Nothing to clean up: the source is the pipeline's own working copy and is
  // removed by whoever downloaded it, and the cut clips are the output.

  opts.onLog?.(
    `evidence: ${results.length}/${wanted.length} clip(s) cut in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  );
  return results;
}
