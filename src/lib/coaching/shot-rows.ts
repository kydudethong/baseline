/**
 * The analyst's shots, as analysis_shots rows.
 *
 * WHY THIS EXISTS. analysis_shots was filled by the CV shot classifier, which
 * was removed along with ball tracking. Nothing has written to it since, so
 * every downstream reader -- the shot table, the contact counts, the "0 shots"
 * on the scoreboard -- has been reading an empty table and reporting zero as
 * though it were a measurement. Gemini now reports a shot per contact, and it
 * fits the table that already exists, so this maps one to the other rather
 * than adding a parallel one.
 *
 * NO MIGRATION, deliberately. The vocabularies already match: SHOT_TYPES in
 * analyst.ts is the same fourteen values as the shot_type check constraint in
 * 0006_shots.sql, and landing_zone already allows kitchen/mid/deep/out/unknown.
 * The one thing this file must do is never emit a value outside those sets --
 * a check-constraint violation would fail the whole coaching write, so every
 * field is clamped to its vocabulary rather than passed through.
 */
import type { AnalysisShotRow } from "@/lib/db/types";

const CATEGORIES = new Set(["serve_return", "kitchen", "offense", "defense", "transition", "unknown"]);
const LANDING = new Set(["kitchen", "mid", "deep", "out", "unknown"]);
const HIT_ZONES = new Set(["kitchen", "transition", "back", "unknown"]);
const OUTCOMES = new Set(["in", "net", "out", "unknown"]);

/** Which broad phase of the point a shot type belongs to. */
const CATEGORY_OF: Record<string, string> = {
  serve: "serve_return", return: "serve_return",
  third_shot_drop: "transition", third_shot_drive: "transition", drop: "transition", reset: "transition",
  dink: "kitchen", volley: "kitchen", block: "defense",
  drive: "offense", speed_up: "offense", overhead: "offense",
  lob: "defense",
};

export interface AnalystShot {
  t: number;
  rally_idx: number;
  player: string;
  type: string;
  confidence: number;
  landing_depth?: string | null;
  landing_side?: string | null;
}

export type ShotInsert = Omit<AnalysisShotRow, "id" | "created_at"> & { id?: string; created_at?: string };

/**
 * One row per contact, numbered within its rally in time order.
 *
 * shot_idx is assigned here rather than taken from the model: it has to be
 * dense and ordered within a rally for the shot table to read as a sequence,
 * and a model numbering its own output will eventually skip one.
 */
export function shotRowsFromAnalyst(analysisId: string, shots: readonly AnalystShot[]): ShotInsert[] {
  const usable = shots
    .filter((s) => Number.isFinite(s.t) && s.t >= 0)
    .sort((a, b) => a.t - b.t);

  const perRally = new Map<number, number>();
  return usable.map((s) => {
    const rallyIdx = Number.isFinite(s.rally_idx) ? Math.max(0, Math.round(s.rally_idx)) : 0;
    const next = (perRally.get(rallyIdx) ?? 0);
    perRally.set(rallyIdx, next + 1);
    const type = s.type || "unknown";
    const landing = String(s.landing_depth ?? "").toLowerCase();
    return {
      analysis_id: analysisId,
      rally_idx: rallyIdx,
      shot_idx: next,
      timestamp_s: Math.round(s.t * 100) / 100,
      player_label: s.player || null,
      shot_type: type,
      category: clamp(CATEGORY_OF[type], CATEGORIES),
      // The model's confidence, clamped: the column rejects anything outside
      // 0-1 and a check violation would lose the whole coaching write.
      confidence: Math.max(0, Math.min(1, Number.isFinite(s.confidence) ? s.confidence : 0.5)),
      hit_court: null,
      // Not asked of the model. Where the HITTER stood is a different question
      // from where the ball landed, and inventing it from the shot type would
      // be a guess dressed as a measurement.
      hit_zone: clamp(undefined, HIT_ZONES),
      landing_court: null,
      // "net" is a real landing observation but not a value this column allows;
      // it becomes the outcome instead, which is where it belongs.
      landing_zone: clamp(landing === "net" ? "unknown" : landing, LANDING),
      speed_mps_approx: null,
      arc_norm: null,
      bounced_before: null,
      outcome: clamp(landing === "net" ? "net" : landing === "out" ? "out" : undefined, OUTCOMES),
      features: s.landing_side ? { landing_side: s.landing_side } : null,
      mechanics: null,
    } as ShotInsert;
  });
}

function clamp(value: string | undefined, allowed: Set<string>): string {
  return value && allowed.has(value) ? value : "unknown";
}
