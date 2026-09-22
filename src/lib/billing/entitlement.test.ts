import test from "node:test";
import assert from "node:assert/strict";
import { entitlementFrom } from "./entitlement";

test("an active subscription is the paid plan", () => {
  assert.equal(entitlementFrom([{ status: "active" }]).plan, "pro");
  assert.equal(entitlementFrom([{ status: "trialing" }]).plan, "pro");
});

test("a failed renewal still being retried keeps the plan", () => {
  // past_due is usually an expired card on somebody who means to pay.
  assert.equal(entitlementFrom([{ status: "past_due" }]).plan, "pro");
});

test("a subscription that never got its first payment is not paying", () => {
  for (const status of ["incomplete", "incomplete_expired", "canceled", "unpaid", "paused"]) {
    assert.equal(entitlementFrom([{ status }]).plan, "free", status);
  }
});

test("one paying subscription among dead ones is enough", () => {
  // Somebody who cancelled and re-subscribed has both on the customer.
  assert.equal(entitlementFrom([{ status: "canceled" }, { status: "active" }]).plan, "pro");
});

test("no subscriptions at all is free", () => {
  assert.equal(entitlementFrom([]).plan, "free");
});
