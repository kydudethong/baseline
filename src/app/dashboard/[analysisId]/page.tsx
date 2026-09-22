import type { CSSProperties } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { pickReferenceFrame } from "@/lib/vision/reference-frame";
import { sideOfCourt } from "@/lib/vision/positioning";
import { courtFrameFor } from "@/lib/vision/shots";
import { referenceFramePath } from "@/lib/coaching/reference-frame-image";
import { createClient } from "@/lib/supabase/server";
import { getSignedDownloadUrl } from "@/lib/storage/r2";
import { getSetup, isCompleteSetup } from "@/lib/db/setup";
import { getAnalysisForUser, type AnalysisWithVideo } from "@/lib/db/analyses";
import { getPhase2Data } from "@/lib/db/vision";
import { getProfile } from "@/lib/db/profiles";
import { getCoachingData } from "@/lib/db/coaching";
import { feedbackForAnalysis } from "@/lib/db/feedback";
import { evidenceForObservations } from "@/lib/db/evidence";
import { getBlueprintsForAnalysis } from "@/lib/db/blueprints";
import { getPracticePlan } from "@/lib/db/practice-plan";
import { playstyleMatches } from "@/lib/coaching/playstyle-match";
import { partnershipFrom } from "@/lib/coaching/partnership-read";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { ProcessingControls } from "@/components/dashboard/ProcessingControls";
import { AnalysisResultPanel } from "@/components/dashboard/AnalysisResultPanel";
import { MovementMetricsPanel } from "@/components/dashboard/MovementMetricsPanel";
import { PlayerTagPicker, type TagPickerFrame } from "@/components/dashboard/PlayerTagPicker";
import { Dialog } from "@/components/ui/Dialog";
import { CourtCalibrationEditor, type FullCourtCorners } from "@/components/dashboard/CourtCalibrationEditor";
import { computeHomography, applyHomography } from "@/lib/vision/homography";
import type { CourtCalibrationRow } from "@/lib/db/types";
import { CoachingReadPanel } from "@/components/dashboard/CoachingReadPanel";
import { ShareLinkButton } from "@/components/dashboard/ShareLinkButton";
import { shareUrl } from "@/lib/db/share";
import { env } from "@/lib/env";
import { BlueprintPanel } from "@/components/dashboard/BlueprintPanel";
import { PracticeSessionPanel } from "@/components/dashboard/PracticeSessionPanel";
import { PlaystyleMatchPanel } from "@/components/dashboard/PlaystyleMatchPanel";
import { PartnershipPanel } from "@/components/dashboard/PartnershipPanel";
import { CoachingFailureNote } from "@/components/dashboard/CoachingFailureNote";
import { CoachingInProgress } from "@/components/dashboard/CoachingInProgress";
import { PersonalDrillsReveal, prescribedDrills } from "@/components/analysis/DrillCards";
import { ShotsPanel } from "@/components/dashboard/ShotsPanel";
import { AnalysisWorkspace } from "@/components/analysis/AnalysisWorkspace";
import { EmptyState } from "@/components/analysis/EmptyState";
import { ErrorState } from "@/components/analysis/ErrorState";
import { getAnalysisView, type ViewRally } from "@/lib/db/analysis-view";
import { getAllDrills } from "@/lib/coaching/drills";
import { topPriorityObservation } from "@/lib/coaching/ranking";
import type { AnalysisFrameRow, PlayerTrackRow } from "@/lib/db/types";
import { clock, secs } from "@/lib/format/duration";

export const dynamic = "force-dynamic";


export async function generateMetadata({
  params,
}: {
  params: Promise<{ analysisId: string }>;
}): Promise<Metadata> {
  const { analysisId } = await params;
  const supabase = await createClient();
  const { data } = await supabase.from("analyses").select("title").eq("id", analysisId).maybeSingle();
  return { title: `${data?.title ?? "Analysis"} — Baseline` };
}

