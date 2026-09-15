import type { CoachingObservationRow, CoachingShotTechniqueRow } from "@/lib/db/types";

/**
 * "Why am I being told this?"
 *
 * THE ARGUMENT FOR THIS COMPONENT. Tell a 4.0 player their positioning is poor
 * and they may well answer "no it isn't" -- and they are entitled to, because
 * until there is evidence the exchange is one opinion against another and
 * theirs comes with twenty years of playing. An AI coach that cannot show its
 * work is a worse coach than a friend with a phone.
 *
 * So every claim carries three things, in the order a player would ask for
 * them: the moment it came from, the footage of that moment, and what the
 * model actually saw in the body before contact. The last is the part that
 * converts "your preparation is late" from a verdict into something checkable
 * -- shoulders still square, feet still moving, and there it is on screen.
 *
 * A <details> element rather than a state toggle: it is a disclosure, it works
 * before hydration, it is keyboard-accessible for free, and it costs nothing
 * on the page for every reader who does not ask.
 */
export function WhyThis({
  observation,
  clipUrl,
  technique,
}: {
  observation: CoachingObservationRow;
  /** Null when no clip could be cut. The section still has something to say. */
  clipUrl?: string | null;
  /** The technique read nearest this moment, when the burst pass caught it. */
  technique?: CoachingShotTechniqueRow | null;
}) {
  const o = observation;
  const before = technique
    ? ([
        ["Paddle", technique.paddle_face],
        ["Shoulders", technique.shoulder_rotation],
        ["Contact point", technique.contact_height],
        ["Feet", technique.foot_position],
      ] as const).filter(([, v]) => v && v.trim() && !/^cannot tell$/i.test(v.trim()))
    : [];

  // Nothing to show is not a reason to render an empty disclosure that
  // disappoints whoever opens it.
  if (!clipUrl && before.length === 0 && o.t_s === null && !o.why_it_matters) return null;

  return (
    <details className="why">
      <summary className="why-sum">Why am I being told this?</summary>

      <div className="why-body">
        <p className="why-lead">
          {o.valence === "strength"
            ? "This came back as a strength because of what happened at"
            : "You are seeing this because of what happened at"}{" "}
          {o.t_s !== null ? <strong>{timecode(Number(o.t_s))}</strong> : "several points in the clip"}
          {o.rally_idx !== null ? <> in rally {o.rally_idx}</> : null}.
        </p>

        {clipUrl ? (
          <figure className="why-clip">
            {/*
              The overlay's own footage, not a re-render of it. The court, the
              boxes and the skeleton in this clip are the exact ones the model
              was looking at when it said this -- which is what makes it
              evidence rather than an illustration.
            */}
            <video src={clipUrl} controls playsInline preload="metadata" />
            <figcaption className="xs">
              The seconds around {timecode(Number(o.t_s ?? 0))}, as the coach saw them.
            </figcaption>
          </figure>
        ) : o.t_s !== null ? (
          <p className="xs why-noclip">
            No clip was cut for this moment — scrub the full overlay to{" "}
            {timecode(Number(o.t_s))} to see it.
          </p>
        ) : null}

        {before.length > 0 ? (
          <div className="why-before">
            <span className="insight-lbl">Before contact</span>
            <dl className="why-grid">
              {before.map(([label, value]) => (
                <div key={label} className="why-row">
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {technique?.confidence ? (
              <p className="xs why-conf">Confidence: {technique.confidence}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}

/** 41.2 -> 0:41. The form a player reads off a scrubber. */
function timecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
