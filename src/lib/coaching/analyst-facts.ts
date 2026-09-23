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

/**
 * Only the mechanics a coach can act on; the rest is our own bookkeeping.
 *
 * THE SECOND GROUP IS WHY THIS LIST MATTERS. Every field in it is a number the
 * pose pass has been able to compute all along, and the coaching model was
 * being asked to estimate by eye instead -- "shoulders still square", "hitting
 * the ball behind you", "you never reset" were all impressions of a video. A
 * field that is not in this set does not reach the model, so leaving one out
 * is choosing to have it guessed.
 */
const COACHABLE_MECHANICS = new Set([
  "hand", "kneeAngleAtContactDeg", "kneeAngleMinDeg", "contactHeightTorsos",
  "contactReachShoulders", "backswingShoulders", "wristSpeedIntoContact",
  "followThroughShoulders", "shoulderRotationDeg",
  // Preparation and rotation.
  "shoulderTurnDeg", "hipShoulderSeparationDeg", "rotationLeadSeconds",
  // Contact point.
  "contactHeightRatio", "contactAheadShoulderWidths", "paddleElbowDeg",
  // Stance and balance.
  "stanceWidthRatio", "driftTowardNetTorsosPerSecond",
  // Ready position between shots.
  "readyPaddleHeightRatio", "readyKneeFlexionDeg", "resetSeconds",
]);

/**
 * The half of the court the subject spent their time in, or null.
 *
 * Reads `movement_metrics.positioning`, which the vision pass writes per
 * player when the court was calibrated. Null when there was no court, when the
 * subject has no row, or when their labels disagree about which half they were
 * in -- that last case is the tracker having swapped them with somebody, and a
 * side derived from a swap is exactly the wrong thing to hand a coach.
 */
export function subjectSide(
  movement: Array<{ player_label: string; positioning: unknown }>,
  subjectPlayerId: string | null,
): "near" | "far" | null {
  if (!subjectPlayerId) return null;
  const labels = new Set(subjectPlayerId.split(",").map((l) => l.trim()).filter(Boolean));
  const sides = new Set<string>();
  for (const row of movement) {
    if (!labels.has(row.player_label)) continue;
    const side = (row.positioning as { side?: unknown } | null)?.side;
    if (side === "near" || side === "far") sides.add(side);
  }
  return sides.size === 1 ? ([...sides][0] as "near" | "far") : null;
}

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

/**
 * How many contacts are worth putting in front of the model.
 *
 * A twenty-minute game at four players produces several hundred wrist-speed
 * peaks, each with up to twenty body measurements, and the whole list would be
 * a large share of a prompt that is already paying for eight frames a second
 * of video. It would also be mostly irrelevant: the read is addressed to ONE
 * player, and an opponent's knee angle changes nothing anybody is told.
 */
const MAX_CONTACTS_IN_PROMPT = 240;

/**
 * The subject's contacts in full, everyone else's as bare timings.
 *
 * The opponents are not dropped outright, because the RHYTHM of an exchange is
 * information the body measurements do not carry -- four contacts in two
 * seconds is a hands battle and the same four spread over eight is a dink
 * rally, and that context changes what a measurement means. What they do not
 * need is twenty joint angles each.
 *
 * When even the subject's own contacts overflow the budget, the list is
 * thinned EVENLY across the clip rather than truncated at the front. A
 * truncated list would hand back a detailed read of the first four minutes and
 * silence after it, which reads as "nothing happened later" rather than "we
 * stopped looking".
 */
function trimContacts(contacts: MeasuredContact[], subjectPlayerId: string | null): MeasuredContact[] {
  if (contacts.length <= MAX_CONTACTS_IN_PROMPT) return contacts;
  const subjectLabels = new Set(
    (subjectPlayerId ?? "").split(",").map((l) => l.trim()).filter(Boolean)
  );
  const isSubject = (c: MeasuredContact) => c.player !== null && subjectLabels.has(c.player);

  const mine = contacts.filter(isSubject);
  const theirs = contacts.filter((c) => !isSubject(c)).map((c) => ({ t: c.t, player: c.player }));

  const kept = mine.length > MAX_CONTACTS_IN_PROMPT ? thinEvenly(mine, MAX_CONTACTS_IN_PROMPT) : mine;
  const room = Math.max(0, MAX_CONTACTS_IN_PROMPT - kept.length);
  const others = theirs.length > room ? thinEvenly(theirs, room) : theirs;
  return [...kept, ...others].sort((a, b) => a.t - b.t);
}

/** Every nth item, so the survivors span the whole clip rather than its start. */
function thinEvenly<T>(xs: T[], n: number): T[] {
  if (n <= 0) return [];
  if (xs.length <= n) return xs;
  const step = xs.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.floor(i * step)]);
  return out;
}

export function buildAnalystInput(opts: {
  clipSeconds: number;
  subjectPlayerId: string | null;
  /** Track label of the partner, when one was tagged on the setup frame. */
  partnerPlayerId?: string | null;
  /** Whether a partner was TAPPED on the setup frame, matched to a track or not. */
  partnerTagged?: boolean;
  shots: AnalysisShotRow[];
  ballTrack: BallTrackRow | null;
  movement: MovementMetricRow[];
  courtConfidence: number | null;
  skillLevel: string | null;
  focusArea: string | null;
  drillCatalogue: Array<{ slug: string; name: string; skill: string }>;
  knownLimitations?: string[];
}): AnalystInput {
  const contacts = trimContacts(contactsFromShots(opts.shots), opts.subjectPlayerId);
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
      // NOT "nothing can be said about technique" any more. The second pass
      // re-watches each shot at 15fps and high resolution and reads technique
      // straight off the footage -- that is the whole reason it exists. What is
      // missing here is the numeric check on it, which is a different and much
      // smaller claim.
      "No body measurements were taken on any contact, so any technique note must come from watching the " +
        "footage rather than from a measured number, and cannot cite swing size, contact height or knee " +
        "bend as figures."
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
    partnerPlayerId: opts.partnerPlayerId ?? null,
    // The TAP, not the match. See AnalystInput.partnerTagged: the match can
    // fail on a frame where the tracker had nobody under the tap, and the
    // section was being switched off by that rather than by the user.
    partnerTagged: opts.partnerTagged ?? Boolean(opts.partnerPlayerId),
    // WHICH HALF, from the positioning pass rather than from the model's eye.
    // It is computed over the whole clip (see PlayerPositioning.side), so a
    // player who steps across the kitchen line for one frame does not change
    // sides -- and the two labels that mean "you" are merged first, because
    // the tracker hands the subject more than one when it loses them.
    subjectSide: subjectSide(opts.movement, opts.subjectPlayerId),
    ballCoverage: coverage,
    courtConfidence: opts.courtConfidence,
    contacts,
    skillLevel: opts.skillLevel,
    focusArea: opts.focusArea,
    drillCatalogue: opts.drillCatalogue,
    knownLimitations: limitations,
  };
}
