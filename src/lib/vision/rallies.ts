/**
 * Rally boundaries — from player motion in the video, purely. This app no
 * longer uses audio for anything (see ball.ts for the same call applied
 * to shot/contact timing): a rally is a stretch where at least one
 * tracked player is moving fast enough to be playing a point, not
 * standing around between them.
 *
 * This module used to also take a list of audio-detected paddle-contact
 * timestamps and use them two ways: (1) as the primary clustering signal
 * (audio-first, motion fallback) and (2) even in motion-only mode, to
 * stretch a rally's reported window to cover a contact just outside the
 * speed-threshold boundary — a serve before anyone's visibly moving yet,
 * or a put-away that lands before the opponent reacts. Both audio-specific
 * behaviors are gone now. What's left of (2): callers may still pass a
 * list of externally-computed contact timestamps (now ball-hit-derived,
 * see ball.ts's detectHits) purely to GROUP them by which rally they fall
 * inside — see `contactsToAttach` below — but that list no longer moves
 * startS/endS. A rally's first/last shot can occasionally sit slightly
 * outside [startS, endS] until this gets revisited; the fix would be to
 * re-stretch each window after hits are known, which callers that compute
 * hits per-rally already (run-vision-pipeline.ts) don't need at all.
 *
 * Used by both the coaching facts (facts.ts) and the vision pipeline (to
 * decide which windows of the clip are worth running the ball detector
 * over) — so the rallies the coach talks about and the rallies the ball
 * was tracked in are the same rallies.
 */

import { courtFrameFor, type CourtFrame } from "./shots";

export interface ClusteredRally {
  idx: number;
  startS: number;
  endS: number;
  /** Any externally-supplied contact timestamps that land inside [startS, endS]. Empty unless the caller passed contactsToAttach. */
  contacts: number[];
}

export interface MotionTrackPoint {
  timestampSeconds: number;
  boxImageNorm: { x: number; y: number; width: number; height: number };
  courtPosition: { x: number; y: number } | null;
}

export interface MotionTrack {
  playerId: string;
  points: MotionTrackPoint[];
}

export interface MotionClusterParams {
  /** Width of the smoothing bucket used to build the activity signal. */
  bucketS: number;
  /**
   * Minimum player speed to count a bucket as "in play", in court metres/
   * second — used whenever at least one tracked point has a calibrated
   * courtPosition. About a brisk shuffle-step; standing between points or
   * a slow reset reads well under this. Tune against real footage: if
   * rallies are coming out too short, lower it; if dead time between
   * points is being read as a rally, raise it.
   */
  activeSpeedCourt: number;
  /**
   * Same idea, in normalized image-box-widths/second — the fallback used
   * when court calibration isn't available for this clip. Image-space
   * speed isn't physically comparable across camera distances, so this
   * threshold is cruder than the court-space one; recalibrating the
   * camera setup (see the court calibration dialog) is the real fix if
   * this path is triggering often.
   */
  activeSpeedImage: number;
  /** Consecutive quiet buckets allowed inside one rally before it ends. */
  gapS: number;
  minDurationS: number;
  /** Padding added before/after the detected active window. */
  leadS: number;
  tailS: number;
}

export const MOTION_CLUSTER_PARAMS: MotionClusterParams = {
  bucketS: 0.5,
  activeSpeedCourt: 1.4,
  activeSpeedImage: 0.18,
  gapS: 1.5,
  minDurationS: 1.5,
  leadS: 0.8,
  tailS: 1.2,
};

/** A single lost-track frame gap (occlusion, missed detection) shouldn't
 * itself read as speed — anything wider than this is treated as "no
 * sample" rather than one huge (and fake) burst of motion. */
const MAX_SAMPLE_GAP_S = 2;

/**
 * How far outside a motion-detected rally's window to look for a ball
 * hit that really belongs to this rally -- the serve just before anyone
 * visibly sprints, or the put-away that lands before the opponent
 * reacts. This is the ball-track equivalent of what audio-contact
 * timestamps used to do (see the removed contactMarginS): find a real
 * contact just past the speed-threshold edge, then stretch the reported
 * window to actually cover it. See contactSearchWindows/restretchToHits
 * below -- callers with a ball track (run-vision-pipeline.ts,
 * recompute.ts) scan this wider slice for NEW hits; callers with only
 * already-known contact timestamps (facts.ts) just check which of those
 * fall in it.
 */
