/**
 * Which parts of a clip are worth paying to watch closely.
 *
 * THE COST PROBLEM. At 10fps and high media resolution a second of video is
 * about 2,580 tokens. A 20-minute game is therefore ~3.6M tokens, and most of
 * those are spent on people walking to pick up a ball, arguing about the
 * score, and standing still between points. A recreational pickleball game is
 * somewhere around half dead time, and the model is currently charged full
 * price to watch all of it.
 *
 * THE FIX USES DATA THAT ALREADY EXISTS. The vision pipeline has already
 * tracked every player through the clip before any of this runs. Players move
 * fast during a rally and barely at all between points, so their own tracks
 * say where the play is -- for free, with no extra model call and no extra
 * token. This is NOT rally segmentation coming back: it does not decide where
 * rallies start or end and nothing downstream reads it as a rally. It decides
 * only where to POINT the expensive pass. Gemini still says what a rally is.
 *
 * That distinction matters because motion gating is wrong at the edges in ways
 * rally detection could not tolerate -- a slow dink exchange looks quiet, a
 * player jogging back for a ball looks busy. Hence generous padding, a low
 * threshold, and a floor on total coverage: the cost of including dead time is
 * a few cents, and the cost of cutting a rally in half is a wrong analysis.
 */

export interface MotionSample {
  timestampSeconds: number;
  /** Any monotonic position; the units cancel out because only change matters. */
  x: number;
  y: number;
}

export interface Window {
  startSeconds: number;
  endSeconds: number;
}

/**
 * Seconds of padding either side of a burst of movement.
 *
 * Asymmetric because points start with motion and end with stillness: the
 * serve is preceded by a stationary player who has to be in frame for the
 * model to see the serve happen, and the moment a point ENDS is the moment
 * people stop moving, so the tail needs less.
 */
export const PAD_BEFORE_S = 2.5;
export const PAD_AFTER_S = 1.5;

/**
 * Windows closer than this are merged rather than left as a sliver of a gap.
 *
 * EIGHT, RAISED FROM THREE, AND THE REASON IS THE DINK. A kitchen exchange is
 * four people planted at the line moving their hands: the paddle is busy and
 * the body is not, so the motion signal goes quiet in the MIDDLE of a rally
 * that is still very much being played. At three seconds a lull that long
 * split one rally into two windows and dropped the quiet part between them --
 * which is the single most likely way this file loses a real point, in the
 * one phase of the sport where most points are decided.
 *
 * The cost of being wrong the other way is a few seconds of someone walking.
 */
export const MERGE_GAP_S = 8;

/** A window shorter than this cannot contain a rally worth analysing. */
export const MIN_WINDOW_S = 4;

/**
 * Never analyse less than this fraction of the clip, whatever the motion says.
 *
 * A guard against the failure that would be hardest to notice: tracking that
 * mostly failed produces almost no motion, which looks exactly like a clip
 * with almost no play, and the pass would quietly analyse thirty seconds of a
 * twenty-minute game and report confidently on it. Below this floor the gating
 * is not trusted and the whole clip is analysed.
 */
export const MIN_COVERAGE = 0.25;

/**
 * Time windows containing actual play.
 *
 * Returns the whole clip as one window when the tracks are too sparse to
 * judge, or when gating would cut below MIN_COVERAGE — in both cases the
 * honest answer is "I cannot tell where the play is", and the safe response to
 * that is to look everywhere.
 */
