/**
 * Proof that a run is still alive, written by the run itself.
 *
 * See supabase/migrations/0014_run_heartbeat.sql for why this exists rather
 * than another timeout. The short version: a timeout catches a process that is
 * HUNG; nothing catches one that is GONE except something the live process was
 * actively writing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/db/types";

/**
 * How often the pulse is written.
 *
 * One row update every 15s is nothing next to a run that takes minutes, and
 * the interval has to be comfortably shorter than the staleness window so a
 * single dropped write never reads as death.
 */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * How quiet it must go before a run is presumed dead.
 *
 * Eight intervals. Generous on purpose: calling a LIVE run dead is much worse
 * than being slow to notice a dead one -- it would tell someone their analysis
 * failed while it was still working, and invite them to restart it on top of
 * itself. A stage that legitimately blocks for two minutes without the event
 * loop getting a turn does not exist here, because every long step is a
 * subprocess and the timer keeps ticking while Node waits on it.
 */
export const HEARTBEAT_DEAD_AFTER_MS = 120_000;

export interface Heartbeat {
  stop: () => void;
}

/**
 * Start pulsing for this analysis. Always pair with stop() in a finally.
 *
 * Failures are swallowed: a missed pulse means a reader waits a little longer
 * to call the run dead, whereas throwing from a timer would take down a run
 * that is working perfectly well. The heartbeat is diagnostics, and
 * diagnostics must never be able to cause the fault they describe.
 */
export function startHeartbeat(
  supabase: SupabaseClient<Database>,
  analysisId: string,
  intervalMs = HEARTBEAT_INTERVAL_MS
): Heartbeat {
  let stopped = false;

  const beat = async () => {
    if (stopped) return;
    await supabase
      .from("analyses")
      .update({ heartbeat_at: new Date().toISOString() })
      .eq("id", analysisId)
      .then(undefined, () => { /* see above */ });
  };

  void beat(); // one immediately, so a run is never born already stale
  const timer = setInterval(() => void beat(), intervalMs);
  // Never hold the process open on this timer's account: a leaked heartbeat
  // must not be the reason a container refuses to exit.
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export interface Liveness {
  /** True when the row says 'processing' but nothing has pulsed recently. */
  looksDead: boolean;
  /** Seconds since the last pulse, or null when this run never sent one. */
  quietForSeconds: number | null;
}

/**
 * Is this processing row backed by a live process?
 *
 * Pure, so the same rule can be applied on the server, in the view payload and
 * in a sweep without three subtly different definitions of "dead".
 *
 * A row with NO heartbeat at all is not called dead. It predates this column
 * or comes from an older build, and inventing a verdict from missing data is
 * how you tell someone a working run has failed.
 */
export function livenessOf(
  status: string,
  heartbeatAt: string | null,
  now: number = Date.now(),
  deadAfterMs: number = HEARTBEAT_DEAD_AFTER_MS
): Liveness {
  if (status !== "processing" && status !== "queued") {
    return { looksDead: false, quietForSeconds: null };
  }
  if (!heartbeatAt) return { looksDead: false, quietForSeconds: null };
  const last = Date.parse(heartbeatAt);
  if (!Number.isFinite(last)) return { looksDead: false, quietForSeconds: null };
  const quietMs = Math.max(0, now - last);
  return {
    looksDead: quietMs > deadAfterMs,
    quietForSeconds: Math.round(quietMs / 1000),
  };
}
