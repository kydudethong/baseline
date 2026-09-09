"use client";

import type { ViewRally, ViewShot } from "@/lib/db/analysis-view";
import { ShotBadge, shotName } from "./ShotBadge";
import { ConfidenceIndicator } from "./ConfidenceIndicator";

/**
 * A rally read top to bottom, the way somebody would describe it out loud:
 * serve, return, third-shot drop, dink, dink, speed-up, block.
 *
 * Clicking a shot seeks the video to that contact. The seek is the whole
 * point — a shot label the user cannot go and watch is a claim they have no
 * way to check, and this product's credibility rests on them being able to.
 */
export function ShotSequence({
  rally, selectedShot, onSelectShot,
}: {
  rally: ViewRally;
  selectedShot: ViewShot | null;
  onSelectShot: (shot: ViewShot) => void;
}) {
  if (rally.shots.length === 0) {
    return (
      <p className="sm">
        No shots were classified in this rally. The contacts were found but the
        ball was not tracked well enough between them to say what each shot was.
      </p>
    );
  }
  return (
    <div className="seq">
      {rally.shots.map((s, i) => {
        const selected = selectedShot?.t === s.t && selectedShot?.shotIdx === s.shotIdx;
        const last = i === rally.shots.length - 1;
        return (
          <div className="seq-row" key={`${s.rallyIdx}-${s.shotIdx}-${s.t}`} aria-selected={selected}>
            <div className="seq-line">
              <span className="seq-dot" />
              {!last ? <span className="seq-stem" /> : null}
            </div>
            <button type="button" className="seq-btn" onClick={() => onSelectShot(s)}>
              <div className="row g1" style={{ justifyContent: "space-between", gap: 8 }}>
                <span className="seq-name">{shotName(s.type)}</span>
                <span className="seq-t">{s.t.toFixed(1)}s</span>
              </div>
              <div className="seq-meta">
                {s.isSelf ? "You" : s.playerLabel ? "Opponent" : "Unattributed"}
                {s.hitZone !== "unknown" ? ` · from the ${s.hitZone}` : ""}
                {s.landingZone !== "unknown" ? ` · into the ${s.landingZone}` : ""}
                {s.speedMps !== null ? ` · ${s.speedMps.toFixed(1)} m/s` : ""}
              </div>
              <div className="row g1" style={{ marginTop: 4, gap: 6 }}>
                <ShotBadge shot={s} />
                <ConfidenceIndicator value={s.confidence} label="Shot classification" />
              </div>
            </button>
          </div>
        );
      })}
    </div>
  );
}