export function activeWindows(
  tracks: MotionSample[][],
  durationSeconds: number,
  /** `speedPercentile` is how far from the median toward the 90th the cut sits. */
  opts: { speedPercentile?: number } = {}
): { windows: Window[]; coverage: number; gated: boolean } {
  const whole = [{ startSeconds: 0, endSeconds: durationSeconds }];
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return { windows: [], coverage: 0, gated: false };
  }

  // Per-sample speed for every track, keyed by time.
  const speedAt = new Map<number, number>();
  for (const track of tracks) {
    const sorted = [...track].sort((a, b) => a.timestampSeconds - b.timestampSeconds);
    for (let i = 1; i < sorted.length; i++) {
      const dt = sorted[i].timestampSeconds - sorted[i - 1].timestampSeconds;
      if (dt <= 0) continue;
      const dx = sorted[i].x - sorted[i - 1].x;
      const dy = sorted[i].y - sorted[i - 1].y;
      const speed = Math.hypot(dx, dy) / dt;
      const t = sorted[i].timestampSeconds;
      // The FASTEST player at each instant, not the average: one player
      // sprinting is a rally even if the other three are waiting.
      speedAt.set(t, Math.max(speedAt.get(t) ?? 0, speed));
    }
  }
  if (speedAt.size < 10) return { windows: whole, coverage: 1, gated: false };

  // THE THRESHOLD IS RELATIVE TO THIS CLIP'S OWN SPREAD, not a percentile of
  // it, and that distinction is the whole correctness of this function.
  //
  // A percentile silently assumes a fixed proportion of the clip is busy: take
  // the 55th percentile of a game that is only 30% rallies and the threshold
  // lands among the stationary samples, so everything passes and nothing is
  // saved. Take it on a game that is 80% rallies and it cuts into real play.
  // The busy fraction is exactly the thing we do not know in advance.
  //
  // Speeds instead fall into two clumps -- standing about, and playing -- so
  // the threshold sits between them: a fraction of the way from the median to
  // the 90th percentile. Absolute numbers are no use either, because court
  // units per second mean different things at different camera distances.
  const speeds = [...speedAt.values()].sort((a, b) => a - b);
  const p50 = speeds[Math.floor(speeds.length * 0.5)];
  const p90 = speeds[Math.floor(speeds.length * 0.9)];

  // No clear separation between the clumps means there is no dead time to find
  // -- either the whole clip is play, or tracking is too noisy to tell. Both
  // answer the same way: analyse everything. Gating on a signal this weak is
  // how a pass quietly skips most of a match.
  if (!Number.isFinite(p90) || p90 <= 0 || p90 <= p50 * 2) {
    return { windows: whole, coverage: 1, gated: false };
  }
  const threshold = p50 + (p90 - p50) * (opts.speedPercentile ?? 0.35);

  const busy = [...speedAt.entries()]
    .filter(([, v]) => v >= threshold)
    .map(([t]) => t)
    .sort((a, b) => a - b);
  if (busy.length === 0) return { windows: whole, coverage: 1, gated: false };

  const merged: Window[] = [];
  for (const t of busy) {
    const start = Math.max(0, t - PAD_BEFORE_S);
    const end = Math.min(durationSeconds, t + PAD_AFTER_S);
    const last = merged[merged.length - 1];
    if (last && start - last.endSeconds <= MERGE_GAP_S) {
      last.endSeconds = Math.max(last.endSeconds, end);
    } else {
      merged.push({ startSeconds: start, endSeconds: end });
    }
  }

  const windows = merged
    .filter((w) => w.endSeconds - w.startSeconds >= MIN_WINDOW_S)
    .map((w) => ({
      startSeconds: Math.round(w.startSeconds * 100) / 100,
      endSeconds: Math.round(w.endSeconds * 100) / 100,
    }));

  const covered = windows.reduce((sum, w) => sum + (w.endSeconds - w.startSeconds), 0);
  const coverage = covered / durationSeconds;
  // Below the floor: almost certainly broken tracking rather than a game with
  // almost no play. Above 0.9: gating found nothing worth skipping, and one
  // window over the whole clip is simpler than nine that nearly touch.
  if (windows.length === 0 || coverage < MIN_COVERAGE || coverage > 0.9) {
    return { windows: whole, coverage: 1, gated: false };
  }
  return { windows, coverage: Math.round(coverage * 100) / 100, gated: true };
}
