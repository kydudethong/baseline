import Link from "next/link";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getActiveBlueprintsForUser } from "@/lib/db/blueprints";
import { completedAnalysisMeta, getRankedWeaknesses, getSkillProfiles } from "@/lib/coaching/stats";

export const metadata: Metadata = { title: "Practice — Baseline" };
export const dynamic = "force-dynamic";

const GROUP_ORDER = ["Kitchen", "Movement", "Serve & return", "Offense", "Decisions", "Defense"];

const TREND_LABEL: Record<"up" | "down" | "flat", string> = {
  up: "↑ improving",
  down: "↓ slipping",
  flat: "→ steady",
};

export default async function PracticePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const metaById = await completedAnalysisMeta(supabase, user.id);
  const completedCount = metaById.size;

  if (completedCount === 0) {
    return (
      <div className="sec">
        <div className="stack g1">
          <span className="eyebrow">Practice</span>
          <h1 className="h1">What to work on</h1>
        </div>
        <div className="empty">
          <p className="h3">Nothing to show yet</p>
          <p className="sm measure">
            This page pulls your recurring weaknesses and skill ratings across every game you&apos;ve analyzed.
            Finish processing at least one game and it&apos;ll build itself.
          </p>
          <Link href="/dashboard/library" className="btn btn-primary">
            Go to your library
          </Link>
        </div>
      </div>
    );
  }

  const [weaknesses, profiles, blueprints] = await Promise.all([
    getRankedWeaknesses(supabase, user.id, 8, metaById),
    getSkillProfiles(supabase, user.id, metaById),
    getActiveBlueprintsForUser(supabase, user.id),
  ]);

  const ratedProfiles = profiles.filter((p) => p.weightedAvg !== null);
  const profilesByGroup = GROUP_ORDER.map((group) => ({
    group,
    skills: ratedProfiles.filter((p) => p.group === group).sort((a, b) => (a.weightedAvg ?? 0) - (b.weightedAvg ?? 0)),
  })).filter((g) => g.skills.length > 0);

  return (
    <div className="sec">
      <div className="stack g1">
        <span className="eyebrow">Practice</span>
        <h1 className="h1">What to work on</h1>
        <p className="sm measure">
          Weighted across your {completedCount} completed game{completedCount === 1 ? "" : "s"} — your most recent
          games count for more than your first ones.
        </p>
      </div>

      <div className="sec">
        <div className="sec-head">
          <h2 className="h2">Recurring weaknesses</h2>
          <span className="count xs">{weaknesses.length}</span>
        </div>
        {weaknesses.length === 0 ? (
          <div className="note">No recurring weaknesses surfaced yet — nice work.</div>
        ) : (
          <div className="stack g3">
            {weaknesses.map((w) => (
              <div key={w.skillKey} className="weak">
                <div className="stripe" />
                <div className="in">
                  <span className="eyebrow">{w.name}</span>
                  <p className="h3">{w.mostRecent.title}</p>
                  <p className="sm">{w.mostRecent.detail}</p>
                  <div className="evid">
                    <Link href={`/dashboard/${w.mostRecent.analysisId}`}>
                      most recent: {w.mostRecent.analysisTitle}
                    </Link>
                    <span className="chip">shown up {w.occurrences}×</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {profilesByGroup.length > 0 ? (
        <div className="sec">
          <div className="sec-head">
            <h2 className="h2">Skill ratings over time</h2>
          </div>
          <div className="grid2">
            {profilesByGroup.map(({ group, skills }) => (
              <div key={group} className="card stack g4">
                <span className="eyebrow">{group}</span>
                {skills.map((s) => {
                  const pct = Math.max(0, Math.min(100, ((s.weightedAvg ?? 0) / 5) * 100));
                  return (
                    <div key={s.skillKey} className="meter">
                      <div className="meter-top">
                        <span className="nm">{s.name}</span>
                        <span className="sc">
                          {s.weightedAvg}
                          <small>/5</small>
                        </span>
                      </div>
                      <div className="track">
                        <div className="fill" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="meter-foot">
                        <span>
                          {s.analysesRated} game{s.analysesRated === 1 ? "" : "s"} rated
                        </span>
                        {s.trend ? <span className={`trend ${s.trend}`}>{TREND_LABEL[s.trend]}</span> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="sec">
        <div className="sec-head">
          <h2 className="h2">Active practice plans</h2>
        </div>
        {blueprints.length === 0 ? (
          <div className="note">
            No active practice plan yet — open a weakness on any completed game&apos;s Skills tab and build one.
          </div>
        ) : (
          <div className="stack g5">
            {blueprints.map(({ blueprint, steps }) => {
              const doneCount = steps.filter((s) => s.done_at).length;
              const nextStep = steps.find((s) => !s.done_at);
              return (
                <div key={blueprint.id} className="card stack g3">
                  <div className="row g3" style={{ justifyContent: "space-between" }}>
                    <div className="stack g1">
                      <span className="eyebrow">{blueprint.title}</span>
                      <p className="h3">{blueprint.goal}</p>
                    </div>
                    <span className="chip">
                      {doneCount}/{steps.length} done
                    </span>
                  </div>
                  <div className="bp">
                    {steps.map((step) => {
                      const done = Boolean(step.done_at);
                      const isNext = !done && step.id === nextStep?.id;
                      return (
                        <div key={step.id} className={`bp-step${done ? " done" : ""}${isNext ? " next" : ""}`}>
                          <span className="bp-mk">{done ? "✓" : step.idx + 1}</span>
                          <div className="bp-body">
                            <span className="focus">{step.focus}</span>
                            <span className="dn">{step.drill_name}</span>
                            <span className="xs">{step.target}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {blueprint.analysis_id ? (
                    <Link href={`/dashboard/${blueprint.analysis_id}?tab=plan`} className="crumb">
                      Manage this plan →
                    </Link>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
