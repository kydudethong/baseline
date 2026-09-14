/**
 * Pass two: look closely at each shot.
 *
 * Pass one watches the whole clip at 1 frame per second, which is enough to
 * find rallies and shots and far too little to judge a swing -- a pickleball
 * stroke is about a third of a second, so at 1fps the entire thing happens
 * between two frames. This pass goes back to each shot and re-watches one
 * short window at a high frame rate, which is the only configuration in which
 * the model can see a backswing, a contact and a follow-through at all.
 *
 * Measured on ky-720p, same second, same model:
 *   1fps  -> "only a single still frame is shown and no stroke is visible"
 *   15fps -> paddle open, contact at knee level, "bend the knees more to get
 *            down to the level of the low bounce rather than swinging
 *            predominantly with the arm from an upright posture", high
 *            confidence, citing backswing / bounce / contact / follow-through.
 */
import { mapWithConcurrency } from "./concurrency";
import { planSegments, maxSegmentSeconds, isSampled } from "./technique-segments";
import { generateJSON, type UploadedFile, type VideoConfig } from "./gemini";

/**
 * The window around a contact, in seconds.
 *
 * ASYMMETRIC BY MEASUREMENT, not by taste. A swing is backswing -> contact ->
 * follow-through, so most of it happens BEFORE the moment the ball is struck;
 * a window centred on contact misses the half that shows the preparation. And
 * a contact timestamp can be late: a +/-0.5s window on ky-720p produced "the
 * stroke was executed before the clip started", which a longer lead absorbs.
 */
export const CLIP_LEAD_S = 1.2;
export const CLIP_TRAIL_S = 0.6;

/** Frames per second for the close look. 1fps demonstrably cannot see a swing. */
export const TECHNIQUE_FPS = 15;

/**
 * How many of the subject's shots are pointed out to the model.
 *
 * This is no longer a cap on CALLS -- the segments are, and the model sees
 * every frame of a segment whether or not a shot in it is on this list. It is
 * a cap on how many timestamps we hand over as "look here", which keeps the
 * prompt short and the answer focused on a handful of corrections rather than
 * eighty. Shots beyond it still get watched; they just are not signposted.
 */
export const DEFAULT_MAX_SHOTS = 18;

/**
 * How many segment reads are in flight at once.
 *
 * Three, down from six, because a segment is not a shot. Each of these carries
 * up to 600k tokens of video rather than ~4k, so the limit that bites first is
 * tokens per minute, not requests per minute -- three in flight is already
 * nearly two million tokens of video in the air. There are also at most eight
 * segments, so a wider pool buys very little: eight over three lanes is three
 * rounds, and over six it is two.
 */
export const TECHNIQUE_CONCURRENCY = 3;

export interface ShotTechnique {
  tSeconds: number;
  strikerCourt: string | null;
  strokeVisible: boolean;
  paddleFace: string | null;
  contactHeight: string | null;
  correction: string | null;
  confidence: string | null;
  clipStartSeconds: number;
  clipEndSeconds: number;
}

/**
 * ONE ENTRY PER SHOT, in one answer.
 *
 * The per-shot version asked for a single object because each call saw a
 * single swing. A segment call sees several minutes of continuous play, so it
 * returns a list -- and gains the thing the per-shot version structurally
 * could not have: `pattern`, which is a statement across shots. "Your first
 * two drops cleared the net by a foot and the third clipped it" is only
 * sayable by something that watched all three.
 */
const SCHEMA = {
  type: "object",
  properties: {
    shots: {
      type: "array",
      items: {
        type: "object",
        properties: {
          t: { type: "number", description: "Seconds into the SOURCE video, not into this segment." },
          striker_court: { type: "string", description: "near (closest to camera) / far / unclear" },
          stroke_visible: {
            type: "boolean",
            description: "True only if you can actually see the swing happen across several frames.",
          },
          paddle_face: { type: "string", nullable: true, description: "open / closed / neutral / cannot tell" },
          contact_height: { type: "string", nullable: true, description: "Relative to the striker's own body." },
          correction: { type: "string", nullable: true, description: "The single most useful change, in a coach's words." },
          confidence: { type: "string", nullable: true, description: "high / medium / low, and why." },
        },
        required: ["t", "striker_court", "stroke_visible"],
      },
    },
    pattern: {
      type: "string",
      nullable: true,
      description:
        "One thing that held ACROSS the shots in this stretch, which no single shot would show. "
        + "Null if nothing did — an invented pattern is worse than none.",
    },
  },
  required: ["shots"],
};

