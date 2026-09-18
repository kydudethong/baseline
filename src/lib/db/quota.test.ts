import { test } from "node:test";
import assert from "node:assert/strict";
import { quotaFor, monthStart, monthEnd, isUnlimited } from "./quota";

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

test("three games a month, then no more", () => {
  withEnv({ ANALYSES_PER_MONTH: undefined, UNLIMITED_ANALYSIS_EMAILS: undefined }, () => {
    const q = quotaFor({ startedThisMonth: ["a", "b", "c"], analysisId: "d", email: "x@y.com" });
    assert.equal(q.allowed, false);
    assert.equal(q.used, 3);
    assert.equal(q.limit, 3);
  });
});

test("re-running a game already counted is free, even at the limit", () => {
  // THE DIFFERENCE BETWEEN A QUOTA AND A TRAP. A run that failed, or one being
  // re-analysed after fixing the court or re-tagging the wrong player, is the
  // SAME game. Charging again would leave somebody at their limit with a bad
  // court and no way to fix it — which is exactly when they most need the
  // re-run.
  withEnv({ ANALYSES_PER_MONTH: undefined, UNLIMITED_ANALYSIS_EMAILS: undefined }, () => {
    const q = quotaFor({ startedThisMonth: ["a", "b", "c"], analysisId: "b", email: "x@y.com" });
    assert.equal(q.allowed, true);
    assert.equal(q.used, 3, "a re-run must not inflate the count either");
  });
});

test("the same game started twice counts once", () => {
  withEnv({ ANALYSES_PER_MONTH: undefined, UNLIMITED_ANALYSIS_EMAILS: undefined }, () => {
    const q = quotaFor({ startedThisMonth: ["a", "a", "a", "b"], analysisId: "c", email: "x@y.com" });
    assert.equal(q.used, 2);
    assert.equal(q.allowed, true);
  });
});

test("a listed account has no limit", () => {
  withEnv({ UNLIMITED_ANALYSIS_EMAILS: "dev@example.com, other@example.com" }, () => {
    const q = quotaFor({ startedThisMonth: ["a", "b", "c", "d", "e"], analysisId: "f", email: "dev@example.com" });
    assert.equal(q.allowed, true);
    assert.equal(q.unlimited, true);
  });
});

test("the allowlist ignores case and spacing, and an empty one exempts nobody", () => {
  // A trailing space in a secret is invisible and would silently switch the
  // dev account back on to the limit.
  withEnv({ UNLIMITED_ANALYSIS_EMAILS: "  DEV@Example.com  " }, () => {
    assert.equal(isUnlimited("dev@example.com"), true);
    // AND THE OTHER DIRECTION, which is the one that actually bites: the
    // secret is typed by a person and the email comes from the auth provider,
    // so either side can differ in case. A dev account silently back on the
    // limit is a confusing way to spend an afternoon.
    assert.equal(isUnlimited("DEV@Example.com"), true);
    assert.equal(isUnlimited(" dev@EXAMPLE.com "), true);
    assert.equal(isUnlimited("someone@else.com"), false);
  });
  withEnv({ UNLIMITED_ANALYSIS_EMAILS: undefined }, () => {
    assert.equal(isUnlimited("dev@example.com"), false);
    assert.equal(isUnlimited(null), false, "a missing email must never be unlimited");
  });
});

test("the limit is configurable without a deploy", () => {
  withEnv({ ANALYSES_PER_MONTH: "10", UNLIMITED_ANALYSIS_EMAILS: undefined }, () => {
    assert.equal(quotaFor({ startedThisMonth: ["a", "b", "c"], analysisId: "d", email: "x@y.com" }).allowed, true);
  });
  withEnv({ ANALYSES_PER_MONTH: "not a number", UNLIMITED_ANALYSIS_EMAILS: undefined }, () => {
    // A typo in a secret must not mean "zero games a month for everybody".
    assert.equal(quotaFor({ startedThisMonth: [], analysisId: "d", email: "x@y.com" }).limit, 3);
  });
});

test("the window is a calendar month in UTC", () => {
  const mid = new Date("2026-03-17T12:00:00Z");
  assert.equal(monthStart(mid).toISOString(), "2026-03-01T00:00:00.000Z");
  assert.equal(monthEnd(mid).toISOString(), "2026-04-01T00:00:00.000Z");
  // December has to roll the year, which an off-by-one on the month does not.
  assert.equal(monthEnd(new Date("2026-12-09T00:00:00Z")).toISOString(), "2027-01-01T00:00:00.000Z");
});
