import { test } from "node:test";
import assert from "node:assert/strict";
import { matchPlaystyles, PRO_PLAYSTYLES, MIN_RATED_SKILLS } from "./pro-playstyles";
import { SKILL_KEYS } from "./types";

/** A full rating vector, defaulting to 3 and overridden per key. */
function ratings(overrides: Record<string, number> = {}): Record<string, number> {
  return Object.fromEntries(SKILL_KEYS.map((k) => [k, overrides[k] ?? 3]));
}

test("every profile rates every skill, in range", () => {
  for (const pro of PRO_PLAYSTYLES) {
    for (const key of SKILL_KEYS) {
      const v = pro.ratings[key];
      assert.equal(typeof v, "number", `${pro.slug} is missing ${key}`);
      assert.ok(v >= 1 && v <= 5, `${pro.slug}.${key} = ${v} is outside 1-5`);
    }
  }
});

test("slugs are unique and every profile is sourced", () => {
  const slugs = PRO_PLAYSTYLES.map((p) => p.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const pro of PRO_PLAYSTYLES) {
    assert.ok(pro.sources.length > 0, `${pro.slug} has no sources`);
    assert.ok(pro.sources.every((s) => s.startsWith("https://")), `${pro.slug} has a non-URL source`);
  }
});

test("the profiles are actually different from each other", () => {
  // The failure this guards is a set of profiles that all look the same, which
  // would make every player match whoever happens to sit first. If the most
  // similar PAIR is nearly identical, the reference set is not discriminative.
  let worst = -1;
  let pair = "";
  for (let i = 0; i < PRO_PLAYSTYLES.length; i++) {
    for (let j = i + 1; j < PRO_PLAYSTYLES.length; j++) {
      const a = PRO_PLAYSTYLES[i];
      const b = PRO_PLAYSTYLES[j];
      const sim = matchPlaystyles(a.ratings, PRO_PLAYSTYLES.length).find((m) => m.slug === b.slug)!.similarity;
      if (sim > worst) {
        worst = sim;
        pair = `${a.slug} vs ${b.slug}`;
      }
    }
  }
  assert.ok(worst < 0.97, `two profiles are near-identical (${pair} = ${worst})`);
});

test("a pro matches themselves first", () => {
  for (const pro of PRO_PLAYSTYLES) {
    const [top] = matchPlaystyles(pro.ratings);
    assert.equal(top.slug, pro.slug, `${pro.slug} did not match itself`);
    assert.ok(top.similarity > 0.999);
  }
});

test("the match is on SHAPE, not level — a weaker player with the same shape still matches", () => {
  // This is the whole method. Ben Johns's shape, shifted down by two and
  // squashed toward the middle, is still Ben Johns's shape: soft game and
  // court IQ ahead of offense. If this failed, the feature would just be
  // ranking people by how good they are.
  const johns = PRO_PLAYSTYLES.find((p) => p.slug === "ben-johns")!;
  const mean = SKILL_KEYS.reduce((s, k) => s + johns.ratings[k], 0) / SKILL_KEYS.length;
  const weaker = Object.fromEntries(
    SKILL_KEYS.map((k) => [k, Math.round(((johns.ratings[k] - mean) * 0.4 + 2) * 100) / 100])
  );
  const [top] = matchPlaystyles(weaker);
  assert.equal(top.slug, "ben-johns");
  assert.ok(top.similarity > 0.95);
});

test("a flat rating vector has no shape, so it matches nobody", () => {
  assert.deepEqual(matchPlaystyles(ratings()), []);
});

test("too few rated skills is refused rather than guessed", () => {
  const sparse = Object.fromEntries(
    SKILL_KEYS.slice(0, MIN_RATED_SKILLS - 1).map((k, i) => [k, i + 1])
  );
  assert.deepEqual(matchPlaystyles(sparse), []);
});

test("unrated skills are dropped from both sides, not treated as zero", () => {
  // Rating only the kitchen block, with hands highest, must find a hands
  // player. Imputing 0 for the other 11 keys would drown that signal in
  // eleven identical "nothing like a pro" dimensions.
  const partial = { dinking: 2, kitchen: 4, hands: 5, volleys: 5, resets: 2, defense: 3 };
  const [top] = matchPlaystyles(partial);
  // Asserted as a PROPERTY of the answer rather than a fixed slug: several
  // pros are legitimately hands-and-volleys-forward, and which of them wins on
  // a six-key slice is a detail that should be free to change when a profile
  // is edited. What must not change is that the match is driven by the keys
  // the player was actually rated on.
  assert.ok(top.sharedStrengths.includes("hands"), `expected a hands-first pro, got ${top.slug}`);
  assert.ok(top.sharedStrengths.includes("volleys"), `expected a volley-forward pro, got ${top.slug}`);
  assert.ok(top.similarity > 0.8);
});

test("a soft-game shape and a power shape do not match the same pro", () => {
  const soft = ratings({ dinking: 5, resets: 5, thirdshot: 5, consistency: 5, offense: 1, hands: 2 });
  const power = ratings({ offense: 5, hands: 5, volleys: 5, dinking: 1, resets: 1, consistency: 2 });
  assert.notEqual(matchPlaystyles(soft)[0].slug, matchPlaystyles(power)[0].slug);
});

test("the match explains itself: shared strengths are things the player is above their own average at", () => {
  const soft = ratings({ dinking: 5, resets: 5, thirdshot: 5, offense: 1 });
  const [top] = matchPlaystyles(soft);
  assert.ok(top.sharedStrengths.length > 0);
  for (const key of top.sharedStrengths) {
    const mean = SKILL_KEYS.reduce((s, k) => s + soft[k], 0) / SKILL_KEYS.length;
    assert.ok(soft[key] > mean, `${key} is not above the player's own average`);
  }
});

test("divergences name places the player and the pro disagree", () => {
  const power = ratings({ offense: 5, hands: 5, dinking: 1, resets: 1 });
  const johns = matchPlaystyles(power, PRO_PLAYSTYLES.length).find((m) => m.slug === "ben-johns")!;
  assert.ok(johns.divergences.length > 0);
  assert.ok(johns.similarity < 0.5, "a power game should not resemble Ben Johns");
});

test("results come back ranked, best first, and capped", () => {
  const got = matchPlaystyles(ratings({ hands: 5, offense: 5, resets: 1 }), 3);
  assert.equal(got.length, 3);
  for (let i = 1; i < got.length; i++) {
    assert.ok(got[i - 1].similarity >= got[i].similarity);
  }
});
