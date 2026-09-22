"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The coaching read is being written. Says so, and refreshes when it lands.
 *
 * WHY THIS EXISTS. The analysis is marked "completed" the moment the CV run
 * finishes -- deliberately, so a failing read cannot turn a good run into a
 * failed one -- and the Gemini pass starts AFTER that and runs for several
 * minutes on a full game. The progress poller stopped at "completed" and
 * refreshed the page once, which landed on a Completed badge over empty
 * panels while the read was still being written, with nothing to say so and
 * nothing to update the page when it finished.
 *
 * Reported as "it doesn't show anything". It was not broken; it was not done,
 * and the page claimed it was.
 */

const POLL_MS = 5000;

/**
 * How long without a progress write before this stops saying "working on it".
 *
 * Generous, because a single Gemini call on a two-minute segment can take a
 * few minutes and writes nothing while it runs. Past this, the process behind
 * it has almost certainly died -- a deploy, an out-of-memory kill -- and a
 * spinner that never resolves is worse than saying so.
 */
const STALE_AFTER_MS = 20 * 60 * 1000;

export function CoachingInProgress({
  analysisId,
  startedAt,
}: {
  analysisId: string;
  /** When the coaching stage was last written, from progress.updatedAt. */
  startedAt: string | null;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [lastWrite, setLastWrite] = useState<string | null>(startedAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/analyses/${analysisId}/view?progress=1`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as {
          hasCoachingRead?: boolean;
          progress?: { message?: string; error?: string; coachingDone?: boolean; updatedAt?: string } | null;
        };
        if (!alive) return;
        // Done either way: a read to show, or a failure to explain. Both are
        // rendered by the server page, so one refresh and this unmounts.
        if (data.hasCoachingRead || data.progress?.coachingDone || data.progress?.error) {
          router.refresh();
          return;
        }
        setMessage(data.progress?.message ?? null);
        setLastWrite(data.progress?.updatedAt ?? null);
      } catch {
        // A dropped poll is not a failed read; the run carries on regardless.
      }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; clearInterval(id); clearInterval(clock); };
  }, [analysisId, router]);

  const since = lastWrite ? now - new Date(lastWrite).getTime() : null;
  const stale = since !== null && since > STALE_AFTER_MS;

  if (stale) {
    // Handed back to the server page, which offers the retry.
    return (
      <div className="errbox">
        <p className="errbox-t">The coaching read stopped partway through</p>
        <p className="errbox-b">
          Nothing has been written for over twenty minutes, so the server running it was
          almost certainly restarted. Use “Change who you are” at the top and save to run
          it again — it does not use any of your minutes.
        </p>
      </div>
    );
  }

  const mins = since !== null ? Math.floor(since / 60000) : null;
  return (
    <section className="card stack g3">
      <p className="eyebrow">Writing your coaching read</p>
      <div className="progress indet"><div className="bar" /></div>
      <p className="sm" style={{ margin: 0 }}>
        The tracking is done. Baseline is now watching the game and writing your read —
        rallies, technique, what to fix and the drill for it. On a full game this takes a
        few minutes. This page will update by itself when it&apos;s ready.
      </p>
      <p className="sm" style={{ margin: 0, color: "var(--ink-3)" }}>
        {message ?? "Starting…"}
        {mins !== null && mins > 0 ? ` · ${mins} min in` : ""}
      </p>
    </section>
  );
}