function promptFor(
  segment: { startSeconds: number; endSeconds: number },
  shotTimes: number[],
  playerLabel: string | null
): string {
  return [
    `You are watching ${(segment.endSeconds - segment.startSeconds).toFixed(0)} seconds of a pickleball `
    + `match at a high frame rate, covering ${segment.startSeconds.toFixed(1)}s to `
    + `${segment.endSeconds.toFixed(1)}s of the source video.`,
    "",
    playerLabel
      ? `Coach ONLY ${playerLabel}. Other players appear and are context; do not write technique for them.`
      : "No single player was tagged, so describe whoever is striking.",
    "",
    shotTimes.length > 0
      ? "Shots by that player were observed at roughly these times (seconds into the SOURCE video):\n"
        + shotTimes.map((t) => `- ${t.toFixed(1)}s`).join("\n")
        + "\n\nReport one entry per shot you can actually see. These timestamps came from a pass that "
        + "watched at one frame per second, so they can be off by a few tenths — use them to find the "
        + "stroke, then report `t` as the moment of contact you actually observe. A time in this list "
        + "where you see no stroke should be returned with stroke_visible false rather than omitted."
      : "No shot times were supplied. Report every stroke by that player you can see in this stretch.",
    "",
    "RULES",
    "- Describe only what is visible in these frames. At this frame rate you CAN see the paddle, the",
    "  backswing, the contact and the follow-through — so paddle face and contact height are fair game",
    "  here, unlike the 1fps pass.",
    "- A player in the far court is small in frame. Judge what you can and say in `confidence` that",
    "  distance limited it. Do not refuse, and do not overstate.",
    "- `correction` must be something the player could do differently next time, phrased the way a",
    "  coach standing courtside would say it. Not a description of what happened.",
    "- `t` is seconds into the SOURCE video. Do not restart at zero for this segment.",
  ].join("\n");
}

export async function readShotTechnique(opts: {
  model: string;
  file: UploadedFile;
  shots: Array<{ t: number; player?: string | null }>;
  durationSeconds: number;
  /**
   * Which player labels are "you". Only this player's technique is coached --
   * the overlay legend says so in as many words -- so reading the other three
   * players' shots was work done to be thrown away.
   */
  subjectLabels?: string[];
  maxShots?: number;
  onLog?: (line: string) => void;
}): Promise<{ technique: ShotTechnique[]; patterns: string[]; failed: number }> {
  const max = opts.maxShots ?? DEFAULT_MAX_SHOTS;
  const mine = selectTechniqueShots(opts.shots, opts.durationSeconds, opts.subjectLabels ?? [], max);
  const segments = planSegments(opts.durationSeconds, TECHNIQUE_FPS);
  if (segments.length === 0) return { technique: [], patterns: [], failed: 0 };

  opts.onLog?.(
    `technique: ${segments.length} segment(s) of up to ${maxSegmentSeconds(TECHNIQUE_FPS)}s at `
    + `${TECHNIQUE_FPS}fps, ${mine.length} shot(s) to look for`
    + (isSampled(opts.durationSeconds, TECHNIQUE_FPS)
      ? " — clip too long to watch end to end at this frame rate, so segments are spread across it"
      : "")
  );

  let failed = 0;
  let done = 0;
  const patterns: string[] = [];

  const settled = await mapWithConcurrency(segments, TECHNIQUE_CONCURRENCY, async (segment) => {
    const video: VideoConfig = {
      fps: TECHNIQUE_FPS,
      startOffsetSeconds: segment.startSeconds,
      endOffsetSeconds: segment.endSeconds,
      mediaResolution: "high",
    };
    const inSegment = mine
      .filter((sh) => sh.t >= segment.startSeconds && sh.t <= segment.endSeconds)
      .map((sh) => sh.t);
    const label = opts.subjectLabels?.[0] ?? mine[0]?.player ?? null;

    try {
      const out = await generateJSON<{
        shots?: Array<{
          t?: number; striker_court?: string; stroke_visible?: boolean; paddle_face?: string | null;
          contact_height?: string | null; correction?: string | null; confidence?: string | null;
        }>;
        pattern?: string | null;
      }>({
        model: opts.model,
        file: opts.file,
        prompt: promptFor(segment, inSegment, label),
        schema: SCHEMA,
        video,
        // One entry per shot in several minutes of play, so the ceiling is far
        // higher than the per-shot version's 2k.
        maxOutputTokens: 8000,
      });

      done++;
      opts.onLog?.(`technique: ${done}/${segments.length} segment(s) read`);
      if (out.pattern) patterns.push(out.pattern);

      return (out.shots ?? [])
        // A timestamp outside the segment is the model losing its place, which
        // it does -- and a technique note filed against a moment that was not
        // watched is exactly the kind of ungrounded claim the audit exists to
        // catch. Dropped rather than clamped: a wrong time is not repairable
        // by moving it to the nearest edge.
        .filter((sh) => typeof sh.t === "number" && Number.isFinite(sh.t)
          && sh.t >= segment.startSeconds - 0.5 && sh.t <= segment.endSeconds + 0.5)
        .map((sh) => ({
          tSeconds: Math.round(sh.t! * 100) / 100,
          strikerCourt: sh.striker_court ?? null,
          strokeVisible: sh.stroke_visible === true,
          paddleFace: sh.paddle_face ?? null,
          contactHeight: sh.contact_height ?? null,
          correction: sh.correction ?? null,
          confidence: sh.confidence ?? null,
          // The clip a UI would play to show this note. Derived from the
          // reported contact rather than the segment: nobody wants to watch
          // two and a half minutes to see one swing.
          clipStartSeconds: Math.max(segment.startSeconds, sh.t! - CLIP_LEAD_S),
          clipEndSeconds: Math.min(segment.endSeconds, sh.t! + CLIP_TRAIL_S),
        } satisfies ShotTechnique));
    } catch (err) {
      // Swallowed per segment: one segment the model refused must not lose the
      // others. mapWithConcurrency rejects on a throwing mapper, which is right
      // for it and wrong here.
      failed++;
      done++;
      opts.onLog?.(
        `technique segment ${segment.startSeconds.toFixed(0)}-${segment.endSeconds.toFixed(0)}s failed: `
        + `${(err as Error).message.split("\n")[0]}`
      );
      return [];
    }
  });

  // Segment order is time order, so this is already sorted -- but a model can
  // return its own shots out of order within a segment, so sort anyway.
  const technique = settled.flat().sort((a, b) => a.tSeconds - b.tSeconds);
  const seen = technique.filter((t) => t.strokeVisible).length;
  opts.onLog?.(
    `technique: ${technique.length} shot(s) described, ${seen} with a visible stroke`
    + `${patterns.length ? `, ${patterns.length} cross-shot pattern(s)` : ""}`
    + `${failed ? `, ${failed} segment(s) failed` : ""}`
  );
  return { technique, patterns, failed };
}

