import { test } from "node:test";
import assert from "node:assert/strict";
import { applyVerdicts, verifyWindow, VERIFY_MAX_S, type VerifiableObservation } from "./verify-observations";

const rallies = [
  { idx: 1, start_s: 10, end_s: 22 },
  { idx: 2, start_s: 40, end_s: 90 },   // a long one
];
const weakness = (over: Partial<VerifiableObservation> = {}): VerifiableObservation => ({
  title: "t", detail: "d", valence: "weakness", shot_t: null, rally_idx: null, ...over,
});

test("a named moment is watched with its approach and its follow-through", () => {
  const w = verifyWindow(weakness({ shot_t: 30 }), rallies, 600)!;
  assert.ok(w.startSeconds < 30 && w.endSeconds > 30, "the moment is inside the window");
  assert.equal(w.kind, "moment");
  assert.ok(w.endSeconds - w.startSeconds <= 6, "a stroke, not a passage");
});

test("a moment at the very start of the clip does not ask for negative seconds", () => {
  const w = verifyWindow(weakness({ shot_t: 0.4 }), rallies, 600)!;
  assert.equal(w.startSeconds, 0);
});

test("a rally-level claim is watched as the rally, capped", () => {
  const short = verifyWindow(weakness({ rally_idx: 1 }), rallies, 600)!;
  assert.equal(short.kind, "rally");
  assert.ok(short.startSeconds <= 10 && short.endSeconds >= 22);
  const long = verifyWindow(weakness({ rally_idx: 2 }), rallies, 600)!;
  assert.ok(long.endSeconds - long.startSeconds <= VERIFY_MAX_S, "a fifty-second rally is not sent whole");
});

test("a claim with no moment and no rally cannot be checked", () => {
  // AND IS NOT INVENTED A WINDOW. Picking one is how the evidence clips first
  // ended up showing a player about to serve under a claim about the kitchen.
  assert.equal(verifyWindow(weakness(), rallies, 600), null);
  assert.equal(verifyWindow(weakness({ rally_idx: 99 }), rallies, 600), null);
});

test("a point the footage contradicts is deleted; one it cannot settle is kept", () => {
  // The distinction is the whole design. "The footage shows something else"
  // is evidence against the claim. "I could not tell from this window" is not
  // — and deleting on that would quietly empty the read of everything at the
  // far baseline, where this camera sees least.
  const got = applyVerdicts<{ title: string; unconfirmed?: boolean }>([
    { o: { title: "at the kitchen, not the baseline" }, out: { seen: "he is at the kitchen line", verdict: "wrong" as const, correction: "smash from the kitchen" } },
    { o: { title: "too far away to tell" }, out: { seen: "the far player is a few pixels", verdict: "unclear" as const } },
    { o: { title: "really did stand up" }, out: { seen: "legs straight through contact", verdict: "confirmed" as const } },
  ]);
  assert.deepEqual(got.kept.map((k) => k.title), ["too far away to tell", "really did stand up"]);
  assert.equal(got.kept[0].unconfirmed, true, "the one it could not settle is marked, not silently kept");
  assert.equal(got.kept[1].unconfirmed, undefined);
  assert.equal(got.dropped.length, 1);
  assert.equal(got.dropped[0].correction, "smash from the kitchen");
  assert.equal(got.dropped[0].observation.title, "at the kitchen, not the baseline");
  assert.equal(got.unclear, 1);
});
