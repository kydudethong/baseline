// Shared shapes for the coaching layer. Anything the coaching LLM produces
// lands in one of these before it reaches the database.
//
// Dimensions come in two tiers. The first three are supported by pose and
// movement alone. The rest — kitchen game, serve & return, offense, defense,
// shot selection — need shot types, which exist only when the ball was
// tracked (facts.ts's shot_summary). prompts.ts only offers the second tier
// to the coach when that data is present, so a clip without ball tracking
// never gets a "your third-shot drop..." observation it can't support.

export type Valence = "strength" | "weakness";

export type CoachingDimension =
  | "ready_position_split_step"
  | "paddle_position_proxy"
  | "footwork_court_movement"
  | "kitchen_game"
  | "serve_and_return"
  | "offense"
  | "defense"
  | "shot_selection";

export const BASE_COACHING_DIMENSIONS: CoachingDimension[] = [
  "ready_position_split_step",
  "paddle_position_proxy",
  "footwork_court_movement",
];

/** Only offered to the coach when shot types exist for the clip. */
export const SHOT_COACHING_DIMENSIONS: CoachingDimension[] = [
  "kitchen_game",
  "serve_and_return",
  "offense",
  "defense",
  "shot_selection",
];

export const COACHING_DIMENSIONS: CoachingDimension[] = [...BASE_COACHING_DIMENSIONS, ...SHOT_COACHING_DIMENSIONS];

export const COACHING_DIMENSION_LABELS: Record<CoachingDimension, string> = {
  ready_position_split_step: "Ready position & split step",
  paddle_position_proxy: "Paddle position (proxy)",
  footwork_court_movement: "Footwork & court movement",
  kitchen_game: "Kitchen game",
  serve_and_return: "Serve & return",
  offense: "Offense",
  defense: "Defense",
  shot_selection: "Shot selection",
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
