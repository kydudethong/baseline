import Link from "next/link";
import type { CoachingObservationRow, CoachingReadRow, CoachingSkillRatingRow } from "@/lib/db/types";
import { COACHING_DIMENSION_LABELS, skillName, type CoachingDimension, type CoachingRead } from "@/lib/coaching/types";
import { SkillMeter } from "@/components/breakdown/SkillMeter";
import { Check, Paddle } from "@/components/motifs/Motifs";
import { BuildBlueprintButton } from "./BuildBlueprintButton";

/**
 * Renders one coaching_reads row plus its tagged observations and skill
 * ratings. Deliberately shows only what run-coaching.ts actually persisted —
 * coaching_json is null on the "not enough data" path (see its comment in
 * run-coaching.ts), so this falls back to just the headline/summary/quality
 * section rather than rendering an empty strengths/fix/drill block.
 *
 * Visual hierarchy is the point: one fix leads (the hero band), strengths
 * are quick green confirmations, "also worth noting" is numbered 02/03…
 * so it reads as a ranked list, and the drill sits on the ball's color so
 * the eye lands on "what do I do next".
 */
export function CoachingReadPanel({
  read,
  observations,
  skills,
  analysisId,
  skillKeysWithBlueprint,
}: {
  read: CoachingReadRow;
  observations: CoachingObservationRow[];
  skills: CoachingSkillRatingRow[];
  analysisId: string;
  /** skill_keys that already have a practice plan for this analysis — hide the build button rather than invite a duplicate. */
  skillKeysWithBlueprint: Set<string>;
}) {
  const coaching = parseCoaching(read.coaching_json);
  const quality = read.quality as { usable: boolean; issues: string[] } | null;

  return (
    <div className="stack g6">
      <div className="read-head">
        <span className="eyebrow" style={{ color: "var(--blue)" }}>Your coaching read</span>
        <h2 className="d2 measure">{read.headline ?? "Coaching read"}</h2>
        {read.summary ? <p className="body measure">{read.summary}</p> : null}
      </div>

      {quality && !quality.usable ? (
        <div className="error">
          <strong>Limited footage quality.</strong>
          {quality.issues.length > 0 ? (
            <ul style={{ marginTop: 6, paddingLeft: 18, listStyle: "disc" }}>
              {quality.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {coaching ? (
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

          {coaching.data_gaps ? <p className="xs measure">What the footage couldn&apos;t show: {coaching.data_gaps}</p> : null}
        </>
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

      {observations.length > 0 ? (
        <section className="sec">
          <h3 className="h2">What the coach saw, rally by rally</h3>
          <div className="stack g4">
            {observations.map((o) => (
              <div key={o.id} className={`weak${o.severity <= 3 ? " med" : ""}${o.valence === "strength" ? " strength" : ""}`}>
                <div className="stripe" />
                <div className="in">
                  <div className="row g3">
                    <span className="eyebrow">
                      {COACHING_DIMENSION_LABELS[o.coaching_dimension as CoachingDimension] ?? o.coaching_dimension}
                    </span>
                    {o.valence === "strength" ? (
                      <span className="pill p-good"><span className="dot" />Working</span>
                    ) : (
                      <span className="pill p-warn"><span className="dot" />Needs work</span>
                    )}
                    {o.rally_idx !== null ? <span className="pill p-neutral mono">Rally {o.rally_idx}</span> : null}
                  </div>
                  <h3 className="h2">{o.title}</h3>
                  <p className="body">{o.detail}</p>
                  <div className="evid">
                    {o.t_s !== null ? <a href={`#t=${Math.max(0, o.t_s).toFixed(1)}`}>watch {mmss(o.t_s)}</a> : null}
                    {o.valence === "weakness" && !skillKeysWithBlueprint.has(o.skill_key) ? (
                      <BuildBlueprintButton analysisId={analysisId} observationId={o.id} />
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
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
