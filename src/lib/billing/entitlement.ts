/**
 * What somebody has paid for, derived from Stripe's own records.
 *
 * Pure, and separate from stripe.ts, so the rule can be tested without a
 * network. One plan, so the only question is which subscription states count
 * as paying.
 */
import type { Entitlement } from "@/lib/db/quota";

/**
 * Subscription states that still get the paid allowance.
 *
 * PAST_DUE IS INCLUDED, deliberately. It means a renewal charge failed and
 * Stripe is retrying -- an expired card, usually, on somebody who has every
 * intention of paying. Cutting them off at the first failed retry punishes
 * the ordinary case to guard against the rare one, and Stripe moves the
 * subscription to `unpaid` or `canceled` on its own once retries run out.
 *
 * `incomplete` is NOT included: that is a first payment that never went
 * through, so nothing has ever been paid.
 */
export const PAYING_STATUSES = new Set(["active", "trialing", "past_due"]);

export interface SubscriptionLike {
  status: string;
}

export function entitlementFrom(subscriptions: readonly SubscriptionLike[]): Entitlement {
  return { plan: subscriptions.some((s) => PAYING_STATUSES.has(s.status)) ? "pro" : "free" };
}
