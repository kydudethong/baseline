import Link from "next/link";
import type { CoachingObservationRow, CoachingReadRow } from "@/lib/db/types";
import { type CoachingRead } from "@/lib/coaching/types";
import { Check, Paddle } from "@/components/motifs/Motifs";
import { CoachingInsight } from "@/components/analysis/CoachingInsight";
import type { Evidence } from "@/lib/db/evidence";

/**
 * The coaching read, with every point said ONCE.
 *
 * This used to render the same coaching four times over. The model is asked to
 * write a narrative read (strengths / top_priority_fix / secondary_observations
 * / drill_recommendation) and then to re-express that same read as tagged
 * observations — so `coaching_json.top_priority_fix` and the highest-severity
 * weakness observation are the same point in different words, as are each
 * strength and each secondary issue. This panel rendered both sets, and the
 * new workspace above rendered the rally-tagged ones a third time. Reading
 * your own analysis three times is not thoroughness, it is noise.
 *
 * So the observations win: they are the structured records, they carry
 * why_it_matters / what_to_change / drill_slug, they are tied to a rally, and
 * they are what skills, trends and practice plans are built from. The
 * narrative blob now contributes only what observations do not have — the
 * headline, the summary, the footage-quality note and data_gaps.
 *
 * Division of labour with the workspace above:
 *   - the top priority fix leads HERE, once
 *   - observations tied to a rally appear beside the video, when that rally is
 *     selected (the workspace skips the priority one, since it leads here)
 *   - observations tied to no rally appear here, because nothing above can
 *     ever show them
 *
 * The old narrative sections are still rendered, but ONLY on the fallback path
 * where the tagging call produced no observations at all — there, the blob is
 * the only coaching that exists, and showing it is not a repeat of anything.
 */
/**
 * MUCH SMALLER THAN IT WAS. This used to own the headline paragraph, the top
 * priority fix, the clip-wide observations and the skill ratings -- all of
 * which have either moved to where they belong or been deleted for being
 * restatement. What is left is the narrative fallback, which renders only when
 * the tagging call produced no observations at all.
 */
