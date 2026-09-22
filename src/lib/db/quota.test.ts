import { test } from "node:test";
import assert from "node:assert/strict";
import {
  quotaFor, monthStart, monthEnd, isUnlimited,
  MINUTES_PER_MONTH, PRO_MINUTES_PER_MONTH,
} from "./quota";

/** A clip of `m` minutes, already analysed this month. */
const run = (analysisId: string, m: number) => ({ analysisId, minutes: m });
const NO_ENV = { ANALYSIS_MINUTES_PER_MONTH: undefined, UNLIMITED_ANALYSIS_EMAILS: undefined };

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const before: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { before[k] = process.env[k]; 
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]!; }
  try { fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]!;
    }
  }
}

test("ten minutes a month free, counted in minutes rather than clips", () => {
  // MINUTES BECAUSE MINUTES ARE WHAT COST MONEY. Three games meant twelve
  // minutes for one user and ninety for another on the same allowance, and
  // the bill followed the minutes either way.
  withEnv(NO_ENV, () => {
    const q = quotaFor({
      startedThisMonth: [run("a", 6), run("b", 3)],
      analysisId: "c", minutes: 2, email: "x@y.com",
    });
    assert.equal(q.usedMinutes, 9);
    assert.equal(q.remainingMinutes, 1);
    assert.equal(q.allowed, false, "a 2 minute clip does not fit in 1 minute");
  });
});

test("a clip that fits exactly is allowed", () => {
  // The boundary belongs to the user. Refusing a clip that fits to the second
  // would make the number on the page a lie.
  withEnv(NO_ENV, () => {
    const q = quotaFor({
      startedThisMonth: [run("a", 6)], analysisId: "b", minutes: 4, email: "x@y.com",
    });
    assert.equal(q.allowed, true);
  });
});

test("re-analysing a clip costs nothing, even with no minutes left", () => {
  // THE DIFFERENCE BETWEEN A QUOTA AND A TRAP. A run that failed, or one
  // re-analysed after fixing the court or re-tagging the wrong player, is the
  // same footage. Charging twice leaves somebody out of minutes with a bad
  // court and no way to fix it.
  withEnv(NO_ENV, () => {
    const q = quotaFor({
      startedThisMonth: [run("a", 30)], analysisId: "a", minutes: 30, email: "x@y.com",
    });
    assert.equal(q.allowed, true);
    assert.equal(q.usedMinutes, 30, "a re-run must not be added again either");
  });
});

test("the same clip started three times is counted once", () => {
  withEnv(NO_ENV, () => {
    const q = quotaFor({
      startedThisMonth: [run("a", 4), run("a", 4), run("a", 4)],
      analysisId: "b", minutes: 5, email: "x@y.com",
    });
    assert.equal(q.usedMinutes, 4);
    assert.equal(q.allowed, true);
  });
});

test("a clip longer than the whole allowance says so, rather than saying wait", () => {
  // Two different problems. Being out of minutes is fixed by waiting for the
  // 1st; a 45-minute clip against a 10-minute allowance is never fixed by
  // waiting, and telling somebody to come back next month when next month
  // cannot help is worse than saying nothing.
  withEnv(NO_ENV, () => {
    const q = quotaFor({ startedThisMonth: [], analysisId: "a", minutes: 45, email: "x@y.com" });
    assert.equal(q.allowed, false);
    assert.equal(q.clipExceedsWholeAllowance, true);
  });
  withEnv(NO_ENV, () => {
    const q = quotaFor({ startedThisMonth: [run("a", 8)], analysisId: "b", minutes: 5, email: "x@y.com" });
    assert.equal(q.allowed, false);
    assert.equal(q.clipExceedsWholeAllowance, false, "this one IS fixed by waiting");
  });
});

test("a duration we never recorded is let through, not charged or refused", () => {
  // Missing metadata is our bug. Refusing somebody's run over a gap they
  // cannot see punishes them for it; the exploit needs a deliberately broken
  // upload, which is a worse trade than the occasional free clip.
  withEnv(NO_ENV, () => {
    const q = quotaFor({ startedThisMonth: [run("a", 9)], analysisId: "b", minutes: null, email: "x@y.com" });
    assert.equal(q.allowed, true);
  });
});

test("a listed account has no limit", () => {
  withEnv({ UNLIMITED_ANALYSIS_EMAILS: "dev@example.com, other@example.com" }, () => {
    const q = quotaFor({
      startedThisMonth: [run("a", 500)], analysisId: "b", minutes: 90, email: "dev@example.com",
    });
    assert.equal(q.allowed, true);
    assert.equal(q.unlimited, true);
  });
});

