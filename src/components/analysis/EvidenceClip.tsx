import type { CoachingObservationRow, CoachingShotTechniqueRow } from "@/lib/db/types";

/**
 * The footage behind a coaching point, ALWAYS VISIBLE.
 *
 * This replaced a <details> disclosure called "Why am I being told this?", and
 * the reason it replaced it is the whole argument for the feature. Tell a 4.0
 * player their positioning is poor and they may well answer "no it isn't" --
 * they are entitled to, because until there is evidence the exchange is one
 * opinion against another and theirs comes with twenty years of playing.
 *
 * A disclosure does not fix that. It puts the evidence one click away and then
 * relies on the person who most wants to disagree being the one who clicks. In
 * practice a collapsed section is a section that does not exist: the claim is
 * what gets read, the proof is what gets skipped, and the product is back to
 * asserting things at people. Evidence that has to be opened is not evidence
 * on offer, it is evidence on request.
 *
 * So the clip sits BESIDE the claim, playable where it is. Reading the
 * criticism and watching the thing it is about is one action now, and the
 * player can disagree with the footage rather than with the sentence.
 *
 * THERE IS ALWAYS SOMETHING TO PLAY. A cut clip when one exists; the full
 * overlay seeked to the moment when the cut failed or was capped. The old
 * "several points in the clip" fallback is gone -- it was the sentence this
 * feature existed to delete.
 */
export function EvidenceClip({
  observation,
  clipUrl,
  fallbackUrl,
  startSeconds,
  technique,
}: {
  observation: CoachingObservationRow;
  /** The cut clip. Preferred: it is already trimmed to the moment. */
  clipUrl?: string | null;
  /** The full overlay with a #t= fragment, when no cut clip exists. */
  fallbackUrl?: string | null;
  /** Where the moment is, for the caption. */
  startSeconds?: number | null;
  /** The technique read nearest this moment, when the burst pass caught it. */
  technique?: CoachingShotTechniqueRow | null;
}) {
  const o = observation;
  const src = clipUrl || fallbackUrl || null;
  const t = startSeconds ?? (o.t_s === null ? null : Number(o.t_s));
  const approx = o.t_is_approx === true;

  const before = technique
    ? ([
        ["Paddle", technique.paddle_face],
        ["Shoulders", technique.shoulder_rotation],
        ["Contact", technique.contact_height],
        ["Feet", technique.foot_position],
      ] as const).filter(([, v]) => v && v.trim() && !/^cannot tell$/i.test(v.trim()))
    : [];

  // No overlay at all is the one case with nothing to show. It is already
  // reported on the analysis as a known limitation, so this says nothing.
  if (!src) return null;

  return (
    <aside className="evidence" aria-label="The footage this is based on">
      <figure className="evidence-fig">
        {/*
          The overlay's own footage, not a re-render of it. The court, the
          boxes and the skeleton here are the exact ones the model was looking
          at when it said this -- which is what makes it evidence rather than
          an illustration.

          muted + preload="metadata": several of these sit on one page, and a
          page that downloads a dozen videos before anyone presses anything is
          a page that loads slowly on a phone at a court.
        */}
        <video
          src={src}
          controls
          muted
          playsInline
          preload="metadata"
          className="evidence-video"
        />
        <figcaption className="evidence-cap">
          {approx
            ? <>From rally {o.rally_idx}{t !== null ? <> — around {timecode(t)}</> : null}</>
            : t !== null
              ? <>The seconds around <strong>{timecode(t)}</strong>{o.rally_idx !== null ? <>, rally {o.rally_idx}</> : null}</>
              : <>From the clip the coach read</>}
          {clipUrl ? null : <span className="evidence-full"> · full overlay</span>}
        </figcaption>
      </figure>

      {before.length > 0 ? (
        <div className="evidence-before">
          <span className="insight-lbl">Before contact</span>
          <dl className="evidence-grid">
            {before.map(([label, value]) => (
              <div key={label} className="evidence-row">
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </aside>
  );
}

/** 41.2 -> 0:41. The form a player reads off a scrubber. */
export function timecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
