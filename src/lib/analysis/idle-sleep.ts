/**
 * Stop this machine when nothing is happening, so idle hours cost nothing.
 *
 * WHY THIS EXISTS RATHER THAN FLY'S OWN AUTOSTOP. Fly can stop a machine when
 * its proxy sees no inbound traffic, and start it again on the next request.
 * The starting half is exactly right and this file does not touch it. The
 * stopping half is unusable here, and Fly's own documentation says why:
 *
 *   "There's also no way for your application to tell the proxy, 'I'm busy,
 *    leave me alone.'"
 *
 * An analysis runs on the Node event loop for minutes AFTER its HTTP response
 * has gone back, so to the proxy a machine deep in a run looks identical to an
 * idle one, and autostop would kill runs. Self-pinging does not help either;
 * the same docs say so explicitly.
 *
 * So the machine decides for itself. It knows two things the proxy cannot: how
 * many runs are in flight -- authoritatively, because they live in THIS
 * process's memory -- and when it last served a request.
 *
 * OFF unless FLY_API_TOKEN, FLY_APP_NAME and FLY_MACHINE_ID are all present,
 * which is the right failure mode: not sleeping costs money, sleeping mid-run
 * costs someone their analysis.
 */

const DEFAULT_IDLE_MINUTES = 20;

/**
 * Runs currently in memory on this machine.
 *
 * A counter rather than a database query, deliberately. The database knows
 * which analyses are marked 'processing', but that set includes runs stranded
 * by an earlier machine restart -- which would keep this machine awake
 * indefinitely over work that no longer exists. What must not be interrupted
 * is what is running HERE, and this process is the only thing that knows it.
 */
/**
 * ON globalThis, NOT IN MODULE SCOPE, and this is the whole bug.
 *
 * The watchdog is started from instrumentation.ts; runStarted() is called from
 * a route handler. Next.js does not guarantee those share one instance of this
 * module -- and they did not. The pipeline incremented `activeRuns` in its
 * copy, the watchdog read `activeRuns` in a different copy, saw 0, and
 * reported "no runs in flight" about a run that was two thirds of the way
 * through rendering an overlay.
 *
 * It then SIGINTed the machine out from under it. Every long analysis died
 * this way, and the message it left behind -- "stopped responding, its server
 * was almost certainly restarted or ran out of memory" -- was right about the
 * restart and pointed at the wrong culprit, because the thing doing the
 * restarting was us.
 *
 * globalThis is the one scope Next cannot duplicate.
 */
interface ProcessState { activeRuns: number; lastRequestAt: number }
const STATE_KEY = Symbol.for("baseline.idle-sleep.state");
function state(): ProcessState {
  const g = globalThis as unknown as Record<symbol, ProcessState | undefined>;
  return (g[STATE_KEY] ??= { activeRuns: 0, lastRequestAt: Date.now() });
}

let timer: ReturnType<typeof setInterval> | null = null;
let stopping = false;

export function runStarted(): void {
  const st = state();
  st.activeRuns++;
  st.lastRequestAt = Date.now();
}

export function runFinished(): void {
  const st = state();
  // Clamped at zero: a double-call must not drive the count negative, because
  // a later real run would then be treated as already finished and the
  // machine could sleep underneath it.
  st.activeRuns = Math.max(0, st.activeRuns - 1);
  st.lastRequestAt = Date.now();
}

export function noteRequest(): void {
  state().lastRequestAt = Date.now();
}

export function activeRunCount(): number {
  return state().activeRuns;
}

export interface IdleState {
  activeRuns: number;
  idleMs: number;
  shouldSleep: boolean;
}

/** Pure, so the decision is testable without a clock or a network. */
export function idleState(
  now: number,
  lastAt: number,
  runs: number,
  idleMs: number
): IdleState {
  const idle = Math.max(0, now - lastAt);
  return { activeRuns: runs, idleMs: idle, shouldSleep: runs === 0 && idle >= idleMs };
}

export function idleMinutes(): number {
  const raw = Number(process.env.IDLE_SLEEP_MINUTES ?? DEFAULT_IDLE_MINUTES);
  // A zero or negative threshold would stop the machine the instant it
  // booted, before anyone could reach it -- a loop with no way out from
  // outside except flyctl.
  return Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_IDLE_MINUTES;
}

