import type { AnalysisShotRow, BallTrackRow } from "@/lib/db/types";
import { shotFromRow, summarizeShots, SHOT_LABEL, type Shot, type ShotType, type ShotCategory } from "@/lib/vision/shots";
import { playerDisplayName } from "@/lib/vision/player-colors";

const CATEGORY_LABEL: Record<ShotCategory, string> = {
  serve_return: "Serve & return",
  kitchen: "Kitchen",
  offense: "Offense",
  defense: "Defense",
  transition: "Transition",
  unknown: "Unclassified",
};

const TYPE_ORDER: ShotType[] = [
  "serve", "return", "third_shot_drop", "third_shot_drive", "dink", "volley", "speed_up", "drive",
  "overhead", "drop", "reset", "block", "lob", "unknown",
];

function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : "—";
}

function mmss(s: number): string {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/**
 * Shot mix and the rally-by-rally shot sequence, for the player and for
 * the rest of the court. Numbers here are the classifier's, with its
 * confidence shown rather than hidden: a pro wants to know "4 of 6 drops
 * landed" AND that the ball was seen 71% of the time.
 */
export function ShotsPanel({
  shots,
  ballTrack,
  selfLabels,
}: {
  shots: AnalysisShotRow[];
  ballTrack: BallTrackRow | null;
  selfLabels: string[];
}) {
  const all = shots.map(shotFromRow);
  const self = new Set(selfLabels);
  const mine = summarizeShots(all, self.size ? self : null);
  const coverage = ballTrack ? Number(ballTrack.coverage) : null;
  const meanConf = mine.total ? all.filter((s) => s.playerId && self.has(s.playerId)).reduce((a, s) => a + s.confidence, 0) / mine.total : null;

  const byRally = new Map<number, Shot[]>();
  for (const s of all) byRally.set(s.rallyIdx, [...(byRally.get(s.rallyIdx) ?? []), s]);
  const rallies = [...byRally.entries()].sort((a, b) => a[0] - b[0]);

  const maxTypeCount = Math.max(1, ...TYPE_ORDER.map((t) => mine.byType[t] ?? 0));

  return (
    <div className="stack g6">
      <div className="scoreboard-row">
        <div className="cell">
          <div className="num">{mine.total}</div>
          <div className="lbl">{self.size ? "Your shots" : "Shots tracked"}</div>
        </div>
        <div className="cell">
          <div className="num">{pct(mine.thirdShot.dropsIntoKitchen, mine.thirdShot.drops)}</div>
          <div className="lbl">3rd-shot drops in the kitchen</div>
        </div>
        <div className="cell">
          <div className="num">{pct(mine.dinks.intoKitchen, mine.dinks.count)}</div>
          <div className="lbl">Dinks in the kitchen</div>
        </div>
        <div className="cell">
          <div className="num">{mine.avgDriveSpeedMps !== null ? Math.round(mine.avgDriveSpeedMps * 2.237) : "—"}<small> mph</small></div>
          <div className="lbl">Avg drive speed</div>
        </div>
        <div className="cell">
          <div className="num">{mine.endings.errorsNet + mine.endings.errorsOut}</div>
          <div className="lbl">Rally-ending errors</div>
        </div>
      </div>

      <div className="grid2">
        <div className="card stack g4">
          <div className="sec-head">
            <h3 className="h2">Shot mix</h3>
            <span className="xs">{self.size ? "shots the tracker attributed to you" : "every contact on court"}</span>
          </div>
          <div className="stack g2">
            {TYPE_ORDER.filter((t) => (mine.byType[t] ?? 0) > 0).map((t) => {
              const n = mine.byType[t] ?? 0;
              return (
                <div key={t} className="meter" style={{ gap: 4 }}>
                  <div className="meter-top">
                    <span className="nm" style={{ fontSize: 14 }}>{SHOT_LABEL[t]}</span>
                    <span className="sc" style={{ fontSize: 15 }}>{n}</span>
                  </div>
                  <div className="track" style={{ height: 6 }}>
                    <div className="fill" style={{ width: `${(n / maxTypeCount) * 100}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card stack g4">
          <div className="sec-head">
            <h3 className="h2">By part of the game</h3>
          </div>
          <div className="stack g3">
            {(Object.keys(CATEGORY_LABEL) as ShotCategory[])
              .filter((c) => (mine.byCategory[c] ?? 0) > 0)
              .map((c) => (
                <div key={c} className="row g3" style={{ justifyContent: "space-between" }}>
                  <span className="sm" style={{ color: "var(--ink)", fontWeight: 600 }}>{CATEGORY_LABEL[c]}</span>
                  <span className="num" style={{ color: "var(--ink-2)" }}>
                    {mine.byCategory[c]} · {pct(mine.byCategory[c] ?? 0, mine.total)}
                  </span>
                </div>
              ))}
          </div>
          <div className="dashline" />
          <div className="stack g2">
            <Row k="Serves in" v={`${mine.serves.in} of ${mine.serves.count}`} />
            <Row k="Returns landing deep" v={`${mine.returns.deep} of ${mine.returns.count}`} />
            <Row k="Winners / net errors / out errors" v={`${mine.endings.winners} / ${mine.endings.errorsNet} / ${mine.endings.errorsOut}`} />
          </div>
          <p className="xs">
            Ball seen in {coverage !== null ? `${Math.round(coverage * 100)}%` : "—"} of rally frames
            {meanConf !== null ? ` · average shot confidence ${Math.round(meanConf * 100)}%` : ""}. Speeds and landing spots are estimates from the camera&apos;s view of the court.
          </p>
        </div>
      </div>

      <div className="sec">
        <div className="sec-head">
          <h3 className="h2">Rally by rally</h3>
          <span className="xs">Tap a shot to jump the video there</span>
        </div>
        <div className="stack g3">
          {rallies.map(([idx, list]) => (
            <div key={idx} className="card" style={{ padding: "var(--a3) var(--a4)" }}>
              <div className="row g2" style={{ alignItems: "center" }}>
                <span className="pill p-neutral mono">R{idx}</span>
                <div className="row g1" style={{ flex: 1, minWidth: 0 }}>
                  {list
                    .sort((a, b) => a.shotIdx - b.shotIdx)
                    .map((s) => {
                      const isSelf = s.playerId !== null && self.has(s.playerId);
                      const ended = s.outcome === "net" || s.outcome === "out";
                      return (
                        <a
                          key={s.shotIdx}
                          href={`#t=${Math.max(0, s.t - 0.6).toFixed(1)}`}
                          className="chip"
                          title={`${SHOT_LABEL[s.type]} by ${s.playerId ? playerDisplayName(s.playerId) : "unknown"} at ${mmss(s.t)} · from ${s.hitZone} · landed ${s.landingZone}${s.speedMpsApprox !== null ? ` · ${Math.round(s.speedMpsApprox * 2.237)} mph` : ""} · confidence ${Math.round(s.confidence * 100)}%`}
                          style={{
                            padding: "4px 10px",
                            fontSize: 12,
                            borderColor: isSelf ? "var(--blue)" : "var(--line)",
                            background: isSelf ? "var(--blue-wash)" : "var(--card)",
                            color: ended ? "var(--bad)" : isSelf ? "var(--blue-deep)" : "var(--ink-2)",
                            opacity: s.confidence < 0.4 ? 0.6 : 1,
                          }}
                        >
                          {SHOT_LABEL[s.type]}
                          {ended ? (s.outcome === "net" ? " · net" : " · out") : ""}
                        </a>
                      );
                    })}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="row g3" style={{ justifyContent: "space-between" }}>
      <span className="sm">{k}</span>
      <span className="num" style={{ color: "var(--ink)", fontWeight: 600 }}>{v}</span>
    </div>
  );
}
