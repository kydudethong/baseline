import type { CoachingPracticeBlockRow, CoachingPracticePlanRow } from "@/lib/db/types";

/**
 * The session plan, rendered as a session: in order, on a clock.
 *
 * WHY A RUNNING CLOCK AND NOT JUST DURATIONS. The model returns minutes per
 * block, which answers "how long" but not "when" -- and "when" is the half a
 * player standing on a court actually needs, because they are looking at a
 * phone with 47 minutes left and deciding whether to move on. The offsets are
 * a running sum of the durations above each block, computed here rather than
 * asked of the model, because a model asked for both start times and durations
 * will eventually return a pair that disagree and there is no way to tell
 * which one it meant.
 *
 * The clock is HIDDEN the moment any block is missing its minutes, rather than
 * treating a null as zero. A timeline where block four starts at 0:25 because
 * block three had no duration is worse than no timeline: it is wrong in a way
 * that looks authoritative.
 *
 * `success` gets its own line and its own colour on purpose. It is the part
 * that makes a block finishable -- without it a drill is just a duration, and
 * the player has no way to know whether the ten minutes did anything.
 */
export function PracticeSessionPanel({
  plan,
  blocks,
  drillNames = {},
}: {
  plan: CoachingPracticePlanRow;
  blocks: CoachingPracticeBlockRow[];
  /** slug → human name from the drill library, so a block can name its source. */
  drillNames?: Record<string, string>;
}) {
  const clocked = blocks.every((b) => typeof b.minutes === "number" && b.minutes > 0);
  // Cumulative offsets without a mutable accumulator: the lint rule against
  // reassigning across a render is right in spirit even here, where the map is
  // synchronous -- a running `let` in a component body is exactly the shape
  // that breaks the first time someone makes the list lazy or concurrent.
  const starts = blocks.reduce<number[]>(
    (acc, b, i) => [...acc, i === 0 ? 0 : acc[i - 1] + (blocks[i - 1].minutes ?? 0)],
    []
  );

  return (
    <div className="stack g4">
      <div className="read-head">
        <span className="eyebrow" style={{ color: "var(--blue)" }}>Your next practice session</span>
        <h2 className="d2 measure">{plan.focus}</h2>
        {plan.success_looks_like ? (
          <p className="body measure">
            <strong style={{ color: "var(--ink)" }}>By your next upload:</strong>{" "}
            {plan.success_looks_like}
          </p>
        ) : null}
      </div>

      <div className="row g2">
        <span className="pill p-neutral">
          {blocks.length} block{blocks.length === 1 ? "" : "s"}
        </span>
        {plan.total_minutes ? (
          <span className="pill p-neutral">{plan.total_minutes} min</span>
        ) : null}
      </div>

      <div className="sess">
        {blocks.map((b, i) => (
          <article key={b.id} className={`sess-block k-${b.kind}`}>
            <header className="sess-head">
              <span className="sess-when">
                {clocked ? formatClock(starts[i]) : `#${i + 1}`}
              </span>
              <span className="sess-kind">{KIND_LABEL[b.kind] ?? b.kind}</span>
              {b.minutes ? <span className="sess-mins">{b.minutes} min</span> : null}
            </header>

            <h3 className="sess-name">{b.name}</h3>
            {b.targets ? <p className="sess-targets">Fixes: {b.targets}</p> : null}

            <div className="sess-how">
              {b.how
                .split(/\n+/)
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line, j) => (
                  <p key={j}>{line}</p>
                ))}
            </div>

            {b.success ? (
              <p className="sess-success">
                <strong>Stop when:</strong> {b.success}
              </p>
            ) : null}

            {b.drill_slug && drillNames[b.drill_slug] ? (
              <p className="sess-src">From the library: {drillNames[b.drill_slug]}</p>
            ) : null}
          </article>
        ))}
      </div>

      <p className="note">
        {clocked
          ? "The times are a guide, not a stopwatch — but the ORDER matters. The hardest work sits early on purpose, while you are fresh enough to practise the good version of the stroke rather than a tired one."
          : "Work down the list in order. The hardest block sits early on purpose, while you are fresh enough to practise the good version of the stroke rather than a tired one."}
      </p>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  warmup: "Warm-up",
  drill: "Drill",
  game: "Play",
  cooldown: "Cool-down",
};

/**
 * Minutes elapsed, as a clock reading rather than a duration: "0:00", "10:00",
 * "25:00". A player glances at this to answer "am I meant to be on this block
 * yet", which is a clock question, so it reads like the clock on their phone.
 */
function formatClock(minutes: number): string {
  return `${minutes}:00`;
}
