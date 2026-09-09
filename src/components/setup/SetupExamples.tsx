/**
 * The three ways setup actually goes wrong, drawn.
 *
 * WHY DIAGRAMS AND NOT SCREENSHOTS. A real frame from a real clip is mostly
 * crowd, sponsor boards and one court out of three, and the thing being
 * demonstrated is four small dots somewhere in it. A schematic shows only the
 * geometry that matters, is legible at 200px wide, needs no asset pipeline,
 * and cannot go stale when the overlay colours change — it reads the same
 * tokens the real canvas does.
 *
 * Every court here is the same trapezoid, drawn once by `Court`. The camera
 * is behind the near baseline, so the near line is wide at the bottom and the
 * far one is narrow at the top; that foreshortening is the whole reason
 * mistake 1 is easy to make, and a rectangle would hide it.
 */

const W = 200;
const H = 124;

/** Court landmarks in diagram space. Shared so the overlays line up exactly. */
const NEAR_L: P = [14, 108], NEAR_R: P = [186, 108];
const FAR_L:  P = [70, 24],  FAR_R:  P = [130, 24];
const NET_L:  P = [44, 58],  NET_R:  P = [156, 58];
const KIT_NEAR_L: P = [34, 74], KIT_NEAR_R: P = [166, 74];
const KIT_FAR_L:  P = [55, 45], KIT_FAR_R:  P = [145, 45];

type P = [number, number];
const pts = (...ps: P[]) => ps.map((p) => p.join(",")).join(" ");

/** The court as the camera sees it: lines only, no marks. */
function Court() {
  return (
    <g fill="none" stroke="var(--line-strong)" strokeWidth="1.5" strokeLinecap="round">
      <polygon points={pts(NEAR_L, NEAR_R, FAR_R, FAR_L)} />
      <line x1={KIT_NEAR_L[0]} y1={KIT_NEAR_L[1]} x2={KIT_NEAR_R[0]} y2={KIT_NEAR_R[1]} />
      <line x1={KIT_FAR_L[0]} y1={KIT_FAR_L[1]} x2={KIT_FAR_R[0]} y2={KIT_FAR_R[1]} />
      <line x1={100} y1={108} x2={100} y2={74} />
      <line x1={100} y1={45} x2={100} y2={24} />
      {/* The net, drawn with height so it reads as the net and not a line. */}
      <path d={`M${NET_L[0]},${NET_L[1]} L${NET_R[0]},${NET_R[1]}`} stroke="var(--c2)" strokeWidth="2" strokeOpacity=".42" />
      <path d={`M${NET_L[0]},${NET_L[1]} L${NET_L[0]},${NET_L[1] - 9} L${NET_R[0]},${NET_R[1] - 8} L${NET_R[0]},${NET_R[1]}`}
            stroke="var(--c2)" strokeWidth="1" strokeOpacity=".22" />
    </g>
  );
}

function Marks({ quad, tone }: { quad: P[]; tone: "bad" | "good" }) {
  const c = tone === "good" ? "var(--c4)" : "var(--c2)";
  return (
    <g>
      <polygon
        points={pts(...(quad as [P, P, P, P]))}
        fill={c} fillOpacity=".13" stroke={c} strokeWidth="2"
        strokeDasharray={tone === "bad" ? "5 3" : undefined}
      />
      {quad.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r="4" fill={c} stroke="var(--card)" strokeWidth="1.5" />
      ))}
    </g>
  );
}

/** A player, as a head and shoulders so near/far reads at this size. */
function Player({ at, self, scale = 1 }: { at: P; self?: boolean; scale?: number }) {
  const [x, y] = at;
  const c = self ? "var(--c5)" : "var(--ink-3)";
  return (
    <g fill={c}>
      <circle cx={x} cy={y - 9 * scale} r={3.2 * scale} />
      <path d={`M${x - 4.4 * scale},${y} q${4.4 * scale},${-7 * scale} ${8.8 * scale},0 z`} />
      {self ? (
        <circle cx={x} cy={y - 5 * scale} r={11 * scale} fill="none" stroke="var(--c5)" strokeWidth="1.6" />
      ) : null}
    </g>
  );
}

