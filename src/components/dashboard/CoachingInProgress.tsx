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

/**
 * How long a run may sit with a read row and no further progress before the
 * page gives up waiting for the rest of it and shows what there is.
 */
const PARTIAL_AFTER_MS = 3 * 60 * 1000;

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
        // WAIT FOR THE WHOLE RUN, NOT FOR THE FIRST ROW OF IT.
        //
        // `hasCoachingRead` goes true the moment the read row is inserted --
        // which happens BEFORE the observations, before the clips are cut and
        // uploaded, and before the skill ratings are written. Refreshing there
        // landed the reader on a page with the read text and no ratings chart,
        // no clips and no coaching points, which then never appeared until
        // they reloaded by hand. Reported as "the skill ratings don't load at
        // the same time as the page".
        //
        // `coachingDone` is written once everything is in, so that is what
        // this waits for. The read row is kept only as a safety net: if it
        // exists and nothing has been written for a few minutes, the process
        // died after inserting it, and a partial page beats a spinner.
        const diedPartway = data.hasCoachingRead
          && data.progress?.updatedAt
          && Date.now() - new Date(data.progress.updatedAt).getTime() > PARTIAL_AFTER_MS;
        if (data.progress?.coachingDone || data.progress?.error || diedPartway) {
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
        rallies, technique, what to fix, the clip behind each point and your skill ratings.
        On a full game this takes a few minutes. The page opens when all of it is ready,
        rather than half of it now and half in a minute.
      </p>
      <p className="sm" style={{ margin: 0, color: "var(--ink-3)" }}>
        {message ?? "Starting…"}
        {mins !== null && mins > 0 ? ` · ${mins} min in` : ""}
      </p>
    </section>
  );
}
