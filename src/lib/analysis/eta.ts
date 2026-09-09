/**
 * How long an analysis is likely to take, from runs that actually happened.
 *
 * WHY THIS IS NOT A PROGRESS BAR. The processing screen has never had a
 * percentage, on purpose: the pipeline cannot know how far through it is, so
 * a bar would be a made-up number dressed as a measurement. An ETA is a
 * different kind of claim. "Clips this length have taken 4-7 minutes" is a
 * statement about observed history — checkable, falsifiable, and honest about
 * being a range rather than a promise. The difference is that this one is
 * derived from `analyses.started_at`/`finished_at`, not from a guess about
 * which stage is halfway.
 *
 * THE MODEL IS ONE NUMBER: seconds of wall clock per second of video. Nearly
 * all the cost is per-frame detection, so runtime scales with clip length far
 * more than with anything else about the clip. Rate is therefore comparable
 * across clips of different lengths in a way that raw duration is not, and a
 * 30s test clip is evidence about a 5-minute one.
 *
 * The range is the observed p25-p75 of that rate, not a symmetric error bar
 * around the median. Run times are right-skewed — a clip where the ball is
 * hard to find takes much longer, nothing ever finishes early — so a
 * symmetric interval would understate the top end, which is the end the user
 * actually cares about.
 */

/** A finished run: how long the clip was, how long it took. */
export type RunSample = { videoSeconds: number; wallSeconds: number };

export type Eta = {
  lowS: number;
  highS: number;
  /** How many past runs this rests on. 0 means the fallback constant. */
  basis: number;
  /** True when no history existed and FALLBACK_RATE was used. */
  isFallback: boolean;
};

/**
 * Seconds of processing per second of video, used only until real runs exist.
 *
 * Measured on Ky's laptop over the benchmark clips: a 5s clip took a little
 * over a minute end to end, most of it ball detection. A Fly performance-2x
 * is slower than an M-series laptop, so this is deliberately the pessimistic
 * end of what was seen rather than the average. It is a placeholder with a
 * known provenance, and the first completed run on a box replaces it.
 */
export const FALLBACK_RATE = 12;

/** Nothing is instant; a sub-30s estimate reads as broken rather than fast. */
const FLOOR_S = 30;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Estimate for a clip of `videoSeconds`, given past runs.
 *
 * Samples with a non-positive duration on either side are dropped rather than
 * clamped: they are a bug or a row written before timing existed, and either
 * way they carry no information about how long this clip will take.
 */
export function estimateRuntime(videoSeconds: number, samples: RunSample[]): Eta | null {
  if (!Number.isFinite(videoSeconds) || videoSeconds <= 0) return null;

  const rates = samples
    .filter((s) => s.videoSeconds > 0 && s.wallSeconds > 0)
    .map((s) => s.wallSeconds / s.videoSeconds)
    .sort((a, b) => a - b);

  if (rates.length === 0) {
    // No history. One rate, so no honest spread — widen it by hand and say in
    // the UI that it is a rough first guess rather than a measurement.
    const mid = videoSeconds * FALLBACK_RATE;
    return { lowS: Math.max(FLOOR_S, mid * 0.6), highS: Math.max(FLOOR_S * 2, mid * 1.7), basis: 0, isFallback: true };
  }

  // A single past run is a point, not a distribution. Treat it as a centre and
  // put a deliberately wide band around it — one clip tells you the order of
  // magnitude and nothing about the variance.
  const spread = rates.length === 1 ? { lo: 0.7, hi: 1.6 } : { lo: 1, hi: 1 };
  const lo = quantile(rates, rates.length === 1 ? 0 : 0.25) * spread.lo;
  const hi = quantile(rates, rates.length === 1 ? 0 : 0.75) * spread.hi;

  return {
    lowS: Math.max(FLOOR_S, videoSeconds * lo),
    highS: Math.max(FLOOR_S * 1.5, videoSeconds * hi),
    basis: rates.length,
    isFallback: false,
  };
}

/** "4 min", "90 sec", "1 hr 5 min" — never "0 min". */
export function humanDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${Math.max(5, Math.round(s / 5) * 5)} sec`;
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/**
 * The sentence the user reads.
 *
 * Three states, and the third is the one that matters. Once elapsed passes
 * the top of the range the estimate has been wrong, and the only honest thing
 * is to say so — not to freeze at "about a minute left" and keep saying it,
 * which is what makes progress UI untrustworthy. There is no countdown that
 * stops at zero here because there is no way to know.
 *
 * The overrun sentence also does not claim the run is alive. See the comment
 * on that branch: from the browser, a dead run and a slow one look identical,
 * and asserting the wrong one is the same failure as a fake percentage.
 */
export function etaSentence(eta: Eta | null, elapsedS: number): string {
  if (!eta) return "This usually takes a few minutes.";

  if (elapsedS > eta.highS) {
    // "It is still running" is a claim this code cannot back up. A run lives
    // in one Node process's event loop, so a deploy, a dev-server recompile
    // or an OOM ends it without ever marking the row failed — and from the
    // browser that is indistinguishable from a slow ball-detection stage,
    // because progress is only written on stage TRANSITIONS and that stage
    // can legitimately go minutes without one. Rather than pick a "went
    // quiet" threshold out of the air, say what is actually known: the
    // estimate has been passed, and there are two reasons it might have been.
    return `Past the usual ${humanDuration(eta.lowS)}–${humanDuration(eta.highS)} for a clip this length. `
      + `Hard-to-see balls do this — so does a server restart ending the run, which looks the same from here.`;
  }

  const remainLow = Math.max(0, eta.lowS - elapsedS);
  const remainHigh = Math.max(0, eta.highS - elapsedS);
  const range = remainLow < 30
    ? `under ${humanDuration(remainHigh)} left`
    : `about ${humanDuration(remainLow)}–${humanDuration(remainHigh)} left`;

  if (eta.isFallback) return `${range} — rough estimate, this box has not finished a clip yet.`;
  if (eta.basis === 1) return `${range}, based on your one previous clip.`;
  return `${range}, based on your last ${eta.basis} clips.`;
}
