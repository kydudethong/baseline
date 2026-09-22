import test from "node:test";
import assert from "node:assert/strict";
import { entitlementFrom, GAME_KIND } from "./entitlement";

const game = (analysisId: string, over: Partial<{ mode: string; payment_status: string; kind: string }> = {}) => ({
  mode: over.mode ?? "payment",
  payment_status: over.payment_status ?? "paid",
  metadata: { kind: over.kind ?? GAME_KIND, analysis_id: analysisId },
});

test("an active subscription is the paid plan", () => {
  assert.equal(entitlementFrom([{ status: "active" }], []).plan, "pro");
  assert.equal(entitlementFrom([{ status: "trialing" }], []).plan, "pro");
});

test("a failed renewal still being retried keeps the plan", () => {
  // past_due is usually an expired card on somebody who means to pay.
  assert.equal(entitlementFrom([{ status: "past_due" }], []).plan, "pro");
});

test("a subscription that never got its first payment is not paying", () => {
  for (const status of ["incomplete", "incomplete_expired", "canceled", "unpaid", "paused"]) {
    assert.equal(entitlementFrom([{ status }], []).plan, "free", status);
  }
});

test("one paying subscription among dead ones is enough", () => {
  // Somebody who cancelled and re-subscribed has both on the customer.
  assert.equal(entitlementFrom([{ status: "canceled" }, { status: "active" }], []).plan, "pro");
});

test("a paid game session unlocks exactly that analysis", () => {
  const e = entitlementFrom([], [game("a1"), game("b2")]);
  assert.deepEqual([...e.paidAnalysisIds].sort(), ["a1", "b2"]);
  assert.equal(e.plan, "free", "buying a game is not a subscription");
});

test("a checkout that completed without being paid unlocks nothing", () => {
  // Bank-transfer style methods complete with payment pending.
  const e = entitlementFrom([], [game("a1", { payment_status: "unpaid" })]);
  assert.deepEqual(e.paidAnalysisIds, []);
});

test("the subscription's own checkout is not mistaken for a bought game", () => {
  const e = entitlementFrom([], [game("a1", { mode: "subscription" })]);
  assert.deepEqual(e.paidAnalysisIds, []);
});

test("a one-off payment for something else is not a game", () => {
  const e = entitlementFrom([], [game("a1", { kind: "tip" })]);
  assert.deepEqual(e.paidAnalysisIds, []);
});

test("a session with no metadata does not crash the rest", () => {
  const e = entitlementFrom([], [
    { mode: "payment", payment_status: "paid", metadata: null },
    game("a1"),
  ]);
  assert.deepEqual(e.paidAnalysisIds, ["a1"]);
});

test("paying twice for one game lists it once", () => {
  const e = entitlementFrom([], [game("a1"), game("a1")]);
  assert.deepEqual(e.paidAnalysisIds, ["a1"]);
});