export const CONTACT_SEARCH_MARGIN_S = 1.5;

export interface ContactSearchWindow {
  idx: number;
  searchStartS: number;
  searchEndS: number;
}

/**
 * A wider window per rally to search for boundary-relevant contacts in --
 * never past the video's own bounds, and never past halfway to a
 * neighboring rally, so two adjacent rallies can't both claim the same
 * contact.
 */
export function contactSearchWindows(
  rallies: ClusteredRally[],
  durationSeconds: number,
  marginS: number = CONTACT_SEARCH_MARGIN_S
): ContactSearchWindow[] {
  return rallies.map((r, i) => {
    const prevEnd = i > 0 ? rallies[i - 1].endS : 0;
    const nextStart = i < rallies.length - 1 ? rallies[i + 1].startS : durationSeconds;
    const searchStartS = Math.max(0, prevEnd + (r.startS - prevEnd) / 2, r.startS - marginS);
    const searchEndS = Math.min(durationSeconds, r.endS + (nextStart - r.endS) / 2, r.endS + marginS);
    return { idx: r.idx, searchStartS, searchEndS };
  });
}

/**
 * Stretch a rally's reported [startS, endS] to cover any contact
 * timestamp found in its search window, the same way audio contacts used
 * to (see CONTACT_SEARCH_MARGIN_S above) -- leadS/tailS pad past the
 * outermost one exactly like they pad past the raw motion window. A
 * rally with no contact in its search window is returned unchanged.
 */
export function restretchToHits(
  rally: ClusteredRally,
  contactTimes: number[],
  window: ContactSearchWindow,
  leadS: number,
  tailS: number
): ClusteredRally {
  if (contactTimes.length === 0) return rally;
  const first = Math.min(...contactTimes);
  const last = Math.max(...contactTimes);
  const startS = Math.max(window.searchStartS, Math.min(rally.startS, first - leadS));
  const endS = Math.min(window.searchEndS, Math.max(rally.endS, last + tailS));
  return { ...rally, startS, endS };
}

/**
 * Rally boundaries from ball hits, not player speed. A hit is the
 * strongest evidence the app has that a rally is actually live (see
 * ball.ts detectHits -- it's a paddle actually turning the ball
 * sharply, at real speed, tracked visually). Player movement between
 * points is real but not a reliable "quiet" signal -- players routinely
 * walk briskly to retrieve the ball, switch sides, or reposition to
 * serve for several seconds after a point ends, which crosses any
 * speed threshold that also has to catch real rally movement. Grouping
 * hits directly sidesteps that: dead time between rallies has no hits
 * in it almost by definition, regardless of how much players are
 * moving around.
 *
 * This is the ball-track equivalent of the removed audio-contact
 * clustering (clusterRalliesWithContacts) -- same idea (group nearby
 * contact timestamps, pad the group into a window), but the contacts
 * are now self-detected from the ball's own trajectory instead of
 * supplied externally.
 */
export interface HitClusterParams {
  /** Max gap between two consecutive hits to count as the same rally, in seconds. */
  hitGapS: number;
  /** Padding added before the first hit / after the last hit in a group. */
  leadS: number;
  tailS: number;
}

export const HIT_CLUSTER_PARAMS: HitClusterParams = {
  // Tuned via scripts/eval-rallies.ts --search against all 3 labeled
  // clips at once (worst-clip F1 0.308 -> 0.348, every clip improved
  // individually) -- see shot-results/*/truth.json.
  hitGapS: 3,
  leadS: 1.5,
  tailS: 1.5,
};

export function clusterRalliesFromHits(
  hitTimes: number[],
  durationSeconds: number,
  params: HitClusterParams = HIT_CLUSTER_PARAMS
): ClusteredRally[] {
  if (hitTimes.length === 0) return [];
  const times = [...hitTimes].sort((a, b) => a - b);

  const groups: number[][] = [[times[0]]];
  for (let i = 1; i < times.length; i++) {
    const group = groups[groups.length - 1];
    const gap = times[i] - group[group.length - 1];
    if (gap > params.hitGapS) groups.push([times[i]]);
    else group.push(times[i]);
  }

  const rallies: ClusteredRally[] = [];
  for (const group of groups) {
    const startS = Math.max(0, group[0] - params.leadS);
    const endS = Math.min(durationSeconds, group[group.length - 1] + params.tailS);
    rallies.push({ idx: rallies.length + 1, startS, endS, contacts: group });
  }
  return rallies;
}

