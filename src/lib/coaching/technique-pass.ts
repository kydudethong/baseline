/**
 * Technique: high resolution, high frame rate, and ONLY where a swing is.
 *
 * THE ECONOMICS THIS EXISTS FOR. Gemini charges per frame by resolution tier,
 * so 10fps at high resolution is ~2,580 tokens for every second of footage it
 * is pointed at. Pointed at a whole 20-minute match that is ~3M tokens, and
 * the overwhelming majority of them buy nothing: the reader is judged on
 * fifteen swings, and a swing is under two seconds long. Roughly 27 seconds of
 * a 1,200-second match is being looked at for technique; the other 1,173 were
 * costing full price to establish, repeatedly, that nobody was mid-stroke.
 *
 * So the scan (analyst.ts) runs cheap and wide -- 5fps, low resolution -- and
 * answers where/when/who. This runs expensive and narrow on the windows around
 * the subject's own contacts, and answers what the body did. Same total
 * information, about a sixth of the bill.
 *
 * THE COST OF SPLITTING, stated. Two passes can disagree about when a shot
 * happened: this one finds its windows from the scan's timestamps, and if
 * those drift the burst lands beside the swing rather than on it. That is why
 * the windows are generous rather than tight, and why a burst covering several
 * nearby shots is preferred to one per shot -- a wide window absorbs drift,
 * and it is also cheaper than the sum of the narrow ones it replaces.
 */
import { generateJSON, type UploadedFile, type VideoConfig } from "./gemini";
import { mapWithConcurrency } from "./concurrency";
import { planSegmentsForWindows } from "./technique-segments";

/** Frames per second for the close look. 5fps cannot see a swing; 10 can. */
export const BURST_FPS = 10;

/**
 * The window around a contact.
 *
 * ASYMMETRIC BY MEASUREMENT. A swing is backswing -> contact -> follow-through,
 * so most of it happens BEFORE the ball is struck; a window centred on contact
 * misses the half that shows the preparation. The lead is also the drift
 * budget: a contact timestamp from the scan can be a few tenths late, and on
 * ky-720p a symmetric +/-0.5s window produced "the stroke was executed before
 * the clip started".
 */
export const LEAD_S = 1.2;
export const TRAIL_S = 0.6;

/**
 * Windows closer together than this are merged into one.
 *
 * Shots inside a rally are seconds apart, so merging is usually cheaper than
 * not: two 1.8s windows 2s apart cost 3.6s separately and 5.6s merged, but
 * merged they are ONE request rather than two, and a request has its own
 * prompt and answer to pay for. Past this gap the dead time between them
 * costs more than the saved round trip.
 */
export const MERGE_GAP_S = 4;

/** At most this many bursts, so one long rally-dense clip cannot run away. */
export const MAX_BURSTS = 6;

/** How many bursts are in flight at once. Each carries a lot of video. */
export const BURST_CONCURRENCY = 3;

export interface ShotTechnique {
  tSeconds: number;
  strokeVisible: boolean;
  paddleFace: string | null;
  contactHeight: string | null;
  /** Shoulders before contact: turned, square, opening early. */
  shoulderRotation: string | null;
  /** Stance and weight at contact: set, moving, reaching, off-balance. */
  footPosition: string | null;
  correction: string | null;
  confidence: string | null;
  clipStartSeconds: number;
  clipEndSeconds: number;
}

const SCHEMA = {
  type: "object",
  properties: {
    shots: {
      type: "array",
      items: {
        type: "object",
        properties: {
          t: { type: "number", description: "Seconds into the SOURCE video, not into this window." },
          stroke_visible: {
            type: "boolean",
            description: "True only if you can actually see the swing across several frames.",
          },
          paddle_face: { type: "string", nullable: true, description: "open / closed / neutral / cannot tell" },
          contact_height: { type: "string", nullable: true, description: "Relative to the striker's own body." },
          // THE BODY, not just the paddle. A late preparation shows in the
          // shoulders and the feet long before it shows at the contact, and
          // "your preparation is late" is unanswerable without them -- the
          // player has nothing to check it against and nothing to change.
          shoulder_rotation: {
            type: "string", nullable: true,
            description:
              "Shoulders in the frames BEFORE contact: already turned, still square, "
              + "opening early. Say 'cannot tell' rather than guessing from one frame.",
          },
          foot_position: {
            type: "string", nullable: true,
            description:
              "Stance and weight at contact: set and balanced, still moving, reaching, "
              + "off the back foot. 'cannot tell' if the feet are out of frame or blurred.",
          },
          correction: { type: "string", nullable: true, description: "The single most useful change, in a coach's words." },
          confidence: { type: "string", nullable: true, description: "high / medium / low, and why." },
        },
        required: ["t", "stroke_visible"],
      },
    },
    pattern: {
      type: "string",
      nullable: true,
      description:
        "One thing that held ACROSS these shots, which no single shot would show. "
        + "Null if nothing did — an invented pattern is worse than none.",
    },
  },
  required: ["shots"],
};

