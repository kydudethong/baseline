import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getAnalysisForUser } from "@/lib/db/analyses";
import { GAME_MAX_MINUTES } from "@/lib/db/quota";
import { env } from "@/lib/env";
import { gameCheckoutUrl, planCheckoutUrl, stripeConfigured } from "@/lib/billing/stripe";

const Body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan") }),
  z.object({ kind: z.literal("game"), analysisId: z.string().uuid() }),
]);

/**
 * Start a Stripe Checkout and hand back its URL. The browser goes there.
 *
 * The price is Stripe's, the success page is Stripe's, the card never
 * touches this server. What this route decides is only WHAT is being bought
 * -- and, for a single game, that the game is the caller's and is short
 * enough for one game's price.
 */
export async function POST(request: Request) {
  if (!stripeConfigured()) {
    return NextResponse.json({ error: "Payments aren't set up on this server yet." }, { status: 503 });
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid checkout request." }, { status: 400 });

  try {
    if (parsed.data.kind === "plan") {
      const url = await planCheckoutUrl({ userId: user.id, email: user.email, siteUrl: env.siteUrl });
      return NextResponse.json({ url });
    }

    // Checked here and not only in the UI: the metadata on this payment is
    // what unlocks the run, so it must only ever name the buyer's own clip.
    const analysis = await getAnalysisForUser(supabase, user.id, parsed.data.analysisId);
    if (!analysis?.video) return NextResponse.json({ error: "Analysis not found" }, { status: 404 });
    const secs = analysis.video.duration_seconds;
    if (secs === null || secs / 60 > GAME_MAX_MINUTES) {
      return NextResponse.json({
        error: `A single game covers up to ${GAME_MAX_MINUTES} minutes. Trim the clip, or use the monthly plan.`,
      }, { status: 400 });
    }
    const url = await gameCheckoutUrl({
      userId: user.id, email: user.email, siteUrl: env.siteUrl, analysisId: analysis.id,
    });
    return NextResponse.json({ url });
  } catch (err) {
    console.error(`[billing] checkout failed: ${(err as Error).message}`);
    return NextResponse.json({ error: "Could not start checkout. Try again in a moment." }, { status: 502 });
  }
}
