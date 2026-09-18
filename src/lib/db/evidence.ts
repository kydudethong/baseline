/**
 * The evidence behind each coaching point, resolved for rendering.
 *
 * ON THE SERVER, because a clip in object storage is reached through a SIGNED
 * url with an expiry -- minting one in the browser would mean handing the
 * browser credentials for the bucket, which is not a trade worth making to
 * save a round trip.
 *
 * Never throws. Evidence is an addition to a coaching read: a read that shows
 * its claims without the clips is diminished, and a read that fails to render
 * because a bucket was slow is broken. So a failure here returns an empty map
 * and every insight falls back to stating its claim without the footage.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoachingObservationRow, CoachingShotTechniqueRow } from "./types";
import { evidenceClipUrl } from "@/lib/vision/debug-video-store";

export interface Evidence {
  /** The cut clip, when one exists. Preferred: it starts where it should. */
  clipUrl: string | null;
  /**
   * THE WHOLE SOURCE VIDEO, for when no clip was cut.
   *
   * The player windows it to startSeconds..endSeconds itself rather than
   * trusting a #t= media fragment, which several browsers ignore -- that is
   * exactly how a criticism ended up showing the entire twenty-minute film
   * and asking the reader to find the moment.
   *
   * It is the SOURCE, not the overlay, for the same reason the cut clips are:
   * a player checking a claim about their own swing should be looking at
   * themselves, not at a wireframe.
   */
  fallbackUrl: string | null;
  /** Where the moment is, in seconds. Null when the observation names none. */
  startSeconds: number | null;
  /** Window the fallback plays, so it sections out rather than playing everything. */
  windowStartSeconds: number | null;
  windowEndSeconds: number | null;
  technique: CoachingShotTechniqueRow | null;
}

/** Matches evidence-clips.ts. The approach, and the follow-through. */
const LEAD_S = 2.0;
const TRAIL_S = 1.5;

/**
 * How near a technique read has to be to an observation's moment to be the
 * same moment.
 *
 * Half a second. The two numbers come from different passes -- the scan gives
 * the observation its timestamp, the burst pass gives the technique read its
 * own -- and a pickleball stroke lasts about a third of a second, so anything
 * further apart is a different shot. Attaching the wrong shot's mechanics to a
 * claim would be worse than attaching none: it is evidence that contradicts
 * the footage beside it.
 */
const MATCH_TOLERANCE_S = 0.5;

export async function evidenceForObservations(
  supabase: SupabaseClient,
  analysisId: string,
  observations: CoachingObservationRow[],
  /**
   * A playable url for the SOURCE video, for observations whose clip was
   * never cut. Optional: without it, a missing clip simply has no video.
   */
  sourceVideoUrl?: string | null
): Promise<Map<string, Evidence>> {
  const out = new Map<string, Evidence>();
  if (observations.length === 0) return out;

  // One url for the whole source, reused by every observation that needs it.
  const source = sourceVideoUrl ?? null;

  let technique: CoachingShotTechniqueRow[] = [];
  try {
    const { data, error } = await supabase
      .from("coaching_shot_technique")
      .select("*")
      .eq("analysis_id", analysisId);
    // 42P01 is "table does not exist" — the migration has not been run. Not an
    // error worth surfacing on a page that works fine without it.
    if (!error) technique = (data ?? []) as CoachingShotTechniqueRow[];
  } catch {
    // Same reasoning: no technique data is a quieter page, not a broken one.
  }

  const nearest = (t: number | null): CoachingShotTechniqueRow | null => {
    if (t === null || !Number.isFinite(t)) return null;
    let best: CoachingShotTechniqueRow | null = null;
    let bestDt = MATCH_TOLERANCE_S;
    for (const row of technique) {
      const dt = Math.abs(Number(row.t_s) - t);
      if (dt <= bestDt) { bestDt = dt; best = row; }
    }
    // A window the model said held no stroke is not evidence of technique.
    // It is a correct and useful answer to a different question.
    return best?.stroke_visible ? best : null;
  };

  // Signed urls in parallel: each is a round trip to the bucket, and a dozen
  // of them in sequence is a visible pause on a page that is otherwise ready.
  const urls = await Promise.all(
    observations.map(async (o) => {
      try {
        return await evidenceClipUrl(o.clip_path ?? null, o.clip_bucket ?? null);
      } catch {
        return null;
      }
    })
  );

  // The rallies, for the observations whose moment was borrowed rather than
  // cited. A claim about a whole point is played as the whole point; a
  // shot-length window cut around an instant the model never named is what put
  // a serve under a sentence about kitchen exchanges.
  const rallyEnd = new Map<number, number>();
  try {
    const { data } = await supabase
      .from("coaching_rallies").select("idx, end_s").eq("analysis_id", analysisId);
    for (const r of (data ?? []) as Array<{ idx: number; end_s: number | null }>) {
      if (Number.isFinite(Number(r.end_s))) rallyEnd.set(r.idx, Number(r.end_s));
    }
  } catch {
    // Without them an approximate observation falls back to the shot-length
    // window, which is what it used to get. Worse, not broken.
  }

  observations.forEach((o, i) => {
    const t = o.t_s === null || !Number.isFinite(Number(o.t_s)) ? null : Number(o.t_s);
    const approxEnd = o.t_is_approx && o.rally_idx !== null ? rallyEnd.get(o.rally_idx) ?? null : null;
    // An approximate moment IS the rally's start, so the window runs from
    // there to the rally's end rather than backing up before it.
    const start = t === null ? null : approxEnd !== null ? t : Math.max(0, t - LEAD_S);
    const end = start === null
      ? null
      : approxEnd !== null ? approxEnd : start + LEAD_S + TRAIL_S;
    out.set(o.id, {
      clipUrl: urls[i],
      fallbackUrl: source,
      startSeconds: t,
      windowStartSeconds: start,
      windowEndSeconds: end,
      technique: approxEnd !== null ? null : nearest(t),
    });
  });
  return out;
}


