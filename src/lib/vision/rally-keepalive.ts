/**
 * Keep a rally open through kitchen play.
 *
 * Rallies currently start AND end on the same signal: net crossings. Starting
 * on them is right -- a serve and return clear the net unambiguously. Ending on
 * them is not, and the reason is geometric rather than a matter of tuning.
 *
 * To be assigned a side, the ball has to clear the WHOLE net: above the tape
 * for far, below the base for near, with everything between counted as behind
 * the net from this camera. But the camera sits behind the near baseline, so
 * the far kitchen images just above the tape and the near kitchen just below
 * the base. Both kitchens are squeezed into the band a dink never leaves. So
 * the moment a point settles into dinking the crossings stop, and three
 * seconds later the rally is declared over -- mid-point. A 25-second rally is
 * recorded as an 8-second one and everything after the drop is lost.
 *
 * The fix is to stop using one signal for two different questions. Crossings
 * still decide where a rally BEGINS. What keeps it alive is evidence that
 * people are still playing.
 *
 * Which evidence, though, is the whole design. Ball visibility is no good: the
 * ball is on screen between points too. Contacts alone are no good either --
 * Ky's original complaint was a player bouncing the ball on the floor being
 * counted as a rally, and bouncing produces contacts.
 *
 * What separates a dink exchange from anything that happens between points is
 * that a dink exchange ALTERNATES SIDES. Somebody hits, then somebody on the
 * other side hits. One player bouncing a ball, feeding, or knocking it back to
 * a server produces contacts on one side only, however many. So the rally
 * stays alive on alternating contacts and dies on repetition, which is the
 * same rule the rest of the pipeline already uses to decide a rally is real --
 * applied to continuing one rather than starting one.
 */
import type { ClusteredRally } from "./rallies";

export interface KeepAliveContact {
  t: number;
  /** Which side of the net the striker was on; null when it could not be told. */
  side: "near" | "far" | null;
}

export interface KeepAliveParams {
  /** No alternating contact for this long and the point is over. */
  quietS: number;
  /** Padding after the last alternating contact, matching the segmenter's tail. */
  tailS: number;
  /** A ceiling on how far one rally may be stretched, whatever the evidence. */
  maxExtendS: number;
}

export const KEEP_ALIVE_PARAMS: KeepAliveParams = {
  // Kitchen exchanges run at roughly one contact a second; 2.5s of nothing is
  // a dead ball, not a slow dink.
  quietS: 2.5,
  tailS: 1.0,
  // Even with contacts alternating forever, one rally is not 40 seconds long.
  // The cap is what stops a mis-attributed side turning two points into one.
  maxExtendS: 20,
};

export interface KeepAliveResult {
  rallies: ClusteredRally[];
  /** How many rallies were extended, and by how much in total. */
  extended: number;
  addedSeconds: number;
}

/**
 * Extend each rally for as long as contacts keep alternating sides.
 *
 * Never extends past the start of the following rally: two points that would
 * merge are left as two. A rally that reaches the next one is clamped short of
 * it rather than swallowing it, because a wrong merge destroys both.
 */
export function extendRalliesWhileLive(
  rallies: ClusteredRally[],
  contacts: KeepAliveContact[],
  durationSeconds: number,
  params: KeepAliveParams = KEEP_ALIVE_PARAMS
): KeepAliveResult {
  if (rallies.length === 0) return { rallies, extended: 0, addedSeconds: 0 };

  const ordered = [...contacts].sort((a, b) => a.t - b.t);
  const sorted = [...rallies].sort((a, b) => a.startS - b.startS);
  const out: ClusteredRally[] = [];
  let extended = 0;
  let addedSeconds = 0;

  for (let i = 0; i < sorted.length; i++) {
    const rally = sorted[i];
    const next = sorted[i + 1];
    // A rally may grow up to, but never into, the next one.
    const ceiling = Math.min(
      rally.endS + params.maxExtendS,
      durationSeconds,
      next ? next.startS - 0.05 : Infinity
    );

    // Seed the alternation from the last known side inside the rally, so the
    // first contact after the end is judged against who hit last, not against
    // nothing.
    let prevSide: "near" | "far" | null = null;
    for (const c of ordered) {
      if (c.t > rally.endS) break;
      if (c.t >= rally.startS && c.side) prevSide = c.side;
    }

    let aliveUntil = rally.endS;
    for (const c of ordered) {
      if (c.t <= rally.endS) continue;
      if (c.t > ceiling) break;
      // The gap is measured from the last thing that kept the rally ALIVE, not
      // from the last contact of any kind: a run of same-side contacts must not
      // hold a dead ball open.
      if (c.t - aliveUntil > params.quietS) break;
      if (!c.side) continue;
      if (prevSide && c.side !== prevSide) aliveUntil = c.t;
      prevSide = c.side;
    }

    // The tail belongs to the extension, not to every rally. Adding it
    // unconditionally would push out even rallies nothing kept alive, which is
    // a silent boundary change dressed up as keep-alive.
    const newEnd = aliveUntil > rally.endS
      ? Math.min(ceiling, aliveUntil + params.tailS)
      : rally.endS;
    if (newEnd > rally.endS + 1e-6) {
      extended += 1;
      addedSeconds += newEnd - rally.endS;
    }
    out.push({
      ...rally,
      endS: Math.round(newEnd * 1000) / 1000,
      contacts: ordered.filter((c) => c.t >= rally.startS && c.t <= newEnd).map((c) => c.t),
    });
  }

  return { rallies: out, extended, addedSeconds: Math.round(addedSeconds * 10) / 10 };
}

/**
 * On by default. It can only ever lengthen a rally, never create or shorten
 * one, and it is capped — so the failure mode of leaving it on is a rally a
 * few seconds too long, against the current failure of losing the entire
 * kitchen phase of every point.
 */
export function keepAliveEnabled(): boolean {
  const v = (process.env.RALLY_KEEP_ALIVE || "on").toLowerCase();
  return v !== "off" && v !== "0" && v !== "false";
}
