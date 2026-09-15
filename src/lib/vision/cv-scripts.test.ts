import { test } from "node:test";
import assert from "node:assert/strict";
import { frameScaledTimeoutMs } from "./cv-scripts";

test("a scaled timeout is always an integer Node will accept", () => {
  // The failure: execFile rejects a fractional timeout outright, and 0.05
  // seconds-per-frame times a frame count is floating point, so the product is
  // a hair off a whole number roughly always. 4152 frames produced
  // 207600.00000000003 and killed every overlay render before Python started.
  for (const frames of [1, 692, 4152, 4153, 12345, 99999]) {
    const ms = frameScaledTimeoutMs(frames, 0.05, 2 * 60_000, 40 * 60_000);
    assert.ok(Number.isInteger(ms), `${frames} frames gave a non-integer timeout: ${ms}`);
    assert.ok(ms >= 0, "a timeout must be unsigned");
  }
});

test("the floor and ceiling still hold, and still come back as integers", () => {
  assert.equal(frameScaledTimeoutMs(1, 0.05, 2 * 60_000, 40 * 60_000), 2 * 60_000);
  assert.equal(frameScaledTimeoutMs(10_000_000, 0.05, 2 * 60_000, 40 * 60_000), 40 * 60_000);
});
