import { test } from "node:test";
import assert from "node:assert/strict";
import { overallRating, type SkillProfile } from "./stats";

const skill = (over: Partial<SkillProfile> = {}): SkillProfile => ({
  skillKey: "dinking", name: "Dinking", group: "Kitchen",
  weightedAvg: 3, analysesRated: 1, trend: null, ...over,
});

test("nothing rated is null, not zero", () => {
  // A NUMBER WOULD BE A CLAIM. Zero reads as "rated, and terrible"; null reads
  // as "not enough to say", which is the true state before any game is
  // analysed and the only honest thing to show.
  assert.deepEqual(overallRating([]), { rating: null, games: 0, skills: 0 });
  assert.deepEqual(
    overallRating([skill({ weightedAvg: null, analysesRated: 0 })]),
    { rating: null, games: 0, skills: 0 }
  );
});

test("a skill seen in six games outweighs one seen once", () => {
  // Without this, one lucky reading of a skill the player has barely shown
  // moves their whole number as much as a habit observed all season.
  const got = overallRating([
    skill({ skillKey: "dinking", weightedAvg: 2, analysesRated: 6 }),
    skill({ skillKey: "serve", weightedAvg: 5, analysesRated: 1 }),
  ]);
  // Straight mean would be 3.5; weighted is (2*6 + 5*1) / 7 = 2.43.
  assert.equal(got.rating, 2.4);
});

test("it reports what it rests on, not just the number", () => {
  // The count is not decoration. A 4.2 from one game and a 4.2 from twelve are
  // different claims, and the reader can only discount the first if they are
  // told which one they are looking at.
  const got = overallRating([
    skill({ skillKey: "dinking", weightedAvg: 4, analysesRated: 3 }),
    skill({ skillKey: "serve", weightedAvg: 4, analysesRated: 2 }),
  ]);
  assert.equal(got.skills, 2);
  assert.equal(got.games, 3, "games should be the most any one skill was rated, not the row count");
});

test("one decimal, because the inputs are whole numbers off a video", () => {
  const got = overallRating([
    skill({ skillKey: "a", weightedAvg: 3.33, analysesRated: 1 }),
    skill({ skillKey: "b", weightedAvg: 4.67, analysesRated: 1 }),
  ]);
  assert.equal(got.rating, 4);
  assert.ok(String(got.rating).split(".")[1]?.length !== 2);
});

test("unrated skills are skipped rather than counted as zero", () => {
  // SKILLS the model declined to rate come back with weightedAvg null, one per
  // key, always — so treating them as zeros would drag every player toward the
  // bottom in proportion to how much of the sport their clip did not show.
  const got = overallRating([
    skill({ skillKey: "dinking", weightedAvg: 4, analysesRated: 2 }),
    skill({ skillKey: "serve", weightedAvg: null, analysesRated: 0 }),
    skill({ skillKey: "resets", weightedAvg: null, analysesRated: 0 }),
  ]);
  assert.equal(got.rating, 4);
  assert.equal(got.skills, 1);
});