export default async function AnalysisDetailPage({
  params,
}: {
  params: Promise<{ analysisId: string }>;
}) {
  const { analysisId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();

  const analysis = await getAnalysisForUser(supabase, user.id, analysisId);
  if (!analysis) notFound();

  const video = analysis.video;
  const setup = await getSetup(supabase, analysisId);
  // A frame of the footage, for the header. Failing to sign is not an error —
  // the header simply renders without a thumbnail.
  const videoPoster = video ? await getSignedDownloadUrl(video.storage_path).catch(() => null) : null;

  const controls = (
    <ProcessingControls
      analysisId={analysis.id}
      status={analysis.status}
      // The same test the server gates on, so the button and the API can
      // never disagree about whether this clip is ready to run.
      hasSetup={isCompleteSetup(setup)}
    />
  );

  return (
    <>
      <Link href="/dashboard/library" className="crumb">← All analyses</Link>

      {/* WHICH VIDEO AM I LOOKING AT. The header was a filename and a row of
          grey metadata, which is a poor answer when somebody has six uploads
          called ky-720p, ky-720p-2 and so on. A frame from the footage answers
          it instantly and no amount of text does — you recognise the court,
          the lighting and who you were playing before you have finished
          reading the title. */}
      {/* WHICH VIDEO AM I LOOKING AT.
          Two answers, and which one is right depends on whether there is a
          player on the page. Before a run there is none, so the question is
          answered here, by a frame from the footage and the details beside it
          -- no amount of text tells six uploads called ky-720p apart, and one
          still frame does it instantly.

          After a run the player IS the answer, and it carries the title inside
          its own frame (see AnalysisWorkspace). Repeating it above would push
          the film a third of a phone screen down the page to say a second time
          what the picture already says. */}
      {analysis.status !== "completed" || !analysis.result ? (
      <header className="analysis-head">
        {videoPoster ? (
          <div className="analysis-thumb">
            <video src={`${videoPoster}#t=1`} preload="metadata" muted playsInline aria-hidden="true" />
          </div>
        ) : null}
        <div className="stack g2" style={{ minWidth: 0 }}>
          <div className="row g3">
            <h1 className="d2" style={{ margin: 0 }}>{analysis.title}</h1>
            <StatusBadge status={analysis.status} />
          </div>
          <div className="analysis-meta">
            <span>
              {new Date(analysis.created_at).toLocaleDateString(undefined, {
                weekday: "long", month: "long", day: "numeric",
              })}
            </span>
            {video?.duration_seconds ? <span>{formatDuration(video.duration_seconds)}</span> : null}
            {video?.width && video?.height ? <span>{video.height}p</span> : null}
            {analysis.coaching_kind ? <span>{prettyKind(analysis.coaching_kind)}</span> : null}
          </div>
        </div>
      </header>
      ) : null}

      {analysis.status === "failed" ? (
        <div className="error">
          <strong>Processing didn&apos;t finish.</strong>{" "}
          {analysis.error_message ?? "Something went wrong on our side."} You can try again below — if it keeps
          failing, a clip with the whole court in frame from a fixed camera usually fixes it.
        </div>
      ) : null}

      {/* Where these controls belong depends on whether there is anything to
          look at yet.

          Before a run they ARE the page: setup and "start processing" are the
          only things to do, so they lead. After one, the breakdown is what the
          user came for, and "the court was wrong, fix it and run again" is a
          conclusion they reach by watching the video — so the controls follow
          it rather than pushing it below the fold. Same component, two
          positions, decided here rather than by the component guessing. */}
      {analysis.status !== "completed" ? controls : null}

      {analysis.status === "completed" ? (
        <>
          {/* The breakdown needs a result; the controls do not. A completed
              run with no result row is rare but it is exactly when someone
              needs the re-run button, so the two conditions stay separate. */}
          {analysis.result ? (
            <AnalysisBreakdown
              supabase={supabase}
              analysis={analysis}
              heading={
                <>
                  <div className="row g2" style={{ alignItems: "center", flexWrap: "wrap" }}>
                    <h1 className="player-title">{analysis.title}</h1>
                    <StatusBadge status={analysis.status} />
                    {/* AT THE TOP, BESIDE THE TITLE. This first went into the
                        collapsed "measurements" panel on the reasoning that
                        sharing is an occasional owner action -- which read
                        sensibly and was wrong about the only use case there
                        is. The whole point of the feature is handing a read to
                        somebody standing next to you at a court, and a button
                        three taps inside a disclosure marked "Movement, the
                        raw shot table" is a button nobody finds. Reported as
                        exactly that: "i dont see share this read button". */}
                    {analysis.status === "completed"
                      ? <ShareLinkButton url={shareUrl(analysis.id, env.siteUrl)} />
                      : null}
                  </div>
                  <div className="player-meta">
                    <span>
                      {new Date(analysis.created_at).toLocaleDateString(undefined, {
                        month: "long", day: "numeric",
                      })}
                    </span>
                    {video?.duration_seconds ? <span>{formatDuration(video.duration_seconds)}</span> : null}
                    {video?.width && video?.height ? <span>{video.height}p</span> : null}
                    {analysis.coaching_kind ? <span>{prettyKind(analysis.coaching_kind)}</span> : null}
                  </div>
                </>
              }
            />
          ) : null}
          {controls}
        </>
      ) : null}
    </>
  );
}

async function AnalysisBreakdown({
  supabase,
  analysis,
  heading,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  analysis: AnalysisWithVideo;
  /** Title and details, handed to the player to draw inside its own frame. */
  heading?: React.ReactNode;
}) {
  const [phase2, profile, coachingData, blueprints, view, drills, practice, feedback] = await Promise.all([
    getPhase2Data(supabase, analysis.id),
    getProfile(supabase, analysis.user_id),
    getCoachingData(supabase, analysis.id),
    getBlueprintsForAnalysis(supabase, analysis.id),
    getAnalysisView(supabase, analysis),
    getAllDrills(supabase),
    getPracticePlan(supabase, analysis.id),
    feedbackForAnalysis(supabase, analysis.id),
  ]);
  const skillKeysWithBlueprint = new Set(blueprints.map((b) => b.blueprint.skill_key));
  const drillNames: Record<string, string> = {};
  for (const d of drills) drillNames[d.slug] = d.name;
  const drillCatalog = Object.fromEntries(drills.map((d) => [d.slug, d]));
  const prescribedCount = prescribedDrills(coachingData.observations)
    .filter((d) => drillCatalog[d.slug]).length;
  // Computed once and shared, so the workspace and the read below cannot
  // disagree about which point leads — if they did, it would print twice.
  const hero = topPriorityObservation(coachingData.observations);
  // The footage behind each claim. After the parallel fetch above because it
  // needs the observations it is evidence for.
  const video = analysis.video;
  let videoUrl: string | null = null;
  if (video) {
    videoUrl = await getSignedDownloadUrl(video.storage_path).catch(() => null);
  }

  // Resolved AFTER the video url, because a criticism whose clip was never cut
  // falls back to playing a window of the source -- the player's own footage,
  // not the overlay, and not the whole film.
  const evidence = await evidenceForObservations(
    supabase, analysis.id, coachingData.observations, videoUrl
  );

  const hasRead = coachingData.read !== null;
  const selfLabels = (analysis.self_player_label ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  /*
   * ASKED ONCE, ON THE SETUP PAGE.
   *
   * This step used to appear whenever there was no coaching read, which meant
   * somebody who had already tapped themselves before the analysis ran was
   * asked the same question again afterwards -- and asked it against a
   * DIFFERENT frame, with different boxes, so the two answers could disagree.
   * Reported as "I don't want it to show this; when I press on the person in
   * the setup page, that's who I chose".
   *
   * It is gated on the tag now rather than on the read. The only people who
   * still see it are the ones it was built for: analyses from before setup
   * asked, and any run where the seed never matched a track. Everyone else
   * changes their mind through the dialog below, which is a choice rather
   * than a step in the way.
   */
  const needsTagging = selfLabels.length === 0;

  /*
   * WHY THIS PAGE IS EMPTY, when it is empty.
   *
   * The coaching read is attempted after the analysis is already marked
   * completed, so that a failing read cannot turn a good CV run into a failed
   * one. The cost of that was a page marked Completed with nothing on it and
   * no way to tell "this clip had no rallies" from "the read never ran".
   *
   * Only shown when there is no read to show. A failure recorded on a run that
   * later succeeded is history, not news.
   */
  const coachingProgressRow = analysis.progress as
    { stage?: string; error?: string; coachingDone?: boolean; updatedAt?: string } | null;
  const coachingFailure = !hasRead ? (coachingProgressRow?.error ?? null) : null;
  /*
   * STILL BEING WRITTEN, which is different from failed and from never run.
   * The analysis says "completed" as soon as tracking ends; the read comes
   * minutes later. Without this the page showed that gap as empty panels.
   */
  const coachingRunning = !hasRead && !needsTagging && !coachingFailure
    && analysis.status === "completed"
    && coachingProgressRow?.stage === "coaching" && !coachingProgressRow?.coachingDone;
  /*
   * Tagged, completed, no read, and nothing says one is coming: an analysis
   * from before the run recorded its coaching stage, or one whose read was
   * never attempted. Offered the same retry as a failure, because the fix is
   * the same.
   */
  const coachingNeverRan = !hasRead && !needsTagging && !coachingFailure && !coachingRunning
    && analysis.status === "completed";

  const tagSection = (
    <TagSection
      supabase={supabase}
      analysis={analysis}
      phase2Tracks={phase2.tracks}
      phase2Frames={phase2.frames}
      calibration={phase2.calibration}
      profile={profile}
      hasExistingRead={hasRead}
      frameless={!needsTagging}
    />
  );


  return (
    <div className="stack g6">
      {coachingFailure ? (
        <CoachingFailureNote analysisId={analysis.id} reason={coachingFailure} />
      ) : null}
      {coachingRunning ? (
        <CoachingInProgress analysisId={analysis.id} startedAt={coachingProgressRow?.updatedAt ?? null} />
      ) : null}
      {coachingNeverRan ? (
        <CoachingFailureNote
          analysisId={analysis.id}
          reason="No coaching read was written for this clip — this analysis finished without starting one."
        />
      ) : null}

      {needsTagging ? (
        <div className="stack g4">
          <div className="stepbar">
            <span className="step done">
              <span className="n">✓</span>Tracked
            </span>
            <span className="step cur">
              <span className="sep" />
              <span className="n">2</span>Tag yourself
            </span>
            <span className="step">
              <span className="sep" />
              <span className="n">3</span>Coaching read
            </span>
          </div>
          {tagSection}
        </div>
      ) : null}

      <div className="row g3" style={{ justifyContent: "space-between" }}>
        <div className="row g2">
          {view.rallies.length > 0 ? (
            <p className="eyebrow" style={{ margin: 0 }}>Film room</p>
          ) : null}
        </div>
        <div className="row g2">
          <CourtDialog supabase={supabase} analysis={analysis} calibration={phase2.calibration} frames={phase2.frames} />
          {/* AVAILABLE WHENEVER SOMEBODY IS TAGGED, not only once a read exists.
              A run whose coaching pass failed still needs a way to re-tag and
              try again, and gating this on hasRead left that person with a
              page full of empty panels and no button on it. */}
          {!needsTagging && phase2.tracks.length > 0 ? (
            <Dialog
              trigger={
                <button type="button" className="btn btn-soft btn-sm">
                  Change who you are
                </button>
              }
              eyebrow="Re-tag & regenerate"
              title="Change who you are in this clip"
            >
              {tagSection}
            </Dialog>
          ) : null}
        </div>
      </div>

      {phase2.calibration && phase2.calibration.method !== "manual" && (Number(phase2.calibration.confidence) < 0.75 || phase2.calibration.confidence === 0) ? (
        <div className="note" style={{ borderLeft: "4px solid var(--warn)" }}>
          <strong style={{ color: "var(--ink)" }}>Check the court lines.</strong>{" "}
          {Number(phase2.calibration.confidence) === 0
            ? "Baseline couldn't find the court in this clip, so distances, zones and shot types are missing. Set the four corners and everything recomputes."
            : "The court was found automatically but not with full confidence. Every distance, zone and shot type is measured against those lines — a 20-second check makes the rest of this page trustworthy."}
        </div>
      ) : null}

      {view.rallies.length > 0 ? (
        <div className="scoreboard-row">
          <div className="cell">
            <div className="num">{view.rallies.length}</div>
            <div className="lbl">Rallies</div>
          </div>
          <div className="cell">
            <div className={`num${totalContacts(view.rallies) ? "" : " empty"}`}>
              {totalContacts(view.rallies) || "—"}
            </div>
            <div className="lbl">Paddle contacts</div>
          </div>
          <div className="cell">
            <div className={`num${median(view.rallies.map((r) => r.contactCount)) ? "" : " empty"}`}>
              {median(view.rallies.map((r) => r.contactCount)) || "—"}
            </div>
            <div className="lbl">Contacts / rally</div>
          </div>
          <div className="cell">
            <div className="num">{longestRally(view.rallies)}</div>
            <div className="lbl">Longest rally</div>
          </div>
        </div>
      ) : null}

      {/* The workspace itself: video, rallies, shots and the coaching on each,
          sharing one selection. It owns the Player, so nothing above renders one. */}
      {videoUrl ? (
        <AnalysisWorkspace
          view={view}
          videoUrl={videoUrl}
          drillNames={drillNames}
          heroObservationId={hero?.id ?? null}
          heading={heading}
          evidence={evidence}
          analysisId={analysis.id}
          feedback={feedback}
          coachingPending={coachingRunning}
          drillCatalog={drillCatalog}
          skillKeysWithBlueprint={skillKeysWithBlueprint}
          skills={coachingData.skills}
        />
      ) : (
        <ErrorState
          title="The video for this clip couldn't be loaded"
          body="Everything Baseline measured is still below, but the film itself is unavailable right now. This is usually temporary — reloading the page often fixes it."
        />
      )}

      {/* The ratings chart lives INSIDE the workspace now, beside the key
          takeaways -- see Overview in AnalysisWorkspace. */}

      {/* THE PRO MATCH, HIGH UP, because it is the thing people actually want
          to know and it was several screens below the film. It reads as a
          shape, so it belongs beside the chart that IS that shape. */}
      <PlaystyleMatchPanel
        matches={playstyleMatches(coachingData.read?.coaching_json ?? null)}
        hasRead={hasRead}
      />

      {/* HOW THE PAIR WORKS, next to how the player plays. It is a different
          question from everything else on this page -- most recreational
          doubles is lost by two people who each play fine and leave the middle
          open -- and it renders nothing at all unless a partner was tagged on
          the setup frame, which is the only way to know who it is about. */}
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
            analysisId={analysis.id}
            heroVerdict={hero ? feedback?.get(hero.id) ?? null : null}
          />
        </section>
      ) : (
        /* WHICH empty this is. "Tag which player is you" was shown to people
           who had already tagged themselves in setup, whose read had FAILED --
           sending them to look for a step that no longer exists. */
        <EmptyState
          title={needsTagging ? "Your coaching read goes here"
            : coachingRunning ? "Your coaching read is being written" : "The coaching read didn't run"}
          body={coachingRunning
            ? "It usually takes a few minutes on a full game. This page updates by itself when it's ready."
            : needsTagging
            ? "Tag which player is you above and Baseline will write it — strengths, the one fix that matters most, and a drill to start with."
            : coachingFailure
              ? "The reason is in the red box at the top of this page, with a button to try again."
              : "You're tagged, but no read was saved for this clip. Use “Change who you are” at the top to run it again."}
        />
      )}






      {/* The session plan, written by every run that produces a coaching read.
          It goes ABOVE the per-skill blueprints because it answers the more
          immediate question -- "what do I do at practice on Tuesday" -- while a
          blueprint answers "how do I get good at dinking over six weeks". The
          blueprints are also opt-in (someone has to press Build), so most
          analyses have none and this is the only plan on the page. */}
      {/* OFFERED, NOT IMPOSED.
          Four blocks, fifty-two minutes, every drill written out in full --
          setup, technique, and a stop-when condition. All of it useful, and
          all of it was landing on someone who had come to find out how they
          played, as roughly two screens of instructions they had not asked
          for. It is a different job on a different day: you read the analysis
          on the sofa and you read the drills at the court.

          Closed by default and one tap from open. The summary carries the
          block and minute counts, so the offer is specific -- "see the drills"
          with no idea whether that means two minutes or an hour is not an
          offer anyone can take. */}
      {/* THE DRILLS, OUT IN THE OPEN. They were a tab of names and a collapsed
          session plan below the fold -- the one part of the page that says
          what to DO, and it was the hardest part to find. Now a section of its
          own directly under the read, framed as the answer: each card says
          what it fixes before it says what it is. */}
      {prescribedCount > 0 ? (
        <section className="stack g3">
          <PersonalDrillsReveal observations={coachingData.observations} catalog={drillCatalog} />
        </section>
      ) : null}

      {/* THE SESSION PLAN ONLY WHEN THERE ARE NO PERSONAL DRILLS. It repeated
          the same drills inside a fifty-minute schedule, directly under them,
          and two things labelled "drills" read as the page not knowing which
          one it meant. Kept as the fallback for a read with no drills. */}
      {prescribedCount > 0 ? null : practice && practice.blocks.length > 0 ? (
        <section className="stack g4">
          <details className="reveal" style={{ "--reveal-accent": "var(--warn)" } as CSSProperties}>
            <summary className="reveal-sum">
              <span className="reveal-ic" aria-hidden="true">◎</span>
              <span className="reveal-txt">
                <span className="reveal-title">The full practice session</span>
                <span className="reveal-sub">
                  {practice.blocks.length} block{practice.blocks.length === 1 ? "" : "s"}
                  {practiceMinutes(practice.blocks) ? `, ${practiceMinutes(practice.blocks)} minutes` : ""}
                  {" · warm-up, drills and a game to finish"}
                </span>
              </span>
              <span className="reveal-chev" aria-hidden="true">Open</span>
            </summary>
            <div className="reveal-body">
              <PracticeSessionPanel
                plan={practice.plan}
                blocks={practice.blocks}
                drillNames={drillNames}
              />
            </div>
          </details>
        </section>
      ) : coachingData.read ? (
        <EmptyState
          title="No practice session was written for this clip"
          body="The session plan is the last step of a run and the only optional one — everything above it is already saved. Re-running the analysis usually produces one."
        />
      ) : null}

      {blueprints.length > 0 ? (
        <section className="stack g4">
          <h2 className="eyebrow">Build a skill over several sessions</h2>
          {blueprints.map(({ blueprint, steps }) => (
            <BlueprintPanel key={blueprint.id} analysisId={analysis.id} blueprint={blueprint} steps={steps} />
          ))}
        </section>
      ) : null}

      {/* Movement, the raw shot table and the tracker's own output. Collapsed
          because it is evidence for the read above, not the read itself. */}
      <details className="reveal" style={{ "--reveal-accent": "var(--ink-3)" } as CSSProperties}>
        <summary className="reveal-sum">
          <span className="reveal-ic" aria-hidden="true">⌗</span>
          <span className="reveal-txt">
            <span className="reveal-title">The measurements behind this page</span>
            <span className="reveal-sub">Movement, the raw shot table, and what the tracker saw</span>
          </span>
          <span className="reveal-chev" aria-hidden="true">Open</span>
        </summary>
        <div className="reveal-body stack g5">
          <AnalysisResultPanel result={analysis.result!} />
          <MovementMetricsPanel calibration={phase2.calibration} movement={phase2.movement} selfLabels={selfLabels} />
          {phase2.shots.length > 0 ? (
            <ShotsPanel shots={phase2.shots} ballTrack={phase2.ballTrack} selfLabels={selfLabels} />
          ) : null}
          <ReferenceFrameShown supabase={supabase} analysis={analysis} />
          <p className="dev-note">
            Want to see what the tracker actually detected?{" "}
            <Link href={`/dashboard/${analysis.id}/debug`}>Open the raw detections view</Link>.
          </p>
        </div>
      </details>
    </div>
  );
}

