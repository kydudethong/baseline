import { test } from "node:test";
import assert from "node:assert/strict";
import { planSegments, maxSegmentSeconds, isSampled, MAX_SEGMENTS, SEGMENT_TOKEN_BUDGET, TOKENS_PER_FRAME_HIGH } from "./technique-segments";

const FPS = 15;

test("a segment fits inside the token budget", () => {
  const seconds = maxSegmentSeconds(FPS);
  assert.ok(seconds * FPS * TOKENS_PER_FRAME_HIGH <= SEGMENT_TOKEN_BUDGET,
    `${seconds}s at ${FPS}fps exceeds the budget`);
});

test("a short clip is genuinely ONE call", () => {
  // The thing that was asked for: a 2:18 clip should not be chopped up.
  const got = planSegments(138, FPS);
  assert.equal(got.length, 1);
  assert.equal(got[0].startSeconds, 0);
  assert.equal(got[0].endSeconds, 138);
});

test("segments cover the clip end to end with no gap when it fits", () => {
  const duration = maxSegmentSeconds(FPS) * 3 - 20;
  const got = planSegments(duration, FPS);
  assert.equal(got[0].startSeconds, 0);
  assert.equal(got[got.length - 1].endSeconds, duration);
  for (let i = 1; i < got.length; i++) {
    assert.equal(got[i].startSeconds, got[i - 1].endSeconds, "a gap opened between segments");
  }
});

test("a clip too long to cover is sampled across its whole length, not truncated", () => {
  // The failure this guards: analysing the first twenty minutes of an hour and
  // calling it a read of the match.
  const duration = maxSegmentSeconds(FPS) * 30;
  const got = planSegments(duration, FPS);
  assert.equal(got.length, MAX_SEGMENTS);
  assert.equal(got[0].startSeconds, 0);
  assert.ok(got[got.length - 1].endSeconds >= duration - 1, "the end of the clip was never reached");
});

test("segments are always in order and never inverted", () => {
  for (const duration of [30, 500, 5000, 50000]) {
    const got = planSegments(duration, FPS);
    for (let i = 0; i < got.length; i++) {
      assert.ok(got[i].endSeconds > got[i].startSeconds, `segment ${i} of a ${duration}s clip is inverted`);
      if (i > 0) assert.ok(got[i].startSeconds >= got[i - 1].startSeconds);
    }
  }
});

test("no segment runs past the end of the clip", () => {
  for (const duration of [45, 900, 9000]) {
    for (const seg of planSegments(duration, FPS)) {
      assert.ok(seg.endSeconds <= duration, `a segment ended at ${seg.endSeconds} on a ${duration}s clip`);
    }
  }
});

test("isSampled says plainly whether footage is being skipped", () => {
  assert.equal(isSampled(138, FPS), false);
  assert.equal(isSampled(maxSegmentSeconds(FPS) * 30, FPS), true);
});

test("a zero-length or nonsense duration plans nothing rather than dividing by zero", () => {
  assert.deepEqual(planSegments(0, FPS), []);
  assert.deepEqual(planSegments(-5, FPS), []);
  assert.deepEqual(planSegments(NaN, FPS), []);
});

test("a higher frame rate buys shorter segments, and the budget still holds", () => {
  assert.ok(maxSegmentSeconds(30) < maxSegmentSeconds(15));
  assert.ok(maxSegmentSeconds(30) * 30 * TOKENS_PER_FRAME_HIGH <= SEGMENT_TOKEN_BUDGET);
});
