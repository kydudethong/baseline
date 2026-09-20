/**
 * What to shrink a clip to before uploading it, and whether to bother.
 *
 * Pure: no browser APIs, no mediabunny, no File. Every judgement that decides
 * whether a phone spends two minutes re-encoding a game lives here so it can
 * be tested in node, because the alternative is testing it by filming a game.
 * transcode.ts does the work; this file decides what the work is.
 */

/**
 * The longest edge the pipeline ever looks at.
 *
 * Not a guess: `ml/rally_seg/config.py` sets `max_side = 1280` and every CV
 * pass downscales to it on the way in. `makeCvProxy` in ffmpeg.ts already
 * transcodes down to the same 1280 server-side, for the same reason. So a
 * phone that uploads 1080p is uploading pixels that are thrown away twice --
 * once in transit, once by a server transcode that then has to happen anyway.
 *
 * Doing it on the phone deletes both costs. And the resolution question is
 * settled rather than assumed: the Sept 9 benchmark ran the real detector over
 * the same footage at 1080p and 720p and found no meaningful difference,
 * because the ball fails as a motion-blurred streak, and a streak is equally
 * unreadable at any resolution.
 */
export const TRANSCODE_MAX_SIDE = 1280;

/**
 * Bits per pixel per second, which is the only honest way to write a bitrate
 * down: 3 Mbps is generous at 720p30 and starvation at 4K60.
 *
 * 0.12 sits around x264's crf 23 for sport, which is what makeCvProxy uses
 * server-side, so the phone produces roughly what the server would have. It is
 * deliberately a little above what looks transparent to an eye, because the
 * thing being protected is not how the video looks -- it is a ball four pixels
 * across that the detector already only finds 41% of the time. Compression
 * noise lands hardest on exactly that: small, fast, low-contrast.
 *
 * IF THE BALL GETS WORSE AFTER THIS SHIPS, THIS NUMBER IS THE FIRST SUSPECT,
 * and `ml-experiments/` already has the harness to prove it either way -- run
 * the detector over an original and its transcode and compare coverage and run
 * lengths. Raising it costs upload time and nothing else.
 */
export const BITS_PER_PIXEL_SECOND = 0.12;

/** Floor and ceiling, because the formula is a heuristic and heuristics need rails. */
export const MIN_TARGET_BITRATE = 1_500_000;
export const MAX_TARGET_BITRATE = 8_000_000;

/**
 * How much smaller the output has to be before the re-encode earns its keep.
 *
 * Transcoding is a full decode plus a full encode. On a phone that is minutes
 * of the user staring at a progress bar and a warm battery, so shaving 10% off
 * an upload is a bad trade -- it can easily cost more time than it saves.
 * Below this saving, upload the original and say nothing.
 */
export const MIN_SAVING_RATIO = 0.35;

export interface SourceProbe {
  width: number;
  height: number;
  /** Frames per second. Null when the container does not say. */
  fps: number | null;
  /** Seconds. Null when the container does not say. */
  durationSeconds: number | null;
  sizeBytes: number;
}

export interface TranscodePlan {
  width: number;
  height: number;
  bitrate: number;
  /** Best guess at the output size, used to decide if this is worth doing. */
  estimatedBytes: number;
}

export type PlanResult =
  | { transcode: true; plan: TranscodePlan }
  | { transcode: false; reason: string };

/**
 * Even numbers, always.
 *
 * H.264 in yuv420p stores chroma at half resolution in both axes, so an odd
 * width has half a chroma sample in it. Encoders respond to that by failing,
 * or -- worse, because it is silent -- by quietly adjusting the dimension and
 * handing back a video whose frames no longer match the coordinates everything
 * downstream was calibrated against.
 */
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * Fit inside a square of `maxSide`, preserving aspect ratio.
 *
 * NEVER UPSCALES. A 640x360 clip stays 640x360: enlarging it would invent no
 * detail, cost encode time, and make the file bigger, which is the opposite of
 * the point. Portrait footage is handled by the same rule, since it caps the
 * longest edge rather than the width -- a phone held upright gives 720x1280,
 * not 1280x2276.
 */
export function targetDimensions(
  width: number,
  height: number,
  maxSide = TRANSCODE_MAX_SIDE
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width: even(width), height: even(height) };
  const scale = maxSide / longest;
  return { width: even(width * scale), height: even(height * scale) };
}

/**
 * Frame rate is never reduced, and that is a deliberate cost.
 *
 * Halving it would halve the file, and it is the obvious lever. But
 * `VideoConfig.stride` is 1 precisely because "a pickleball crosses a 20 ft
 * court in well under a second", and the ball benchmark found the detector is
 * already reading every frame of every clip on disk. Dropping frames here
 * would reintroduce, permanently and invisibly, the exact decimation that the
 * fps-cap bug caused -- which capped ball coverage at 50% by construction and
 * took a benchmark to find.
 */
export function targetBitrate(width: number, height: number, fps: number | null): number {
  // 30 when the container does not say. Under-guessing starves a 60 fps clip;
  // over-guessing wastes bytes on a 24 fps one. 30 is wrong by less in both
  // directions than either extreme, and phone footage is overwhelmingly 30.
  const rate = fps && fps > 0 ? fps : 30;
  const raw = width * height * rate * BITS_PER_PIXEL_SECOND;
  return Math.round(Math.min(MAX_TARGET_BITRATE, Math.max(MIN_TARGET_BITRATE, raw)));
}

/**
 * Decide whether this clip is worth re-encoding, and to what.
 *
 * The bar is a real saving, not any saving: see MIN_SAVING_RATIO. Everything
 * this cannot measure is treated as a reason NOT to spend the user's battery,
 * because uploading the original is the behaviour that already works.
 */
export function planTranscode(source: SourceProbe): PlanResult {
  if (!(source.width > 0) || !(source.height > 0)) {
    return { transcode: false, reason: "could not read the video's dimensions" };
  }

  // A RESOLUTION REDUCTION IS THE WHOLE JUSTIFICATION, so a clip that is
  // already at or below the cap is left alone -- exactly what makeCvProxy does
  // server-side with the same test, and for the same reason. Re-encoding such
  // a clip could still shrink it, since a high bitrate wastes bytes at any
  // size, but that trade has never been measured here: it would be a second
  // lossy generation applied to a ball the detector already only finds 41% of
  // the time, bought with a saving nobody has shown is needed. The downscale
  // is different -- that one was benchmarked, on this footage, in September.
  const longestSide = Math.max(source.width, source.height);
  if (longestSide <= TRANSCODE_MAX_SIDE) {
    return { transcode: false, reason: `already ${longestSide}px on its longest side` };
  }

  const { width, height } = targetDimensions(source.width, source.height);
  const bitrate = targetBitrate(width, height, source.fps);

  // Without a duration there is no way to predict the output size, and so no
  // way to know whether this saves anything. A clip that is already small
  // enough is the common case for that (short test clips have the least
  // reliable metadata), so the safe answer is to leave it alone.
  if (!source.durationSeconds || source.durationSeconds <= 0) {
    return { transcode: false, reason: "could not read the video's duration" };
  }

  const estimatedBytes = Math.round((bitrate * source.durationSeconds) / 8);
  const saving = 1 - estimatedBytes / source.sizeBytes;

  if (saving < MIN_SAVING_RATIO) {
    return {
      transcode: false,
      reason: `re-encoding would only save ${Math.max(0, Math.round(saving * 100))}%`,
    };
  }

  return { transcode: true, plan: { width, height, bitrate, estimatedBytes } };
}