/**
 * The still the coaching model was shown, and who was marked on it.
 *
 * THE ONE INPUT THAT DECIDES THE SUBJECT, and until this existed nobody could
 * look at it: the image was built in a temp directory, base64'd into the
 * request and deleted. If a read comes back addressed to the wrong person,
 * this is the first thing to check -- either the mark is on the wrong player,
 * in which case the tag is wrong, or it is on the right one and the model
 * lost them, which is a different problem with a different fix.
 *
 * Absent until a coaching read has run, which is correct: before that there
 * is nothing to show, and a placeholder would imply otherwise.
 */
async function ReferenceFrameShown({
  supabase,
  analysis,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  analysis: AnalysisWithVideo;
}) {
  const { data } = await supabase.storage
    .from("videos")
    .createSignedUrl(referenceFramePath(analysis.user_id, analysis.id), 3600);
  if (!data?.signedUrl) return null;
  return (
    <div className="stack g2">
      <strong style={{ fontSize: 14 }}>What the coach was told about who you are</strong>
      <p className="sm measure" style={{ margin: 0, color: "var(--ink-2)" }}>
        This still is sent with the video. Nothing else in the footage says
        which player the read is about, so if the ring is on the wrong person,
        the coaching is about that person.
      </p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={data.signedUrl}
        alt="The frame sent to the coaching model, with the tagged player ringed"
        style={{ maxWidth: "100%", borderRadius: "var(--r3)", border: "1px solid var(--line)" }}
      />
    </div>
  );
}

