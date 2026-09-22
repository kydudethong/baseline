import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { planCheckoutUrl, stripeConfigured } from "@/lib/billing/stripe";

/**
 * Start a Stripe Checkout for the monthly plan and hand back its URL.
 *
 * One plan, so there is nothing to choose: the price is Stripe's, the success
 * page is Stripe's, and the card never touches this server.
 */
export async function POST() {
  if (!stripeConfigured()) {
    return NextResponse.json({ error: "Payments aren't set up on this server yet." }, { status: 503 });
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  try {
    const url = await planCheckoutUrl({ userId: user.id, email: user.email, siteUrl: env.siteUrl });
    return NextResponse.json({ url });
  } catch (err) {
    console.error(`[billing] checkout failed: ${(err as Error).message}`);
    return NextResponse.json({ error: "Could not start checkout. Try again in a moment." }, { status: 502 });
  }
}
