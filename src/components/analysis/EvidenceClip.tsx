import type { CoachingObservationRow, CoachingShotTechniqueRow } from "@/lib/db/types";
import { EvidenceVideo } from "./EvidenceVideo";
import { clock } from "@/lib/format/duration";

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
  windowStartSeconds,
  windowEndSeconds,
  technique,
}: {
  observation: CoachingObservationRow;
  /** The cut clip. Preferred: it is already trimmed to the moment. */
  clipUrl?: string | null;
  /** The whole source video, when no cut clip exists. Windowed by the player. */
  fallbackUrl?: string | null;
  /** The window to play out of the fallback. Ignored when a cut clip exists. */
  windowStartSeconds?: number | null;
  windowEndSeconds?: number | null;
  /** Where the moment is, for the caption. */
  startSeconds?: number | null;
  /** The technique read nearest this moment, when the burst pass caught it. */
  technique?: CoachingShotTechniqueRow | null;
}) {
  const o = observation;
  // A cut clip IS its window and needs no seeking. The source video is the
  // whole film, so it only works with one.
  const cut = clipUrl || null;
  const src = cut || fallbackUrl || null;
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
        <EvidenceVideo
          src={src}
          startSeconds={cut ? null : windowStartSeconds}
          endSeconds={cut ? null : windowEndSeconds}
          className="evidence-video"
        />
        <figcaption className="evidence-cap">
          {/* SAY WHICH KIND OF EVIDENCE THIS IS. An approximate clip is now the
              WHOLE rally rather than a few seconds around a moment the
              pipeline chose, so the caption says so plainly: the coach named
              the point, not the instant. It used to read "around 41.2s", which
              claimed a precision nobody had — and when the reader watched 41.2s
              and saw a serve under a sentence about the kitchen, the honest
              conclusion was that the analysis was wrong. */}
          {approx
            ? <>Rally {o.rally_idx}, in full — the coach named this point, not a single shot</>
            : t !== null
              ? <>The seconds around <strong>{timecode(t)}</strong>{o.rally_idx !== null ? <>, rally {o.rally_idx}</> : null}</>
              : <>From the clip the coach read</>}

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
/** Kept as the name the rest of the page imports; the shape lives in one place now. */
export function timecode(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  return clock(seconds);
}
