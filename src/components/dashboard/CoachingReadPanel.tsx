import Link from "next/link";
import type { CoachingObservationRow, CoachingReadRow, CoachingSkillRatingRow } from "@/lib/db/types";
import { skillName, type CoachingRead } from "@/lib/coaching/types";
import { rankObservations, topPriorityObservation } from "@/lib/coaching/ranking";
import { SkillMeter } from "@/components/breakdown/SkillMeter";
import { Check, Paddle } from "@/components/motifs/Motifs";
import { CoachingInsight } from "@/components/analysis/CoachingInsight";
import type { Evidence } from "@/lib/db/evidence";
import { BuildBlueprintButton } from "./BuildBlueprintButton";

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
export function CoachingReadPanel({
  read,
  observations,
  skills,
  analysisId,
  skillKeysWithBlueprint,
  drillNames = {},
  feedback,
  evidence,
}: {
  read: CoachingReadRow;
  observations: CoachingObservationRow[];
  skills: CoachingSkillRatingRow[];
  analysisId: string;
  /** skill_keys that already have a practice plan for this analysis — hide the build button rather than invite a duplicate. */
  skillKeysWithBlueprint: Set<string>;
  /** slug → human name, so an insight can name its drill. */
  drillNames?: Record<string, string>;
  /** observation id → this user's existing verdict, so the control is not blank. */
  feedback?: Map<string, "right" | "wrong" | "unsure">;
  /**
   * observation id → the clip that shows it and the technique read at that
   * moment. Resolved on the server, because a clip URL may be a signed one
   * with an expiry and that is not a thing to mint in the browser.
   */
  evidence?: Map<string, Evidence>;
}) {
  const coaching = parseCoaching(read.coaching_json);

  const hero = topPriorityObservation(observations);
  // Everything the workspace above cannot show, because it has no rally to be
  // selected under. Ranked, so the order matches the priority order.
  const clipWide = rankObservations(observations).filter(
    (o) => o.rally_idx === null && o.id !== hero?.id
  );
  const inWorkspace = observations.filter((o) => o.rally_idx !== null && o.id !== hero?.id).length;
  // The narrative blob is the ONLY coaching on the fallback path. Anywhere else
  // it is the observations reworded, so it is not rendered.
  const narrativeOnly = observations.length === 0;

  return (
    <div className="stack g6">
      <div className="read-head">
        <span className="eyebrow" style={{ color: "var(--blue)" }}>Your coaching read</span>
        <h2 className="d2 measure">{read.headline ?? "Coaching read"}</h2>
        {read.summary ? <p className="body measure">{read.summary}</p> : null}
      </div>

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

      {/* One point, once. The priority leads here; rally-tagged points live
          beside the video above; points with no rally follow below. */}
      {hero ? (
        <section className="sec">
          <div className="sec-head">
            <h3 className="h2">The one thing to work on</h3>
            <span className="xs">Start here</span>
          </div>
          <CoachingInsight
            analysisId={analysisId}
            initialVerdict={feedback?.get(hero.id) ?? null}
            clipUrl={evidence?.get(hero.id)?.clipUrl ?? null}
            fallbackUrl={evidence?.get(hero.id)?.fallbackUrl ?? null}
            startSeconds={evidence?.get(hero.id)?.startSeconds ?? null}
            windowStartSeconds={evidence?.get(hero.id)?.windowStartSeconds ?? null}
            windowEndSeconds={evidence?.get(hero.id)?.windowEndSeconds ?? null}
            technique={evidence?.get(hero.id)?.technique ?? null}
            observation={hero}
            drillName={hero.drill_slug ? drillNames[hero.drill_slug] : null}
            hero
            eyebrow="Top priority"
            action={
              !skillKeysWithBlueprint.has(hero.skill_key)
                ? <BuildBlueprintButton analysisId={analysisId} observationId={hero.id} />
                : null
            }
          />
        </section>
      ) : null}

      {clipWide.length > 0 ? (
        <section className="sec">
          <div className="sec-head">
            <h3 className="h2">Across the whole clip</h3>
            <span className="xs">Not tied to one rally</span>
          </div>
          <div className="stack g4">
            {clipWide.map((o) => (
              <CoachingInsight
                analysisId={analysisId}
                initialVerdict={feedback?.get(o.id) ?? null}
                clipUrl={evidence?.get(o.id)?.clipUrl ?? null}
                fallbackUrl={evidence?.get(o.id)?.fallbackUrl ?? null}
                startSeconds={evidence?.get(o.id)?.startSeconds ?? null}
                windowStartSeconds={evidence?.get(o.id)?.windowStartSeconds ?? null}
                windowEndSeconds={evidence?.get(o.id)?.windowEndSeconds ?? null}
                technique={evidence?.get(o.id)?.technique ?? null}
                key={o.id}
                observation={o}
                drillName={o.drill_slug ? drillNames[o.drill_slug] : null}
                action={
                  o.valence === "weakness" && !skillKeysWithBlueprint.has(o.skill_key)
                    ? <BuildBlueprintButton analysisId={analysisId} observationId={o.id} />
                    : null
                }
              />
            ))}
          </div>
        </section>
      ) : null}

      {inWorkspace > 0 ? (
        <p className="xs measure">
          {inWorkspace} more point{inWorkspace === 1 ? "" : "s"} {inWorkspace === 1 ? "is" : "are"} tied
          to a specific rally. Pick that rally in the film room above and it appears next to the video,
          so you can watch the thing being described.
        </p>
      ) : null}

      {coaching?.data_gaps ? (
        <p className="xs measure">What the footage couldn&apos;t show: {coaching.data_gaps}</p>
      ) : null}

      {skills.length > 0 ? (
        <section className="sec">
          <h3 className="h2">Skill ratings from this game</h3>
          <div className="grid2">
            {skills.map((s) => (
              <div key={s.id} className="card">
                <SkillMeter name={skillName(s.skill_key)} raw={s.raw} basis={s.basis} />
              </div>
            ))}
          </div>
        </section>
      ) : null}

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