/**
 * Merge contact times into the windows worth watching closely.
 *
 * Exported and pure because it decides the entire cost of this pass, and its
 * failures (a window that misses its own shot, windows that overlap and bill
 * twice for the same second) are invisible in a screenshot.
 */
export function burstWindows(
  shotTimes: readonly number[],
  durationSeconds: number,
  maxBursts = MAX_BURSTS
): Array<{ startSeconds: number; endSeconds: number }> {
  const times = [...shotTimes]
    .filter((t) => Number.isFinite(t) && t >= 0 && t <= durationSeconds)
    .sort((a, b) => a - b);
  if (times.length === 0) return [];

  const merged: Array<{ startSeconds: number; endSeconds: number }> = [];
  for (const t of times) {
    const start = Math.max(0, t - LEAD_S);
    const end = Math.min(durationSeconds, t + TRAIL_S);
    const last = merged[merged.length - 1];
    if (last && start - last.endSeconds <= MERGE_GAP_S) {
      last.endSeconds = Math.max(last.endSeconds, end);
    } else {
      merged.push({ startSeconds: start, endSeconds: end });
    }
  }

  if (merged.length <= maxBursts) return round(merged);
  // Over the cap: keep the windows covering the MOST shots, because a burst
  // over four contacts is worth four times one over a single stray shot, and
  // an evenly-spread selection would keep the sparse ones.
  const scored = merged
    .map((w) => ({ w, n: times.filter((t) => t >= w.startSeconds && t <= w.endSeconds).length }))
    .sort((a, b) => b.n - a.n)
    .slice(0, maxBursts)
    .map((x) => x.w)
    .sort((a, b) => a.startSeconds - b.startSeconds);
  return round(scored);
}

function round(ws: Array<{ startSeconds: number; endSeconds: number }>) {
  return ws.map((w) => ({
    startSeconds: Math.round(w.startSeconds * 100) / 100,
    endSeconds: Math.round(w.endSeconds * 100) / 100,
  }));
}

function promptFor(
  window: { startSeconds: number; endSeconds: number },
  shotTimes: number[],
  playerLabel: string | null
): string {
  return [
    `You are watching ${(window.endSeconds - window.startSeconds).toFixed(0)} seconds of a pickleball `
    + `match at ${BURST_FPS} frames per second and high resolution, covering `
    + `${window.startSeconds.toFixed(1)}s to ${window.endSeconds.toFixed(1)}s of the source video.`,
    "",
    playerLabel
      ? `Coach ONLY ${playerLabel}. Other players appear and are context; do not write technique for them.`
      : "Describe whoever is striking.",
    "",
    "Shots by that player were observed at roughly these times (SOURCE video seconds):",
    shotTimes.map((t) => `- ${t.toFixed(1)}s`).join("\n"),
    "",
    "Those timestamps came from a pass watching at 5 frames per second, so they can be off by a few",
    "tenths. Use them to find the stroke, then report `t` as the contact you actually observe. A time",
    "where you see no stroke should come back with stroke_visible false rather than being omitted.",
    "",
    "RULES",
    "- At this frame rate you CAN see the paddle, the backswing, the contact and the follow-through.",
    "- Describe the BODY as well as the paddle: where the shoulders were before contact, and what",
    "  the feet were doing at it. Those two are the evidence behind almost every correction worth",
    "  making, and a correction the player cannot check against their own footage is one they are",
    "  entitled to ignore.",
    "  Describe them. Do not describe spin or where on the face contact was made — those are not",
    "  visible from this camera angle at any frame rate.",
    "- A player in the far court is small in frame. Judge what you can, say in `confidence` that",
    "  distance limited it, and neither refuse nor overstate.",
    "- `correction` must be something they could do differently next time, phrased the way a coach",
    "  standing courtside would say it. Not a description of what happened.",
    "- `t` is seconds into the SOURCE video. Do not restart at zero for this window.",
  ].join("\n");
}

