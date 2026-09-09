import type { AnalysisView } from "@/lib/db/analysis-view";

/**
 * The four numbers worth putting at the top of an analysis, as gradient tiles
 * with a completion ring.
 *
 * EVERY TILE IS A REAL FRACTION WITH A REAL DENOMINATOR. That constraint is
 * the whole design. A ring is a proportion, so it may only be drawn for a
 * quantity that genuinely has a whole: frames with the ball out of frames
 * looked at, shots with mechanics out of shots found, seconds of live play out
 * of seconds of clip. It is not a score, a grade, or "performance", and there
 * is deliberately no tile averaging the others into one headline figure — that
 * number would have no unit and no way to be wrong, which is exactly the kind
 * of confident nonsense this product exists to avoid.
 *
 * A tile whose inputs are missing does not render. Four tiles is the happy
 * case, not a layout requirement; better a row of two than two invented ones.
 */

export type Tile = {
  key: string;
  /** Which gradient, 1-5. Fixed per tile — colour follows the entity. */
  hue: 1 | 2 | 3 | 4 | 5;
  label: string;
  /** Big number, already formatted. */
  value: string;
  /** Small text under the label. */
  caption: string;
  /** 0..1, or null for a tile that is a count with no meaningful whole. */
  ratio: number | null;
  /** What the ring is a fraction OF, for the tooltip and the screen reader. */
  ratioLabel: string | null;
};

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function buildTiles(view: AnalysisView): Tile[] {
  const q = view.quality;
  const tiles: Tile[] = [];

  // 1. Live play. The ring is the share of the clip that was actually a
  //    rally, which is a genuinely useful thing to know about your own
  //    footage: most people's "20 minute game" is four minutes of play.
  const clip = view.video?.durationSeconds ?? null;
  if (view.rallies.length > 0) {
    const liveS = view.rallies.reduce((a, r) => a + Math.max(0, r.endS - r.startS), 0);
    tiles.push({
      key: "rallies",
      hue: 1,
      label: `${view.rallies.length} rall${view.rallies.length === 1 ? "y" : "ies"}`,
      value: String(view.rallies.length),
      caption: clip && clip > 0
        ? `${Math.round(liveS)}s of play in a ${Math.round(clip)}s clip`
        : `${Math.round(liveS)}s of play`,
      ratio: clip && clip > 0 ? Math.min(1, liveS / clip) : null,
      ratioLabel: clip && clip > 0 ? "of the clip was live play" : null,
    });
  }

  // 2. Shots, ringed by how many got mechanics. Pose fails on occluded or
  //    part-frame players, so this is routinely below 1 and saying so is the
  //    point.
  const shots = q?.shots_classified ?? view.shots.length;
  if (shots > 0) {
    const measured = view.shots.filter((s) => s.mechanics != null).length;
    tiles.push({
      key: "shots",
      hue: 2,
      label: `${shots} shot${shots === 1 ? "" : "s"}`,
      value: String(shots),
      caption: `${measured} with mechanics measured`,
      ratio: shots > 0 ? Math.min(1, measured / shots) : null,
      ratioLabel: "of shots had body mechanics measured",
    });
  }

  // 3. Ball coverage. The honest bottleneck, and the number every other
  //    number on the page rests on, so it gets a tile rather than a footnote.
  if (q?.ball_coverage != null) {
    tiles.push({
      key: "ball",
      hue: 3,
      label: "Ball tracked",
      value: pct(q.ball_coverage),
      caption: q.ball_points_detected != null
        ? `${q.ball_points_detected} frames the ball was found in`
        : "of frames the ball was visible in",
      ratio: q.ball_coverage,
      ratioLabel: "of sampled frames had the ball",
    });
  }

  // 4. Court fit. Confidence is the fitter's own score, not a rating of the
  //    user, and `userConfirmed` overrides it — a court the user placed by
  //    hand is correct by definition and should not show a machine's doubt.
  if (view.court) {
    const confirmed = view.court.userConfirmed;
    tiles.push({
      key: "court",
      hue: 4,
      label: "Court fit",
      value: confirmed ? "Yours" : pct(view.court.confidence),
      caption: confirmed ? "you placed the lines yourself" : `fitted by ${view.court.method}`,
      // No ring when the user placed it. Confidence is the fitter's doubt
      // about its own guess; a court someone marked by hand has no such
      // quantity, and drawing a full ring would invent a 100% score out of
      // the absence of a measurement.
      ratio: confirmed ? null : view.court.confidence,
      ratioLabel: confirmed ? null : "confidence in the automatic fit",
    });
  }

  return tiles;
}

/** Ring geometry. r is chosen so the stroke sits inside the 44px box. */
const R = 19;
const C = 2 * Math.PI * R;

export function StatTiles({ view }: { view: AnalysisView }) {
  const tiles = buildTiles(view);
  if (tiles.length === 0) return null;

  return (
    <div className="gtiles">
      {tiles.map((t) => (
        <article className={`gtile hue-${t.hue}`} key={t.key}>
          <div className="gtile-txt">
            <p className="gtile-v">{t.value}</p>
            <p className="gtile-l">{t.label}</p>
            <p className="gtile-c">{t.caption}</p>
          </div>
          {t.ratio !== null ? (
            <div className="gtile-ring" title={t.ratioLabel ?? undefined}>
              <svg viewBox="0 0 44 44" aria-hidden="true">
                <circle className="tr" cx="22" cy="22" r={R} />
                <circle
                  className="tv"
                  cx="22"
                  cy="22"
                  r={R}
                  strokeDasharray={`${C * t.ratio} ${C}`}
                  transform="rotate(-90 22 22)"
                />
              </svg>
              <span className="gtile-ring-n">{Math.round(t.ratio * 100)}</span>
              {t.ratioLabel ? (
                <span className="sr-only">{Math.round(t.ratio * 100)}% {t.ratioLabel}</span>
              ) : null}
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}
