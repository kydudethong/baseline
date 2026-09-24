import { test } from "node:test";
import assert from "node:assert/strict";
import { digestEmail } from "./digest-email";

const base = {
  gamesThisWeek: 2, minutesThisWeek: 34, topFix: "Get lower on resets",
  moved: [], drill: "Cross-court dinks, 5 minutes", url: "https://baseline.test/dashboard/practice",
};

test("a week with nothing in it is not emailed", () => {
  // "You did not play this week" is a reason to unsubscribe, not to come back.
  assert.equal(digestEmail({ ...base, gamesThisWeek: 0 }), null);
});

test("the subject is the thing that moved, because that is the news", () => {
  const got = digestEmail({ ...base, moved: [
    { name: "Dinking", now: 3.6, before: 3.1 },
    { name: "Serving", now: 3.0, before: 3.05 },
  ] })!;
  assert.equal(got.subject, "Dinking is up this week");
  assert.match(got.html, /3\.1 → <strong>3\.6<\/strong>/);
  assert.doesNotMatch(got.html, /Serving/, "a 0.05 wobble is not a move");
});

test("a rating going down is reported as plainly as one going up", () => {
  const got = digestEmail({ ...base, moved: [{ name: "Resets", now: 2.6, before: 3.4 }] })!;
  assert.equal(got.subject, "Resets is down this week");
  assert.match(got.text, /Resets: 3\.4 → 2\.6/);
});

test("with nothing moved yet it still has something to say", () => {
  const got = digestEmail({ ...base, moved: [{ name: "Dinking", now: 3.1, before: null }] })!;
  assert.equal(got.subject, "This week: Get lower on resets");
  assert.match(got.text, /2 games/);
  assert.match(got.text, /Cross-court dinks/);
});

test("the minutes read as minutes", () => {
  assert.match(digestEmail({ ...base, minutesThisWeek: 34 })!.text, /34:00|0:34/);
});