export function clusterRalliesFromMotion(
  tracks: MotionTrack[],
  durationSeconds: number,
  params: MotionClusterParams = MOTION_CLUSTER_PARAMS,
  quadKind: CourtFrame["kind"] | null = null,
  contactsToAttach: number[] = []
): ClusteredRally[] {
  if (durationSeconds <= 0) return [];

  const useCourt = tracks.some((t) => t.points.some((p) => p.courtPosition !== null));
  const threshold = useCourt ? params.activeSpeedCourt : params.activeSpeedImage;
  // courtPosition is a 0..1 UNIT of whatever quad got calibrated (see
  // court.ts) -- near-inplay/near-half/full are physically different
  // rectangles, so a raw unit-distance is not meters and isn't comparable
  // across quadKinds. courtFrameFor's metresX/metresY scale each axis to
  // real court meters before distance is computed, same conversion
  // shots.ts's metresBetween() uses for shot-landing distances.
  const courtFrame: CourtFrame = courtFrameFor(quadKind);

  const bucketCount = Math.max(1, Math.ceil(durationSeconds / params.bucketS));
  const activity = new Array<number>(bucketCount).fill(0);

  for (const track of tracks) {
    const pts = [...track.points].sort((a, b) => a.timestampSeconds - b.timestampSeconds);
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const curr = pts[i];
      const dt = curr.timestampSeconds - prev.timestampSeconds;
      if (dt <= 0 || dt > MAX_SAMPLE_GAP_S) continue;

      let dist: number;
      if (useCourt && curr.courtPosition && prev.courtPosition) {
        dist = Math.hypot(
          (curr.courtPosition.x - prev.courtPosition.x) * courtFrame.metresX,
          (curr.courtPosition.y - prev.courtPosition.y) * courtFrame.metresY
        );
      } else {
        const cx1 = prev.boxImageNorm.x + prev.boxImageNorm.width / 2;
        const cy1 = prev.boxImageNorm.y + prev.boxImageNorm.height / 2;
        const cx2 = curr.boxImageNorm.x + curr.boxImageNorm.width / 2;
        const cy2 = curr.boxImageNorm.y + curr.boxImageNorm.height / 2;
        dist = Math.hypot(cx2 - cx1, cy2 - cy1);
      }

      const speed = dist / dt;
      if (speed < threshold) continue;
      const bucket = Math.min(bucketCount - 1, Math.floor(curr.timestampSeconds / params.bucketS));
      activity[bucket] = Math.max(activity[bucket], speed);
    }
  }

  const activeBuckets: number[] = [];
  for (let i = 0; i < bucketCount; i++) if (activity[i] > 0) activeBuckets.push(i);
  if (activeBuckets.length === 0) return [];

  const groups: number[][] = [[activeBuckets[0]]];
  for (let i = 1; i < activeBuckets.length; i++) {
    const group = groups[groups.length - 1];
    const gapS = (activeBuckets[i] - group[group.length - 1]) * params.bucketS;
    if (gapS > params.gapS) groups.push([activeBuckets[i]]);
    else group.push(activeBuckets[i]);
  }

  const sortedContacts = [...contactsToAttach].sort((a, b) => a - b);
  const rallies: ClusteredRally[] = [];
  for (const group of groups) {
    const rawStartS = group[0] * params.bucketS;
    const rawEndS = (group[group.length - 1] + 1) * params.bucketS;
    const startS = Math.max(0, rawStartS - params.leadS);
    const endS = Math.min(durationSeconds, rawEndS + params.tailS);
    if (endS - startS < params.minDurationS) continue;
    const contacts = sortedContacts.filter((t) => t >= startS && t <= endS);
    rallies.push({ idx: rallies.length + 1, startS, endS, contacts });
  }
  return rallies;
}
