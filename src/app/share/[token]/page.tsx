import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";

import { createServiceRoleClient } from "@/lib/supabase/server";
import { analysisIdFromToken } from "@/lib/db/share";
import { getCoachingData } from "@/lib/db/coaching";
import { getAnalysisView } from "@/lib/db/analysis-view";
import { getPracticePlan } from "@/lib/db/practice-plan";
import { evidenceForObservations } from "@/lib/db/evidence";
import { getAllDrills } from "@/lib/coaching/drills";
import { topPriorityObservation } from "@/lib/coaching/ranking";
import { playstyleMatches } from "@/lib/coaching/playstyle-match";
import { partnershipFrom } from "@/lib/coaching/partnership-read";
import { getSignedDownloadUrl } from "@/lib/storage/r2";
import { AnalysisWorkspace } from "@/components/analysis/AnalysisWorkspace";
import { CoachingReadPanel } from "@/components/dashboard/CoachingReadPanel";
import { PlaystyleMatchPanel } from "@/components/dashboard/PlaystyleMatchPanel";
import { PartnershipPanel } from "@/components/dashboard/PartnershipPanel";
import { PracticeSessionPanel } from "@/components/dashboard/PracticeSessionPanel";
import { PersonalDrillsReveal, prescribedDrills } from "@/components/analysis/DrillCards";
import { ErrorState } from "@/components/analysis/ErrorState";
import type { AnalysisWithVideo } from "@/lib/db/analyses";

/**
 * One analysis, in full, readable by anybody holding the link.
 *
 * THE SAME PAGE THE OWNER SEES, minus the things that write. The first
 * version of this was a hand-built summary -- the read, a chart, the clips --
 * on the reasoning that a stranger needs less. That was wrong twice over: the
 * person being shown this is the player IN the footage, so they want the video
 * and the drills more than the owner does, and a second hand-maintained copy
 * of the analysis layout is a copy that drifts. Every improvement to the real
 * page would have had to be made twice, and would not have been.
 *
 * SO THE DIFFERENCE IS PERMISSION, NOT CONTENT. AnalysisWorkspace,
 * CoachingReadPanel and the rest already treat `analysisId` as optional and
 * hide every control that writes when it is absent -- the feedback buttons,
 * the blueprint builder. Omitting it is the whole of read-only, and it is
 * enforced by those components rather than by this page remembering to leave
 * things out.
 *
 * WHAT IS STILL MISSING ON PURPOSE: no tagging, no re-running, no route to the
 * owner's other games, and no share button of its own.
 *
 * It sits outside /dashboard deliberately. Auth is enforced in that layout, so
 * everything under it is private by construction and everything outside is
 * not. A public page inside that tree with a hole in the layout would make the
 * rule "private unless excepted", which is the shape that eventually leaks.
 *
 * The service-role client is used BECAUSE there is no user for row-level
 * security to key off. The signature is therefore the only thing between this
 * and somebody else's video, which is why it is verified before a query runs.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(
  { params }: { params: Promise<{ token: string }> }
): Promise<Metadata> {
  const { token } = await params;
  if (!analysisIdFromToken(token)) return { title: "Not found" };
  return {
    title: "A Baseline coaching read",
    // NOT INDEXED. A share link is for one person who was handed it, and the
    // page holds video of people who never agreed to be on the open web.
    robots: { index: false, follow: false },
  };
}

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const analysisId = analysisIdFromToken(token);
  if (!analysisId) notFound();

  const supabase = createServiceRoleClient();
  const { data: row } = await supabase
    .from("analyses")
    .select("*, videos(*)")
    .eq("id", analysisId)
    .maybeSingle();
  if (!row || row.status !== "completed") notFound();

  const video = Array.isArray(row.videos) ? row.videos[0] : row.videos;
  const analysis = { ...row, video } as AnalysisWithVideo;

  const [coachingData, view, drills, practice] = await Promise.all([
    getCoachingData(supabase, analysisId),
    getAnalysisView(supabase, analysis),
    getAllDrills(supabase),
    getPracticePlan(supabase, analysisId),
  ]);

  const drillNames: Record<string, string> = {};
  for (const d of drills) drillNames[d.slug] = d.name;
  const drillCatalog = Object.fromEntries(drills.map((d) => [d.slug, d]));
  const prescribedCount = prescribedDrills(coachingData.observations)
    .filter((d) => drillCatalog[d.slug]).length;
  const hero = topPriorityObservation(coachingData.observations);

  const videoUrl = video?.storage_path
    ? await getSignedDownloadUrl(video.storage_path).catch(() => null)
    : null;
  const evidence = await evidenceForObservations(
    supabase, analysisId, coachingData.observations, videoUrl
  );

  return (
    <div className="sec stack g6" style={{ maxWidth: 1100, margin: "0 auto", padding: "var(--a5) var(--a4)" }}>
      <div className="stack g1">
        <span className="eyebrow">Shared with you</span>
        <h1 className="h1">{analysis.title || "Your game, read back"}</h1>
        <p className="sm measure" style={{ color: "var(--ink-2)" }}>
          Someone ran this game through Baseline and sent you the result. Everything here is
          read-only, and the link only opens this one game.
        </p>
      </div>

      {videoUrl ? (
        <AnalysisWorkspace
          view={view}
          videoUrl={videoUrl}
          drillNames={drillNames}
          drillCatalog={drillCatalog}
          heroObservationId={hero?.id ?? null}
          evidence={evidence}
          skills={coachingData.skills}
          /* No analysisId: that is what makes every write control disappear. */
        />
      ) : (
        <ErrorState
          title="The video for this clip couldn't be loaded"
          body="Everything Baseline measured is still below, but the film itself is unavailable right now. This is usually temporary — reloading the page often fixes it."
        />
      )}

      <PlaystyleMatchPanel
        matches={playstyleMatches(coachingData.read?.coaching_json ?? null)}
        hasRead={coachingData.read !== null}
      />

      {/* The shared page shows everything the owner sees. No onSeek here --
          the timestamps read as text rather than as buttons, because the
          read-only view has no player to drive. */}
      <PartnershipPanel
        partnership={partnershipFrom(coachingData.read?.coaching_json ?? null)}
      />

      {coachingData.read ? (
        <section className="stack g4">
          <CoachingReadPanel
            read={coachingData.read}
            observations={coachingData.observations}
            hero={hero}
            heroEvidence={hero ? evidence.get(hero.id) ?? null : null}
            drillName={hero?.drill_slug ? drillNames[hero.drill_slug] : null}
          />
        </section>
      ) : null}

      {prescribedCount > 0 ? (
        <section className="stack g3">
          <PersonalDrillsReveal observations={coachingData.observations} catalog={drillCatalog} subject="them" />
        </section>
      ) : null}

      {prescribedCount === 0 && practice?.plan && practice.blocks.length > 0 ? (
        <section className="stack g4">
          <h2 className="h2">The full practice session</h2>
          <PracticeSessionPanel plan={practice.plan} blocks={practice.blocks} drillNames={drillNames} />
        </section>
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
