import Link from "next/link";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { listAnalysisSummariesForUser } from "@/lib/db/analyses";
import { getRankedWeaknesses } from "@/lib/coaching/stats";
import { StatusBadge } from "@/components/dashboard/StatusBadge";

export const metadata: Metadata = { title: "Home — Baseline" };
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null; // layout already redirects unauthenticated requests

  const analyses = await listAnalysisSummariesForUser(supabase, user.id);
  const completedCount = analyses.filter((a) => a.status === "completed").length;
  const inFlightCount = analyses.filter((a) => a.status === "queued" || a.status === "processing").length;
  const mostRecent = analyses[0] ?? null;
  const weaknesses = completedCount > 0 ? await getRankedWeaknesses(supabase, user.id, 3) : [];

  if (analyses.length === 0) {
    return (
      <div className="sec">
        <div className="stack g1">
          <span className="eyebrow">Home</span>
          <h1 className="h1">Let&apos;s break down your first game</h1>
        </div>
        <div className="empty">
          <p className="h3">Nothing analyzed yet</p>
          <p className="sm measure">
            Upload a recording of a match and Baseline will track court positioning, footwork, and readiness
            patterns — the way a coach would.
          </p>
          <Link href="/dashboard/new" className="btn btn-primary">
            Analyze your first game
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="sec">
      <div className="stack g1">
        <span className="eyebrow">Home</span>
        <h1 className="h1">Your game, at a glance</h1>
      </div>

      <div className="scoreboard-row">
        <div className="cell">
          <div className="num">{analyses.length}</div>
          <div className="lbl">Game{analyses.length === 1 ? "" : "s"} uploaded</div>
        </div>
        <div className="cell">
          <div className="num">{completedCount}</div>
          <div className="lbl">Ready</div>
        </div>
        <div className="cell">
          <div className="num">{inFlightCount}</div>
          <div className="lbl">Processing</div>
        </div>
      </div>

      {mostRecent ? (
        <div className="sec">
          <div className="sec-head">
            <h2 className="h2">Most recent</h2>
          </div>
          <Link
            href={`/dashboard/${mostRecent.id}`}
            className="card row g4"
            style={{ justifyContent: "space-between", textDecoration: "none", color: "inherit" }}
          >
            <div className="stack g1" style={{ minWidth: 0 }}>
              <p className="h3" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {mostRecent.title}
              </p>
              <p className="xs">
                {new Date(mostRecent.created_at).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </p>
            </div>
            <StatusBadge status={mostRecent.status} />
          </Link>
        </div>
      ) : null}

      <div className="sec">
        <div className="sec-head">
          <h2 className="h2">What to work on</h2>
          {weaknesses.length > 0 ? (
            <Link href="/dashboard/practice" className="crumb mla">
              See your full practice plan →
            </Link>
          ) : null}
        </div>
        {weaknesses.length === 0 ? (
          <div className="note">
            {completedCount === 0
              ? "Once a game finishes processing, your top priorities will show up here."
              : "No recurring weaknesses found yet across your completed games — keep uploading to build a fuller picture."}
          </div>
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
                      seen in {w.mostRecent.analysisTitle}
                    </Link>
                    {w.occurrences > 1 ? (
                      <span className="chip">shown up {w.occurrences}×</span>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