test("the allowlist ignores case and spacing on BOTH sides", () => {
  // The secret is typed by a person and the email comes from the auth
  // provider, so either can differ in case. A dev account quietly back on the
  // limit is a confusing way to lose an afternoon.
  withEnv({ UNLIMITED_ANALYSIS_EMAILS: "  DEV@Example.com  " }, () => {
    assert.equal(isUnlimited("dev@example.com"), true);
    assert.equal(isUnlimited("DEV@Example.com"), true);
    assert.equal(isUnlimited(" dev@EXAMPLE.com "), true);
    assert.equal(isUnlimited("someone@else.com"), false);
  });
  withEnv({ UNLIMITED_ANALYSIS_EMAILS: undefined }, () => {
    assert.equal(isUnlimited("dev@example.com"), false);
    assert.equal(isUnlimited(null), false, "a missing email must never be unlimited");
  });
});

test("the limit is configurable, and a typo does not mean zero", () => {
  withEnv({ ANALYSIS_MINUTES_PER_MONTH: "90", UNLIMITED_ANALYSIS_EMAILS: undefined }, () => {
    assert.equal(quotaFor({
      startedThisMonth: [run("a", 60)], analysisId: "b", minutes: 25, email: "x@y.com",
    }).allowed, true);
  });
  withEnv({ ANALYSIS_MINUTES_PER_MONTH: "not a number", UNLIMITED_ANALYSIS_EMAILS: undefined }, () => {
    assert.equal(quotaFor({
      startedThisMonth: [], analysisId: "b", minutes: 1, email: "x@y.com",
    }).limitMinutes, MINUTES_PER_MONTH);
  });
});

test("the window is a calendar month in UTC", () => {
  const mid = new Date("2026-03-17T12:00:00Z");
  assert.equal(monthStart(mid).toISOString(), "2026-03-01T00:00:00.000Z");
  assert.equal(monthEnd(mid).toISOString(), "2026-04-01T00:00:00.000Z");
  // December has to roll the year, which an off-by-one on the month does not.
  assert.equal(monthEnd(new Date("2026-12-09T00:00:00Z")).toISOString(), "2027-01-01T00:00:00.000Z");
});


// ---------------------------------------------------------------------------
// Plans. What somebody has paid for, as Stripe reports it.
// ---------------------------------------------------------------------------

const PRO = { plan: "pro" as const };

test("the free allowance is a stretch of a game, not a whole one", () => {
  // Ky's own games run 16-19 minutes. Ten free minutes is a taste: a whole
  // game is refused as too long for the plan (not "wait until next month").
  withEnv(NO_ENV, () => {
    assert.equal(quotaFor({ startedThisMonth: [], analysisId: "a", minutes: 10, email: "x@y.com" }).allowed, true);
    const game = quotaFor({ startedThisMonth: [], analysisId: "a", minutes: 16, email: "x@y.com" });
    assert.equal(game.allowed, false);
    assert.equal(game.clipExceedsWholeAllowance, true);
  });
});

test("the paid plan raises the allowance to ninety minutes", () => {
  withEnv(NO_ENV, () => {
    const q = quotaFor({
      startedThisMonth: [run("a", 19), run("b", 17), run("c", 18)],
      analysisId: "d", minutes: 20, email: "x@y.com", entitlement: PRO,
    });
    assert.equal(q.limitMinutes, PRO_MINUTES_PER_MONTH);
    assert.equal(q.allowed, true, "four games is 74 minutes, inside 90");
    assert.equal(q.plan, "pro");
  });
});

test("the paid plan is not unlimited", () => {
  withEnv(NO_ENV, () => {
    const q = quotaFor({
      startedThisMonth: [run("a", 80)], analysisId: "b", minutes: 20, email: "x@y.com", entitlement: PRO,
    });
    assert.equal(q.allowed, false);
  });
});

test("a whole game fits on the paid plan even with free minutes used", () => {
  withEnv(NO_ENV, () => {
    const q = quotaFor({
      startedThisMonth: [run("a", 10)], analysisId: "b", minutes: 19, email: "x@y.com", entitlement: PRO,
    });
    assert.equal(q.allowed, true);
  });
});

test("omitting the entitlement means free, never paid", () => {
  // Every caller that forgets to pass it must fail toward the cheaper plan.
  withEnv(NO_ENV, () => {
    const q = quotaFor({ startedThisMonth: [], analysisId: "a", minutes: 1, email: "x@y.com" });
    assert.equal(q.plan, "free");
    assert.equal(q.limitMinutes, MINUTES_PER_MONTH);
  });
});
