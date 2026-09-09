import test from "node:test";
import assert from "node:assert/strict";
import { estimateRuntime, etaSentence, humanDuration, FALLBACK_RATE, type RunSample } from "./eta";

const samples = (rates: number[], videoSeconds = 60): RunSample[] =>
  rates.map((r) => ({ videoSeconds, wallSeconds: videoSeconds * r }));

test("no history falls back to the documented constant, flagged as such", () => {
  const eta = estimateRuntime(60, []);
  assert.ok(eta);
  assert.equal(eta.isFallback, true);
  assert.equal(eta.basis, 0);
  const mid = 60 * FALLBACK_RATE;
  assert.ok(eta.lowS < mid && eta.highS > mid, "the band should straddle the constant");
});

test("the band is asymmetric — run times are right-skewed, nothing finishes early", () => {
  const eta = estimateRuntime(60, [])!;
  const mid = 60 * FALLBACK_RATE;
  assert.ok(eta.highS - mid > mid - eta.lowS, "top of the band must be further out than the bottom");
});

test("real history replaces the constant and reports how much there is", () => {
  const eta = estimateRuntime(120, samples([8, 9, 10, 11, 12]))!;
  assert.equal(eta.isFallback, false);
  assert.equal(eta.basis, 5);
  // p25-p75 of the rates is 9-11, so a 120s clip lands in 1080-1320s.
  assert.ok(eta.lowS >= 1000 && eta.lowS <= 1150, `lowS was ${eta.lowS}`);
  assert.ok(eta.highS >= 1250 && eta.highS <= 1400, `highS was ${eta.highS}`);
});

test("rate generalises across clip lengths — a short clip predicts a long one", () => {
  // Ten seconds of video that took 100s is a rate of 10. A 60s clip should be
  // predicted near 600s, not near 100s.
  const eta = estimateRuntime(60, [{ videoSeconds: 10, wallSeconds: 100 }])!;
  assert.ok(eta.lowS < 600 && eta.highS > 600, `band ${eta.lowS}-${eta.highS} should straddle 600`);
});

test("a single sample gets a deliberately wide band", () => {
  const one = estimateRuntime(60, samples([10]))!;
  const many = estimateRuntime(60, samples([10, 10, 10, 10]))!;
  assert.ok(one.highS - one.lowS > many.highS - many.lowS,
    "one run is a point, not a distribution");
});

test("garbage samples are dropped, not clamped", () => {
  const eta = estimateRuntime(60, [
    { videoSeconds: 0, wallSeconds: 500 },     // pre-0010 row
    { videoSeconds: 60, wallSeconds: -3 },     // clock skew
    { videoSeconds: 60, wallSeconds: 600 },    // the only real one
  ])!;
  assert.equal(eta.basis, 1);
});

test("an estimate is never below the floor", () => {
  const eta = estimateRuntime(0.5, samples([1]))!;
  assert.ok(eta.lowS >= 30, `lowS was ${eta.lowS}`);
});

test("a zero-length clip has no estimate at all", () => {
  assert.equal(estimateRuntime(0, samples([10])), null);
  assert.equal(estimateRuntime(NaN, samples([10])), null);
});

test("overrunning says so instead of freezing at 'about a minute left'", () => {
  const eta = estimateRuntime(60, samples([10]))!;
  const s = etaSentence(eta, eta.highS + 1);
  assert.match(s, /past the usual/i);
  assert.doesNotMatch(s, /left/i);
});

test("the overrun sentence never claims the run is still alive", () => {
  // A deploy or a restart ends a run without marking it failed, and from the
  // browser that is indistinguishable from a slow stage. Asserting liveness
  // would be exactly the kind of unbacked claim the ETA exists to avoid.
  const eta = estimateRuntime(60, samples([10, 11, 12]))!;
  const s = etaSentence(eta, eta.highS * 4);
  assert.doesNotMatch(s, /still running|still going|in progress/i);
  assert.match(s, /restart/i, "should name the other explanation");
});

test("the sentence names its evidence", () => {
  assert.match(etaSentence(estimateRuntime(60, [])!, 10), /rough estimate/i);
  assert.match(etaSentence(estimateRuntime(60, samples([10]))!, 10), /one previous clip/i);
  assert.match(etaSentence(estimateRuntime(60, samples([10, 10, 10]))!, 10), /last 3 clips/i);
});

test("no eta at all still says something true", () => {
  assert.match(etaSentence(null, 0), /few minutes/i);
});

test("humanDuration never says zero", () => {
  assert.equal(humanDuration(0), "5 sec");
  assert.equal(humanDuration(-10), "5 sec");
  assert.equal(humanDuration(62), "60 sec");
  assert.equal(humanDuration(200), "3 min");
  assert.equal(humanDuration(3600), "1 hr");
  assert.equal(humanDuration(3900), "1 hr 5 min");
});
