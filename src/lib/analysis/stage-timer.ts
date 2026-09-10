/**
 * Where an analysis run's wall-clock time actually goes.
 *
 * Written because every performance claim about this pipeline so far has been
 * inferred from reading the code -- "ball detection runs on every frame, so it
 * must dominate" -- and inference is how you spend a day optimising the second
 * biggest cost. The pipeline already announces each stage it enters; this
 * measures the gaps between those announcements.
 *
 * WALL CLOCK, deliberately, not CPU time. Most of the work happens in Python
 * subprocesses and ffmpeg, so CPU time in this process would report close to
 * zero for the expensive parts. Wall clock is also what the user actually
 * waits through, which is the number the ETA has to predict.
 *
 * The important design decision is that shares are of the WHOLE run, not of
 * measured time, and whatever the stages fail to account for is reported as
 * its own line. Normalising to 100% would produce a breakdown that always
 * looks complete -- and the first thing you want to know about a
 * seven-minute run where the stages add up to four minutes is where the other
 * three went, which is exactly the fact that normalising destroys.
 */

export interface StageTiming {
  stage: string;
  seconds: number;
  /** Fraction of the whole run, 0..1. Shares sum to 1 across all rows. */
  share: number;
}

const round = (n: number, dp = 1) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Name used for the row covering time no stage claimed. */
export const UNACCOUNTED = "unaccounted";

export class StageTimer {
  private readonly startedAt: number;
  private readonly closed: Array<{ stage: string; ms: number }> = [];
  private open: { stage: string; at: number } | null = null;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.startedAt = now();
  }

  /**
   * Close whatever stage is running and start this one.
   *
   * Re-entering a stage adds to its total rather than replacing it: the
   * pipeline genuinely returns to "ball" for the in-rally rescan, and two
   * separate rows for one stage would be harder to read than one sum.
   */
  mark(stage: string): void {
    const at = this.now();
    if (this.open) this.closed.push({ stage: this.open.stage, ms: at - this.open.at });
    this.open = { stage, at };
  }

  /** Close the running stage without starting another. Safe to call twice. */
  end(): void {
    if (!this.open) return;
    this.closed.push({ stage: this.open.stage, ms: this.now() - this.open.at });
    this.open = null;
  }

  /** Whole-run wall clock so far, in seconds. */
  totalSeconds(): number {
    return (this.now() - this.startedAt) / 1000;
  }

  /**
   * The breakdown, largest first, with an `unaccounted` row when the stages
   * do not cover the whole run.
   *
   * Calling this closes the running stage -- forgetting to close the last one
   * is the obvious way to lose the most interesting measurement, so it is not
   * left to the caller to remember.
   */
  breakdown(): StageTiming[] {
    this.end();
    const total = Math.max(1, this.now() - this.startedAt);

    const byStage = new Map<string, number>();
    for (const { stage, ms } of this.closed) {
      byStage.set(stage, (byStage.get(stage) ?? 0) + ms);
    }

    const measured = [...byStage.values()].reduce((a, b) => a + b, 0);
    // Clamped at zero: a clock that goes backwards, or rounding on a very
    // short run, must not produce a negative row.
    const missing = Math.max(0, total - measured);
    // Below a second is noise, not a finding. Reporting "unaccounted: 0.2s"
    // on every run trains people to ignore the row that matters.
    if (missing > 1000) byStage.set(UNACCOUNTED, missing);

    return [...byStage.entries()]
      .map(([stage, ms]) => ({
        stage,
        seconds: round(ms / 1000),
        share: ms / total,
      }))
      .sort((a, b) => b.seconds - a.seconds);
  }

  /**
   * One line for the log: "ball 182.4s (61%) · players 54.1s (18%) · …".
   *
   * Trailing stages under 1% are dropped from the line but not from
   * breakdown() -- a dozen sub-second rows push the interesting ones off the
   * end of a terminal, and anything that small is not the reason a run is
   * slow.
   */
  summary(): string {
    const rows = this.breakdown();
    if (rows.length === 0) return "no stages recorded";
    const shown = rows.filter((r) => r.share >= 0.01);
    const hidden = rows.length - shown.length;
    const parts = (shown.length ? shown : rows.slice(0, 1))
      .map((r) => `${r.stage} ${r.seconds}s (${Math.round(r.share * 100)}%)`);
    if (hidden > 0) parts.push(`+${hidden} under 1%`);
    return parts.join(" · ");
  }
}
