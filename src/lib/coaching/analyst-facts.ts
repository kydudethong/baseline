/**
 * What the CV layer measured, in the shape the analyst wants.
 *
 * Replaces the per-rally assembly in facts.ts for the analyst path. That file
 * groups everything by rally -- which made sense when this app decided where
 * rallies were, and does not now that Gemini does. Worse, feeding our rally
 * grouping to the thing being asked to produce one is the failure Ky caught
 * in the overlay: it stops being a question.
 *
 * So this is deliberately FLAT. A list of contacts, each with when it
 * happened, who hit it, where from and to, and what the body did. No rally
 * numbers, no shot types, no side-of-net labels derived from our own
 * grouping.
 */

import type { AnalysisShotRow, BallTrackRow, MovementMetricRow } from "@/lib/db/types";
import type { AnalystInput, MeasuredContact } from "./analyst";

/**
 * Court positions are stored NORMALISED 0-1 with the near baseline at y=1
 * (shots.ts courtFrameFor "full"). A coach reads feet, and an earlier version
 * of the Python harness described the stored numbers as feet -- which would
 * have made every distance the model quoted wrong by a factor of twenty, in
 * prose confident enough that nobody would check.
 */
/**
 * Above this, the clip gets an explicit warning in the prompt.
 *
 * Ten minutes is not a cliff, it is where the risk starts being worth naming.
 * The audit catches a timestamp outside the clip either way -- this is the
 * cheaper half of the defence, aimed at preventing the mistake rather than
 * reporting it.
 */
const LONG_CLIP_WARN_S = 600;

const COURT_W_FT = 20;
const COURT_L_FT = 44;

export function toFeet(p: { x: number; y: number } | null | undefined):
  { x_ft: number; y_ft: number } | undefined {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return undefined;
  return {
    x_ft: Math.round(p.x * COURT_W_FT * 10) / 10,
    // Flipped so y grows AWAY from the camera: 0 at the near baseline, 22 at
    // the net, 44 at the far. That is how a person describes a court.
    y_ft: Math.round((1 - p.y) * COURT_L_FT * 10) / 10,
  };
}

/** Only the mechanics a coach can act on; the rest is our own bookkeeping. */
const COACHABLE_MECHANICS = new Set([
  "hand", "kneeAngleAtContactDeg", "kneeAngleMinDeg", "contactHeightTorsos",
  "contactReachShoulders", "backswingShoulders", "wristSpeedIntoContact",
  "followThroughShoulders", "shoulderRotationDeg",
]);

export function contactsFromShots(shots: AnalysisShotRow[]): MeasuredContact[] {
  return [...shots]
    .filter((s) => Number.isFinite(Number(s.timestamp_s)))
    .sort((a, b) => Number(a.timestamp_s) - Number(b.timestamp_s))
    .map((s) => {
      const mech = (s.mechanics ?? null) as Record<string, unknown> | null;
      const body: Record<string, number | string> = {};
      for (const [k, v] of Object.entries(mech ?? {})) {
        if (!COACHABLE_MECHANICS.has(k)) continue;
        if (typeof v === "number" && Number.isFinite(v)) {
          // Two decimals. A knee angle quoted to fourteen places invites the
          // model to write it out, and is false precision besides.
          body[k] = Math.round(v * 100) / 100;
        } else if (typeof v === "string") {
          body[k] = v;
        }
      }
      const contact: MeasuredContact = {
        t: Math.round(Number(s.timestamp_s) * 100) / 100,
        player: s.player_label ?? null,
      };
      const from = toFeet(s.hit_court as { x: number; y: number } | null);
      const to = toFeet(s.landing_court as { x: number; y: number } | null);
      if (from) contact.hit_from = from;
      if (to) contact.landed_at = to;
      if (s.speed_mps_approx !== null && s.speed_mps_approx !== undefined) {
        contact.speed_mps = Number(s.speed_mps_approx);
      }
      if (Object.keys(body).length) contact.body = body;
      return contact;
    });
}

export function buildAnalystInput(opts: {
  clipSeconds: number;
  subjectPlayerId: string | null;
  shots: AnalysisShotRow[];
  ballTrack: BallTrackRow | null;
  movement: MovementMetricRow[];
  courtConfidence: number | null;
  skillLevel: string | null;
  focusArea: string | null;
  drillCatalogue: Array<{ slug: string; name: string; skill: string }>;
  knownLimitations?: string[];
}): AnalystInput {
  const contacts = contactsFromShots(opts.shots);
  const limitations = [...(opts.knownLimitations ?? [])];

  // Said out loud rather than left for the model to infer from sparse data.
  // A coverage figure it cannot see is a caveat it cannot apply.
  const coverage = opts.ballTrack?.coverage ?? null;
  if (coverage !== null && coverage < 0.35) {
    limitations.push(
      `The ball was only visible in ${Math.round(coverage * 100)}% of frames, so contacts may be missing `
      + "entirely — a gap in the list is not evidence that nothing happened there."
    );
  }
  if (!contacts.some((c) => c.body)) {
    limitations.push(
      "No body measurements were taken on any contact, so nothing can be said about technique."
    );
  }
  // One call for the whole clip, deliberately -- chunking is not worth its
  // failure modes for clips of this length. But the model's known failure is
  // losing track of WHERE IT IS in a long video: on a 101-second clip run
  // unassisted it returned rallies at 119s and 131s. That gets likelier the
  // longer the footage, so say so rather than discovering it as coaching that
  // cites points which never happened.
  if (opts.clipSeconds > LONG_CLIP_WARN_S) {
    limitations.push(
      `This clip is ${Math.round(opts.clipSeconds / 60)} minutes long. Be especially careful that every `
      + `timestamp you report falls inside it; do not report anything after ${opts.clipSeconds.toFixed(0)}s.`
    );
  }
  if (!opts.subjectPlayerId) {
    limitations.push(
      "No player was identified as the subject, so coaching cannot be addressed to one person."
    );
  }

  return {
    clipSeconds: Math.round(opts.clipSeconds * 10) / 10,
    subjectPlayerId: opts.subjectPlayerId,
    ballCoverage: coverage,
    courtConfidence: opts.courtConfidence,
    contacts,
    skillLevel: opts.skillLevel,
    focusArea: opts.focusArea,
    drillCatalogue: opts.drillCatalogue,
    knownLimitations: limitations,
  };
}
