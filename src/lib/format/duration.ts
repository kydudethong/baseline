/**
 * Seconds, written the way people say them.
 *
 * "155s" is a number a stopwatch produces and nobody reads: past a minute the
 * mind has to divide before the figure means anything, and a page full of
 * three-digit second counts reads as machine output. Past sixty seconds
 * everything here says minutes and a remainder.
 *
 * TWO SHAPES, because two different questions are being answered:
 * `clock` for a MOMENT in the clip (2:35 — the shape every video player uses,
 * so it can be matched against the scrubber) and `secs` for a LENGTH of time
 * (2m 35s — a duration read on its own, where a bare 2:35 could be either).
 */

/** A moment in the clip, as a video player writes it: 0:07, 2:35, 71:04. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  return `${m}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * A length of time: "8.4s", "47s", "2m 35s".
 *
 * Under a minute it stays in seconds, with `decimals` places where the
 * fraction carries meaning (a rally of 8.4s is not the same as 8s). At a
 * minute and over, the decimals go: nobody needs a tenth of a second on a
 * figure they are reading as "about two and a half minutes", and "2m 35.4s"
 * is harder to read than what it replaced.
 */
export function secs(seconds: number, decimals = 0): string {
  const v = Math.max(0, seconds);
  if (v < 60) {
    const n = decimals > 0 ? v.toFixed(decimals) : String(Math.round(v));
    // 59.97s rounds to "60.0s", which is the one thing this must never print.
    if (Number(n) < 60) return `${n}s`;
  }
  const total = Math.round(v);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * Rewrite seconds written into prose as minutes and seconds.
 *
 * FOR TEXT WE DID NOT WRITE. Everything this app renders itself goes through
 * `clock` and `secs` above, but the coaching read is written by a model that
 * is given times in seconds and hands them back the same way -- "at 766.1s",
 * in the middle of a sentence. No formatter reaches inside a paragraph, so
 * the page kept showing three-digit second counts in exactly the place a
 * person reads most carefully.
 *
 * Only figures of a minute or more are touched: "you hung back for 3s" is
 * clearer as it is, and rewriting it would be noise. Speeds are left alone --
 * "4.2 m/s" ends in the same letter and means something else entirely.
 */
export function timesInProse(text: string): string;
export function timesInProse(text: string | null | undefined): string | null;
export function timesInProse(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  return text
    // "766.1s", "at 766 s" — but never "4.2 m/s" or a bare "12s".
    .replace(/(^|[^\w/.])(\d+(?:\.\d+)?)\s?s\b/g, (whole, before: string, num: string) => {
      const v = Number(num);
      return Number.isFinite(v) && v >= 60 ? `${before}${clock(v)}` : whole;
    })
    // "at 766.1 seconds"
    .replace(/(^|[^\w/.])(\d+(?:\.\d+)?)\s?seconds\b/g, (whole, before: string, num: string) => {
      const v = Number(num);
      return Number.isFinite(v) && v >= 60 ? `${before}${clock(v)}` : whole;
    });
}