/**
 * Why the watchdog is off, or null when it is on.
 *
 * Separate from the boolean because "no log line appeared" is a useless
 * symptom: it reads the same whether the code never shipped or shipped and
 * decided to do nothing. A feature whose failure mode is silence cannot be
 * debugged from the outside, and this one's failure mode costs money quietly.
 */
export function idleSleepDisabledReason(): string | null {
  if ((process.env.IDLE_SLEEP ?? "on").toLowerCase() === "off") return "IDLE_SLEEP=off";
  const missing = (["FLY_API_TOKEN", "FLY_APP_NAME", "FLY_MACHINE_ID"] as const)
    .filter((k) => !process.env[k]);
  if (missing.length) {
    return `${missing.join(", ")} not set`
      + (missing.includes("FLY_APP_NAME") || missing.includes("FLY_MACHINE_ID")
        ? " (Fly injects those two itself, so this is probably not running on Fly)"
        : " (create one: fly tokens create deploy --name idle-sleep --expiry 8760h)");
  }
  return null;
}

export function idleSleepEnabled(): boolean {
  return idleSleepDisabledReason() === null;
}

/**
 * Ask Fly to stop this machine.
 *
 * Over 6PN via _api.internal, so the token never leaves Fly's private network.
 * SIGINT with a timeout lets Node close cleanly; nothing depends on that,
 * because the caller has already established there is no work to lose.
 */
async function stopSelf(): Promise<void> {
  const host = process.env.FLY_API_HOSTNAME || "http://_api.internal:4280";
  const app = process.env.FLY_APP_NAME;
  const machine = process.env.FLY_MACHINE_ID;
  const res = await fetch(`${host}/v1/apps/${app}/machines/${machine}/stop`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.FLY_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ signal: "SIGINT", timeout: "30s" }),
  });
  if (!res.ok) {
    throw new Error(`Fly refused the stop (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

/**
 * Start watching. Safe to call repeatedly; only the first call takes effect.
 *
 * The check is on an interval rather than at the end of each run, so a machine
 * woken by a request that never becomes a run still goes back to sleep.
 */
export function startIdleWatchdog(stop: () => Promise<void> = stopSelf): void {
  if (timer) return;
  const off = idleSleepDisabledReason();
  if (off) {
    // Say so. Locally this is the expected state and the line is noise worth
    // paying; on Fly it is the difference between "it is working" and "it has
    // been billing you by the hour for a week".
    console.error(`[idle] watchdog OFF — ${off}`);
    return;
  }
  const ms = idleMinutes() * 60_000;

  timer = setInterval(() => {
    if (stopping) return;
    const st = state();
    const decision = idleState(Date.now(), st.lastRequestAt, st.activeRuns, ms);
    if (!decision.shouldSleep) return;
    stopping = true;
    console.error(
      `[idle] ${Math.round(decision.idleMs / 60_000)} min without a request and `
      // The COUNT, not the word "no". "No runs in flight" is a claim, and when
      // it was wrong there was nothing in the log to say so -- the line read
      // identically whether the counter was right or had never been
      // incremented in this copy of the module.
      + `${decision.activeRuns} run(s) in flight — `
      + "stopping this machine. The next visitor wakes it (auto_start_machines)."
    );
    void stop().catch((err) => {
      // Failing to sleep costs money, not correctness, so it must never take
      // the app down with it. Reset and try again on the next tick.
      stopping = false;
      console.error(`[idle] could not stop the machine: ${(err as Error).message}`);
    });
  }, Math.min(ms, 60_000));

  // Never hold the process open on this timer's account.
  timer.unref?.();
  console.error(`[idle] watchdog on — sleeping after ${idleMinutes()} idle minutes`);
}

/** Testing seam: forget all state between cases. */
export function __resetIdleState(): void {
  if (timer) clearInterval(timer);
  timer = null;
  const st = state();
  st.activeRuns = 0;
  st.lastRequestAt = Date.now();
  stopping = false;
}
