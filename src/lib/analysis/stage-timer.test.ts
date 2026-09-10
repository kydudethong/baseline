import assert from "node:assert/strict";
import test from "node:test";

import { StageTimer, UNACCOUNTED } from "./stage-timer";

/** A clock the test drives by hand, so nothing here depends on real time. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test("each stage is measured from its mark to the next one", () => {
  const c = fakeClock();
  const timer = new StageTimer(c.now);
  timer.mark("court"); c.advance(2_000);
  timer.mark("players"); c.advance(8_000);
  timer.mark("ball"); c.advance(30_000);
  const rows = timer.breakdown();
  assert.deepEqual(
    rows.map((r) => [r.stage, r.seconds]),
    [["ball", 30], ["players", 8], ["court", 2]]
  );
});

test("the breakdown is sorted with the most expensive stage first", () => {
  const c = fakeClock();
  const timer = new StageTimer(c.now);
  timer.mark("a"); c.advance(1_000);
  timer.mark("b"); c.advance(50_000);
  timer.mark("c"); c.advance(10_000);
  assert.deepEqual(timer.breakdown().map((r) => r.stage), ["b", "c", "a"]);
});

test("the last stage is closed by breakdown, not lost", () => {
  // The obvious way to lose the most interesting measurement is to forget to
  // close the stage that was running when the pipeline finished.
  const c = fakeClock();
  const timer = new StageTimer(c.now);
  timer.mark("ball"); c.advance(60_000);
  const rows = timer.breakdown();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seconds, 60);
});

test("re-entering a stage adds to it rather than starting a second row", () => {
  // The pipeline really does return to "ball" for the in-rally rescan.
  const c = fakeClock();
  const timer = new StageTimer(c.now);
  timer.mark("ball"); c.advance(10_000);
  timer.mark("rallies"); c.advance(4_000);
  timer.mark("ball"); c.advance(6_000);
  const rows = timer.breakdown();
  assert.deepEqual(rows.map((r) => [r.stage, r.seconds]), [["ball", 16], ["rallies", 4]]);
});

test("time no stage claimed is reported, not absorbed", () => {
  // The whole point. A run whose stages cover four minutes of seven should
  // say where the other three went.
  const c = fakeClock();
  c.advance(0);
  const timer = new StageTimer(c.now);
  c.advance(120_000);            // before any stage was marked
  timer.mark("ball"); c.advance(60_000);
  const rows = timer.breakdown();
  const gap = rows.find((r) => r.stage === UNACCOUNTED);
  assert.ok(gap, "expected an unaccounted row");
  assert.equal(gap!.seconds, 120);
});

test("shares are of the whole run, so they include the gap", () => {
  const c = fakeClock();
  const timer = new StageTimer(c.now);
  c.advance(50_000);
  timer.mark("ball"); c.advance(50_000);
  const rows = timer.breakdown();
  // Not 100% for ball, which is what normalising over measured time would say.
  const ball = rows.find((r) => r.stage === "ball")!;
  assert.ok(Math.abs(ball.share - 0.5) < 0.01, `ball share was ${ball.share}`);
  const sum = rows.reduce((n, r) => n + r.share, 0);
  assert.ok(Math.abs(sum - 1) < 0.01, `shares summed to ${sum}`);
});

test("a sub-second gap is not reported as a finding", () => {
  const c = fakeClock();
  const timer = new StageTimer(c.now);
  c.advance(200);
  timer.mark("ball"); c.advance(60_000);
  assert.ok(!timer.breakdown().some((r) => r.stage === UNACCOUNTED));
});

test("summary names the big stages with their share", () => {
  const c = fakeClock();
  const timer = new StageTimer(c.now);
  timer.mark("ball"); c.advance(80_000);
  timer.mark("players"); c.advance(20_000);
  const line = timer.summary();
  assert.match(line, /ball 80s \(80%\)/);
  assert.match(line, /players 20s \(20%\)/);
});

test("summary collapses the rows too small to be the reason a run is slow", () => {
  const c = fakeClock();
  const timer = new StageTimer(c.now);
  timer.mark("ball"); c.advance(100_000);
  timer.mark("tiny"); c.advance(100);
  timer.mark("tinier"); c.advance(100);
  const line = timer.summary();
  assert.match(line, /\+2 under 1%/);
  // Still present in the data, just not in the one-liner.
  assert.equal(timer.breakdown().length, 3);
});

test("a timer that recorded nothing says so instead of dividing by zero", () => {
  const timer = new StageTimer(fakeClock().now);
  assert.equal(timer.summary(), "no stages recorded");
  assert.deepEqual(timer.breakdown(), []);
});

test("end is safe to call more than once", () => {
  const c = fakeClock();
  const timer = new StageTimer(c.now);
  timer.mark("ball"); c.advance(5_000);
  timer.end(); c.advance(5_000);
  timer.end();
  assert.equal(timer.breakdown().find((r) => r.stage === "ball")!.seconds, 5);
});
