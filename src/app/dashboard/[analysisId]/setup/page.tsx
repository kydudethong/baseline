import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import SetupCanvas from "@/components/setup/SetupCanvas";
import { createClient } from "@/lib/supabase/server";
import { getAnalysisForUser } from "@/lib/db/analyses";
import { getSetup } from "@/lib/db/setup";
import { getSignedDownloadUrl } from "@/lib/storage/r2";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ analysisId: string }>;
}): Promise<Metadata> {
  const { analysisId } = await params;
  return { title: `Setup — Analysis ${analysisId.slice(0, 8)} — Baseline` };
}

/**
 * Setup before processing: confirm the court sits on the painted lines.
 *
 * ONE QUESTION, AND IT IS REQUIRED. This screen used to ask for three things --
 * the court, the players, and which player is you -- and it was optional,
 * because the pipeline could fall back on its own detection for all of them.
 * Two of the three moved to after the analysis, where the pipeline has already
 * found the players and can show real boxes to point at.
 *
 * What is left cannot move, because everything measured in feet depends on it
 * and nothing downstream can tell a court in the wrong place from one in the
 * right place. A bad court does not produce missing numbers, it produces
 * confident wrong ones -- so this is now a gate rather than a suggestion.
 */
export default async function SetupPage({
  params,
}: {
  params: Promise<{ analysisId: string }>;
}) {
  const { analysisId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) notFound();

  const analysis = await getAnalysisForUser(supabase, user.id, analysisId);
  if (!analysis) notFound();
  if (!analysis.video) {
    return (
      <div className="sec">
        <Link href={`/dashboard/${analysisId}`} className="crumb">← Back to analysis</Link>
        <div className="blank">
          <p className="blank-t">Nothing to set up yet</p>
          <p className="blank-b">Upload a video for this analysis first.</p>
        </div>
      </div>
    );
  }

  const videoUrl = await getSignedDownloadUrl(analysis.video.storage_path).catch(() => null);
  const setup = await getSetup(supabase, analysisId);

  return (
    <div>
      <Link href={`/dashboard/${analysisId}`} className="crumb">← Back to analysis</Link>

      <div className="stack g1" style={{ margin: "18px 0 20px" }}>
        <span className="eyebrow">Before analysing</span>
        <h1 className="h1">Put the lines on the court</h1>
      </div>
      <p className="sm measure" style={{ margin: "0 0 20px" }}>
        This page opens by scanning the clip for a frame with all four players
        on court and fitting the court lines on it, so most of the time there is
        nothing to do but check the blue lines sit on the paint and click the
        player you want analysed. Correct anything it got wrong — dragging a
        corner moves the kitchen line and net with it, which is the fastest way
        to see whether the geometry is right. Both parts are optional, but a
        court fitted wrongly is worse than none, so if the overlay on a previous
        run looked off, this is the fix.
      </p>

      {videoUrl ? (
        <SetupCanvas
          analysisId={analysisId}
          videoUrl={videoUrl}
          initial={
            setup
              ? {
                  frameTimestampSeconds: setup.frameTimestampSeconds,
                  court: setup.court
                    ? {
                        nearLeft: setup.court.nearLeft,
                        nearRight: setup.court.nearRight,
                        farRight: setup.court.farRight,
                        farLeft: setup.court.farLeft,
                        quadKind: setup.court.quadKind,
                      }
                    : null,
                  lineColorHex: setup.lineColorHex,
                  matchMode: setup.matchMode,
                }
              : null
          }
        />
      ) : (
        <div className="errbox">
          <p className="errbox-t">The video couldn&apos;t be loaded for setup</p>
          <p className="errbox-b">
            This is usually temporary — reloading the page often fixes it. You can also
            skip setup and analyse anyway; Baseline will find the court itself and say
            so honestly if it can&apos;t.
          </p>
        </div>
      )}
    </div>
  );
}
