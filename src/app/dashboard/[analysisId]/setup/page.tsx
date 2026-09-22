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
 * Setup before processing: the court, and who you are.
 *
 * TWO QUESTIONS, BOTH REQUIRED, and they are required for different reasons.
 *
 * The court, because everything measured in feet depends on it and nothing
 * downstream can tell one in the wrong place from one in the right place. A
 * bad court does not produce missing numbers, it produces confident wrong
 * ones.
 *
 * The identity, because the coaching pass cannot be addressed to anybody
 * without it. That question briefly lived AFTER the analysis, on the theory
 * that the pipeline's own boxes make it an easier thing to answer -- and they
 * do, but it cost a whole Gemini pass: the run either skipped the read and
 * needed re-running once somebody tagged themselves, or wrote a read about
 * whoever the pipeline guessed. Asking here means the expensive part happens
 * once, already knowing who it is about.
 *
 * Tagging a PARTNER is offered here too and stays optional. It is the only
 * thing that produces the partnership read -- how the two of you work as a
 * pair rather than how each of you plays -- and there is no way to infer it:
 * on a doubles court the teammate is one of three candidates.
 */
export default async function SetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ analysisId: string }>;
  searchParams?: Promise<{ paid?: string }>;
}) {
  const { analysisId } = await params;
  const justPaid = (await searchParams)?.paid === "1";
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

      {justPaid ? (
        // Back from Stripe. The only thing left to do is the thing they paid
        // for, so say that, rather than landing them on a page that looks
        // exactly like the one that just refused them.
        <div className="note" style={{ borderLeft: "4px solid var(--good)", marginTop: 18 }}>
          <strong style={{ color: "var(--ink)" }}>Payment received.</strong>{" "}
          Your court and your tag are still here — press <strong>Looks right — analyse</strong> to run it.
        </div>
      ) : null}

      <div className="stack g1" style={{ margin: "18px 0 20px" }}>
        <span className="eyebrow">Before analysing</span>
        <h1 className="h1">Put the lines on the court</h1>
      </div>
      <p className="sm measure" style={{ margin: "0 0 20px" }}>
        This page opens by scanning the clip for a frame with all four players
        on court and fitting the court lines on it, so most of the time there is
        nothing to do but check the blue lines sit on the paint and tap
        yourself. Correct anything it got wrong — dragging a corner moves the
        kitchen line and net with it, which is the fastest way to see whether
        the geometry is right. Tap your partner too if you want a read on how
        the two of you play together; that part is optional.
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
                  players: setup.players,
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
