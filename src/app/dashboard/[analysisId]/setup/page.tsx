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
 * Setup before processing: mark the court, pick the players.
 *
 * Optional by design. Skipping it costs accuracy, not function -- the pipeline
 * detects everything itself and says honestly when it could not. But two
 * minutes here removes the failure modes that are hardest to recover from
 * afterwards: a wrong court corrupts every out-of-bounds call, and untagged
 * spectators end up tracked as players.
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
                  players: setup.players.map((p) => ({ x: p.x, y: p.y, isSelf: p.isSelf })),
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