/**
 * "Court lines" — opens the manual calibration editor on a stored debug
 * frame. Starting corners come from the automatic calibration: its quad is
 * converted to full-court baseline corners through its own homography
 * (extrapolating the far baseline when the detector only saw the near
 * half), so the user usually only nudges rather than starts from scratch.
 */
async function CourtDialog({
  supabase,
  analysis,
  calibration,
  frames,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  analysis: AnalysisWithVideo;
  calibration: CourtCalibrationRow | null;
  frames: AnalysisFrameRow[];
}) {
  const width = analysis.video?.width ?? 1920;
  const height = analysis.video?.height ?? 1080;
  const debugFrames = frames.filter((f) => f.debug_storage_path);
  if (debugFrames.length === 0) return null;
  const targetT = calibration ? Number(calibration.frame_timestamp_s) : 0;
  const frame = [...debugFrames].sort((a, b) => Math.abs(Number(a.timestamp_s) - targetT) - Math.abs(Number(b.timestamp_s) - targetT))[0];
  const { data } = await supabase.storage.from("videos").createSignedUrl(frame.debug_storage_path!, 3600);
  if (!data?.signedUrl) return null;

  const initial = initialFullCourtCorners(calibration, width, height);
  const source: "auto" | "manual" | "none" = !calibration || Number(calibration.confidence) === 0 ? "none" : calibration.method === "manual" ? "manual" : "auto";

  return (
    <Dialog
      trigger={
        <button type="button" className="btn btn-soft btn-sm">
          Court lines
        </button>
      }
      eyebrow="Calibration"
      title="Put the lines on the court"
      maxWidth={1100}
    >
      <CourtCalibrationEditor analysisId={analysis.id} imageUrl={data.signedUrl} width={width} height={height} initial={initial} source={source} />
    </Dialog>
  );
}

