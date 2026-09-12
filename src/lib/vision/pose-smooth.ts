/**
 * Take the snap out of the skeletons.
 *
 * THE BUG THIS FIXES. Every pose frame is estimated independently — nothing
 * in this pipeline ever compared a keypoint to the same keypoint a frame
 * earlier. So a single bad estimate is drawn at full amplitude, and what a
 * viewer sees is the whole skeleton jumping and snapping back. Ky reported it
 * as the skeletons glitching at ball contact, which is exactly where it would
 * be most visible:
 *
 *   - the pose BURSTS sample at 12-30fps around each contact, against 5fps
 *     elsewhere, so there are several times more frames there to go wrong;
 *   - contact is the hardest instant to estimate — maximum extension and
 *     maximum limb speed coincide, so the fastest-moving limb is also the most
 *     motion-blurred, the paddle reads as an extension of the forearm, and the
 *     arm is often pointed at or away from the camera.
 *
 * A 3-POINT MEDIAN, not an average and not an EMA. The failure mode here is a
 * single frame that is badly wrong while its neighbours are right, and the
 * median discards that outright — a mean would bend toward it and an EMA would
 * both bend toward it AND lag the real motion, which matters when the whole
 * point is to measure a third-of-a-second swing.
 *
 * ONLY WITHIN A BURST. This is the constraint that makes it safe. The 5fps
 * baseline puts samples 200ms apart, and a real swing happens BETWEEN two of
 * them — smoothing across that gap would not remove noise, it would erase
 * genuine motion and quietly corrupt the mechanics. So neighbours only count
 * when they are close enough in time that the body cannot have moved much,
 * which in practice means inside the high-rate bursts, where the glitching is.
 */
import type { PlayerPoseFrame, PoseKeypoint } from "./phase2-types";

/**
 * Samples further apart than this are not neighbours.
 *
 * 120ms sits above a 30fps burst (33ms) and a 12fps burst (83ms), and below
 * the 5fps baseline (200ms), so bursts smooth and the baseline is left alone.
 */
const MAX_NEIGHBOUR_GAP_S = 0.12;

/**
 * Keypoints below this are treated as absent rather than as a position.
 *
 * A low-confidence keypoint is the model saying it does not know, and feeding
 * that into a median lets a guess vote on the answer.
 */
const MIN_KEYPOINT_CONFIDENCE = 0.3;

function median3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/**
 * Smooth each player's keypoints against their immediate neighbours in time.
 *
 * Pure and order-independent: returns new frames, sorted by timestamp within
 * each player, and never mutates the input. Frames for different players never
 * influence each other.
 */
export function smoothPoseFrames(frames: PlayerPoseFrame[]): PlayerPoseFrame[] {
  const byPlayer = new Map<string, PlayerPoseFrame[]>();
  for (const f of frames) {
    const list = byPlayer.get(f.playerId);
    if (list) list.push(f);
    else byPlayer.set(f.playerId, [f]);
  }

  const out: PlayerPoseFrame[] = [];
  for (const list of byPlayer.values()) {
    const seq = [...list].sort((x, y) => x.timestampSeconds - y.timestampSeconds);
    for (let i = 0; i < seq.length; i++) {
      const cur = seq[i];
      const prev = seq[i - 1];
      const next = seq[i + 1];
      const usable = (o: PlayerPoseFrame | undefined): o is PlayerPoseFrame =>
        !!o && Math.abs(o.timestampSeconds - cur.timestampSeconds) <= MAX_NEIGHBOUR_GAP_S;

      // An edge frame, or one with no close neighbours, passes through
      // untouched. Inventing a smoothed value from one sample would be making
      // the data up.
      if (!usable(prev) || !usable(next)) {
        out.push(cur);
        continue;
      }

      const keypoints: PoseKeypoint[] = cur.keypoints.map((k) => {
        if ((k.confidence ?? 0) < MIN_KEYPOINT_CONFIDENCE || k.xNorm === null || k.yNorm === null) {
          return k;
        }
        const p = prev.keypoints.find((o) => o.name === k.name);
        const n = next.keypoints.find((o) => o.name === k.name);
        // Both neighbours must have this joint confidently, or there is no
        // majority to take and the current value stands.
        const pOk = p && (p.confidence ?? 0) >= MIN_KEYPOINT_CONFIDENCE
          && p.xNorm !== null && p.yNorm !== null;
        const nOk = n && (n.confidence ?? 0) >= MIN_KEYPOINT_CONFIDENCE
          && n.xNorm !== null && n.yNorm !== null;
        if (!pOk || !nOk) return k;
        return {
          ...k,
          xNorm: median3(p!.xNorm!, k.xNorm, n!.xNorm!),
          yNorm: median3(p!.yNorm!, k.yNorm, n!.yNorm!),
        };
      });
      out.push({ ...cur, keypoints });
    }
  }
  return out;
}
