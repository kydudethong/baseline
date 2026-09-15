/**
 * Fold several track ids into one person.
 *
 * The tracker has no re-identification: every time it loses somebody behind
 * another player it picks them back up under a new id, so a fourteen-minute
 * doubles game comes back as sixteen tracks for four people. Something else
 * decides which ids belong together (identify-players.ts asks Gemini, which
 * can watch the whole clip and use hair, hat, shoes, build and what happened
 * in between). This applies that decision.
 *
 * Pure and synchronous, so the rule that matters can be tested without a video
 * or a model.
 */

import type { PlayerTrack } from "./phase2-types";

export interface MergeResult {
  tracks: PlayerTrack[];
  /** Kept id -> the ids folded into it, for the log. */
  merged: Map<string, string[]>;
  /** Ids a group claimed were one person while they were on court together. */
  rejected: Array<{ kept: string; dropped: string; reason: string }>;
}

/**
 * How much two tracks may overlap in time and still be called one person.
 *
 * A fifth of a second. Not zero, because the moment one fragment ends and the
 * next begins they can share a sampled frame -- the tracker's last sighting
 * and its first re-acquisition are genuinely the same instant. Anything longer
 * than that is two people.
 */
export const OVERLAP_TOLERANCE_S = 0.2;

function span(t: PlayerTrack): { from: number; to: number } {
  const ts = t.points.map((p) => p.timestampSeconds);
  return { from: Math.min(...ts), to: Math.max(...ts) };
}

function overlapSeconds(a: PlayerTrack, b: PlayerTrack): number {
  const sa = span(a), sb = span(b);
  return Math.min(sa.to, sb.to) - Math.max(sa.from, sb.from);
}

/**
 * Applies id groups to tracks.
 *
 * PHYSICS OUTRANKS THE MODEL, and this is the whole reason this is a separate
 * function with its own tests. A model watching a clip of four people in
 * similar kit will sometimes say two ids are one person, and if those two ids
 * were on court AT THE SAME TIME then they are definitively not -- nobody is
 * in two places at once. That is not a judgement call to be weighed against
 * the model's confidence; it is arithmetic, and it wins.
 *
 * A rejected member is left as its own track rather than dropped. The model
 * being wrong about one pairing is not a reason to lose a player.
 */
export function mergeTrackGroups(
  tracks: PlayerTrack[],
  groups: string[][]
): MergeResult {
  const byId = new Map(tracks.map((t) => [t.playerId, t]));
  const merged = new Map<string, string[]>();
  const rejected: MergeResult["rejected"] = [];
  const consumed = new Set<string>();

  for (const group of groups) {
    // Only ids we actually have, longest-lived first: the id somebody
    // recognises is the one that was on screen the most.
    const members = group
      .map((id) => byId.get(id))
      .filter((t): t is PlayerTrack => !!t && !consumed.has(t.playerId))
      .sort((a, b) => b.points.length - a.points.length);
    if (members.length < 2) continue;

    const keep = members[0];
    const folded: string[] = [];
    const accepted: PlayerTrack[] = [keep];

    for (const other of members.slice(1)) {
      const conflict = accepted.find((a) => overlapSeconds(a, other) > OVERLAP_TOLERANCE_S);
      if (conflict) {
        rejected.push({
          kept: conflict.playerId,
          dropped: other.playerId,
          reason: `on court at the same time for ${overlapSeconds(conflict, other).toFixed(1)}s`,
        });
        continue;
      }
      accepted.push(other);
      folded.push(other.playerId);
    }
    if (folded.length === 0) continue;

    keep.points = [...accepted.flatMap((t) => t.points)]
      .sort((a, b) => a.timestampSeconds - b.timestampSeconds);
    for (const id of folded) consumed.add(id);
    merged.set(keep.playerId, folded);
  }

  return { tracks: tracks.filter((t) => !consumed.has(t.playerId)), merged, rejected };
}
