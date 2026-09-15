import { test } from "node:test";
import assert from "node:assert/strict";
import { planSegments, maxSegmentSeconds, isSampled, MAX_SEGMENTS, DEFAULT_MAX_SEGMENT_SECONDS, maxSegmentSecondsCap, tokensPerFrame, TOKENS_PER_FRAME_LOW, SEGMENT_TOKEN_BUDGET, TOKENS_PER_FRAME_HIGH } from "./technique-segments";

const FPS = 15;

test("a segment fits inside the token budget", () => {
  const seconds = maxSegmentSeconds(FPS);
  assert.ok(seconds * FPS * TOKENS_PER_FRAME_HIGH <= SEGMENT_TOKEN_BUDGET,
    `${seconds}s at ${FPS}fps exceeds the budget`);
});

test("a clip inside the time cap is ONE call", () => {
  // The cap is now TIME, not tokens: the model loses track of the clock past
  // about two minutes and starts reporting rallies that are off the end of the
  // video. A clip under that is still a single call.
  const got = planSegments(100, FPS);
  assert.equal(got.length, 1);
  assert.equal(got[0].startSeconds, 0);
  assert.equal(got[0].endSeconds, 100);
});

test("a clip past the time cap is split even though the tokens would fit", () => {
  // 138s at 15fps is well inside the 600k token budget, and is split anyway —
  // because the binding constraint is the model's sense of time, not context.
  const got = planSegments(138, FPS);
  assert.ok(got.length > 1, "a 138s clip should now be split");
  for (const seg of got) {
    assert.ok(seg.endSeconds - seg.startSeconds <= DEFAULT_MAX_SEGMENT_SECONDS + 0.01);
  }
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

test("a low-resolution frame is priced as low, so more of the clip fits one call", () => {
  // The bug this guards: the planner assumed `high` for every pass, so a scan
  // running at `low` was split into four times as many calls as it needed.
  assert.equal(tokensPerFrame("low"), TOKENS_PER_FRAME_LOW);
  const fps = 10;
  assert.ok(
    maxSegmentSeconds(fps, "low") >= maxSegmentSeconds(fps, "high"),
    "cheaper frames must not buy a shorter segment"
  );
});

test("the time cap is overridable, and the token budget still binds above it", () => {
  const before = process.env.ANALYST_MAX_SEGMENT_SECONDS;
  try {
    process.env.ANALYST_MAX_SEGMENT_SECONDS = "900";
    assert.equal(maxSegmentSecondsCap(), 900);
    // Raising the time cap cannot conjure context that does not exist: at
    // 10fps high a segment is still bounded by SEGMENT_TOKEN_BUDGET.
    const seconds = maxSegmentSeconds(10, "high");
    assert.ok(seconds < 900, "the token budget should still be the binding limit");
    assert.ok(seconds * 10 * TOKENS_PER_FRAME_HIGH <= SEGMENT_TOKEN_BUDGET);
  } finally {
    if (before === undefined) delete process.env.ANALYST_MAX_SEGMENT_SECONDS;
    else process.env.ANALYST_MAX_SEGMENT_SECONDS = before;
  }
});
