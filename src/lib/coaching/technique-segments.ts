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

/** And at low, where a frame is read coarsely. The same figure, other tier. */
export const TOKENS_PER_FRAME_LOW = 66;

export type MediaResolution = "low" | "medium" | "high";

/**
 * What a frame costs at a given tier.
 *
 * Split out because the segment planner used to assume `high` unconditionally
 * while the scan pass ran at `low` -- so it sized every segment as though each
 * frame cost four times what it actually did, and split clips that would have
 * fitted in one call. Wrong in the safe direction, but wrong, and the whole
 * point of this module is to know how much video fits.
 *
 * `medium` is priced as `high`: Gemini bills it at the same tier, and guessing
 * cheaper here buys an overflow that costs a whole call to discover.
 */
export function tokensPerFrame(resolution: MediaResolution = "high"): number {
  return resolution === "low" ? TOKENS_PER_FRAME_LOW : TOKENS_PER_FRAME_HIGH;
}

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

/**
 * The longest stretch the model can watch and still know WHERE IT IS.
 *
 * MEASURED, and it is the binding constraint rather than the token budget.
 * Given 446 seconds of video in one call the model returned seven rallies
 * between 506s and 725s — up to five minutes past the end of a clip that was
 * seven and a half minutes long. It was not inventing play it never saw; it
 * lost track of the clock and kept counting. An earlier run did the same on a
 * 101-second clip, returning rallies at 119s and 131s.
 *
 * The context window would happily take 465 seconds at 5fps. The model's sense
 * of time will not, so the cap is time and not tokens. Two minutes costs more
 * calls on a long clip and buys timestamps that are worth reading — and every
 * timestamp in this product is load-bearing, because the rallies, the burst
 * windows and every coaching citation are all joins on them.
 */
export const DEFAULT_MAX_SEGMENT_SECONDS = 120;

/**
 * The cap actually in force.
 *
 * ANALYST_MAX_SEGMENT_SECONDS raises or lowers it. Set it high and the token
 * budget becomes the only limit, which is what "one pass over the whole clip"
 * means in practice -- and the timekeeping failure above comes back with it,
 * so mergeAnalystOutputs drops anything that lands outside the clip and the
 * run logs the fact that it is past the measured-safe length.
 */
export function maxSegmentSecondsCap(): number {
  const v = Number(process.env.ANALYST_MAX_SEGMENT_SECONDS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_SEGMENT_SECONDS;
}

/** The longest segment that fits the budget at this frame rate, in seconds. */
export function maxSegmentSeconds(fps: number, resolution: MediaResolution = "high"): number {
  const byTokens = Math.max(10, Math.floor(SEGMENT_TOKEN_BUDGET / (fps * tokensPerFrame(resolution))));
  return Math.min(byTokens, maxSegmentSecondsCap());
}

/**
 * Segments covering a clip of `durationSeconds`.
 *
 * Contiguous while the clip fits in MAX_SEGMENTS; evenly spread across the
 * whole clip when it does not, so a long game is sampled from end to end
 * rather than analysed for its first twenty minutes and abandoned.
 */
export function planSegments(durationSeconds: number, fps: number, resolution: MediaResolution = "high"): Segment[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  const width = maxSegmentSeconds(fps, resolution);
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
export function isSampled(durationSeconds: number, fps: number, resolution: MediaResolution = "high"): boolean {
  return Math.ceil(durationSeconds / maxSegmentSeconds(fps, resolution)) > MAX_SEGMENTS;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Segments that cover only the given windows, each still inside the token
 * budget.
 *
 * This is where the cost saving lands: instead of tiling the whole clip, the
 * expensive pass tiles only the stretches where somebody was moving. A window
 * longer than one segment is split; several short windows close together stay
 * separate rather than being bridged, because bridging them would pay for
 * exactly the dead time this is avoiding.
 *
 * The MAX_SEGMENTS cap still applies, and when it bites the segments are taken
 * evenly from across the list rather than from the front -- the same reasoning
 * as planSegments: a read of the first twenty minutes is not a read of the
 * match.
 */
export function planSegmentsForWindows(
  windows: ReadonlyArray<{ startSeconds: number; endSeconds: number }>,
  fps: number,
  resolution: MediaResolution = "high"
): Segment[] {
  const width = maxSegmentSeconds(fps, resolution);
  const all: Segment[] = [];
  for (const w of windows) {
    const span = w.endSeconds - w.startSeconds;
    if (!(span > 0)) continue;
    const pieces = Math.ceil(span / width);
    for (let i = 0; i < pieces; i++) {
      const start = w.startSeconds + i * width;
      all.push({
        startSeconds: round(start),
        endSeconds: round(Math.min(w.endSeconds, start + width)),
      });
    }
  }
  if (all.length <= MAX_SEGMENTS) return all;

  const out: Segment[] = [];
  for (let i = 0; i < MAX_SEGMENTS; i++) {
    out.push(all[Math.round((i * (all.length - 1)) / (MAX_SEGMENTS - 1))]);
  }
  return [...new Map(out.map((s) => [`${s.startSeconds}`, s])).values()];
}
