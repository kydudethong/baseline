import os from "node:os";

/**
 * How busy the machine actually is, sampled per stage.
 *
 * WHY THIS EXISTS. The question "would running pose and player detection at
 * the same time make anything faster" has exactly one answer, and it is not a
 * matter of opinion: it depends on whether the detection stage already
 * saturates the box. If it does, running a second model alongside it
 * interleaves the same work and saves nothing. If half the cores sit idle, the
 * saving is close to the whole shorter stage.
 *
 * Checking by hand does not work. `cat /proc/loadavg` on a live machine
 * reported 0.00 — because nothing was running at that moment, and load average
 * is a one-minute ROLLING average, so a stage lasting 60 seconds has barely
 * moved the figure before it is over. The measurement has to happen from
 * inside the run, continuously, and be attributed to the stage it belongs to.
 *
 * Sampled rather than derived from /proc/stat deltas because load average is
 * the figure that answers the question directly -- "how many runnable
 * processes" against "how many cores" -- and it needs no bookkeeping between
 * calls that could itself drift.
 */
const SAMPLE_MS = 2_000;

export interface StageLoad {
  /** Peak 1-minute load average seen during the stage. */
  peak: number;
  mean: number;
  samples: number;
  cores: number;
}

export class LoadSampler {
  private readonly cores = os.cpus().length || 1;
  private samples: number[] = [];
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    if (this.timer) return;
    // unref so a sampler nobody stopped can never hold the process open --
    // telemetry must not be the reason a run fails to exit.
    this.timer = setInterval(() => this.samples.push(os.loadavg()[0]), SAMPLE_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Read and reset, so each stage reports only its own samples. */
  take(): StageLoad | null {
    const s = this.samples;
    this.samples = [];
    if (s.length === 0) return null;
    return {
      peak: Math.round(Math.max(...s) * 10) / 10,
      mean: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10,
      samples: s.length,
      cores: this.cores,
    };
  }
}

/**
 * The sentence the measurement is for.
 *
 * Deliberately states the CONCLUSION rather than just the number: a log line
 * reading "load 3.2 of 8" requires the reader to remember what that implies,
 * and the whole point of taking the measurement was to stop guessing.
 */
export function describeLoad(load: StageLoad | null): string {
  if (!load) return "";
  const used = load.peak / load.cores;
  const verdict = used >= 0.85
    ? "box saturated — running another model alongside this would save nothing"
    : used >= 0.55
      ? "partly loaded — overlapping another stage would save some, not all"
      : "mostly idle — overlapping another stage here should be close to free";
  return `load ${load.mean}/${load.peak} of ${load.cores} cores (${verdict})`;
}
