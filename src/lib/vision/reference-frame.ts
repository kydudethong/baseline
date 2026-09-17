/**
 * The one frame that says who is who.
 *
 * WHAT REPLACED THE BOXES. The overlay used to carry a labelled box on every
 * player in every frame, and a gold one on the subject, so the coaching model
 * was told who it was coaching thirty times a second. Those labels came from
 * the pipeline's own identity tracking, which is sometimes wrong -- and a
 * wrong label is worse than no label, because coaching addressed to the wrong
 * body arrives sounding just as confident and the reader has no way to catch
 * it.
 *
 * So the video carries no identity at all now. Instead the player is shown ONE
 * still from their own clip, picks themselves out of it, and that still -- with
 * a mark on the person they picked -- is handed to the model alongside the
 * video. The model finds that person and follows them, which is what a human
 * watching would do and what the pipeline was pretending to do better.
 *
 * THIS MODULE EXISTS SO BOTH SIDES PICK THE SAME FRAME. The tag page shows the
 * frame and the coaching pass marks it, in different processes at different
 * times; if they chose independently the player would be tagging one moment
 * and the model would be shown another. Same function, same answer.
 */

/** The shape both callers have: a stored frame with a rendered image behind it. */
export interface ReferenceFrameCandidate {
  timestamp_s: number;
  debug_storage_path: string | null;
}

/** The shape of a stored track: points with a box and a timestamp. */
export interface ReferenceTrack {
  player_label: string;
  points: unknown;
}

export interface BoxAtTime {
  playerLabel: string;
  box: { x: number; y: number; width: number; height: number };
}

/**
 * How near in time a track point has to be to count as "in this frame".
 *
 * A twentieth of a second. Pose and tracks are sampled at VISION_FPS, which is
 * 5, so the nearest point to any rendered frame is at most a tenth of a second
 * away and usually exact. Loosening this would start drawing a player at where
 * they were two frames ago, which on a marked reference still is the one error
 * that matters: the mark has to land on the person, not near them.
 */
const MATCH_TOLERANCE_S = 0.05;

export function boxesAtTimestamp(tracks: ReferenceTrack[], timestampSeconds: number): BoxAtTime[] {
  const boxes: BoxAtTime[] = [];
  for (const t of tracks) {
    const points = (t.points ?? []) as Array<{
      timestampSeconds: number;
      boxImageNorm: { x: number; y: number; width: number; height: number };
    }>;
    if (!Array.isArray(points)) continue;
    const point = points.find((p) => Math.abs(p.timestampSeconds - timestampSeconds) < MATCH_TOLERANCE_S);
    if (point) boxes.push({ playerLabel: t.player_label, box: point.boxImageNorm });
  }
  return boxes;
}

export interface PickedReferenceFrame<F extends ReferenceFrameCandidate> {
  frame: F;
  index: number;
  boxes: BoxAtTime[];
}

/**
 * The frame where the most players are visible, nearest the middle of the clip.
 *
 * WHY THE FULLEST FRAME. With one frame to show, which frame it is stops being
 * cosmetic. A player hidden behind their partner gets no box, so they cannot be
 * tagged at all and the whole read has no subject; and a frame showing three of
 * four invites somebody to tag the wrong one of the three. Ranking by how many
 * of the roster are visible picks the moment where the question can actually be
 * answered.
 *
 * WHY THE MIDDLE BREAKS TIES. The ends of a clip are people walking on and
 * warming up, where the four on court may not yet be the four who play. The
 * middle is a point in progress.
 */
export function pickReferenceFrame<F extends ReferenceFrameCandidate>(
  frames: F[],
  tracks: ReferenceTrack[]
): PickedReferenceFrame<F> | null {
  const usable = frames.filter((f) => f.debug_storage_path);
  if (usable.length === 0) return null;
  const middle = (usable.length - 1) / 2;
  let best: PickedReferenceFrame<F> | null = null;
  let bestRank: [number, number] | null = null;
  usable.forEach((frame, index) => {
    const boxes = boxesAtTimestamp(tracks, frame.timestamp_s);
    const rank: [number, number] = [boxes.length, -Math.abs(index - middle)];
    if (!bestRank || rank[0] > bestRank[0] || (rank[0] === bestRank[0] && rank[1] > bestRank[1])) {
      bestRank = rank;
      best = { frame, index, boxes };
    }
  });
  return best;
}