/**
 * Which shots get a close look, and this is where most of the cost lives.
 *
 * TWO THINGS WERE WRONG. It took every shot the analyst returned -- in a
 * doubles clip that is four players' shots, and technique is only ever read
 * for one of them ("Only this player's technique should be coached; the others
 * are context", says the overlay legend the model is given). So roughly three
 * quarters of these calls were reading an opponent's swing, at 15fps and high
 * resolution, to store as this player's technique. That is not a speed
 * trade-off; storing a stranger's mechanics under your name is simply wrong.
 *
 * And the cap was `.slice(0, max)` -- the FIRST n shots, so on a long clip
 * every technique note came from the opening minutes and nothing from the rest.
 * An even spread across the clip is both faster and more representative.
 *
 * The subject filter falls back to all shots when nothing matches, rather than
 * returning none. Label formats have drifted before ("Player 3" vs "player_3"),
 * and the failure mode of a strict match is a silent empty technique pass,
 * which looks exactly like the model having nothing to say.
 */
export function selectTechniqueShots<T extends { t: number; player?: string | null }>(
  shots: readonly T[],
  durationSeconds: number,
  subjectLabels: readonly string[],
  max: number
): T[] {
  const inClip = shots
    .filter((s) => Number.isFinite(s.t) && s.t >= 0 && s.t <= durationSeconds)
    .sort((a, b) => a.t - b.t);

  const wanted = new Set(subjectLabels.map(normaliseLabel).filter(Boolean));
  const mine = wanted.size > 0
    ? inClip.filter((s) => s.player && wanted.has(normaliseLabel(s.player)))
    : [];
  const pool = mine.length > 0 ? mine : inClip;

  if (pool.length <= max || max <= 0) return pool;
  return evenSpread(pool, max);
}

/** "Player 3", "player_3" and "PLAYER3" are the same player. */
function normaliseLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** `count` items spread evenly across the list, first and last included. */
function evenSpread<T>(items: readonly T[], count: number): T[] {
  if (count === 1) return [items[0]];
  const out: T[] = [];
  for (let i = 0; i < count; i++) {
    out.push(items[Math.round((i * (items.length - 1)) / (count - 1))]);
  }
  // Rounding can land twice on the same index when count is close to length.
  return [...new Set(out)];
}
