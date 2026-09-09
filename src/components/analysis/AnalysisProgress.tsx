"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ANALYSIS_STAGES, ANALYSIS_STAGE_LABELS, type AnalysisProgress as Progress, type AnalysisStage } from "@/lib/db/types";
import { Check } from "@/components/motifs/Motifs";
import { etaSentence, humanDuration, type Eta } from "@/lib/analysis/eta";

/**
 * What the pipeline is doing right now, while it does it.
 *
 * Two deliberate absences:
 *
 * NO PERCENTAGE. The pipeline genuinely does not know how far through it is —
 * ball detection alone varies with clip length, contact count and how much of
 * the ball was visible. A bar that invented a number would be the exact
 * dishonesty this product is built against. Stages a user can watch tick off
 * are both truthful and more informative.
 *
 * AN ETA IS NOT A PERCENTAGE, which is why one appears here and a bar still
 * does not. The percentage would be a claim about internal state nobody can
 * observe. The ETA is a claim about history — how long this user's previous
 * clips of this length actually took, from recorded start and finish times —
 * so it can be checked and it can be visibly wrong. When it IS wrong, the
 * sentence says so rather than freezing at "about a minute left", which is
 * the behaviour that teaches people to distrust progress UI.
 *
 * NO ASSUMED ORDER. A stage is shown as done only if the run actually reported
 * finishing it. Stages get skipped for real reasons (no ball model configured,
 * no audio track), and marking a skipped stage complete because the ones after
 * it ran would be a small lie in a product whose whole claim is that it does
 * not tell them.
 *
 * Polls the light `?progress=1` endpoint rather than refreshing the whole
 * server tree, which is what this replaced: a router.refresh() every 3 seconds
 * for four minutes, re-rendering eleven tables' worth of page to learn one
 * string.
 */
const POLL_MS = 2500;

export function AnalysisProgress({
  analysisId, initialStatus,
}: {
  analysisId: string;
  initialStatus: string;
}) {
  const router = useRouter();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [status, setStatus] = useState(initialStatus);
  const [unreachable, setUnreachable] = useState(false);
  const [eta, setEta] = useState<Eta | null>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  // Ticks once a second purely so elapsed time moves. The poll is every few
  // seconds and stays that way; a clock that only advanced when the network
  // answered would stutter.
  const [now, setNow] = useState(() => Date.now());
  const finished = useRef(false);

  useEffect(() => {
    if (status !== "processing" && status !== "queued") return;
    let alive = true;

    const tick = async () => {
      try {
        const res = await fetch(`/api/analyses/${analysisId}/view?progress=1`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json() as {
          status: string; progress: Progress | null;
          eta?: Eta | null; startedAt?: string | null;
        };
        if (!alive) return;
        setUnreachable(false);
        setProgress(data.progress);
        setStatus(data.status);
        setEta(data.eta ?? null);
        setStartedAt(data.startedAt ?? null);
        // The run ended. Re-render the page once so the finished analysis (or
        // the failure) replaces this panel, then stop polling.
        if (data.status !== "processing" && data.status !== "queued" && !finished.current) {
          finished.current = true;
          router.refresh();
        }
      } catch {
        // A dropped poll is not a failed analysis: the run continues on the
        // server whatever the browser can reach. Say so rather than implying
        // the work was lost.
        if (alive) setUnreachable(true);
      }
    };

    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [analysisId, status, router]);

  useEffect(() => {
    if (status !== "processing" && status !== "queued") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  if (status !== "processing" && status !== "queued") return null;

  // Elapsed comes off the server's started_at, not a timer started when this
  // component mounted. The user may have closed the tab and come back, and a
  // clock that restarted at zero on every visit would say the run had just
  // begun when it was four minutes in.
  const elapsedS = startedAt ? Math.max(0, (now - new Date(startedAt).getTime()) / 1000) : null;

  const done = new Set<AnalysisStage>(progress?.completedStages ?? []);
  const current = progress?.stage ?? null;
  // Only stages that have actually happened, plus the one running. Listing all
  // twelve up front would promise work that may legitimately be skipped.
  const visible = ANALYSIS_STAGES.filter((s) => done.has(s) || s === current);

  return (
    <section className="card stack g3">
      <div className="row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "nowrap", alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <p className="eyebrow">Analysing</p>
          <p className="sm" style={{ margin: 0 }}>
            {etaSentence(eta, elapsedS ?? 0)} You can leave this page — the analysis
            keeps running and will be here when you come back.
          </p>
        </div>
        {elapsedS !== null ? (
          <p className="xs num" style={{ margin: 0, whiteSpace: "nowrap" }}>
            {humanDuration(elapsedS)} elapsed
          </p>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <p className="sm">Starting up…</p>
      ) : (
        <div className="stages">
          {visible.map((s) => {
            const isNow = s === current;
            return (
              <div key={s} className={`stage-row${isNow ? " now" : " done"}`}>
                <span className="stage-mk">{!isNow ? <Check /> : null}</span>
                <span>{ANALYSIS_STAGE_LABELS[s]}</span>
                {isNow && progress?.message ? <span className="stage-msg">{progress.message}</span> : null}
              </div>
            );
          })}
        </div>
      )}

      {unreachable ? (
        <p className="xs">
          Lost contact with the server for a moment — the analysis is still running.
        </p>
      ) : null}
    </section>
  );
}
