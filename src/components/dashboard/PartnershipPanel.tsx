import Link from "next/link";
import type { PartnershipRead } from "@/lib/coaching/analyst";
import { PARTNERSHIP_DIMENSIONS } from "@/lib/coaching/analyst";
import { clock } from "@/lib/format/duration";

/**
 * How the pair works, rather than how each of them plays.
 *
 * THE DISTINCTION IS THE WHOLE PANEL. Everything else on this page is about
 * one player; this is about what two of them do in the same twenty feet. Those
 * are genuinely different questions, and the second one is where most
 * recreational doubles is actually lost -- two people who each play well and
 * leave the middle open every time lose to two people who are individually
 * worse and move together.
 *
 * So the compatibility number is explicitly NOT a level. Two 3.0s who move as
 * one score higher here than two 4.0s who both chase everything, and the panel
 * says so, because a number that looks like a rating and is not is worse than
 * no number.
 */

const DIMENSION_LABELS: Record<typeof PARTNERSHIP_DIMENSIONS[number], string> = {
  spacing: "Spacing",
  moving_as_a_unit: "Moving as a unit",
  middle_balls: "The middle ball",
  transition_together: "Getting up together",
  switches_and_stacking: "Switches and stacking",
  poaching: "Poaching",
  style_fit: "Do your games fit",
  who_gets_targeted: "Who gets targeted",
  reset_after_scramble: "Resetting after a scramble",
  workload_balance: "Share of the work",
};

/** Seconds as m:ss, because a coaching clip is something you scrub to. */
/**
 * A timestamp, clickable when there is a player to drive.
 *
 * MODULE LEVEL, not defined inside the panel. Closing over `onSeek` inside the
 * render body makes a NEW component type on every render, which React treats
 * as a different component -- it unmounts and remounts the whole subtree each
 * time, losing focus and any state inside it.
 */
function At({ at, onSeek }: { at: number | null; onSeek?: (seconds: number) => void }) {
  if (at === null) return null;
  if (!onSeek) return <span className="crumb">{clock(at)}</span>;
  return (
    <button type="button" className="crumb" onClick={() => onSeek(at)}>{clock(at)}</button>
  );
}

function Bar({ rating }: { rating: number }) {
  const pct = Math.max(0, Math.min(100, (rating / 10) * 100));
  // Colour by band rather than a gradient: the useful reading is "which of
  // these is the problem", and a continuous ramp makes 4 and 6 look the same.
  const tone = rating >= 7 ? "var(--good)" : rating >= 4.5 ? "var(--warn)" : "var(--bad)";
  return (
    <div className="progress" style={{ height: 6 }}>
      <div className="bar" style={{ width: `${pct}%`, background: tone }} />
    </div>
  );
}

