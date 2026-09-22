/**
 * What somebody has paid for, derived from Stripe's own records.
 *
 * Pure, and separate from stripe.ts, so the rule can be tested without a
 * network: which subscription states count as paying, and which checkout
 * sessions unlock which game.
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

/** Tag on every one-off game checkout, so other one-off payments are never mistaken for one. */
export const GAME_KIND = "game";

export interface SubscriptionLike {
  status: string;
}

export interface CheckoutSessionLike {
  mode: string | null;
  payment_status: string | null;
  metadata: Record<string, string> | null;
}

export function entitlementFrom(
  subscriptions: readonly SubscriptionLike[],
  sessions: readonly CheckoutSessionLike[]
): Entitlement {
  const plan = subscriptions.some((s) => PAYING_STATUSES.has(s.status)) ? "pro" : "free";
  const paidAnalysisIds = sessions
    // PAID, NOT MERELY COMPLETED. A session can complete with payment still
    // pending (bank transfers), and unlocking the game then would be giving it
    // away on a promise.
    .filter((s) => s.mode === "payment" && s.payment_status === "paid")
    .filter((s) => s.metadata?.kind === GAME_KIND && typeof s.metadata.analysis_id === "string")
    .map((s) => s.metadata!.analysis_id);
  return { plan, paidAnalysisIds: [...new Set(paidAnalysisIds)] };
}
