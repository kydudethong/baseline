/**
 * Shrink a clip on the phone, before it is uploaded.
 *
 * WHY THIS IS WORTH THE TROUBLE. Ky's own footage is 1080p30 HEVC at 13-17
 * Mbps -- a nineteen-minute game is 1.9 GB. The pipeline downscales every
 * frame to 1280 on the way in (`ml/rally_seg/config.py`, `max_side`), and
 * `makeCvProxy` in ffmpeg.ts already transcodes to that same 1280 on the
 * server before the CV passes run. So those 1.9 GB are pushed up a phone's
 * uplink, stored, downloaded again by the worker, and then thrown away.
 *
 * Doing the downscale here removes three costs at once: the upload is four to
 * five times smaller, the server-side proxy transcode stops happening (it
 * checks the source width and correctly does nothing), and the worker has less
 * to download. The cost is a few minutes of the phone's own hardware encoder.
 *
 * AND THE QUALITY QUESTION IS ALREADY ANSWERED, which is the only reason this
 * is defensible: the September 9 benchmark ran the real ball detector over the
 * same footage at 1080p and at 720p and found no meaningful difference,
 * because the ball fails as a motion-blurred streak and a streak is equally
 * unreadable at any resolution. See claude/ball-detection-benchmark-sept-2026.
 *
 * NOTHING HERE IS ALLOWED TO BE FATAL. Every path that cannot produce a
 * smaller file returns null, and null means "upload the original", which is
 * the behaviour that already worked. A browser without WebCodecs, a codec the
 * browser cannot decode, a full disk, a cancelled conversion -- all of them
 * cost the optimisation and none of them cost the upload.
 */

import type { Conversion as ConversionInstance, StreamTargetChunk } from "mediabunny";
import { planTranscode, targetBitrate, type SourceProbe } from "./transcode-plan";
import { openForWrite, readBack, remove } from "./opfs";

/**
 * How often a key frame goes in, in seconds.
 *
 * Two, against mediabunny's default of five. Key frames are the only places a
 * player can seek to cheaply, and this video's whole job is to be scrubbed: a
 * coaching read is a list of clips, and every one of them is a seek. Five
 * seconds of granularity on a three-second rally means the clip starts before
 * the point does. The extra key frames cost a few percent of file size.
 */
export const KEY_FRAME_INTERVAL_S = 2;

export interface TranscodeOutcome {
  file: File;
  /** Name in the origin-private filesystem, so a reload can find it again. */
  opfsName: string;
  originalBytes: number;
}

export interface TranscodeOptions {
  /** 0 to 1. Called often; the caller is responsible for not thrashing React. */
  onProgress: (fraction: number) => void;
  /** Aborting mid-conversion leaves no partial file behind. */
  signal: AbortSignal;
  /** Stable name for the scratch file, from opfsNameFor(fingerprint). */
  opfsName: string;
  /** Told the reason whenever this declines, so the caller can log it. */
  onSkip?: (reason: string) => void;
  /**
   * Cut the clip to these seconds before uploading.
   *
   * WHY IT LIVES HERE. The free allowance is ten minutes and a game is
   * sixteen to nineteen, so a new player's first action is being refused.
   * Cutting server-side would mean uploading the whole game first, which is
   * the slow part; the encoder is already running in the browser and trimming
   * costs it nothing extra.
   *
   * A TRIM IS ITS OWN REASON TO RE-ENCODE. Everything below normally declines
   * on a clip that is already small enough -- the saving would not pay for the
   * battery. When there is a range to cut, the cut IS the point, so the plan's
   * "no need" answer is overridden and the source's own dimensions are kept.
   */
  trim?: { startSeconds: number; endSeconds: number } | null;
}

/**
 * A trim that is worth doing and can be done, or null.
 *
 * Refused when it is not shorter than the clip: re-encoding a whole game to
 * cut nothing off it is minutes of a phone's battery for no bytes saved.
 */
export function normaliseTrim(
  trim: { startSeconds: number; endSeconds: number } | null | undefined,
  durationSeconds: number | null,
): { startSeconds: number; endSeconds: number } | null {
  if (!trim) return null;
  const start = Math.max(0, trim.startSeconds);
  const end = trim.endSeconds;
  if (!(Number.isFinite(start) && Number.isFinite(end)) || end - start < 1) return null;
  if (durationSeconds && start <= 0.05 && end >= durationSeconds - 0.05) return null;
  return { startSeconds: start, endSeconds: end };
}

/** Cheap enough to call before deciding anything: no decoding happens. */
export function webCodecsAvailable(): boolean {
  return typeof globalThis !== "undefined"
    && typeof (globalThis as { VideoEncoder?: unknown }).VideoEncoder === "function"
    && typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder === "function";
}

/**
 * Re-encode `source` to something worth uploading, or return null to say don't.
 *
 * Returning null is the normal, expected outcome for plenty of real files --
 * a clip already at 720p, a browser without the codec, a short video where the
 * saving would not pay for the wait. The caller uploads the original and says
 * nothing about it.
 */
