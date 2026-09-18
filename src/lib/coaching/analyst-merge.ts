/**
 * Stitching several segment answers into one analysis.
 *
 * WHY SEGMENTS EXIST AT ALL. One pass at 10fps over the whole clip is what was
 * asked for and what a short clip gets literally -- a 2:18 game is one call.
 * But a frame at high media resolution is ~258 tokens, so 10fps is ~2,580
 * tokens per second of video and a 1M context holds a little under four
 * minutes. A 20-minute match cannot be one request at this frame rate; the
 * request does not degrade, it fails. So: the longest windows that fit,
 * stitched here.
 *
 * THE HARD PART IS RALLY NUMBERING. Each segment watches its own window and
 * numbers rallies from 1, because it has no idea another segment exists. Three
 * segments therefore all return a "rally 1", and the shots inside them all
 * point at rally_idx 1. Merging naively would collapse three different points
 * into one and attach twenty shots to it.
 *
 * So rallies are renumbered globally by start time, and shots are re-pointed
 * at the renumbered rally BY TIMESTAMP rather than by the index they came
 * with. Time is the only identifier that means the same thing in every
 * segment; an index means "first in my window", which is a different fact in
 * each one.
 */
import type { AnalystOutput } from "./analyst";

/** A rally that survived the merge, with its original segment recorded. */
type Rally = AnalystOutput["rallies"][number];
type Shot = AnalystOutput["shots"][number];

/**
 * Merge segment outputs into one, in clip order.
 *
 * `narrative` picks which segment's prose to keep when there is no synthesis
 * step -- the longest one, as a proxy for the one that saw the most play.
 * With a single segment (the common case) this is the identity function in
 * everything but name.
 */
export function mergeAnalystOutputs(
  parts: AnalystOutput[],
  clipSeconds?: number,
  onLog?: (line: string) => void
): AnalystOutput {
  const usable = parts.filter(Boolean);
  if (usable.length === 0) throw new Error("nothing to merge");

  const rallies = mergeRallies(usable, clipSeconds, onLog);
  if (usable.length === 1) {
    // Still passed through mergeRallies, because a single segment can and does
    // hallucinate past the end of the clip -- one run returned seven rallies
    // between 506s and 725s of a 446-second video. Returning the raw output
    // untouched let every one of those reach the page.
    return { ...usable[0], rallies, shots: repointShots(usable[0].shots ?? [], rallies) };
  }
  const shots = repointShots(usable.flatMap((p) => p.shots ?? []), rallies);

  // Observations reference rallies too, and by the same broken index. The ones
  // that name a shot time can be re-pointed the same way; the ones that name
  // only a rally index cannot be trusted across segments, so their rally is
  // cleared rather than guessed. A clip-wide observation is still useful; one
  // attached to the wrong point is worse than one attached to none.
  const observations = usable.flatMap((p) =>
    (p.observations ?? []).map((o) => ({
      ...o,
      rally_idx: o.shot_t !== null && o.shot_t !== undefined
        ? (rallyAt(rallies, o.shot_t)?.idx ?? null)
        : null,
    }))
  );

  const lead = [...usable].sort((a, b) => (b.rallies?.length ?? 0) - (a.rallies?.length ?? 0))[0];

  return {
    rallies,
    shots,
    observations,
    playstyle: lead.playstyle,
    // Ratings for the same skill from different segments are averaged rather
    // than last-one-wins: each is a real reading of a real stretch of play,
    // and "you were a 4 in the first ten minutes and a 2 in the last ten" is
    // most honestly a 3 until something is built that can say the better
    // thing.
    skills: mergeSkills(usable),
    coaching: lead.coaching,
    drills: dedupeBy(usable.flatMap((p) => p.drills ?? []), (d) => d.slug ?? d.name),
    data_gaps: usable.map((p) => p.data_gaps).filter(Boolean).join(" ") || null,
  };
}

/**
 * All rallies, in time order, renumbered from 1 — and only those that could
 * have happened.
 *
 * A rally past the end of the clip is not a rally. The audit already REPORTS
 * these, which is how they were found, but reporting is not removing: they
 * were still being stored, still numbered, still cited in coaching, and still
 * counted in "N rallies" on the page. A read that says "in rally 15, at 541
 * seconds" about a 446-second video is worse than one that says nothing,
 * because it is confidently checkable and wrong.
 *
 * Half a second of slack at the end, because a rally genuinely running to the
 * final frame can round past the duration by a hair.
 */
