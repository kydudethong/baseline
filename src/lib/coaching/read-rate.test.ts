import { test } from "node:test";
import assert from "node:assert/strict";
import { ANALYST_FPS, analystFps, overlayFps } from "./read-rate";

test("the overlay is never written slower than the model reads it", () => {
  // The bug: ANALYST_FPS went to 15 while the overlay stayed at 10. You cannot
  // sample fifteen distinct frames a second out of a ten-frame-a-second video,
  // so the model gets duplicates and the run pays 15fps rates for 10fps of
  // information.
  const before = process.env.ANALYST_FPS;
  try {
    for (const rate of ["3", "5", "10", "12", "15"]) {
      process.env.ANALYST_FPS = rate;
      assert.ok(overlayFps() >= analystFps(),
        `at ${rate}fps the overlay would be coarser than the read`);
    }
  } finally {
    if (before === undefined) delete process.env.ANALYST_FPS;
    else process.env.ANALYST_FPS = before;
  }
});

test("the overlay never drops below 10fps, whatever the read rate", () => {
  // 10 is what a person scrubbing needs, and the decimation from 30 is what
  // stopped this stage killing long runs.
  const before = process.env.ANALYST_FPS;
  try {
    process.env.ANALYST_FPS = "3";
    assert.equal(overlayFps(), 10);
  } finally {
    if (before === undefined) delete process.env.ANALYST_FPS;
    else process.env.ANALYST_FPS = before;
  }
});

test("an out-of-range rate falls back rather than being obeyed", () => {
  const before = process.env.ANALYST_FPS;
  try {
    // Against the CONSTANT, not against a number typed into the test. This
    // asserted 15 and broke the day the default became 10 -- which told us
    // nothing about the clamp, only that someone had changed their mind about
    // the default. The behaviour worth protecting is "out of range falls back
    // to the default", whatever the default happens to be.
    process.env.ANALYST_FPS = "60";
    assert.equal(analystFps(), ANALYST_FPS);
    process.env.ANALYST_FPS = "0";
    assert.equal(analystFps(), ANALYST_FPS);
    process.env.ANALYST_FPS = "not a number";
    assert.equal(analystFps(), ANALYST_FPS);
  } finally {
    if (before === undefined) delete process.env.ANALYST_FPS;
    else process.env.ANALYST_FPS = before;
  }
});
