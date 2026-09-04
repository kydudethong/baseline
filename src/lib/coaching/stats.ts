// Cross-analysis aggregation — the Practice/Home pages' data source.
// coaching_skill_ratings and coaching_observations are one-row-per-analysis
// (see 0005_coaching_layer.sql); this module is what turns "N analyses,
// each with their own ratings" into "one profile per skill, weighted
// toward your most recent games", the way a real coach tracking you over
// a season would. Named/pointed to directly in that migration's own
// comment.
//
// Both queries below select from coaching_skill_ratings/coaching_observations
// with NO explicit analysis_id filter — RLS (0005_coaching_layer.sql) already
// scopes every row to "an analysis this user owns" via a join to analyses,
// so an unfiltered select under the caller's session client already returns
// exactly (and only) this user's rows across every analysis. The explicit
// per-analysis metadata map below exists for recency ranking, not for
// authorization.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoachingObservationRow, CoachingSkillRatingRow, Database } from "@/lib/db/types";
import { SKILLS } from "./types";

type Client = SupabaseClient<Database>;

// Each analysis back in recency order counts for 80% of the next-most-recent
// one (rank 0 = newest -> weight 1.0, rank 1 -> 0.8, rank 2 -> 0.64, ...).
// Deliberately gentle: a real weakness that showed up in your last 3-4
// sessions should still outweigh a single very recent fluke observation.
const RECENCY_DECAY = 0.8;

function recencyWeight(rank: number): number {
  return Math.pow(RECENCY_DECAY, rank);
}

interface AnalysisMeta {
  id: string;
  title: string;
  createdAt: string;
  /** 0 = most recently completed analysis. */
  rank: number;
}

export async function completedAnalysisMeta(supabase: Client, userId: string): Promise<Map<string, AnalysisMeta>> {
  const { data, error } = await supabase
    .from("analyses")
    .select("id, title, created_at")
    .eq("user_id", userId)
    .eq("status", "completed")
    .order("created_at", { ascending: false });
  if (error) throw error;

  const map = new Map<string, AnalysisMeta>();
  (data ?? []).forEach((row, i) => {
    map.set(row.id, { id: row.id, title: row.title, createdAt: row.created_at, rank: i });
  });
  return map;
}

export interface SkillProfile {
  skillKey: string;
  name: string;
  group: string;
  /** Recency-weighted average of raw (1-5) across every analysis that rated this skill; null if never rated. */
  weightedAvg: number | null;
  analysesRated: number;
  /** Compares the two most recent ratings for this skill; null with fewer than 2. */
  trend: "up" | "down" | "flat" | null;
}

/** One entry per SKILLS key, always — callers don't need to guard for a missing skill, only for weightedAvg === null. */
export async function getSkillProfiles(
  supabase: Client,
  userId: string,
  precomputedMeta?: Map<string, AnalysisMeta>
): Promise<SkillProfile[]> {
  const metaById = precomputedMeta ?? (await completedAnalysisMeta(supabase, userId));
  const empty = (): SkillProfile[] =>
    SKILLS.map((s) => ({ skillKey: s.key, name: s.name, group: s.group, weightedAvg: null, analysesRated: 0, trend: null }));
  if (metaById.size === 0) return empty();

  const { data, error } = await supabase.from("coaching_skill_ratings").select("*");
  if (error) throw error;
  const rows = (data as CoachingSkillRatingRow[] | null) ?? [];

  const bySkill = new Map<string, Array<{ raw: number; rank: number }>>();
  for (const row of rows) {
    const meta = metaById.get(row.analysis_id);
    if (!meta) continue; // rating belongs to an analysis that isn't "completed" (or was deleted) -- skip
    const list = bySkill.get(row.skill_key) ?? [];
    list.push({ raw: row.raw, rank: meta.rank });
    bySkill.set(row.skill_key, list);
  }

  return SKILLS.map((s) => {
    const ratings = (bySkill.get(s.key) ?? []).sort((a, b) => a.rank - b.rank);
    if (ratings.length === 0) {
      return { skillKey: s.key, name: s.name, group: s.group, weightedAvg: null, analysesRated: 0, trend: null };
    }
    let weightedSum = 0;
    let weightTotal = 0;
    for (const r of ratings) {
      const w = recencyWeight(r.rank);
      weightedSum += r.raw * w;
      weightTotal += w;
    }
    const weightedAvg = Math.round((weightedSum / weightTotal) * 100) / 100;

    let trend: SkillProfile["trend"] = null;
    if (ratings.length >= 2) {
      const diff = ratings[0].raw - ratings[1].raw;
      trend = diff > 0.3 ? "up" : diff < -0.3 ? "down" : "flat";
    }

    return { skillKey: s.key, name: s.name, group: s.group, weightedAvg, analysesRated: ratings.length, trend };
  });
}