function Panel({ tone, label, children }: { tone: "bad" | "good"; label: string; children: React.ReactNode }) {
  return (
    <figure className={`exd ${tone}`}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        <Court />
        {children}
      </svg>
      <figcaption>
        <span className="exd-mk" aria-hidden="true">{tone === "good" ? "✓" : "✗"}</span>
        {label}
      </figcaption>
    </figure>
  );
}

const EXAMPLES = [
  {
    id: "kitchen",
    title: "Put the corners on the baselines, not the kitchen",
    // This is the most common one by a distance, and the most damaging,
    // because it fails silently: the quad still looks like a court, the
    // homography still solves, and every distance downstream is then wrong by
    // the ratio of a 44ft court to a 14ft box.
    why: "The kitchen lines are the easiest to see, so they get clicked. A court marked this way still looks right and still solves — it is just a third of the size, and every speed and distance measured on it is wrong by the same factor.",
    bad: <Marks tone="bad" quad={[KIT_NEAR_L, KIT_NEAR_R, KIT_FAR_R, KIT_FAR_L]} />,
    badLabel: "Corners on the kitchen lines",
    good: <Marks tone="good" quad={[NEAR_L, NEAR_R, FAR_R, FAR_L]} />,
    goodLabel: "Corners on the two baselines",
  },
  {
    id: "far-baseline",
    title: "If the far baseline is out of frame, mark the net instead",
    why: "A phone on a fence often cannot see the far baseline. Guessing where it would be puts the whole far half of the court in the wrong place. Marking the net line and ticking the box below tells Baseline it has half a court, which it can work with honestly.",
    bad: (
      <>
        <Marks tone="bad" quad={[NEAR_L, NEAR_R, [128, 6], [72, 6]]} />
        <line x1="0" y1="9" x2={W} y2="9" stroke="var(--c2)" strokeWidth="1.2" strokeDasharray="4 3" />
        <text x={W / 2} y="19" textAnchor="middle" fontSize="9" fill="var(--c2)" fontWeight="700">
          top of frame
        </text>
      </>
    ),
    badLabel: "Far corners guessed off-screen",
    good: <Marks tone="good" quad={[NEAR_L, NEAR_R, NET_R, NET_L]} />,
    goodLabel: "Near baseline to the net, box ticked",
  },
  {
    id: "which-player",
    title: "Tag yourself, not whoever is easiest to see",
    why: "The far players are smaller and often clearer against the background, so they get clicked. Baseline measures the player you tag — tag the wrong one and you get a clean, detailed read of your opponent.",
    bad: (
      <>
        <Player at={[84, 40]} scale={0.72} self />
        <Player at={[118, 40]} scale={0.72} />
        <Player at={[62, 100]} />
        <Player at={[140, 100]} />
      </>
    ),
    badLabel: "Tagged a player on the far side",
    good: (
      <>
        <Player at={[84, 40]} scale={0.72} />
        <Player at={[118, 40]} scale={0.72} />
        <Player at={[62, 100]} self />
        <Player at={[140, 100]} />
      </>
    ),
    goodLabel: "Tagged yourself, camera side",
  },
];

export function SetupExamples() {
  return (
    <section className="stack g4">
      <div>
        <p className="eyebrow">Getting it right</p>
        <p className="sm" style={{ margin: "4px 0 0", opacity: 0.8 }}>
          Three mistakes worth knowing about. All three still produce a result —
          that is what makes them worth showing.
        </p>
      </div>

      {EXAMPLES.map((ex) => (
        <div className="ex" key={ex.id}>
          <div className="ex-pair">
            <Panel tone="bad" label={ex.badLabel}>{ex.bad}</Panel>
            <Panel tone="good" label={ex.goodLabel}>{ex.good}</Panel>
          </div>
          <div className="ex-txt">
            <strong>{ex.title}</strong>
            <p className="sm" style={{ margin: "4px 0 0" }}>{ex.why}</p>
          </div>
        </div>
      ))}
    </section>
  );
}
