import type { ReactNode } from "react";
import type { CoachingObservationRow } from "@/lib/db/types";
import { FeedbackButtons } from "./FeedbackButtons";
import { EvidenceClip } from "./EvidenceClip";
import type { CoachingShotTechniqueRow } from "@/lib/db/types";

/**
 * One coaching point, in the order a coach would actually say it:
 *
 *   what happened → why it matters → what to do differently → how to practise
 *
 * Every part after the first is OPTIONAL and simply absent when the model
 * could not justify it. There is no empty slot, no "—", no "N/A" — an
 * observation with two real parts is worth more than one with four where two
 * are filler, and the prompt is written to omit rather than pad.
 *
 * Strengths get no fix and no drill, which is not a gap: there is nothing to
 * correct about a thing you are doing well.
 */
export function CoachingInsight({
  observation, drillName, hero = false, action, eyebrow, analysisId, initialVerdict,
  clipUrl, fallbackUrl, startSeconds, technique,
}: {
  observation: CoachingObservationRow;
  /** Resolved from the drill catalogue; the row only stores a slug. */
  drillName?: string | null;
  hero?: boolean;
  /** e.g. "Build a practice plan" — client-interactive, so passed in. */
  action?: ReactNode;
  /** Overrides the pill, for the one insight that leads the read. */
  eyebrow?: string;
  /** Enables the "is this right?" control. Omit to hide it. */
  analysisId?: string;
  /** This user's existing verdict, so the control shows what they already said. */
  initialVerdict?: "right" | "wrong" | "unsure" | null;
  /** The clip cut around this observation's moment, when one was cut. */
  clipUrl?: string | null;
  /** The full overlay seeked to the moment, for when no clip was cut. */
  fallbackUrl?: string | null;
  /** Where the moment is, in seconds. */
  startSeconds?: number | null;
  /** What the technique pass saw at that moment, when it was one of the shots read. */
  technique?: CoachingShotTechniqueRow | null;
}) {
  const o = observation;
  const isStrength = o.valence === "strength";
  const evidence = (
    <EvidenceClip
      observation={o}
      clipUrl={clipUrl}
      fallbackUrl={fallbackUrl}
      startSeconds={startSeconds}
      technique={technique}
    />
  );
  return (
    <article className={`insight${hero ? " insight-hero" : ""}`}>
      <div className="insight-top">
        <h3 className="insight-title">{o.title}</h3>
        <span className={`pill ${isStrength ? "p-good" : o.severity >= 4 ? "p-bad" : "p-warn"}`}>
          {eyebrow ?? (isStrength ? "Strength" : o.severity >= 4 ? "Priority" : "Worth fixing")}
        </span>
      </div>

      {/* TWO COLUMNS: the claim, and the footage it rests on.
          Side by side rather than one after the other, because reading the
          criticism and watching the moment should be one action. On a phone
          the grid collapses and the clip follows the text -- still visible,
          still nothing to open. */}
      <div className="insight-grid">
        <div className="insight-main">

      <div className="insight-part">
        <span className="insight-lbl">What happened</span>
        <p className="insight-txt">{o.detail}</p>
      </div>

      {o.why_it_matters ? (
        <div className="insight-part">
          <span className="insight-lbl">Why it matters</span>
          <p className="insight-txt">{o.why_it_matters}</p>
        </div>
      ) : null}

      {o.what_to_change ? (
        <div className="insight-part insight-fix">
          <span className="insight-lbl">What to change</span>
          <p className="insight-txt">{o.what_to_change}</p>
        </div>
      ) : null}

      {o.drill_slug ? (
        <div className="insight-drill">
          <span className="eyebrow">Practice</span>
          <span>{drillName ?? o.drill_slug}</span>
        </div>
      ) : null}

        </div>

        {/* The evidence, beside the claim and before the "is this right?"
            control: somebody about to disagree should be looking at what the
            claim rests on while they decide. That is the difference between a
            disagreement and a dismissal. */}
        {evidence}
      </div>

      {/* The correction, on the thing being corrected.
          Per COACHING POINT rather than per page: "the read was wrong" is not
          a usable label, and by the time somebody reaches a summary control at
          the bottom they have forgotten which of six points they disagreed
          with. The disagreement happens while reading one claim, so the button
          lives under that claim. */}
      {analysisId ? (
        <FeedbackButtons
          analysisId={analysisId}
          targetKind="observation"
          targetId={o.id}
          initialVerdict={initialVerdict ?? null}
        />
      ) : null}

      {o.rally_idx !== null || action ? (
        <div className="row" style={{ gap: 10 }}>
          {o.rally_idx !== null ? <span className="xs">Seen in rally {o.rally_idx}</span> : null}
          {action ? <span className="mla">{action}</span> : null}
        </div>
      ) : null}
    </article>
  );
}
