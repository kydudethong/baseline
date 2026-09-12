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
 * How many shots get the close look.
 *
 * A cap, because this is per-shot spend: ~4k tokens each, so a 40-shot game is
 * ~160k tokens and about twelve cents, while a long doubles session could run
 * to hundreds of shots without adding hundreds of shots' worth of insight. A
 * player acts on a handful of corrections, not on eighty.
 */
export const DEFAULT_MAX_SHOTS = 40;

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

const SCHEMA = {
  type: "object",
  properties: {
    striker_court: { type: "string", description: "near (closest to camera) / far / unclear" },
    stroke_visible: {
      type: "boolean",
      description: "True only if you can actually see the swing happen across several frames.",
    },
    paddle_face: { type: "string", description: "open / closed / neutral / cannot tell" },
    contact_height: { type: "string", description: "Relative to the striker's own body." },
    correction: { type: "string", description: "The single most useful change, in a coach's words." },
    confidence: { type: "string", description: "high / medium / low, and why." },
  },
  required: ["striker_court", "stroke_visible", "paddle_face", "contact_height",
             "correction", "confidence"],
};

function promptFor(tSeconds: number, playerLabel: string | null): string {
  return (
    "You are watching a short, high-frame-rate window of a pickleball point containing one stroke"
    + (playerLabel ? `, played by ${playerLabel}` : "")
    + ` around ${tSeconds.toFixed(1)}s in the source video.\n\n`
    + "Describe ONLY what is visible in the frames you were given.\n"
    + "- If no stroke happens in this window — the players are between points, retrieving a ball, "
    + "or the point has already ended — set stroke_visible to false and say so. That is a correct "
    + "and useful answer, not a failure.\n"
    + "- If the striker is in the far court they will be small in frame. Judge what you can and say "
    + "in `confidence` that distance limited it. Do not refuse, and do not overstate.\n"
    + "- `correction` must be something the player could actually do differently next time, phrased "
    + "the way a coach standing courtside would say it. Not a description of what happened."
  );
}

/**
 * Read technique for each shot, one short clip at a time.
 *
 * A FAILED SHOT IS SKIPPED, NOT FATAL. These are independent looks at
 * independent moments, and losing one to a timeout or a malformed response is
 * worth far less than losing the other thirty-nine. The caller gets what
 * succeeded plus a count of what did not.
 */
export async function readShotTechnique(opts: {
  model: string;
  file: UploadedFile;
  shots: Array<{ t: number; player?: string | null }>;
  durationSeconds: number;
  maxShots?: number;
  onLog?: (line: string) => void;
}): Promise<{ technique: ShotTechnique[]; failed: number }> {
  const max = opts.maxShots ?? DEFAULT_MAX_SHOTS;
  // Sorted by time so a truncated run covers the clip evenly rather than
  // stopping partway through in whatever order the model happened to answer.
  const shots = [...opts.shots]
    .filter((s) => Number.isFinite(s.t) && s.t >= 0 && s.t <= opts.durationSeconds)
    .sort((a, b) => a.t - b.t)
    .slice(0, max);

  const technique: ShotTechnique[] = [];
  let failed = 0;

  for (const shot of shots) {
    const clipStartSeconds = Math.max(0, shot.t - CLIP_LEAD_S);
    const clipEndSeconds = Math.min(opts.durationSeconds, shot.t + CLIP_TRAIL_S);
    if (clipEndSeconds <= clipStartSeconds) continue;

    const video: VideoConfig = {
      fps: TECHNIQUE_FPS,
      startOffsetSeconds: Math.round(clipStartSeconds * 100) / 100,
      endOffsetSeconds: Math.round(clipEndSeconds * 100) / 100,
      mediaResolution: "high",
    };

    try {
      const out = await generateJSON<{
        striker_court?: string; stroke_visible?: boolean; paddle_face?: string;
        contact_height?: string; correction?: string; confidence?: string;
      }>({
        model: opts.model,
        file: opts.file,
        prompt: promptFor(shot.t, shot.player ?? null),
        schema: SCHEMA,
        video,
        maxOutputTokens: 2000,
      });
      technique.push({
        tSeconds: shot.t,
        strikerCourt: out.striker_court ?? null,
        strokeVisible: out.stroke_visible === true,
        paddleFace: out.paddle_face ?? null,
        contactHeight: out.contact_height ?? null,
        correction: out.correction ?? null,
        confidence: out.confidence ?? null,
        clipStartSeconds,
        clipEndSeconds,
      });
    } catch (err) {
      failed++;
      opts.onLog?.(`technique at ${shot.t.toFixed(1)}s failed: ${(err as Error).message.split("\n")[0]}`);
    }
  }

  const seen = technique.filter((t) => t.strokeVisible).length;
  opts.onLog?.(
    `technique: ${technique.length} shot(s) looked at, ${seen} with a visible stroke`
    + `${failed ? `, ${failed} failed` : ""}`
    + `${opts.shots.length > max ? ` (capped at ${max} of ${opts.shots.length})` : ""}`
  );
  return { technique, failed };
}
