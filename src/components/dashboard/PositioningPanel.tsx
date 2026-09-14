import type { MovementMetricRow } from "@/lib/db/types";
import type { PlayerPositioning } from "@/lib/vision/positioning";

/**
 * Where you stood — kitchen-line time, time to the kitchen, partner gap.
 *
 * WHY KITCHEN TIME LEADS. It is the most level-diagnostic single number in
 * pickleball: recreational players hang back, strong players live at the line,
 * and the gap between a 3.0 and a 4.0 is visible in this one figure more
 * clearly than in any stroke. It is also the rare metric a player can act on
 * the same evening without changing a single technical habit.
 *
 * Shown as a bar of the three zones rather than three numbers, because the
 * shape is the point: 20% kitchen / 30% transition / 50% back is a different
 * player from 50/30/20, and reading that off three percentages takes a moment
 * longer than seeing it.
 *
 * Only the tagged player's row is emphasised. The others are rendered because
 * doubles is relative -- being at the line while your partner is not is a
 * different problem from both of you being back -- but they are context, not
 * the subject.
 */
export function PositioningPanel({
  movement,
  selfLabels,
}: {
  movement: MovementMetricRow[];
  selfLabels: string[];
}) {
  const rows = movement
    .map((m) => ({ label: m.player_label, p: parsePositioning(m.positioning) }))
    .filter((r): r is { label: string; p: PlayerPositioning } => r.p !== null);

  if (rows.length === 0) return null;

  const mine = new Set(selfLabels);
  const ordered = [...rows].sort((a, b) => Number(mine.has(b.label)) - Number(mine.has(a.label)));

  return (
    <section className="stack g4">
      <div className="stack g1">
        <span className="eyebrow" style={{ color: "var(--blue)" }}>Where you stood</span>
        <p className="sm measure">
          Kitchen-line time is the single most level-diagnostic number in pickleball — the difference
          between a 3.0 and a 4.0 shows up here more clearly than in any stroke.
        </p>
      </div>

      <div className="stack g3">
        {ordered.map(({ label, p }) => {
          const isSelf = mine.has(label);
          return (
            <article key={label} className={`card stack g3${isSelf ? "" : " muted-card"}`}>
              <div className="row g2">
                <span className="h3" style={{ margin: 0 }}>{isSelf ? "You" : label}</span>
                <span className="pill p-neutral">{p.side === "near" ? "near side" : "far side"}</span>
                <span className="pill p-good mla">
                  {Math.round(p.zones.kitchen * 100)}% at the kitchen
                </span>
              </div>

              <div className="zonebar" aria-label="time by court zone">
                <span className="z kitchen" style={{ width: `${p.zones.kitchen * 100}%` }} />
                <span className="z transition" style={{ width: `${p.zones.transition * 100}%` }} />
                <span className="z back" style={{ width: `${p.zones.back * 100}%` }} />
              </div>
              <div className="zonekey">
                <span><i className="kitchen" />Kitchen {Math.round(p.zones.kitchen * 100)}%</span>
                <span><i className="transition" />Transition {Math.round(p.zones.transition * 100)}%</span>
                <span><i className="back" />Back court {Math.round(p.zones.back * 100)}%</span>
              </div>

              <div className="posgrid">
                <div>
                  <div className="num">{p.kitchenSeconds}s</div>
                  <div className="lbl">At the kitchen</div>
                  <div className="sub">of {p.trackedSeconds}s tracked</div>
                </div>
                <div>
                  <div className={`num${p.secondsToKitchenMedian === null ? " empty" : ""}`}>
                    {p.secondsToKitchenMedian === null ? "—" : `${p.secondsToKitchenMedian}s`}
                  </div>
                  <div className="lbl">To the kitchen after a return</div>
                  <div className="sub">
                    {p.secondsToKitchenMedian === null
                      ? "no returns identified in this clip"
                      : p.approachesNeverArrived > 0
                        ? `${p.approachesNeverArrived} of ${p.approachesMeasured + p.approachesNeverArrived} never got there`
                        : `across ${p.approachesMeasured} return${p.approachesMeasured === 1 ? "" : "s"}`}
                  </div>
                </div>
                <div>
                  <div className={`num${p.partnerGapMeanFeet === null ? " empty" : ""}`}>
                    {p.partnerGapMeanFeet === null ? "—" : `${p.partnerGapMeanFeet}ft`}
                  </div>
                  <div className="lbl">Gap to your partner</div>
                  <div className="sub">
                    {p.partnerGapMeanFeet === null
                      ? "no partner track found"
                      : p.partnerGapFractionWide !== null
                        ? `${Math.round(p.partnerGapFractionWide * 100)}% of the time wider than 12ft`
                        : `max ${p.partnerGapMaxFeet}ft`}
                  </div>
                </div>
              </div>

              {isSelf && p.partnerGapFractionWide !== null && p.partnerGapFractionWide > 0.25 ? (
                <p className="note" style={{ margin: 0, borderLeft: "4px solid var(--warn)" }}>
                  You and your partner were more than 12 feet apart a quarter of the time. Most doubles
                  points are lost through the middle — when one of you goes wide, the other slides across.
                </p>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The stored jsonb, or null.
 *
 * Defensive because this column is new: every movement row written before 0017
 * has no positioning at all, and every row from a clip with no calibrated
 * court has null — both normal states, neither an error.
 */
function parsePositioning(value: unknown): PlayerPositioning | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Partial<PlayerPositioning>;
  if (!p.zones || typeof p.zones.kitchen !== "number") return null;
  return p as PlayerPositioning;
}