export interface RankedObservation {
  skillKey: string;
  name: string;
  group: string;
  /** How many non-dismissed observations of this valence exist for this skill, across all analyses. */
  occurrences: number;
  /** Severity + recency weighted score. Only meaningful for sorting -- not shown to the user as a number. */
  weight: number;
  mostRecent: { title: string; detail: string; analysisId: string; analysisTitle: string; createdAt: string };
}

async function rankedObservations(
  supabase: Client,
  userId: string,
  valence: "weakness" | "strength",
  limit: number,
  precomputedMeta?: Map<string, AnalysisMeta>
): Promise<RankedObservation[]> {
  const metaById = precomputedMeta ?? (await completedAnalysisMeta(supabase, userId));
  if (metaById.size === 0) return [];

  const { data, error } = await supabase
    .from("coaching_observations")
    .select("*")
    .eq("valence", valence)
    .eq("dismissed", false);
  if (error) throw error;
  const rows = (data as CoachingObservationRow[] | null) ?? [];

  interface Acc {
    weight: number;
    occurrences: number;
    mostRecentRow: CoachingObservationRow;
    mostRecentRank: number;
  }
  const bySkill = new Map<string, Acc>();

  for (const row of rows) {
    const meta = metaById.get(row.analysis_id);
    if (!meta) continue;
    const w = recencyWeight(meta.rank) * (row.severity / 5);
    const existing = bySkill.get(row.skill_key);
    if (!existing) {
      bySkill.set(row.skill_key, { weight: w, occurrences: 1, mostRecentRow: row, mostRecentRank: meta.rank });
    } else {
      existing.weight += w;
      existing.occurrences += 1;
      if (meta.rank < existing.mostRecentRank) {
        existing.mostRecentRow = row;
        existing.mostRecentRank = meta.rank;
      }
    }
  }

  return [...bySkill.entries()]
    .map(([skillKey, acc]) => {
      const s = SKILLS.find((x) => x.key === skillKey);
      const meta = metaById.get(acc.mostRecentRow.analysis_id)!;
      return {
        skillKey,
        name: s?.name ?? skillKey,
        group: s?.group ?? "Other",
        occurrences: acc.occurrences,
        weight: acc.weight,
        mostRecent: {
          title: acc.mostRecentRow.title,
          detail: acc.mostRecentRow.detail,
          analysisId: acc.mostRecentRow.analysis_id,
          analysisTitle: meta.title,
          createdAt: meta.createdAt,
        },
      };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

/** Top weaknesses across every completed analysis, most severe/recent/recurring first. */
export function getRankedWeaknesses(
  supabase: Client,
  userId: string,
  limit = 6,
  precomputedMeta?: Map<string, AnalysisMeta>
): Promise<RankedObservation[]> {
  return rankedObservations(supabase, userId, "weakness", limit, precomputedMeta);
}

/** Top strengths across every completed analysis -- same ranking logic, positive framing. */
export function getTopStrengths(
  supabase: Client,
  userId: string,
  limit = 3,
  precomputedMeta?: Map<string, AnalysisMeta>
): Promise<RankedObservation[]> {
  return rankedObservations(supabase, userId, "strength", limit, precomputedMeta);
}