export function PartnershipPanel({
  partnership,
  onSeek,
  taggedPartner,
  setupHref,
}: {
  partnership: PartnershipRead | null | undefined;
  /** Jump the player to a moment. Omitted on the share page's read-only view. */
  onSeek?: (seconds: number) => void;
  /**
   * Whether a partner was tapped on the setup frame at all.
   *
   * WHY THE ABSENCE NEEDS A VOICE. This section rendered nothing when there
   * was no partnership read, so a player who never tagged a partner and a
   * player whose partner could not be matched saw exactly the same thing --
   * an empty space where they had been told a partnership read would be.
   * Reported twice as "I still don't see the partner analysis". Undefined
   * keeps the old silence, for the shared page where the reader cannot act.
   */
  taggedPartner?: boolean;
  /** Where to go to tag one. Only useful to the owner. */
  setupHref?: string;
}) {
  if (!partnership) {
    if (taggedPartner === undefined) return null;
    return (
      <section className="stack g2 card">
        <span className="eyebrow" style={{ color: "var(--blue)" }}>You and your partner</span>
        <p className="sm measure" style={{ margin: 0, color: "var(--ink-2)" }}>
          {taggedPartner
            ? "Your partner was tagged, but no partnership read came back for this clip — usually the "
              + "tracker lost one of you for too much of it. Re-running the analysis is free and "
              + "usually produces one."
            : "No partner was tagged on this clip, so there is nothing to say about how the two of you "
              + "play together. Tap your partner on the setup frame — the second tap, after yourself — "
              + "and analyse again."}
        </p>
        {setupHref ? (
          <div className="row g2">
            <Link href={setupHref} className="btn btn-sm btn-soft">
              {taggedPartner ? "Check the setup and re-run" : "Tag my partner"}
            </Link>
          </div>
        ) : null}
      </section>
    );
  }

  const rated = (partnership.dimensions ?? [])
    .filter((d) => DIMENSION_LABELS[d.key])
    .sort((a, b) => a.rating - b.rating);

  return (
    <section className="stack g4">
      <div className="stack g1">
        <span className="eyebrow" style={{ color: "var(--blue)" }}>You and your partner</span>
        <div className="row" style={{ alignItems: "baseline", gap: "var(--a3)" }}>
          <span style={{ fontSize: 34, fontWeight: 700, lineHeight: 1 }}>
            {partnership.compatibility.toFixed(1)}
          </span>
          <span className="sm" style={{ color: "var(--ink-3)" }}>/ 10 as a pair</span>
        </div>
        {/* Said plainly, because a number beside two players' names reads as a
            rating of the players unless it is told not to. */}
        <p className="sm" style={{ margin: 0, color: "var(--ink-3)" }}>
          This is how well you two <em>work together</em>, not how good you are. Two steady
          players who move as one score higher here than two better players who both chase
          the same ball.
        </p>
      </div>

      <p className="measure" style={{ margin: 0 }}>{partnership.summary}</p>

      {rated.length > 0 ? (
        <div className="stack g2">
          {/* WORST FIRST. A list in schema order buries the one thing worth
              fixing among nine things that are fine. */}
          <span className="eyebrow">Weakest first</span>
          {rated.map((d) => (
            <div key={d.key} className="stack g1">
              <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                <span className="sm" style={{ color: "var(--ink)" }}>{DIMENSION_LABELS[d.key]}</span>
                <span className="sm" style={{ color: "var(--ink-3)" }}>{d.rating.toFixed(1)}</span>
              </div>
              <Bar rating={d.rating} />
              <p className="sm" style={{ margin: 0, color: "var(--ink-2)" }}>{d.basis}</p>
            </div>
          ))}
        </div>
      ) : null}

      {partnership.friction?.length ? (
        <div className="stack g2">
          <span className="eyebrow" style={{ color: "var(--bad)" }}>What costs you points</span>
          {partnership.friction.map((f, i) => (
            <div key={i} className="note">
              <strong style={{ color: "var(--ink)" }}>{f.pattern}</strong>
              {f.cost ? <> — {f.cost}</> : null}
              {f.fix ? <p className="sm" style={{ margin: "6px 0 0" }}>{f.fix}</p> : null}
              {f.evidence || f.at_s !== null ? (
                <p className="sm" style={{ margin: "6px 0 0", color: "var(--ink-3)" }}>
                  {f.evidence} <At at={f.at_s} onSeek={onSeek} />
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {partnership.works_well?.length ? (
        <div className="stack g2">
          <span className="eyebrow" style={{ color: "var(--good)" }}>What already works</span>
          {partnership.works_well.map((w, i) => (
            <div key={i} className="note">
              <strong style={{ color: "var(--ink)" }}>{w.pattern}</strong>
              {w.why_it_works ? <> — {w.why_it_works}</> : null}
              {w.evidence || w.at_s !== null ? (
                <p className="sm" style={{ margin: "6px 0 0", color: "var(--ink-3)" }}>
                  {w.evidence} <At at={w.at_s} onSeek={onSeek} />
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {partnership.role_split ? (
        <div className="stack g2">
          <span className="eyebrow">Who does what</span>
          <div className="row" style={{ gap: "var(--a3)", flexWrap: "wrap" }}>
            <div className="note" style={{ flex: "1 1 220px" }}>
              <strong style={{ color: "var(--ink)" }}>You</strong>
              <p className="sm" style={{ margin: "4px 0 0" }}>{partnership.role_split.you}</p>
            </div>
            <div className="note" style={{ flex: "1 1 220px" }}>
              <strong style={{ color: "var(--ink)" }}>Your partner</strong>
              <p className="sm" style={{ margin: "4px 0 0" }}>{partnership.role_split.partner}</p>
            </div>
          </div>
          {partnership.role_split.imbalance ? (
            <p className="sm" style={{ margin: 0, color: "var(--warn)" }}>
              {partnership.role_split.imbalance}
            </p>
          ) : null}
        </div>
      ) : null}

      {partnership.fix_together ? (
        <div className="stack g2">
          <span className="eyebrow" style={{ color: "var(--blue)" }}>Practise this together</span>
          <div className="note">
            <strong style={{ color: "var(--ink)" }}>{partnership.fix_together.change}</strong>
            {partnership.fix_together.how_to_practise ? (
              <p className="sm" style={{ margin: "6px 0 0" }}>{partnership.fix_together.how_to_practise}</p>
            ) : null}
            {partnership.fix_together.at_s !== null ? (
              <p className="sm" style={{ margin: "6px 0 0", color: "var(--ink-3)" }}>
                Seen at <At at={partnership.fix_together.at_s} onSeek={onSeek} />
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
