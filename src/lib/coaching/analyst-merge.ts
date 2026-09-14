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
export function mergeAnalystOutputs(parts: AnalystOutput[]): AnalystOutput {
  const usable = parts.filter(Boolean);
  if (usable.length === 0) throw new Error("nothing to merge");
  if (usable.length === 1) return usable[0];

  const rallies = mergeRallies(usable);
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

/** All rallies, in time order, renumbered from 1. */
function mergeRallies(parts: AnalystOutput[]): Rally[] {
  return parts
    .flatMap((p) => p.rallies ?? [])
    .filter((r) => Number.isFinite(r.start_s) && Number.isFinite(r.end_s) && r.end_s > r.start_s)
    .sort((a, b) => a.start_s - b.start_s)
    .map((r, i) => ({ ...r, idx: i + 1 }));
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
