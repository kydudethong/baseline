/**
 * Stripe, as the only record of who has paid.
 *
 * NO TABLE AND NO WEBHOOK, and that is a choice with reasons. This repo does
 * not apply migrations automatically (RUN_MIGRATIONS is unset), so a
 * `subscriptions` table would ship as code reading something that does not
 * exist. And a webhook is a second copy of "is this person paying" that can
 * disagree with the one that charges them -- a missed event, a failed
 * delivery during a deploy -- and those failures are silent and cost somebody
 * a service they paid for. Asking Stripe at the moment it matters cannot
 * disagree with Stripe.
 *
 * The cost is an API call when the dashboard renders and when a run starts,
 * softened by a short cache. At this product's scale that is nothing.
 */
import Stripe from "stripe";
import type { Entitlement } from "@/lib/db/quota";
import { FREE_ENTITLEMENT } from "@/lib/db/quota";
import { entitlementFrom, GAME_KIND } from "./entitlement";

export function stripeConfigured(): boolean {
  return Boolean(
    process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_PLAN && process.env.STRIPE_PRICE_GAME
  );
}

let client: Stripe | null = null;
function stripe(): Stripe {
  if (!client) client = new Stripe(process.env.STRIPE_SECRET_KEY!);
  return client;
}

/**
 * The customer for this account, found by the user id WE stamped on it.
 *
 * Matched on metadata, not on email alone. Two accounts can share an email
 * across a sign-up mix-up, and the Stripe dashboard lets anybody edit a
 * customer's email -- neither should be able to hand one person another's
 * subscription.
 */
async function findCustomer(userId: string, email: string | null | undefined): Promise<Stripe.Customer | null> {
  if (!email) return null;
  const list = await stripe().customers.list({ email, limit: 20 });
  return list.data.find((c) => !c.deleted && c.metadata?.user_id === userId) ?? null;
}

export async function getOrCreateCustomer(userId: string, email: string): Promise<string> {
  const found = await findCustomer(userId, email);
  if (found) return found.id;
  const created = await stripe().customers.create({ email, metadata: { user_id: userId } });
  return created.id;
}

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; value: Entitlement }>();

export interface EntitlementResult {
  entitlement: Entitlement;
  /**
   * Stripe could not be asked. The caller decides what that means: refusing a
   * paying customer's run because Stripe blinked is a worse failure than one
   * free run, so the run gate treats unknown as paid.
   */
  unknown: boolean;
}

export async function entitlementFor(
  userId: string,
  email: string | null | undefined,
  opts: { fresh?: boolean } = {}
): Promise<EntitlementResult> {
  if (!stripeConfigured()) return { entitlement: FREE_ENTITLEMENT, unknown: false };
  const hit = cache.get(userId);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) {
    return { entitlement: hit.value, unknown: false };
  }
  try {
    const customer = await findCustomer(userId, email);
    if (!customer) {
      cache.set(userId, { at: Date.now(), value: FREE_ENTITLEMENT });
      return { entitlement: FREE_ENTITLEMENT, unknown: false };
    }
    const [subs, sessions] = await Promise.all([
      stripe().subscriptions.list({ customer: customer.id, status: "all", limit: 20 }),
      stripe().checkout.sessions.list({ customer: customer.id, limit: 100 }),
    ]);
    const value = entitlementFrom(
      subs.data.map((s) => ({ status: s.status })),
      sessions.data.map((s) => ({ mode: s.mode, payment_status: s.payment_status, metadata: s.metadata }))
    );
    cache.set(userId, { at: Date.now(), value });
    return { entitlement: value, unknown: false };
  } catch (err) {
    console.error(`[billing] could not read entitlement for ${userId}: ${(err as Error).message}`);
    return { entitlement: FREE_ENTITLEMENT, unknown: true };
  }
}

/** Forget what we cached, so the page after a checkout sees the purchase. */
export function forgetEntitlement(userId: string): void {
  cache.delete(userId);
}

export async function planCheckoutUrl(opts: {
  userId: string; email: string; siteUrl: string;
}): Promise<string> {
  const customer = await getOrCreateCustomer(opts.userId, opts.email);
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [{ price: process.env.STRIPE_PRICE_PLAN!, quantity: 1 }],
    success_url: `${opts.siteUrl}/dashboard?billing=success`,
    cancel_url: `${opts.siteUrl}/dashboard?billing=cancelled`,
    allow_promotion_codes: true,
  });
  return session.url!;
}

export async function gameCheckoutUrl(opts: {
  userId: string; email: string; siteUrl: string; analysisId: string;
}): Promise<string> {
  const customer = await getOrCreateCustomer(opts.userId, opts.email);
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    customer,
    line_items: [{ price: process.env.STRIPE_PRICE_GAME!, quantity: 1 }],
    // THE GAME IT BUYS IS WRITTEN ON THE PAYMENT, and that is the whole
    // record. entitlementFrom reads it back; nothing else has to remember.
    metadata: { kind: GAME_KIND, analysis_id: opts.analysisId, user_id: opts.userId },
    // Back to setup, where the court and the tag are already saved: one more
    // press of Analyse and it runs.
    success_url: `${opts.siteUrl}/dashboard/${opts.analysisId}/setup?paid=1`,
    cancel_url: `${opts.siteUrl}/dashboard/${opts.analysisId}/setup`,
  });
  return session.url!;
}

export async function portalUrl(opts: { userId: string; email: string; siteUrl: string }): Promise<string> {
  const customer = await getOrCreateCustomer(opts.userId, opts.email);
  const session = await stripe().billingPortal.sessions.create({
    customer,
    return_url: `${opts.siteUrl}/dashboard`,
  });
  return session.url;
}

/**
 * The prices as Stripe has them, for the buttons.
 *
 * Read from Stripe rather than written into the page, because a price
 * changed in the dashboard and not here would show one number on the button
 * and charge another.
 */
let priceCache: { at: number; plan: string; game: string } | null = null;
export async function priceLabels(): Promise<{ plan: string; game: string } | null> {
  if (!stripeConfigured()) return null;
  if (priceCache && Date.now() - priceCache.at < 10 * 60_000) return priceCache;
  try {
    const [plan, game] = await Promise.all([
      stripe().prices.retrieve(process.env.STRIPE_PRICE_PLAN!),
      stripe().prices.retrieve(process.env.STRIPE_PRICE_GAME!),
    ]);
    const fmt = (p: Stripe.Price) =>
      new Intl.NumberFormat("en-US", { style: "currency", currency: p.currency.toUpperCase() })
        .format((p.unit_amount ?? 0) / 100);
    priceCache = { at: Date.now(), plan: fmt(plan), game: fmt(game) };
    return priceCache;
  } catch {
    return null;
  }
}
