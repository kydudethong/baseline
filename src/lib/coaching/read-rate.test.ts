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

test("the overlay is drawn at exactly the rate the model reads it", () => {
  // THERE USED TO BE A FLOOR OF 10 HERE and it drew frames for nobody: the
  // model reads at ANALYST_FPS, so anything drawn above that rate is decoded,
  // rendered, encoded and then skipped. The floor existed because this stage
  // once decimated from a 30fps source and 10 was what stopped it killing long
  // runs -- a constraint that any rate at or below 10 satisfies anyway.
  const before = process.env.ANALYST_FPS;
  try {
    for (const rate of ["3", "8", "12"]) {
      process.env.ANALYST_FPS = rate;
      assert.equal(overlayFps(), analystFps(), `overlay disagreed with the read rate at ${rate}fps`);
      assert.equal(overlayFps(), Number(rate));
    }
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