export async function transcodeForUpload(
  source: File,
  opts: TranscodeOptions
): Promise<TranscodeOutcome | null> {
  const skip = (reason: string) => {
    opts.onSkip?.(reason);
    return null;
  };

  if (!webCodecsAvailable()) return skip("this browser has no WebCodecs");

  let mediabunny: typeof import("mediabunny");
  try {
    // Dynamically imported so the library -- which is large, and useless to
    // anyone who is not mid-upload -- stays out of the main bundle.
    mediabunny = await import("mediabunny");
  } catch {
    return skip("the encoder library failed to load");
  }

  const {
    ALL_FORMATS, BlobSource, Conversion, Input, Mp4OutputFormat, Output, Quality, StreamTarget,
    canEncodeVideo,
  } = mediabunny;

  const input = new Input({ source: new BlobSource(source), formats: ALL_FORMATS });

  let probe: SourceProbe;
  let canDecode: boolean;
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return skip("no video track");
    canDecode = await track.canDecode();
    // DISPLAY dimensions, not coded ones. A phone filmed sideways stores
    // landscape pixels plus a rotation, and planning against the coded size
    // would cap the wrong edge -- turning portrait footage into a 1280-wide
    // video that is 2276 tall, which is bigger than the source, not smaller.
    const width = await track.getDisplayWidth();
    const height = await track.getDisplayHeight();
    const duration = await input.computeDuration();
    // A prefix of the packets is enough for an accurate frame rate and costs
    // a fraction of a second; scanning the whole file would cost minutes.
    const stats = await track.computePacketStats(120);
    probe = {
      width,
      height,
      fps: stats.averagePacketRate || null,
      durationSeconds: duration || null,
      sizeBytes: source.size,
    };
  } catch {
    return skip("could not read the video's metadata");
  }

  // HEVC is what an iPhone records by default, and a browser that cannot
  // decode it cannot transcode it either. Finding that out here is the
  // difference between uploading the original and a failed upload.
  if (!canDecode) return skip("this browser cannot decode that codec");

  const trim = normaliseTrim(opts.trim, probe.durationSeconds);
  const decision = planTranscode(probe);
  if (!decision.transcode && !trim) return skip(decision.reason);
  // With a trim and no downscale to do, the source's own size is the target:
  // the job is to cut, not to shrink, and re-sizing on top would be a second
  // lossy generation nobody asked for.
  const { width, height, bitrate } = decision.transcode
    ? decision.plan
    : { width: probe.width, height: probe.height, bitrate: targetBitrate(probe.width, probe.height, probe.fps) };

  const quality = new Quality({ bitrate });
  try {
    if (!(await canEncodeVideo("avc", { width, height, quality }))) {
      return skip("this browser cannot encode H.264 at that size");
    }
  } catch {
    return skip("this browser cannot encode H.264 at that size");
  }

  const scratch = await openForWrite(opts.opfsName);
  if (!scratch) return skip("no scratch storage available");

  const target = new StreamTarget(
    new WritableStream<StreamTargetChunk>({
      async write(chunk) {
        await scratch.writable.write({ type: "write", position: chunk.position, data: chunk.data });
      },
    }),
    // Batched, so a two-gigabyte conversion is thousands of writes rather than
    // hundreds of thousands of them.
    { chunked: true }
  );

  const output = new Output({
    format: new Mp4OutputFormat({
      // Metadata at the END of the file. 'in-memory' would put it at the front
      // -- nicer for a player's first request -- but only by holding every
      // media chunk in RAM until finalisation, which is the exact half a
      // gigabyte this whole file exists to avoid. R2 serves range requests, so
      // a player fetches the tail and carries on.
      fastStart: false,
    }),
    target,
  });

  let conversion: ConversionInstance;
  try {
    conversion = await Conversion.init({
      input,
      output,
      video: {
        width,
        height,
        quality,
        codec: "avc",
        keyFrameInterval: KEY_FRAME_INTERVAL_S,
        // BAKE ROTATION INTO THE PIXELS. Left on, mediabunny would record the
        // phone's rotation as metadata instead of applying it -- and the two
        // readers downstream disagree about metadata: ffmpeg honours it, cv2
        // ignores it. That disagreement is a court calibrated on an upright
        // frame and a pose pass reading a sideways one, which fails as
        // nonsense results rather than as an error.
        allowTransformationMetadata: false,
      },
      // Nothing downstream reads audio -- the audio contact detector is gone,
      // and makeCvProxy drops it server-side for the same reason. It is a
      // tenth of the bytes and all of the AAC decoding, for nothing.
      audio: { discard: true },
      ...(trim ? { trim: { start: trim.startSeconds, end: trim.endSeconds } } : {}),
    });
  } catch {
    await remove(opts.opfsName);
    return skip("the conversion could not be set up");
  }

  if (!conversion.isValid) {
    await remove(opts.opfsName);
    return skip("the conversion is not valid for this file");
  }

  conversion.onProgress = (fraction: number) => opts.onProgress(fraction);

  const onAbort = () => void conversion.cancel();
  opts.signal.addEventListener("abort", onAbort, { once: true });

  try {
    await conversion.execute();
  } catch (err) {
    opts.signal.removeEventListener("abort", onAbort);
    await scratch.writable.close().catch(() => {});
    await remove(opts.opfsName);
    if (opts.signal.aborted) throw err;
    return skip(err instanceof Error ? err.message : "the conversion failed");
  }
  opts.signal.removeEventListener("abort", onAbort);

  try {
    await scratch.writable.close();
  } catch {
    await remove(opts.opfsName);
    return skip("the transcoded file could not be finished");
  }

  const file = await readBack(opts.opfsName);
  if (!file) {
    await remove(opts.opfsName);
    return skip("the transcoded file could not be read back");
  }

  // THE ESTIMATE IS NOT THE OUTCOME. planTranscode predicted a saving from a
  // duration and a bitrate; the encoder had the last word. If the prediction
  // was wrong -- a clip that is mostly a static wall compresses to nothing,
  // one that is all motion may not -- uploading the bigger of the two files
  // would make this feature actively harmful.
  if (file.size >= source.size) {
    await remove(opts.opfsName);
    return skip("the re-encode came out no smaller than the original");
  }

  return { file, opfsName: opts.opfsName, originalBytes: source.size };
}
