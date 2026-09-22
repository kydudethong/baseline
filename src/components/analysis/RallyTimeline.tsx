"use client";

import type { ViewRally } from "@/lib/db/analysis-view";
import { secs } from "@/lib/format/duration";

/**
 * The rallies, as a scrollable rail.
 *
 * Each chip shows its real DURATION, because that is the one number that
 * distinguishes a scramble from a grind at a glance, and it is free.
 *
 * What it deliberately does NOT show by default is a verdict badge. The
 * backend can judge a rally, but on real footage most shots end with
 * outcome "unknown" — the ball is not tracked well enough to see where the
 * last one landed — so the model correctly answers "unknown" most of the
 * time. A row of grey question marks is worse than no column at all, so a
 * verdict appears only when it is BOTH known and confident enough to mean
 * something. Everything else is navigation, which is what this is for.
 */
const VERDICT_TONE: Record<string, string> = {
  won: "var(--good)",
  lost: "var(--bad)",
  unforced_error: "var(--warn)",
  neutral: "var(--ink-3)",
};

const VERDICT_WORD: Record<string, string> = {
  won: "won",
  lost: "lost",
  unforced_error: "unforced error",
  neutral: "neutral",
};

/** Below this the verdict is a guess wearing a badge. */
const VERDICT_MIN_CONFIDENCE = 0.5;

export function RallyTimeline({
  rallies, selectedIdx, onSelect,
}: {
  rallies: ViewRally[];
  selectedIdx: number | null;
  onSelect: (rally: ViewRally) => void;
}) {
  if (rallies.length === 0) return null;
  return (
    <div className="rrail" role="tablist" aria-label="Rallies">
      {rallies.map((r) => {
        const showVerdict =
          r.verdict !== null && r.verdict !== "unknown"
          && (r.verdictConfidence ?? 0) >= VERDICT_MIN_CONFIDENCE;
        return (
          <button
            key={r.idx}
            type="button"
            role="tab"
            aria-selected={selectedIdx === r.idx}
            className="rchip"
            onClick={() => onSelect(r)}
            title={showVerdict && r.verdictReason ? r.verdictReason : undefined}
          >
            <span className="rchip-n">Rally {r.idx}</span>
            <span className="rchip-d">{secs(r.durationS, r.durationS < 10 ? 1 : 0)}</span>
            <span className="rchip-s">
              {showVerdict ? (
                <>
                  <span className="rchip-v" style={{ background: VERDICT_TONE[r.verdict!] }} />
                  {" "}{VERDICT_WORD[r.verdict!]}
                </>
              ) : (
                `${r.shots.length || r.contactCount} shot${(r.shots.length || r.contactCount) === 1 ? "" : "s"}`
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