function initialFullCourtCorners(calibration: CourtCalibrationRow | null, width: number, height: number): FullCourtCorners {
  const fallback: FullCourtCorners = {
    topLeft: { x: width * 0.35, y: height * 0.45 },
    topRight: { x: width * 0.65, y: height * 0.45 },
    bottomLeft: { x: width * 0.15, y: height * 0.9 },
    bottomRight: { x: width * 0.85, y: height * 0.9 },
  };
  const corners = calibration?.corners_image_px as { topLeft: [number, number]; topRight: [number, number]; bottomLeft: [number, number]; bottomRight: [number, number] } | null | undefined;
  if (!calibration || !corners || Number(calibration.confidence) === 0) return fallback;
  const kind = ((calibration.diagnostics as { quadKind?: string } | null)?.quadKind ?? "near-half") as string;
  if (kind === "full") {
    return {
      topLeft: { x: corners.topLeft[0], y: corners.topLeft[1] },
      topRight: { x: corners.topRight[0], y: corners.topRight[1] },
      bottomLeft: { x: corners.bottomLeft[0], y: corners.bottomLeft[1] },
      bottomRight: { x: corners.bottomRight[0], y: corners.bottomRight[1] },
    };
  }
  // Project the far baseline through the partial quad's homography.
  const H = computeHomography(
    [[0, 0], [1, 0], [0, 1], [1, 1]],
    [corners.topLeft, corners.topRight, corners.bottomLeft, corners.bottomRight]
  );
  if (!H) return fallback;
  const farY = kind === "near-inplay" ? -29 / 15 : -1; // far baseline in that quad's units
  const [tlx, tly] = applyHomography(H, [0, farY]);
  const [trx, try_] = applyHomography(H, [1, farY]);
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Number.isFinite(v) ? v : 0));
  return {
    topLeft: { x: clamp(tlx, width), y: clamp(tly, height) },
    topRight: { x: clamp(trx, width), y: clamp(try_, height) },
    bottomLeft: { x: corners.bottomLeft[0], y: corners.bottomLeft[1] },
    bottomRight: { x: corners.bottomRight[0], y: corners.bottomRight[1] },
  };
}

