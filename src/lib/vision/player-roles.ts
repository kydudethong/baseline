/**
 * What to call each player: You, Partner, Opponent 1, Opponent 2.
 *
 * "Player 3" is a tracker id leaking into the product. It tells the reader
 * nothing — they have to hold a mapping in their head while reading coaching
 * about four numbers — and it is actively misleading in doubles, where the
 * only distinction that matters is which side of the net someone is on.
 *
 * The ids stay exactly as they are underneath. This is a display layer, and
 * deliberately so: track ids are the join key between eleven tables, and
 * renaming them at the source would mean every stored row disagreed with every
 * other row written before the change.
 *
 * WHERE THE SIDE COMES FROM. `sideOf` is supplied by the caller rather than
 * computed here, because who is on which side is a court-geometry question
 * that positioning.ts already answers, and answering it twice is how two
 * answers start to differ. When no side is known — no calibrated court — the
 * function degrades to "You" plus the original ids rather than guessing, since
 * a confidently wrong "Partner" is worse than an honest "Player 2".
 */

export type PlayerRole = "self" | "partner" | "opponent" | "unknown";

export interface RoleAssignment {
  playerId: string;
  role: PlayerRole;
  /** What a person sees: "You", "Partner", "Opponent 1", "Opponent 2". */
  name: string;
}

/**
 * Assign display names to every tracked player.
 *
 * Opponents are numbered in a stable order (by id) rather than by anything
 * positional, because a positional number would swap the moment the two
 * opponents cross the court — and coaching that says "Opponent 1 is standing
 * too deep" must still mean the same person a rally later.
 */
export function assignRoles(
  playerIds: readonly string[],
  selfIds: readonly string[],
  sideOf: (playerId: string) => "near" | "far" | null
): RoleAssignment[] {
  const mine = new Set(selfIds.map(norm).filter(Boolean));
  const isSelf = (id: string) => mine.has(norm(id));

  // The subject's side defines "my side". Taken from the first tagged player
  // that has one: a real player can span several track labels after an
  // occlusion, and they are all on the same side of the net.
  const selfSide = playerIds.filter(isSelf).map(sideOf).find((s) => s !== null) ?? null;

  const ordered = [...playerIds].sort();
  let opponentN = 0;
  const out: RoleAssignment[] = [];

  for (const id of ordered) {
    if (isSelf(id)) {
      out.push({ playerId: id, role: "self", name: "You" });
      continue;
    }
    const side = sideOf(id);
    if (selfSide === null || side === null) {
      out.push({ playerId: id, role: "unknown", name: fallbackName(id) });
      continue;
    }
    if (side === selfSide) {
      out.push({ playerId: id, role: "partner", name: "Partner" });
    } else {
      opponentN += 1;
      out.push({ playerId: id, role: "opponent", name: `Opponent ${opponentN}` });
    }
  }

  // More than one player on your own side is a tracking artefact, not two
  // partners: doubles has exactly one. They are all named "Partner" rather
  // than "Partner 1" and "Partner 2", because numbering them would assert a
  // distinction the footage does not support.
  return out;
}

/** playerId -> display name, for the common case of a lookup. */
export function roleNameMap(assignments: readonly RoleAssignment[]): Map<string, string> {
  return new Map(assignments.map((a) => [a.playerId, a.name]));
}

/** "player_3" -> "Player 3". Only used when a side could not be determined. */
function fallbackName(playerId: string): string {
  const m = /^player_(\d+)$/.exec(playerId);
  return m ? `Player ${m[1]}` : playerId;
}

/** "Player 3", "player_3" and "PLAYER3" are the same player. */
function norm(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}
