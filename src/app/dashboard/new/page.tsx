import type { Metadata } from "next";
import { VideoUploader } from "@/components/upload/VideoUploader";
import { linkFetchAvailable } from "@/lib/deployment";
import { createClient } from "@/lib/supabase/server";
import { entitlementFor } from "@/lib/billing/stripe";
import { quotaForUser } from "@/lib/db/quota";

export const metadata: Metadata = { title: "Analyze Your Game — Baseline" };

export default async function NewAnalysisPage() {
  // Shown where it works, hidden where it does not — see linkFetchAvailable()
  // for why "does not" is permanent. Offering a control that fails every time
  // is worse than not offering it: on the very first screen, the user reads
  // that failure as the whole product being broken.
  const linkFetchWorks = linkFetchAvailable();

  // WHAT IS LEFT OF THE ALLOWANCE, so the trim panel can open itself on a clip
  // that will not fit and offer a cut of exactly that length. Being told
  // before the upload beats being refused after it.
  let remainingSeconds: number | null = null;
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { entitlement } = await entitlementFor(user.id, user.email);
      const quota = await quotaForUser(supabase, user.id, user.email ?? null, "", null, entitlement);
      if (!quota.unlimited) remainingSeconds = Math.max(0, Math.round(quota.remainingMinutes * 60));
    }
  } catch {
    // The uploader works without it; it just cannot pre-empt the refusal.
  }

  return (
    <div className="sec" style={{ maxWidth: 640, margin: "0 auto", width: "100%" }}>
      <div className="stack g1">
        <span className="eyebrow">New analysis</span>
        <h1 className="h1">Analyze a game</h1>
        <p className="sm measure">
          Upload a recording of your match. Baseline tracks the court and every player, then you tag which
          one is you and get your coaching read.
        </p>
      </div>
      <div className="card">
        <VideoUploader linkFetchWorks={linkFetchWorks} remainingSeconds={remainingSeconds} />
      </div>
      <p className="xs measure">
        Best results: a fixed camera behind or above the baseline, the whole court in frame, one game per
        clip. Phone footage is fine.
      </p>
    </div>
  );
}