function mergeRallies(
  parts: AnalystOutput[],
  clipSeconds?: number,
  onLog?: (line: string) => void
): Rally[] {
  const limit = Number.isFinite(clipSeconds) && (clipSeconds ?? 0) > 0
    ? (clipSeconds as number) + 0.5
    : Infinity;

  const all = parts.flatMap((p) => p.rallies ?? []);
  const wellFormed = all.filter(
    (r) => Number.isFinite(r.start_s) && Number.isFinite(r.end_s) && r.end_s > r.start_s
  );
  const inClip = wellFormed.filter((r) => r.start_s >= -0.5 && r.end_s <= limit);

  // SAY WHAT WAS THROWN AWAY.
  //
  // "Why does it miss rallies" was unanswerable from the logs, because this
  // function silently discarded some and reported neither the count nor the
  // reason. The drops are deliberate -- a rally past the end of the clip is
  // not a rally -- but a deliberate drop nobody can see is indistinguishable
  // from a bug, and the honest failure mode of this guard is that a REAL
  // rally whose timestamp drifted gets binned with the invented ones.
  //
  // Only logged when something was actually dropped: a line that prints on
  // every healthy run is a line people learn to skim past.
  const malformed = all.length - wellFormed.length;
  const outOfClip = wellFormed.length - inClip.length;
  if (malformed > 0 || outOfClip > 0) {
    const bad = wellFormed
      .filter((r) => !(r.start_s >= -0.5 && r.end_s <= limit))
      .slice(0, 5)
      .map((r) => `${r.start_s.toFixed(0)}-${r.end_s.toFixed(0)}s`)
      .join(", ");
    onLog?.(
      `analyst: ${all.length} rallies returned, ${inClip.length} kept`
      + (malformed > 0 ? ` — ${malformed} malformed` : "")
      + (outOfClip > 0
          ? ` — ${outOfClip} outside the ${(clipSeconds ?? 0).toFixed(0)}s clip (${bad})`
          : "")
    );
  } else {
    onLog?.(`analyst: ${inClip.length} rallies, all inside the clip`);
  }

  return renumber(stitch(inClip.sort((a, b) => a.start_s - b.start_s), onLog));
}

/**
 * The shortest believable gap between two points, in seconds.
 *
 * Somebody has to retrieve the ball, walk back and serve. Matches the constant
 * the grounding audit uses to flag this same shape, because they are the same
 * claim about the sport -- and an audit that fires on our own merge output
 * would be reporting a bug rather than a finding.
 */
const MIN_GAP_BETWEEN_RALLIES_S = 1.5;

/**
 * Rejoin a point that was reported as two.
 *
 * SEGMENT BOUNDARIES CUT RALLIES IN HALF, and nothing put them back. A long
 * match is watched in segments; each call sees its own stretch and numbers
 * rallies from 1 with no idea another segment exists. A point straddling a
 * boundary therefore comes back as two rallies -- the first ending where the
 * footage ran out, the second starting mid-point -- and the merge sorted them,
 * renumbered them and shipped both. That is exactly "rallies are getting cut
 * short", plus a rally count inflated by one per boundary, and every
 * per-rally average wrong by the same amount.
 *
 * The rule is physical rather than positional: no two points can be under a
 * second and a half apart, because somebody has to fetch the ball and serve.
 * That catches the boundary case without needing to know where the boundaries
 * were, and it also repairs a rally the model split over a lull in play.
 *
 * end_reason is taken from the LATER half, because that is the one that saw
 * how the point actually ended; the earlier half's reason is "the footage
 * stopped", which is not a thing that happens in pickleball.
 */
function stitch(sorted: Rally[], onLog?: (line: string) => void): Rally[] {
  if (sorted.length < 2) return sorted;
  const out: Rally[] = [sorted[0]];
  let joined = 0;
  for (const cur of sorted.slice(1)) {
    const prev = out[out.length - 1];
    if (cur.start_s - prev.end_s < MIN_GAP_BETWEEN_RALLIES_S) {
      out[out.length - 1] = {
        ...prev,
        end_s: Math.max(prev.end_s, cur.end_s),
        end_reason: cur.end_reason || prev.end_reason,
        winner: cur.winner ?? prev.winner,
        // The lower of the two: a point reported in two halves was seen
        // clearly by neither call on its own.
        confidence: Math.min(prev.confidence ?? 1, cur.confidence ?? 1),
      };
      joined += 1;
    } else {
      out.push(cur);
    }
  }
  if (joined > 0) {
    onLog?.(
      `analyst: rejoined ${joined} rall${joined === 1 ? "y" : "ies"} reported in halves `
      + `(under ${MIN_GAP_BETWEEN_RALLIES_S}s apart — usually a segment boundary through the middle of a point)`
    );
  }
  return out;
}

function renumber(rallies: Rally[]): Rally[] {
  return rallies.map((r, i) => ({ ...r, idx: i + 1 }));
}

/**
 * Point every shot at the rally its timestamp falls inside.
 *
 * A shot that falls in no rally keeps a rally_idx of 0 rather than being
 * dropped: it is still a paddle contact that happened, it still counts toward
 * the contact total, and a between-points tap that the model reported is a
 * fact about the footage even if it belongs to no point.
 */
function repointShots(shots: Shot[], rallies: Rally[]): Shot[] {
  return shots
    .filter((s) => Number.isFinite(s.t))
    .sort((a, b) => a.t - b.t)
    .map((s) => ({ ...s, rally_idx: rallyAt(rallies, s.t)?.idx ?? 0 }));
}

function rallyAt(rallies: Rally[], t: number): Rally | null {
  return rallies.find((r) => t >= r.start_s && t <= r.end_s) ?? null;
}

function mergeSkills(parts: AnalystOutput[]): AnalystOutput["skills"] {
  const byKey = new Map<string, { total: number; n: number; basis: string[] }>();
  for (const p of parts) {
    for (const s of p.skills ?? []) {
      if (!s.skill_key || !Number.isFinite(s.rating)) continue;
      const cur = byKey.get(s.skill_key) ?? { total: 0, n: 0, basis: [] };
      cur.total += s.rating;
      cur.n += 1;
      if (s.basis && !cur.basis.includes(s.basis)) cur.basis.push(s.basis);
      byKey.set(s.skill_key, cur);
    }
  }
  return [...byKey.entries()].map(([skill_key, v]) => ({
    skill_key,
    rating: Math.round((v.total / v.n) * 10) / 10,
    basis: v.basis.join(" "),
  }));
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}
