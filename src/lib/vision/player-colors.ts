// Shared player→color mapping so a given track keeps the same color
// everywhere it's drawn — the debug page's frame overlays and the
// self-tagging picker on the analysis page both need this, and using two
// separate mappings would mean the same player_1 box could be red on one
// page and purple on the other, undermining the whole point of a visual
// reference.

const PLAYER_COLORS: Record<string, string> = {
  player_1: "#ef4444",
  player_2: "#22c55e",
  player_3: "#3b82f6",
  player_4: "#eab308",
};
const FALLBACK_COLORS = ["#a855f7", "#06b6d4", "#f97316", "#ec4899", "#14b8a6", "#84cc16"];

export function colorForPlayer(playerId: string, index: number): string {
  return PLAYER_COLORS[playerId] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}
