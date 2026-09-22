import type { CSSProperties } from "react";
import type { CoachingDrillRow, CoachingObservationRow } from "@/lib/db/types";

/**
 * The drills, as the answer to "so what do I do now".
 *
 * WHY THIS REPLACED A LIST OF NAMES. The drills tab showed a drill's name and
 * "For: <weakness>" in small grey type, and the full session sat below the
 * fold behind a disclosure. The catalogue already knew each drill's purpose,
 * its steps, how many players and what equipment -- the page just never used
 * it. Reported as: make it simpler to look at, and make it obvious these are
 * what will make you better.
 *
 * So each card reads in one direction: WHAT IT FIXES first (the player's own
 * weakness, in their own read's words), then the drill, then why it works,
 * then how -- steps folded away until wanted, because at a glance the only
 * questions are "which one first" and "can I do this with what I've got".
 */

type Catalog = Record<string, Pick<CoachingDrillRow, "name" | "purpose" | "steps" | "players" | "equipment" | "difficulty">>;

/** Steps are jsonb; accept an array of strings or of {text} rather than trust the shape. */
function stepsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => (typeof s === "string" ? s : (s as { text?: unknown })?.text))
    .filter((s): s is string => typeof s === "string" && s.trim() !== "");
}

/**
 * One card per DRILL, not per observation. Two weaknesses fixed by the same
 * drill are one thing to go and do, listed once with both reasons.
 */
export function prescribedDrills(observations: CoachingObservationRow[]): Array<{ slug: string; fixes: string[] }> {
  const bySlug = new Map<string, string[]>();
  // Most severe first, so "Drill 1" is the one that matters most.
  const ordered = [...observations].sort((a, b) => Number(b.severity ?? 0) - Number(a.severity ?? 0));
  for (const o of ordered) {
    if (!o.drill_slug) continue;
    const list = bySlug.get(o.drill_slug) ?? [];
    if (!list.includes(o.title)) list.push(o.title);
    bySlug.set(o.drill_slug, list);
  }
  return [...bySlug.entries()].map(([slug, fixes]) => ({ slug, fixes }));
}

export function DrillCards({
  observations,
  catalog,
  limit,
}: {
  observations: CoachingObservationRow[];
  catalog: Catalog;
  /** Show only the first few; the rest are one scroll away in the tab. */
  limit?: number;
}) {
  const all = prescribedDrills(observations).filter((d) => catalog[d.slug]);
  const drills = limit ? all.slice(0, limit) : all;
  if (drills.length === 0) return null;

  return (
    <div className="stack g3">
      {drills.map((d, i) => {
        const drill = catalog[d.slug];
        const steps = stepsOf(drill.steps);
        return (
          <article
            key={d.slug}
            className="card stack g2"
            style={{ padding: "var(--a4)", borderLeft: "4px solid var(--good)" }}
          >
            <div className="row g3" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
              <span
                aria-hidden="true"
                style={{
                  width: 28, height: 28, borderRadius: "50%", display: "grid", placeItems: "center",
                  background: "var(--good)", color: "#fff", fontWeight: 700, fontSize: 14, flex: "none",
                }}
              >
                {i + 1}
              </span>
              <h3 style={{ margin: 0, fontSize: 18 }}>{drill.name}</h3>
            </div>
            <p className="sm" style={{ margin: 0 }}>
              <span style={{ color: "var(--good)", fontWeight: 600 }}>Fixes: </span>
              {d.fixes.join(" · ")}
            </p>
            {drill.purpose ? (
              <p className="sm" style={{ margin: 0, color: "var(--ink-2)" }}>{drill.purpose}</p>
            ) : null}
            <p className="xs" style={{ margin: 0, color: "var(--ink-3)" }}>
              {drill.players === 1 ? "Solo" : `${drill.players} players`}
              {drill.equipment ? ` · ${drill.equipment}` : ""}
              {drill.difficulty ? ` · ${drill.difficulty}` : ""}
            </p>
            {steps.length > 0 ? (
              <details>
                <summary className="sm" style={{ cursor: "pointer", color: "var(--blue)" }}>How to do it</summary>
                <ol className="sm stack g1" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                  {steps.map((s, j) => <li key={j}>{s}</li>)}
                </ol>
              </details>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

/**
 * The drills, folded into one clearly-labelled door.
 *
 * FOLDED BECAUSE THEY ARE A DIFFERENT JOB. The read is for the sofa; the
 * drills are for the court. Laid out in full under the read they were two
 * screens of instructions nobody had asked for yet -- so they sit behind one
 * tap, with the summary saying how many there are and what they fix.
 *
 * AND LABELLED AS PERSONAL, because a closed box of "drills" reads as a
 * generic library. The summary names the problems from THIS game each one was
 * picked for, which is the thing that makes it worth opening.
 */
export function PersonalDrillsReveal({
  observations,
  catalog,
  subject = "you",
}: {
  observations: CoachingObservationRow[];
  catalog: Catalog;
  /** "you" on your own page; "them" on a shared link, read by somebody else. */
  subject?: "you" | "them";
}) {
  const all = prescribedDrills(observations).filter((d) => catalog[d.slug]);
  if (all.length === 0) return null;
  const fixes = [...new Set(all.flatMap((d) => d.fixes))];
  const shown = fixes.slice(0, 3);
  const you = subject === "you";
  return (
    <details className="reveal drills-reveal" style={{ "--reveal-accent": "var(--good)" } as CSSProperties}>
      <summary className="reveal-sum">
        <span className="reveal-ic" aria-hidden="true">✦</span>
        <span className="reveal-txt">
          <span className="reveal-title">
            {you ? "Your personal drills" : "Drills built for this player"}{" "}
            <span className="drills-badge">Made from this game</span>
          </span>
          <span className="reveal-sub">
            {all.length} drill{all.length === 1 ? "" : "s"} picked for what the coach saw {you ? "you" : "them"} do
            {shown.length ? ` — ${shown.join(" · ")}${fixes.length > shown.length ? ` · +${fixes.length - shown.length} more` : ""}` : ""}
          </span>
        </span>
        <span className="reveal-chev" aria-hidden="true">Open</span>
      </summary>
      <div className="reveal-body stack g3">
        <p className="sm" style={{ margin: 0, color: "var(--ink-2)" }}>
          Not a generic plan. Each drill was chosen for a specific thing in this game, and says
          which. Start with number 1 — it fixes the biggest one.
        </p>
        <DrillCards observations={observations} catalog={catalog} />
      </div>
    </details>
  );
}
