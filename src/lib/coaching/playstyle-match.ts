import type { PlaystyleMatch } from "./pro-playstyles";

/**
 * The stored playstyle matches, or none.
 *
 * Read defensively because coaching_json is a text blob written by a previous
 * version of the pipeline as often as the current one: every read produced
 * before this feature existed has no `playstyle_match` key at all, and that is
 * a normal state rather than a corrupt row.
 */
export function playstyleMatches(coachingJson: string | null): PlaystyleMatch[] {
  if (!coachingJson) return [];
  try {
    const parsed = JSON.parse(coachingJson) as { playstyle_match?: PlaystyleMatch[] };
    return Array.isArray(parsed.playstyle_match) ? parsed.playstyle_match : [];
  } catch {
    return [];
  }
}
