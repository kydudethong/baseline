import type { ViewShot } from "@/lib/db/analysis-view";

/** Human names. The database stores snake_case; nobody says "third_shot_drop". */
export const SHOT_LABEL: Record<string, string> = {
  serve: "Serve",
  return: "Return",
  third_shot_drop: "Third-shot drop",
  third_shot_drive: "Third-shot drive",
  dink: "Dink",
  drop: "Drop",
  reset: "Reset",
  drive: "Drive",
  volley: "Volley",
  speed_up: "Speed-up",
  overhead: "Overhead",
  lob: "Lob",
  block: "Block",
  unknown: "Unclassified",
};

export function shotName(type: string): string {
  return SHOT_LABEL[type] ?? type.replace(/_/g, " ");
}

/**
 * A shot, named and toned by how it ended.
 *
 * Only `net` and `out` get a colour, because only those are unambiguously bad.
 * `in` and `unknown` stay neutral — and `unknown` is the common case on real
 * footage, so colouring it would tint most of the timeline on no evidence.
 */
export function ShotBadge({ shot }: { shot: ViewShot }) {
  const tone =
    shot.outcome === "out" ? " sbadge-out"
    : shot.outcome === "net" ? " sbadge-net"
    : shot.isSelf ? " sbadge-self" : "";
  return (
    <span className={`sbadge${tone}`}>
      {shotName(shot.type)}
      {shot.outcome === "out" || shot.outcome === "net" ? ` · ${shot.outcome}` : ""}
    </span>
  );
}