/** Player self-tagging — see PlayerTagPicker.tsx. Kept as its own section, and
 * in a dialog once a read exists, because it drives (re)generating the read
 * itself rather than showing any part of it.
 *
 * phase2Tracks/phase2Frames are passed in from AnalysisBreakdown's own Phase2Data
 * fetch rather than re-queried here — this section used to call getPhase2Data a
 * second time per page load (6 more queries, including the frames and keypoints
 * tables) just to read the frame list that its caller already has. */
async function TagSection({
  supabase,
  analysis,
  phase2Tracks,
  phase2Frames,
  calibration,
  profile,
  hasExistingRead,
  frameless,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  analysis: AnalysisWithVideo;
  phase2Tracks: PlayerTrackRow[];
  phase2Frames: AnalysisFrameRow[];
  /** For the side-of-net split in the picker; null when no court was fitted. */
  calibration: CourtCalibrationRow | null;
  profile: Awaited<ReturnType<typeof getProfile>>;
  hasExistingRead: boolean;
  frameless?: boolean;
}) {
  if (phase2Tracks.length === 0) return null; // nothing to tag yet

  // ORDERED BY HOW MUCH OF THE CLIP EACH TRACK ACTUALLY COVERS.
  //
  // Sorting by label put "Player 1, Player 10, Player 11, Player 12..." in
  // front of somebody who plays in a doubles game, which is four people. The
  // tracker has no re-identification, so every time it loses a player behind
  // another one it picks them back up under a new id -- over a fourteen-minute
  // clip that turns four players into sixteen tracks, most of them a few
  // seconds long.
  //
  // The long-lived ones are the real players. Ordering by lifetime puts them
  // first, where the four chips somebody is looking for are the four chips
  // they see, and leaves the fragments after them rather than interleaved with
  // them by a lexicographic accident.
  const players = [...phase2Tracks]
    .map((t) => ({
      label: t.player_label,
      seen: ((t.points as unknown[] | null) ?? []).length,
    }))
    .sort((a, b) => b.seen - a.seen || a.label.localeCompare(b.label))
    .map((t) => t.label);
  const width = analysis.video?.width ?? 1920;
  const height = analysis.video?.height ?? 1080;

  // THE SAME FRAME THE COACHING PASS WILL MARK.
  //
  // pickReferenceFrame is shared with the coaching pass on purpose. This page
  // shows the player a frame and asks who they are; the coaching pass later
  // draws a mark on a frame and hands it to the model as the only statement of
  // who is being coached. If the two chose independently -- and they did, from
  // two copies of the same ranking in two files -- the player would be
  // answering a question about one moment and the model would be shown
  // another. Same function, same frame, no way for them to drift.
  // WHICH SIDE EACH PLAYER IS ON, so the picker can say that two of the four
  // are across the net and therefore cannot be you or your partner. Taken from
  // positioning.ts rather than recomputed: the two modules use opposite y
  // conventions and a second implementation would eventually get it backwards.
  // quadKind has no column of its own; it rides in diagnostics so it survives
  // the database round trip (see court.ts). It decides where the net line sits
  // in court units, so reading it wrong would put every player on the wrong
  // side -- which is worse than showing no side at all.
  const quadKind = (calibration?.diagnostics as { quadKind?: string } | null)?.quadKind ?? null;
  const courtFrame = courtFrameFor(
    quadKind === "full" || quadKind === "near-half" || quadKind === "near-inplay" ? quadKind : null
  );
  const hasCourt = Boolean(calibration) && Number(calibration?.confidence ?? 0) > 0;
  const sideOf = hasCourt ? (y: number) => sideOfCourt(y, courtFrame) : undefined;
  const picked = pickReferenceFrame(phase2Frames, phase2Tracks, sideOf);
  const referenceFrames: Array<TagPickerFrame | null> = [];
  if (picked) {
    const { data } = await supabase.storage
      .from("videos").createSignedUrl(picked.frame.debug_storage_path!, 3600);
    if (data?.signedUrl) {
      referenceFrames.push({
        url: data.signedUrl,
        timestampSeconds: picked.frame.timestamp_s,
        boxes: picked.boxes,
      });
    }
  }

  const initialSelfLabels = (analysis.self_player_label ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);

  return (
    <PlayerTagPicker
      analysisId={analysis.id}
      players={players}
      frames={referenceFrames.filter((f): f is TagPickerFrame => f !== null)}
      width={width}
      height={height}
      initialSelfLabels={initialSelfLabels}
      initialSkillLevel={profile?.skill_level ?? null}
      initialPaddleHand={profile?.paddle_hand ?? null}
      initialCoachingKind={analysis.coaching_kind}
      initialNotes={analysis.coaching_notes}
      hasExistingRead={hasExistingRead}
      frameless={frameless}
    />
  );
}

function totalContacts(rallies: ViewRally[]): number {
  return rallies.reduce((sum, r) => sum + r.contactCount, 0);
}

function longestRally(rallies: ViewRally[]): string {
  if (rallies.length === 0) return "—";
  const longest = Math.max(...rallies.map((r) => r.endS - r.startS));
  return secs(longest, 1);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function formatDuration(seconds: number): string {
  return clock(seconds);
}


/** "doubles_match" -> "Doubles match". */
function prettyKind(kind: string): string {
  const s = kind.replace(/[_-]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Total minutes of a session, or 0 when any block is missing its own. */
function practiceMinutes(blocks: Array<{ minutes: number | null }>): number {
  return blocks.every((b) => typeof b.minutes === "number" && b.minutes > 0)
    ? blocks.reduce((n, b) => n + (b.minutes ?? 0), 0)
    : 0;
}
