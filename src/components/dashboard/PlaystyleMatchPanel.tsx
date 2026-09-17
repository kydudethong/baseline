import type { CSSProperties } from "react";
import { watchUrl } from "@/lib/coaching/pro-playstyles";
import type { PlaystyleMatch } from "@/lib/coaching/pro-playstyles";
import { skillName } from "@/lib/coaching/types";

/**
 * "You play like…" — the closest pro by the SHAPE of the skill ratings.
 *
 * THE HONESTY PROBLEM THIS SOLVES. A bare "you play like Ben Johns" is both
 * flattering and meaningless: read as a claim about level it is absurd, and
 * there is nothing in it a player can check. So the panel says the comparison
 * out loud -- this is about what your game LEANS ON relative to the rest of
 * your own game, not how good you are -- and shows the three skills that drove
 * the match next to the places you and the pro diverge. A comparison you can
 * argue with is worth more than one you can only accept.
 *
 * The runners-up are shown too, quietly. One name reads as a verdict; three
 * ranked names read as what it is, a similarity ordering, and the gap between
 * first and second tells you how much to trust the top one.
 */
export function PlaystyleMatchPanel({
  matches,
  hasRead,
}: {
  matches: PlaystyleMatch[];
  /** Whether a coaching read exists at all, which decides WHICH nothing this is. */
  hasRead: boolean;
}) {
  // RENDERING NOTHING WAS THE BUG. `return null` on an empty list meant three
  // completely different situations looked identical from the page: no
  // coaching read yet, a read written before this feature existed, and a read
  // whose ratings were too few or too flat to have a shape. The first is
  // "tag yourself", the second is "re-run", the third is "this clip was too
  // short" -- and a silent gap tells you to do none of them. A feature the
  // user cannot tell is missing is a feature that does not exist.
  if (matches.length === 0) {
    if (!hasRead) return null; // the page already says "tag yourself" above.
    return (
      <section className="stack g3">
        <span className="eyebrow" style={{ color: "var(--blue)" }}>Closest pro playstyle</span>
        <div className="note">
          <strong style={{ color: "var(--ink)" }}>No pro comparison for this clip.</strong>{" "}
          Matching compares the SHAPE of your skill ratings, so it needs several skills rated and
          some variation between them. A short clip often produces neither — and a read written
          before this feature existed has no comparison stored at all. Re-running the coaching read
          on a longer clip is what fixes both.
        </div>
      </section>
    );
  }
  const [top, ...rest] = matches;

  return (
    <section className="stack g4">
      {/* BEHIND A DOOR, AND THE NAME STAYS BEHIND IT.
          Putting "You play like <pro>" on the page as a heading answers the
          question before anyone asks it, which is the one thing that makes it
          worth nothing -- the fun is in the reveal. It is also the least
          load-bearing thing here: nobody changes what they practise because
          of it. So it is offered rather than announced, and the summary does
          not spoil the answer. */}
      <details className="reveal" style={{ "--reveal-accent": "var(--court)" } as CSSProperties}>
        <summary className="reveal-sum">
          <span className="reveal-ic" aria-hidden="true">★</span>
          <span className="reveal-txt">
            <span className="reveal-title">See which pro you play like</span>
            <span className="reveal-sub">Matched on the shape of your ratings, not your level</span>
          </span>
          <span className="reveal-chev" aria-hidden="true">›</span>
        </summary>
        <div className="reveal-body">
      <div className="read-head">
        <span className="eyebrow" style={{ color: "var(--blue)" }}>Closest pro playstyle</span>
        <h2 className="d2 measure">You play like {top.name}</h2>
        <p className="body measure">{top.oneLine}</p>
      </div>

      <div className="card stack g3">
        <div className="row g2">
          <span className="pill p-neutral">{strengthLabel(top.similarity)}</span>
          {top.sharedStrengths.map((k) => (
            <span key={k} className="pill p-good">
              <span className="dot" />
              {skillName(k)}
            </span>
          ))}
          {top.confidence !== "high" ? (
            <span className="pill p-warn mla">profile is {top.confidence}-confidence</span>
          ) : null}
        </div>

        <p className="sm">{top.signature}</p>

        <p className="xs">
          <strong style={{ color: "var(--ink)" }}>Steal this:</strong> {top.watchFor}
        </p>

        {/* The claim is "you play like this person", and the only way to judge
            it is to watch them. Sending the reader to footage is the difference
            between a verdict and something they can check. */}
        <div>
          <a
            className="btn btn-soft btn-sm"
            href={watchUrl(top)}
            target="_blank"
            rel="noreferrer noopener"
          >
            ▶ Watch {top.name} play
          </a>
        </div>

        {top.divergences.length > 0 ? (
          <p className="note" style={{ margin: 0 }}>
            Where you differ most:{" "}
            {top.divergences.map((k) => skillName(k)).join(" and ")} — {top.name} leans on{" "}
            {top.divergences.length === 1 ? "that" : "those"} differently than you do, so that is the
            part of their game you would have to build rather than recognise.
          </p>
        ) : null}

        {top.sources.length > 0 ? (
          <p className="dev-note" style={{ margin: 0 }}>
            Profile from{" "}
            {top.sources.map((s, i) => (
              <span key={s}>
                {i > 0 ? ", " : ""}
                <a href={s} target="_blank" rel="noreferrer noopener">
                  {hostOf(s)}
                </a>
              </span>
            ))}
          </p>
        ) : null}
      </div>

      {rest.length > 0 ? (
        <p className="note">
          Also close:{" "}
          {rest.map((m, i) => (
            <span key={m.slug}>
              {i > 0 ? ", " : ""}
              <strong style={{ color: "var(--ink)" }}>{m.name}</strong> ({percent(m.similarity)}){" "}
              <a href={watchUrl(m)} target="_blank" rel="noreferrer noopener" title={`Watch ${m.name} play`}>▶</a>
            </span>
          ))}
          . This compares the SHAPE of your game — what you lean on relative to the rest of your own
          skills — not your level. It is not a claim that you hit like a pro; it is a claim about
          which pro&apos;s approach your game is already built around, and therefore whose habits
          would transfer to you fastest.
        </p>
      ) : null}
        </div>
      </details>
    </section>
  );
}

/**
 * Plain words for the similarity, because 0.87 means nothing to a reader.
 * The thresholds are deliberately conservative: a shape match is a soft claim
 * and calling a 0.6 "a strong resemblance" would oversell it.
 */
function strengthLabel(similarity: number): string {
  if (similarity >= 0.85) return "Strong resemblance";
  if (similarity >= 0.65) return "Clear resemblance";
  if (similarity >= 0.45) return "Loose resemblance";
  return "Closest of the set — but not a close match";
}

function percent(similarity: number): string {
  return `${Math.round(similarity * 100)}% shape match`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
