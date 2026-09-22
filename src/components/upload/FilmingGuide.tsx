/**
 * How to film a game Baseline can read. Thirty seconds, for a stranger.
 *
 * MOST BAD READS WILL BE BAD FOOTAGE, and none of it is fixable after the
 * fact. A camera at the side sees half the court; portrait crops both
 * baselines; zooming in loses the far pair. And the ball benchmark found the
 * one lever nobody had tried: the ball is lost to MOTION BLUR, not to pixel
 * count -- 720p and 1080p detected it equally -- so a faster shutter (action
 * mode) should help more than any resolution setting.
 *
 * Four points, each one a thing a person can do at the court with the phone
 * already in their hand. Anything longer is skipped.
 */
const TIPS: Array<{ title: string; body: string }> = [
  {
    title: "Behind the baseline, up high",
    body: "Centre of the court, as high as you can — lean it on the fence at head height or above. Not from the side.",
  },
  {
    title: "Landscape, whole court in frame",
    body: "Turn the phone sideways. You should see all four corners and both baselines. Don't zoom.",
  },
  {
    title: "Turn on Action mode",
    body: "If your phone has it (iPhone: the running-person icon in Video). The ball blurs at normal settings — that's what loses it.",
  },
  {
    title: "Keep it still, start before the serve",
    body: "Prop it up rather than holding it. 1080p is plenty; 4K only makes the upload slower.",
  },
];

export function FilmingGuide() {
  return (
    <details className="card" style={{ padding: "var(--a4)" }} open>
      <summary style={{ cursor: "pointer", listStyle: "none" }}>
        <span className="eyebrow">How to film it</span>{" "}
        <span className="sm" style={{ color: "var(--ink-3)" }}>— 30 seconds, and it decides how good the read is</span>
      </summary>
      <div className="row g4" style={{ marginTop: "var(--a3)", alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* Where the phone goes, drawn rather than described: a court seen
            from above with the phone behind one baseline, looking down its
            length. The one picture that answers "where do I stand". */}
        <svg viewBox="0 0 120 180" width="96" height="144" aria-label="Phone placed behind the baseline, facing down the court"
          style={{ flex: "none" }}>
          <rect x="20" y="10" width="80" height="140" rx="2" fill="none" stroke="currentColor" strokeOpacity=".45" strokeWidth="2" />
          <line x1="20" y1="80" x2="100" y2="80" stroke="currentColor" strokeOpacity=".7" strokeWidth="2.5" />
          <line x1="20" y1="55" x2="100" y2="55" stroke="currentColor" strokeOpacity=".3" strokeWidth="1.5" />
          <line x1="20" y1="105" x2="100" y2="105" stroke="currentColor" strokeOpacity=".3" strokeWidth="1.5" />
          <line x1="60" y1="10" x2="60" y2="55" stroke="currentColor" strokeOpacity=".3" strokeWidth="1.5" />
          <line x1="60" y1="105" x2="60" y2="150" stroke="currentColor" strokeOpacity=".3" strokeWidth="1.5" />
          <path d="M60 158 L28 18 M60 158 L92 18" stroke="var(--blue)" strokeOpacity=".5" strokeWidth="1.5" strokeDasharray="3 3" fill="none" />
          <rect x="50" y="156" width="20" height="13" rx="2.5" fill="var(--blue)" />
          <text x="60" y="178" textAnchor="middle" fontSize="9" fill="currentColor" fillOpacity=".7">you film here</text>
        </svg>
        <ol className="stack g2" style={{ margin: 0, paddingLeft: 18, flex: "1 1 240px" }}>
          {TIPS.map((t) => (
            <li key={t.title} className="sm">
              <strong style={{ color: "var(--ink)" }}>{t.title}.</strong>{" "}
              <span style={{ color: "var(--ink-2)" }}>{t.body}</span>
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
