import { test } from "node:test";
import assert from "node:assert/strict";
import { checkedSentence, parseChecked } from "./checked";

test("the sentence says how many were written, dropped and left unsettled", () => {
  assert.equal(
    checkedSentence({ confirmed: 4, unclear: 1, dropped: 2 }),
    "7 criticisms were written and every one was re-watched at full detail, 2 were deleted for not "
    + "matching the footage, 1 could not be settled from the clip and is marked below.",
  );
});

test("a clean read says so rather than staying quiet about it", () => {
  assert.match(checkedSentence({ confirmed: 5, unclear: 0, dropped: 0 }) ?? "", /all of them held up/);
});

test("nothing checked is nothing said", () => {
  // Reads from before the check existed, and reads where every point was
  // clip-wide, have nothing to report and must not imply they were checked.
  assert.equal(checkedSentence({ confirmed: 0, unclear: 0, dropped: 0 }), null);
  assert.equal(checkedSentence(null), null);
  assert.equal(parseChecked(JSON.stringify({ checked: { confirmed: 0, unclear: 0, dropped: 0 } })), null);
  assert.equal(parseChecked(null), null);
  assert.equal(parseChecked("not json"), null);
});

test("the counts survive a round trip and rubbish is not trusted", () => {
  const got = parseChecked(JSON.stringify({ checked: { confirmed: 3, unclear: 1, dropped: "two", droppedTitles: ["a", 2] } }));
  assert.deepEqual(got, { confirmed: 3, unclear: 1, dropped: 0, droppedTitles: ["a"], unconfirmedTitles: undefined });
});
