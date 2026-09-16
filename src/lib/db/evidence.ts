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
import type { AnalysisRow, CoachingObservationRow, CoachingShotTechniqueRow } from "./types";
import { debugVideoUrl, evidenceClipUrl } from "@/lib/vision/debug-video-store";

export interface Evidence {
  /** The cut clip, when one exists. Preferred: it starts where it should. */
  clipUrl: string | null;
  /**
   * The full overlay, seeked to this moment with a media fragment.
   *
   * THE REASON THERE IS A SECOND URL. A cut can fail, the cap can be hit, the
   * clip can have been cut before this analysis was re-run -- and every one of
   * those used to end in a paragraph apologising instead of a video. The
   * overlay is already rendered and already stored; #t=start,end costs nothing
   * and plays the same seconds. There is no reason for a criticism to have
   * nothing to show.
   *
   * Null only when the overlay itself failed to render, which the analysis
   * already reports as a known limitation.
   */
  fallbackUrl: string | null;
  /** Where to start playing, in seconds. Null when the observation names no moment at all. */
  startSeconds: number | null;
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
   * The analysis row, for the overlay fallback. Optional so the older callers
   * keep compiling; without it a missing clip has nothing to fall back to.
   */
  analysis?: Pick<AnalysisRow, "id" | "debug_video_path" | "debug_video_bucket">
): Promise<Map<string, Evidence>> {
  const out = new Map<string, Evidence>();
  if (observations.length === 0) return out;

  // One signed url for the whole overlay, reused by every observation that
  // needs it. Minting one per observation would be a dozen identical round
  // trips for a dozen identical files.
  let overlay: string | null = null;
  if (analysis) {
    try {
      overlay = await debugVideoUrl(analysis);
    } catch {
      // No overlay is a quieter page, not a broken one -- same as the rest.
    }
  }

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

  observations.forEach((o, i) => {
    const t = o.t_s === null || !Number.isFinite(Number(o.t_s)) ? null : Number(o.t_s);
    out.set(o.id, {
      clipUrl: urls[i],
      fallbackUrl: overlay && t !== null ? withFragment(overlay, t) : overlay,
      startSeconds: t,
      technique: nearest(t),
    });
  });
  return out;
}

/**
 * The overlay url, told to play the seconds around a moment.
 *
 * A media fragment rather than a JS seek, because the browser handles it
 * before the element is hydrated and it survives a reload and a shared link.
 * Appended after any existing query string -- a signed R2 url carries one, and
 * dropping it would turn a working video into a 403.
 */
function withFragment(url: string, t: number): string {
  const start = Math.max(0, t - LEAD_S).toFixed(2);
  const end = (Math.max(0, t - LEAD_S) + LEAD_S + TRAIL_S).toFixed(2);
  const base = url.split("#")[0];
  return `${base}#t=${start},${end}`;
}