/**
 * Read technique for the subject's shots. Never throws.
 *
 * A missing technique note is a missing nice-to-have: the rallies, ratings,
 * coaching and drills are all written by the time this runs, and losing them
 * to a failure in an enrichment would be a bad trade.
 */
export async function readTechnique(opts: {
  model: string;
  file: UploadedFile;
  /** Contact times for the tagged player only. */
  shotTimes: number[];
  durationSeconds: number;
  playerLabel?: string | null;
  onLog?: (line: string) => void;
}): Promise<{ technique: ShotTechnique[]; patterns: string[]; failed: number }> {
  const windows = burstWindows(opts.shotTimes, opts.durationSeconds);
  if (windows.length === 0) {
    opts.onLog?.("technique: no shots by the tagged player to look at");
    return { technique: [], patterns: [], failed: 0 };
  }
  const segments = planSegmentsForWindows(windows, BURST_FPS);
  const watched = segments.reduce((s, w) => s + (w.endSeconds - w.startSeconds), 0);
  opts.onLog?.(
    `technique: ${segments.length} burst(s) covering ${watched.toFixed(0)}s of `
    + `${opts.durationSeconds.toFixed(0)}s at ${BURST_FPS}fps high resolution`
  );

  let failed = 0;
  const patterns: string[] = [];

  const settled = await mapWithConcurrency(segments, BURST_CONCURRENCY, async (w) => {
    const inWindow = opts.shotTimes.filter((t) => t >= w.startSeconds - LEAD_S && t <= w.endSeconds);
    const video: VideoConfig = {
      fps: BURST_FPS,
      startOffsetSeconds: w.startSeconds,
      endOffsetSeconds: w.endSeconds,
      mediaResolution: "high",
    };
    try {
      const out = await generateJSON<{
        shots?: Array<{
          t?: number; stroke_visible?: boolean; paddle_face?: string | null;
          shoulder_rotation?: string | null; foot_position?: string | null;
          contact_height?: string | null; correction?: string | null; confidence?: string | null;
        }>;
        pattern?: string | null;
      }>({
        model: opts.model,
        file: opts.file,
        prompt: promptFor(w, inWindow, opts.playerLabel ?? null),
        schema: SCHEMA,
        video,
        // Generous on purpose: thinking tokens count against this budget, and at
        // 4,000 three of six bursts came back as truncated JSON. Same reasoning
        // as the scan: thinking eats this budget before the
        // answer starts. A burst is short, so the allowance is mostly headroom
        // for reasoning rather than for output.
        maxOutputTokens: 24_000,
        label: `technique burst at ${w.startSeconds.toFixed(0)}s`,
      });
      if (out.pattern) patterns.push(out.pattern);
      return (out.shots ?? [])
        // A timestamp outside the window is the model losing its place, and a
        // technique note filed against a moment nothing watched is exactly the
        // ungrounded claim the audit exists to catch. Dropped, not clamped: a
        // wrong time is not repaired by moving it to the nearest edge.
        .filter((sh) => typeof sh.t === "number" && Number.isFinite(sh.t)
          && sh.t >= w.startSeconds - 0.5 && sh.t <= w.endSeconds + 0.5)
        .map((sh) => ({
          tSeconds: Math.round(sh.t! * 100) / 100,
          strokeVisible: sh.stroke_visible === true,
          paddleFace: sh.paddle_face ?? null,
          shoulderRotation: sh.shoulder_rotation ?? null,
          footPosition: sh.foot_position ?? null,
          contactHeight: sh.contact_height ?? null,
          correction: sh.correction ?? null,
          confidence: sh.confidence ?? null,
          clipStartSeconds: Math.max(w.startSeconds, sh.t! - LEAD_S),
          clipEndSeconds: Math.min(w.endSeconds, sh.t! + TRAIL_S),
        } satisfies ShotTechnique));
    } catch (err) {
      // Per burst: one window the model refused must not lose the others.
      failed++;
      opts.onLog?.(
        `technique burst ${w.startSeconds.toFixed(0)}-${w.endSeconds.toFixed(0)}s failed: `
        + `${(err as Error).message.split("\n")[0]}`
      );
      return [];
    }
  });

  const technique = settled.flat().sort((a, b) => a.tSeconds - b.tSeconds);
  const seen = technique.filter((t) => t.strokeVisible).length;
  opts.onLog?.(
    `technique: ${technique.length} shot(s) described, ${seen} with a visible stroke`
    + `${patterns.length ? `, ${patterns.length} pattern(s)` : ""}`
    + `${failed ? `, ${failed} burst(s) failed` : ""}`
  );
  return { technique, patterns, failed };
}
