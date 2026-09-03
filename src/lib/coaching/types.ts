// Shared shapes for the coaching layer. Anything the coaching LLM produces
// lands in one of these before it reaches the database.
//
// Ported from Baseline's original app with one deliberate change: the
// five-dimension USAPA-style framework there had two dimensions ("shot
// mechanics", "shot selection & strategy") that fundamentally depend on
// knowing shot type — drive vs. drop vs. dink. Rally IQ's CV pipeline
// cannot classify shot type (see facts.ts), so those two dimensions are not
// ported: silently relabeling them to something that *sounds* similar would
// misrepresent what this data can actually support. Only the three
// dimensions this pipeline's real signals bear on remain.

export type Valence = "strength" | "weakness";

export type CoachingDimension =
  | "ready_position_split_step"
  | "paddle_position_proxy"
  | "footwork_court_movement";

export const COACHING_DIMENSIONS: CoachingDimension[] = [
  "ready_position_split_step",
  "paddle_position_proxy",
  "footwork_court_movement",
];

export const COACHING_DIMENSION_LABELS: Record<CoachingDimension, string> = {
  ready_position_split_step: "Ready position & split step",
  paddle_position_proxy: "Paddle position (proxy)",
  footwork_court_movement: "Footwork & court movement",
};

export interface CoachingObservation {
  rally_idx: number | null;
  skill_key: string;
  coaching_dimension: CoachingDimension;
  valence: Valence;
  title: string;
  detail: string;
  severity: number;
}

/** Claude call 2's output — the tagged, per-skill records the app tracks over time. */
export interface CoachingTagging {
  headline: string;
  summary: string;
  observations: CoachingObservation[];
  skills: Array<{ skill_key: string; rating: number; basis: string }>;
  footage_quality: { usable: boolean; issues: string[] };
}

/** Claude call 1's output — the player-facing coaching read itself. */
export interface CoachingRead {
  strengths: string[];
  top_priority_fix: { issue: string; why_it_matters: string; evidence: string };
  secondary_observations: Array<{ issue: string; evidence: string }>;
  drill_recommendation: { name: string; target: string; reps_duration: string };
  data_gaps: string | null;
}

export const SKILLS: Array<{ key: string; name: string; group: string }> = [
  { key: "dinking", name: "Dinking", group: "Kitchen" },
  { key: "kitchen", name: "Kitchen game", group: "Kitchen" },
  { key: "hands", name: "Hand battles", group: "Kitchen" },
  { key: "volleys", name: "Volleys", group: "Kitchen" },
  { key: "resets", name: "Resets", group: "Defense" },
  { key: "defense", name: "Defense", group: "Defense" },
  { key: "transition", name: "Transition game", group: "Movement" },
  { key: "positioning", name: "Positioning", group: "Movement" },
  { key: "serve", name: "Serve", group: "Serve & return" },
  { key: "return", name: "Return", group: "Serve & return" },
  { key: "thirdshot", name: "Third shot", group: "Serve & return" },
  { key: "offense", name: "Offense", group: "Offense" },
  { key: "selection", name: "Shot selection", group: "Decisions" },
  { key: "iq", name: "Court IQ", group: "Decisions" },
  { key: "consistency", name: "Consistency", group: "Decisions" },
];

export const SKILL_KEYS = SKILLS.map((s) => s.key);

export function skillName(key: string): string {
  return SKILLS.find((s) => s.key === key)?.name ?? key;
}
