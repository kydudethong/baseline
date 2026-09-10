/**
 * The runs happening on this machine, so one of them can be stopped.
 *
 * Stopping an analysis is not a matter of setting a flag and checking it in a
 * loop, because there is almost no JavaScript loop to check it in. A run
 * spends its minutes blocked on Python subprocesses -- ball detection over
 * every frame, rally_seg's own pass, pose estimation. A flag consulted between
 * stages would leave "stop" meaning "in up to four minutes, stop", which is
 * not what a person pressing a button means.
 *
 * So cancellation is an AbortSignal, and every subprocess is spawned with it.
 * Node kills the child when the signal aborts, the awaited promise rejects,
 * and the run unwinds through its existing error path within a second or two.
 *
 * IN MEMORY, deliberately, and correct for the same reason the idle watchdog's
 * counter is: a run lives in one process, so the only thing that can stop it
 * is that process. Nothing here survives a restart -- and nothing needs to,
 * because neither does the run. A "processing" row with no entry here is a
 * run that died with its machine, which is what the stale-run window exists
 * to clear.
 */

export class RunCancelledError extends Error {
  readonly cancelled = true;
  constructor(message = "Analysis stopped.") {
    super(message);
    this.name = "RunCancelledError";
  }
}

export function isCancellation(err: unknown): boolean {
  if (err instanceof RunCancelledError) return true;
  // Node rejects an aborted child process with AbortError, and the pipeline
  // has several layers that wrap errors on the way up. Recognising the name
  // as well as the type keeps a cancelled run from being reported as a crash.
  const e = err as { name?: string; cancelled?: boolean } | null;
  return Boolean(e && (e.cancelled === true || e.name === "AbortError"));
}

const running = new Map<string, AbortController>();

/**
 * Register a run and get the signal it should thread everywhere.
 *
 * A second call for an analysis already running aborts the first. That
 * combination should not happen -- the route refuses to start a run on a
 * "processing" row -- but if it ever does, two pipelines writing results for
 * one analysis is a worse outcome than losing the older one.
 */
export function beginRun(analysisId: string): AbortController {
  running.get(analysisId)?.abort(new RunCancelledError("Replaced by a newer run."));
  const controller = new AbortController();
  running.set(analysisId, controller);
  return controller;
}

/** Release the slot. Safe to call for an id that is not registered. */
export function endRun(analysisId: string, controller?: AbortController): void {
  // Only clear the entry if it is still OURS. Without this check, a run that
  // was replaced would delete its successor's registration on the way out,
  // and the successor would become uncancellable.
  const current = running.get(analysisId);
  if (!current || (controller && current !== controller)) return;
  running.delete(analysisId);
}

/**
 * Stop a run on this machine. False when there is nothing to stop.
 *
 * False is not an error and the caller should not treat it as one: it means
 * the run already finished, or it belonged to a machine that has since
 * restarted. Either way the honest reply to the user is the same -- it is not
 * running any more.
 */
export function cancelRun(analysisId: string, reason = "Analysis stopped."): boolean {
  const controller = running.get(analysisId);
  if (!controller) return false;
  controller.abort(new RunCancelledError(reason));
  running.delete(analysisId);
  return true;
}

/**
 * The signal every subprocess started by the current run should honour.
 *
 * Module-level rather than a parameter on each of the dozen spawn sites. The
 * alternative is threading an AbortSignal through every helper and every
 * caller of every helper, where ONE missed call site is an unkillable
 * four-minute Python process -- the exact thing cancelling exists to stop. One
 * place to set it is one place to get it wrong.
 *
 * Correct because the machine runs one analysis at a time; a run has this
 * process to itself. If that ever stops being true this has to become per-run
 * state keyed by analysis id, and the spawn sites have to take it as an
 * argument after all.
 */
let activeSignal: AbortSignal | undefined;

export function setActiveRunSignal(signal: AbortSignal | undefined): void {
  activeSignal = signal;
}

/**
 * Clear the active signal, but only if it is still the one you set.
 *
 * The same trap endRun() guards: a run that was replaced eventually unwinds,
 * and if it cleared unconditionally it would strip the signal off its
 * SUCCESSOR -- whose subprocesses would then spawn unkillable. Clearing
 * conditionally makes the late finally harmless.
 */
export function clearActiveRunSignal(signal: AbortSignal | undefined): void {
  if (!signal || activeSignal === signal) activeSignal = undefined;
}

export function activeRunSignal(): AbortSignal | undefined {
  return activeSignal;
}

export function isRunning(analysisId: string): boolean {
  return running.has(analysisId);
}

export function runningCount(): number {
  return running.size;
}

/** Testing seam. */
export function __resetRunRegistry(): void {
  running.clear();
  activeSignal = undefined;
}
