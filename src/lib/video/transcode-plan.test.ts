import test from "node:test";
import assert from "node:assert/strict";
import {
  planTranscode,
  targetBitrate,
  targetDimensions,
  TRANSCODE_MAX_SIDE,
  MIN_TARGET_BITRATE,
  MAX_TARGET_BITRATE,
} from "./transcode-plan";
import { normaliseTrim } from "./transcode";

/** Ky's actual footage, from ffprobe: 1080p30 HEVC straight off an iPhone. */
const IPHONE_1080P = {
  width: 1920,
  height: 1080,
  fps: 30,
  durationSeconds: 1139,
  sizeBytes: 1_882_863_144,
};

test("a 4K frame comes down to the 1280 the pipeline actually reads", () => {
  const { width, height } = targetDimensions(3840, 2160);
  assert.equal(width, TRANSCODE_MAX_SIDE);
  assert.equal(height, 720, "16:9 has to stay 16:9 or the court homography moves");
});

test("portrait footage caps its long edge, not its width", () => {
  // A phone held upright. Capping WIDTH here would give 1280x2276 -- bigger
  // than the source, which is the opposite of the point.
  const { width, height } = targetDimensions(1080, 1920);
  assert.equal(height, TRANSCODE_MAX_SIDE);
  assert.equal(width, 720);
});

test("a clip already smaller than the cap is never upscaled", () => {
  const { width, height } = targetDimensions(640, 360);
  assert.deepEqual({ width, height }, { width: 640, height: 360 });
});

test("dimensions are always even, whatever the aspect ratio", () => {
  // 1001x1999 scaled is 641.something x 1280 -- an odd width is half a chroma
  // sample in yuv420p, and encoders answer that by silently resizing, which
  // moves every coordinate the court was calibrated against.
  for (const [w, h] of [[1001, 1999], [1919, 1079], [333, 777], [1280, 719]]) {
    const out = targetDimensions(w, h);
    assert.equal(out.width % 2, 0, `width ${out.width} from ${w}x${h}`);
    assert.equal(out.height % 2, 0, `height ${out.height} from ${w}x${h}`);
  }
});

test("bitrate scales with frame rate, because 60 fps is twice the pictures", () => {
  const at30 = targetBitrate(1280, 720, 30);
  const at60 = targetBitrate(1280, 720, 60);
  assert.ok(at60 > at30 * 1.5, `${at60} should be well above ${at30}`);
});

test("bitrate stays inside its rails at both extremes", () => {
  assert.equal(targetBitrate(320, 180, 24), MIN_TARGET_BITRATE);
  assert.equal(targetBitrate(3840, 2160, 60), MAX_TARGET_BITRATE);
});

test("a missing frame rate is assumed to be 30, not zero", () => {
  // Zero would collapse the formula to the floor and starve a real clip.
  assert.equal(targetBitrate(1280, 720, null), targetBitrate(1280, 720, 30));
  assert.ok(targetBitrate(1280, 720, null) > MIN_TARGET_BITRATE);
});

test("Ky's own 1080p iPhone clip is worth re-encoding, and by a lot", () => {
  const result = planTranscode(IPHONE_1080P);
  assert.equal(result.transcode, true);
  if (!result.transcode) return;
  assert.equal(result.plan.width, 1280);
  assert.equal(result.plan.height, 720);
  // 1.88 GB at 13 Mbps down to something a phone can push in a few minutes.
  assert.ok(
    result.plan.estimatedBytes < IPHONE_1080P.sizeBytes / 3,
    `${result.plan.estimatedBytes} should be a third of ${IPHONE_1080P.sizeBytes} or less`
  );
});

test("a clip that is already small is left alone rather than re-encoded", () => {
  // ky-720p.mp4: 1280x720, 22 MB. Already the size the pipeline reads, so
  // there is nothing to downscale and no reason to spend a phone battery.
  const result = planTranscode({
    width: 1280, height: 720, fps: 24, durationSeconds: 37, sizeBytes: 22 * 1024 * 1024,
  });
  assert.equal(result.transcode, false);
});

