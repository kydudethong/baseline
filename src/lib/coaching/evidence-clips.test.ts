import { test } from "node:test";
import assert from "node:assert/strict";
import { clipWindow } from "./evidence-window";

test("a claim about a whole point is cut as the whole point", () => {
  // THE BUG THIS PINS, reported from real footage: a criticism about standing
  // too tall DURING KITCHEN EXCHANGES came back over a clip of a player about
  // to serve, who was never at the kitchen in it.
  //
  // The cause was not the model. An observation that names no single shot
  // borrowed a moment from its rally and got the ordinary shot-length window
  // cut around it — two seconds before, one and a half after. That is not
  // weaker evidence than a cited shot, it is DIFFERENT evidence: the pipeline
  // chose the instant, then presented four seconds of it as the footage the
  // claim rests on. A reader who watches it and sees something else does not
  // conclude the clip is approximate; they conclude the analysis is wrong.
  const win = clipWindow({ tSeconds: 30, endSeconds: 48 }, 120);
  assert.deepEqual(win, { startSeconds: 30, endSeconds: 48 });
});

test("a claim about one shot is still cut around that shot", () => {
  const win = clipWindow({ tSeconds: 30 }, 120);
  assert.deepEqual(win, { startSeconds: 28, endSeconds: 31.5 });
});

test("a window is never cut past the end of the clip", () => {
  assert.deepEqual(clipWindow({ tSeconds: 118, endSeconds: 200 }, 120),
    { startSeconds: 118, endSeconds: 120 });
  assert.deepEqual(clipWindow({ tSeconds: 1 }, 120).startSeconds, 0);
});
