import { test } from "node:test";
import assert from "node:assert/strict";
import { clock, secs, timesInProse } from "./duration";

test("a moment reads like a video player", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(7.4), "0:07");
  assert.equal(clock(155), "2:35");
  assert.equal(clock(59.6), "1:00", "rounding up crosses the minute properly");
  assert.equal(clock(3661), "61:01", "an hour keeps counting in minutes rather than wrapping to 1:01");
  assert.equal(clock(-3), "0:00");
});

test("a length under a minute stays in seconds, with the tenths it was asked for", () => {
  assert.equal(secs(8.42, 1), "8.4s");
  assert.equal(secs(8.42), "8s");
  assert.equal(secs(47), "47s");
});

test("a minute and over becomes minutes and a remainder", () => {
  // THE WHOLE POINT. "155s" is what this replaced.
  assert.equal(secs(155), "2m 35s");
  assert.equal(secs(155, 1), "2m 35s", "tenths are dropped once minutes are in play");
  assert.equal(secs(60), "1m");
  assert.equal(secs(600), "10m");
  assert.equal(secs(61), "1m 1s");
});

test("nothing ever prints sixty seconds", () => {
  // 59.97 with one decimal is "60.0s", which is the bug this guards.
  assert.equal(secs(59.97, 1), "1m");
  assert.equal(secs(59.4, 1), "59.4s");
});


test("seconds written into the coaching prose become minutes too", () => {
  // The read is written by a model that is handed times in seconds. No
  // formatter reaches inside a paragraph, so this is where "766.1s" survived.
  assert.equal(
    timesInProse("During a kitchen battle at 766.1s, you flicked a ball"),
    "During a kitchen battle at 12:46, you flicked a ball",
  );
  assert.equal(timesInProse("the rally at 155 seconds"), "the rally at 2:35");
  assert.equal(timesInProse("(92.0s)"), "(1:32)");
});

test("short times, speeds and ordinary words are left alone", () => {
  assert.equal(timesInProse("you hung back for 3s"), "you hung back for 3s", "under a minute reads fine");
  assert.equal(timesInProse("the ball left at 4.2 m/s"), "the ball left at 4.2 m/s", "a speed is not a time");
  assert.equal(timesInProse("shots, drops and resets"), "shots, drops and resets");
  assert.equal(timesInProse("3.5s level"), "3.5s level", "a rating is not a time");
  assert.equal(timesInProse(null), null);
});
