/**
 * How a clip is divided for the high-frame-rate technique pass.
 *
 * WHAT CHANGED AND WHY. Pass two used to make one Gemini call per shot: a
 * ~1.8-second window each, up to forty of them, in sequence. That is forty
 * round trips to look at one video, and it could not see anything ACROSS
 * shots -- each call watched one swing in isolation, so "your third drop got
 * lower every time" was not a sentence it could ever produce.
 *
 * Watching the whole clip in one call is the right shape and cannot be done
 * literally. At 15fps and high media resolution a frame costs roughly 258
 * tokens, so a second of footage costs about 3,900 and a one-million-token
 * context holds about four minutes -- before the prompt, the shot list and
 * the answer. A 20-minute game does not fit, and a request that exceeds the
 * window does not degrade gracefully; it fails.
 *
 * So: the longest segments that comfortably fit, covering the clip in order.
 * A 2-minute clip is genuinely one call. A 20-minute game is a handful, each
 * seeing several minutes of continuous play, which is where the cross-shot
 * patterns live. That is the whole-clip reading, made possible.
 */

/** Tokens per frame at high media resolution. Gemini's own published figure. */
export const TOKENS_PER_FRAME_HIGH = 258;

/**
 * Video tokens allowed in one call.
 *
 * 600k of a 1M window, not 950k. The remainder is the prompt, the shot list,
 * the schema and the answer -- and a segment that fits in theory and overflows
 * in practice costs a whole call to discover. Headroom is cheaper than a retry.
 */
export const SEGMENT_TOKEN_BUDGET = 600_000;

/**
 * How many segments a single analysis will pay for.
 *
 * Past this the clip is SAMPLED rather than covered: segments are spread
 * evenly across the footage instead of packed from the start. An hour of
 * pickleball does not contain an hour of coaching, and a player acts on a
 * handful of corrections; covering minute 55 in full while charging for it is
 * not a trade worth making silently. When it happens, it is logged.
 */
export const MAX_SEGMENTS = 8;

export interface Segment {
  startSeconds: number;
  endSeconds: number;
}

/** The longest segment that fits the budget at this frame rate, in seconds. */
export function maxSegmentSeconds(fps: number): number {
  return Math.max(10, Math.floor(SEGMENT_TOKEN_BUDGET / (fps * TOKENS_PER_FRAME_HIGH)));
}

/**
 * Segments covering a clip of `durationSeconds`.
 *
 * Contiguous while the clip fits in MAX_SEGMENTS; evenly spread across the
 * whole clip when it does not, so a long game is sampled from end to end
 * rather than analysed for its first twenty minutes and abandoned.
 */
export function planSegments(durationSeconds: number, fps: number): Segment[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  const width = maxSegmentSeconds(fps);
  const needed = Math.ceil(durationSeconds / width);

  if (needed <= MAX_SEGMENTS) {
    const out: Segment[] = [];
    for (let start = 0; start < durationSeconds; start += width) {
      out.push({ startSeconds: round(start), endSeconds: round(Math.min(durationSeconds, start + width)) });
    }
    return out;
  }

  // Spread: MAX_SEGMENTS windows whose starts are evenly spaced over the clip,
  // first at 0 and last ending at the final second. Gaps between them are the
  // footage nobody is paying to have watched twice.
  const stride = (durationSeconds - width) / (MAX_SEGMENTS - 1);
  const out: Segment[] = [];
  for (let i = 0; i < MAX_SEGMENTS; i++) {
    const start = i * stride;
    out.push({ startSeconds: round(start), endSeconds: round(Math.min(durationSeconds, start + width)) });
  }
  return out;
}

/** True when the plan skips footage rather than covering all of it. */
export function isSampled(durationSeconds: number, fps: number): boolean {
  return Math.ceil(durationSeconds / maxSegmentSeconds(fps)) > MAX_SEGMENTS;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
