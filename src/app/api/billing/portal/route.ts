import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { portalUrl, stripeConfigured } from "@/lib/billing/stripe";

/**
 * Stripe's customer portal: change card, see invoices, cancel.
 *
 * Cancelling is one click away and handled entirely by Stripe, on purpose. A
 * subscription that is hard to leave is one people are wary of starting.
 */
export async function POST() {
  if (!stripeConfigured()) {
    return NextResponse.json({ error: "Payments aren't set up on this server yet." }, { status: 503 });
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  try {
    const url = await portalUrl({ userId: user.id, email: user.email, siteUrl: env.siteUrl });
    return NextResponse.json({ url });
  } catch (err) {
    console.error(`[billing] portal failed: ${(err as Error).message}`);
    return NextResponse.json({ error: "Could not open billing. Try again in a moment." }, { status: 502 });
  }
}
