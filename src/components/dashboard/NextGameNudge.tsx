import Link from "next/link";

/**
 * Ask for the second game, because one game cannot answer the question people
 * actually have.
 *
 * ONE READ SAYS "HERE IS WHAT HAPPENED IN THIS GAME". Two say "here is what
 * you do", and three say whether it is getting better -- which is the only
 * version anybody pays for twice. The practice page already draws the trend
 * and sits empty until there is something to draw; nothing anywhere asked for
 * the game that would fill it.
 *
 * WORDED FROM WHAT THIS READ FOUND, not as a marketing line. "Your dinking is
 * rated 3.4 off one game" is a fact with an obvious next question attached,
 * and the answer to it is another clip.
 */
export function NextGameNudge({
  analysisCount,
  weakestSkill,
  weakestRating,
}: {
  /** How many analyses this account has. */
  analysisCount: number;
  /** The lowest-rated skill on this read, when there is one. */
  weakestSkill?: string | null;
  weakestRating?: number | null;
}) {
  // After a handful of games the trend speaks for itself and this becomes
  // nagging. It exists to get somebody from one game to two.
  if (analysisCount >= 3) return null;
  const second = analysisCount <= 1;

  return (
    <section className="card stack g2 nextgame">
      <div className="row g2" style={{ alignItems: "center" }}>
        <span className="nextgame-ic" aria-hidden="true">&#8599;</span>
        <strong style={{ fontSize: 15 }}>
          {second ? "One game is a snapshot" : "Two games is nearly a trend"}
        </strong>
      </div>
      <p className="sm measure" style={{ margin: 0, color: "var(--ink-2)" }}>
        {weakestSkill && typeof weakestRating === "number" ? (
          <>
            This read rates your <strong>{weakestSkill.toLowerCase()}</strong> at{" "}
            {weakestRating.toFixed(1)} — off {second ? "one game" : "two games"}. Analyse another and
            the practice page will show whether it is moving, which is the thing a single read
            cannot tell you.
          </>
        ) : (
          <>
            Analyse another game and the practice page starts showing which of your ratings are
            moving and which are stuck — a single read can only say what happened once.
          </>
        )}
      </p>
      <div className="row g2" style={{ flexWrap: "wrap" }}>
        <Link href="/dashboard/new" className="btn btn-sm btn-primary">Analyse another game</Link>
        <Link href="/dashboard/practice" className="btn btn-sm btn-ghost">See the trend so far</Link>
      </div>
    </section>
  );
}
