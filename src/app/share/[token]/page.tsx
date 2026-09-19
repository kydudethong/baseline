import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";

import { createServiceRoleClient } from "@/lib/supabase/server";
import { analysisIdFromToken } from "@/lib/db/share";
import { getCoachingData } from "@/lib/db/coaching";
import { evidenceForObservations } from "@/lib/db/evidence";
import { topPriorityObservation } from "@/lib/coaching/ranking";
import { getSignedDownloadUrl } from "@/lib/storage/r2";
import { CoachingInsight } from "@/components/analysis/CoachingInsight";
import { SkillRadar } from "@/components/breakdown/SkillRadar";
import type { CoachingObservationRow } from "@/lib/db/types";

/**
 * One analysis, readable by anybody holding the link.
 *
 * THIS PAGE EXISTS FOR A CONVERSATION AT A COURT. Analysing a stranger's game
 * and handing them the result on their phone is the demo; "first make an
 * account" is where that conversation ends. So there is no sign-in here, and
 * deliberately nothing to sign in to: no tagging, no re-running, no feedback
 * buttons, no way to reach the owner's other games. Everything on this page is
 * a read of one row.
 *
 * IT IS OUTSIDE /dashboard ON PURPOSE. Authentication is enforced in
 * dashboard/layout.tsx, so anything under it is private by construction and
 * anything outside it is not. Putting a public page inside that tree and
 * poking a hole in the layout would make the rule "private unless excepted",
 * which is the shape that eventually leaks something.
 *
 * The service-role client is used BECAUSE there is no user: row-level security
 * keys off the signed-in account and there is not one. The signature is
 * therefore the only thing standing between this and somebody else's video,
 * which is why it is verified before a single query runs.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(
  { params }: { params: Promise<{ token: string }> }
): Promise<Metadata> {
  const { token } = await params;
  const id = analysisIdFromToken(token);
  if (!id) return { title: "Not found" };
  return {
    title: "A Baseline coaching read",
    // NOT INDEXED. A share link is for one person who was handed it, not for
    // anybody who searches for a name — and the page holds video of people who
    // never agreed to be on the open web.
    robots: { index: false, follow: false },
  };
}

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const analysisId = analysisIdFromToken(token);
  if (!analysisId) notFound();

  const supabase = createServiceRoleClient();
  const { data: analysis } = await supabase
    .from("analyses")
    .select("id, title, status, created_at, videos(storage_path, duration_seconds)")
    .eq("id", analysisId)
    .maybeSingle();
  if (!analysis || analysis.status !== "completed") notFound();

  const coaching = await getCoachingData(supabase, analysisId);
  if (!coaching.read) notFound();

  const video = Array.isArray(analysis.videos) ? analysis.videos[0] : analysis.videos;
  const videoUrl = video?.storage_path
    ? await getSignedDownloadUrl(video.storage_path).catch(() => null)
    : null;
  const evidence = await evidenceForObservations(supabase, analysisId, coaching.observations, videoUrl);
  const hero = topPriorityObservation(coaching.observations);
  const rest = coaching.observations.filter((o: CoachingObservationRow) => o.id !== hero?.id);

  return (
    <div className="sec stack g6" style={{ maxWidth: 860, margin: "0 auto", padding: "var(--a5) var(--a4)" }}>
      <div className="stack g1">
        <span className="eyebrow">Coaching read</span>
        <h1 className="h1">{analysis.title || "Your game, read back"}</h1>
        <p className="sm measure" style={{ color: "var(--ink-2)" }}>
          Someone ran this game through Baseline and shared the result with you. Nothing here
          needs an account, and this link only opens this one game.
        </p>
      </div>

      {coaching.skills.length > 0 ? (
        <div className="card stack g2">
          <span className="eyebrow">The shape of this game</span>
          <SkillRadar skills={coaching.skills} />
        </div>
      ) : null}

      {hero ? (
        <CoachingInsight
          observation={hero}
          hero
          eyebrow="The one thing to work on first"
          clipUrl={evidence.get(hero.id)?.clipUrl ?? null}
          fallbackUrl={evidence.get(hero.id)?.fallbackUrl ?? null}
          startSeconds={evidence.get(hero.id)?.startSeconds ?? null}
          windowStartSeconds={evidence.get(hero.id)?.windowStartSeconds ?? null}
          windowEndSeconds={evidence.get(hero.id)?.windowEndSeconds ?? null}
          technique={evidence.get(hero.id)?.technique ?? null}
        />
      ) : null}

      {rest.length > 0 ? (
        <div className="stack g4">
          <h2 className="h2">The rest of the read</h2>
          {rest.map((o: CoachingObservationRow) => (
            <CoachingInsight
              key={o.id}
              observation={o}
              clipUrl={evidence.get(o.id)?.clipUrl ?? null}
              fallbackUrl={evidence.get(o.id)?.fallbackUrl ?? null}
              startSeconds={evidence.get(o.id)?.startSeconds ?? null}
              windowStartSeconds={evidence.get(o.id)?.windowStartSeconds ?? null}
              windowEndSeconds={evidence.get(o.id)?.windowEndSeconds ?? null}
              technique={evidence.get(o.id)?.technique ?? null}
            />
          ))}
        </div>
      ) : null}

      <div className="card stack g2">
        <strong>Want one of these for your own games?</strong>
        <p className="sm measure" style={{ margin: 0, color: "var(--ink-2)" }}>
          Baseline watches a clip of your match and tells you the one change worth making,
          with the footage it is based on.
        </p>
        <div className="row g2">
          <Link href="/signup" className="btn btn-optic">Analyse your own game</Link>
        </div>
      </div>
    </div>
  );
}