export function CoachingReadPanel({
  read, observations, hero, heroEvidence, drillName, analysisId, heroVerdict,
}: {
  read: CoachingReadRow;
  /** Only to decide whether the narrative fallback is the only coaching there is. */
  observations: CoachingObservationRow[];
  /**
   * The top priority fix, WITH ITS FOOTAGE.
   *
   * IT HAD NOWHERE TO BE SHOWN. The workspace skips this one deliberately --
   * "it leads the read below, so it is not repeated here" -- and the read
   * below only rendered the narrative when there were no observations at all.
   * On the normal path the single most important criticism therefore appeared
   * as a line of text in the takeaways and nowhere else: no clip, no
   * timestamp, nothing to check it against. The claim with the most weight on
   * the page was the only one the player could not go and look at.
   */
  hero?: CoachingObservationRow | null;
  heroEvidence?: Evidence | null;
  drillName?: string | null;
  analysisId?: string;
  heroVerdict?: "right" | "wrong" | "unsure" | null;
}) {
  const coaching = parseCoaching(read.coaching_json);

  // The narrative blob is the ONLY coaching on the fallback path. Anywhere else
  // it is the observations reworded, so it is not rendered.
  const narrativeOnly = observations.length === 0;

  return (
    <div className="stack g6">
      {hero ? (
        <CoachingInsight
          observation={hero}
          hero
          eyebrow="The one thing to work on first"
          clipUrl={heroEvidence?.clipUrl ?? null}
          fallbackUrl={heroEvidence?.fallbackUrl ?? null}
          startSeconds={heroEvidence?.startSeconds ?? null}
          windowStartSeconds={heroEvidence?.windowStartSeconds ?? null}
          windowEndSeconds={heroEvidence?.windowEndSeconds ?? null}
          technique={heroEvidence?.technique ?? null}
          drillName={drillName ?? null}
          analysisId={analysisId}
          initialVerdict={heroVerdict ?? null}
        />
      ) : null}
      {/* THE HEADLINE PARAGRAPH IS GONE.
          "Dominant Kitchen Offense Balanced by Smarter Baseline Margins" --
          a sentence no player would write, restating in praise-shaped prose
          what the sections below say with evidence attached. It read as a
          school report, and it was the first thing on the page. */}

      {/* THE SELF-DOUBT BANNER IS GONE.
          It was well-intentioned and it read terribly: the first thing a
          player saw, above their coaching, was the product arguing with
          itself about paddle faces and topspin. Nobody wants to be told
          their coach is unreliable before they have read a word of the
          coaching -- and the audit's own complaints ("this pass cannot see
          a paddle at 5fps") are OUR problem to fix, not the reader's to
          adjudicate.
          The audit still runs. What it finds belongs in the logs, and in
          the prompt that stops the model claiming it, rather than in a
          warning box stapled to the person's results. */}


      {/* The narrative read, ONLY when the tagging call produced no observations
          to say the same thing better. Anywhere else this is a reworded repeat. */}
      {coaching && narrativeOnly ? (
        <>
          {coaching.strengths.length > 0 ? (
            <section className="sec">
              <div className="sec-head">
                <h3 className="h2">What&apos;s working</h3>
                <span className="xs">Keep doing these</span>
              </div>
              <div className="strengths">
                {coaching.strengths.map((s, i) => (
                  <div key={i} className="strength">
                    <span className="ic">
                      <Check size={14} />
                    </span>
                    <p className="tx">{s}</p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="read-hero">
            <div className="band">
              <span className="no">01</span>
              <span className="lb">Top priority fix — the one thing to work on first</span>
            </div>
            <div className="bd">
              <h3 className="issue">{coaching.top_priority_fix.issue}</h3>
              <p className="why">{coaching.top_priority_fix.why_it_matters}</p>
              <div className="evidence">
                <span className="k">Seen in your clip</span>
                <span>{coaching.top_priority_fix.evidence}</span>
              </div>
            </div>
          </section>

          {coaching.secondary_observations.length > 0 ? (
            <section className="sec">
              <div className="sec-head">
                <h3 className="h2">Also worth noting</h3>
                <span className="xs">After the priority fix, in order</span>
              </div>
              <div className="notings">
                {coaching.secondary_observations.map((o, i) => (
                  <div key={i} className="noting">
                    <span className="no">{String(i + 2).padStart(2, "0")}</span>
                    <div>
                      <p className="issue">{o.issue}</p>
                      <p className="ev">{o.evidence}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="sec">
            <div className="sec-head">
              <h3 className="h2">Start here</h3>
              <span className="xs">The drill that targets your priority fix</span>
            </div>
            <div className="drill-rec">
              <span className="ic">
                <Paddle size={30} />
              </span>
              <div className="stack g3" style={{ minWidth: 0 }}>
                <p className="nm">{coaching.drill_recommendation.name}</p>
                <div className="kv">
                  <span className="k">Targets</span>
                  <span className="v">{coaching.drill_recommendation.target}</span>
                  <span className="k">Do</span>
                  <span className="v">{coaching.drill_recommendation.reps_duration}</span>
                </div>
                <div className="row g2">
                  <Link href="/dashboard/drills" className="btn btn-primary btn-sm">
                    Browse all drills
                  </Link>
                </div>
              </div>
            </div>
          </section>

        </>
      ) : null}

      {/* "THE ONE THING TO WORK ON" AND "ACROSS THE WHOLE CLIP" ARE GONE.
          Both rendered a full coaching card with its evidence clip, and
          between them they made this the longest thing on the page. The
          rally-tagged points already live beside the video, where a player can
          watch the rally they are about -- which is the only place a criticism
          has its context.

          Known cost, stated rather than buried: an observation tied to NO
          rally now has nowhere to appear. The workspace can only show points
          attached to a rally it can select. If those start going missing in a
          way that matters, the fix is to surface them in the workspace rather
          than to put these sections back. */}

      {/* TWO PARAGRAPHS OF HOUSEKEEPING, DELETED.
          The first explained the page's own navigation -- "7 more points are
          tied to a specific rally, pick that rally above" -- which is a
          product describing itself instead of working. If the coaching beside
          the video is not discoverable, the fix is the layout, not a note.

          The second dumped data_gaps verbatim: bounding box IDs swapping
          between player_9 and player_1, no per-shot biomechanical contact
          measurements, no automated paddle tracking. Every word true, every
          word ours. The reliability note above the film says the same thing in
          the reader's language, and the rest belongs in the logs. */}

      {/* The skill ratings moved OUT of this panel and under the radar they
          explain -- see SkillRatingsPanel. A rating and the chart it is a
          point on were several screens apart, which made the chart
          unquestionable: there was nowhere to go from an axis you disagreed
          with. */}

    </div>
  );
}

function parseCoaching(json: string | null): CoachingRead | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as CoachingRead;
  } catch {
    // A malformed coaching_json shouldn't take the whole page down — show
    // just the headline/summary/quality section above instead.
    return null;
  }
}