test("a 720p clip at a silly bitrate is STILL left alone", () => {
  // Same frame size as the clip above, twenty times the bitrate. There are
  // real bytes to save here and this deliberately declines them: shrinking
  // without downscaling means a second lossy generation over a four-pixel
  // ball, and no benchmark says that is safe. The downscale has one; this
  // does not. If that changes, this test is the thing to delete.
  const result = planTranscode({
    width: 1280, height: 720, fps: 30, durationSeconds: 600, sizeBytes: 1_500_000_000,
  });
  assert.equal(result.transcode, false);
  if (result.transcode) return;
  assert.match(result.reason, /longest side/);
});

test("1280 wide is inside the cap, 1282 is not", () => {
  // The boundary both ways, because an off-by-one here is the difference
  // between re-encoding every clip and re-encoding none of them, and neither
  // failure announces itself.
  const inside = planTranscode({
    width: 1280, height: 720, fps: 30, durationSeconds: 600, sizeBytes: 1_500_000_000,
  });
  assert.equal(inside.transcode, false);
  const outside = planTranscode({
    width: 1282, height: 720, fps: 30, durationSeconds: 600, sizeBytes: 1_500_000_000,
  });
  assert.equal(outside.transcode, true);
});

test("a marginal saving is declined, and the reason says why", () => {
  // Roughly 20% smaller: not worth minutes of decode-plus-encode on a phone.
  const bitrate = targetBitrate(1280, 720, 30);
  const sizeBytes = Math.round((bitrate * 600) / 8 / 0.8);
  const result = planTranscode({ width: 1920, height: 1080, fps: 30, durationSeconds: 600, sizeBytes });
  // Above the cap, so it got past the resolution gate and declined on the
  // saving -- which is the thing under test.
  assert.equal(result.transcode, false);
  if (result.transcode) return;
  assert.match(result.reason, /only save/);
});

test("unknown duration declines instead of guessing", () => {
  // With no duration the output size cannot be predicted, so there is no way
  // to know the re-encode saves anything. Uploading the original already works.
  const result = planTranscode({ ...IPHONE_1080P, durationSeconds: null });
  assert.equal(result.transcode, false);
  if (result.transcode) return;
  assert.match(result.reason, /duration/);
});

test("unknown dimensions decline instead of guessing", () => {
  const result = planTranscode({ ...IPHONE_1080P, width: 0, height: 0 });
  assert.equal(result.transcode, false);
  if (result.transcode) return;
  assert.match(result.reason, /dimensions/);
});

// ---------------------------------------------------------------------------
// Trimming. See TranscodeOptions.trim: the free allowance is ten minutes and a
// game is sixteen to nineteen, so the first thing a new player meets is a
// refusal unless they can cut the clip before it is uploaded.
// ---------------------------------------------------------------------------

test("a trim shorter than the clip is worth doing", () => {
  const got = normaliseTrim({ startSeconds: 120, endSeconds: 720 }, 1140);
  assert.deepEqual(got, { startSeconds: 120, endSeconds: 720 });
});

test("a trim that cuts nothing off is not a trim", () => {
  // Re-encoding a whole game to remove none of it is minutes of a phone's
  // battery for no bytes saved.
  assert.equal(normaliseTrim({ startSeconds: 0, endSeconds: 1140 }, 1140), null);
  assert.equal(normaliseTrim({ startSeconds: 0, endSeconds: 1139.98 }, 1140), null);
});

test("nonsense ranges are refused rather than passed to the encoder", () => {
  assert.equal(normaliseTrim({ startSeconds: 60, endSeconds: 60.5 }, 1140), null, "half a second is not a clip");
  assert.equal(normaliseTrim({ startSeconds: 600, endSeconds: 60 }, 1140), null, "backwards");
  assert.equal(normaliseTrim({ startSeconds: NaN, endSeconds: 60 }, 1140), null);
  assert.equal(normaliseTrim(null, 1140), null);
});

test("a negative start is clamped, not refused", () => {
  assert.deepEqual(normaliseTrim({ startSeconds: -3, endSeconds: 600 }, 1140), { startSeconds: 0, endSeconds: 600 });
});
