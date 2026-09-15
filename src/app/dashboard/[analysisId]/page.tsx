import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getSignedDownloadUrl } from "@/lib/storage/r2";
import { getSetup } from "@/lib/db/setup";
import { getAnalysisForUser, type AnalysisWithVideo } from "@/lib/db/analyses";
import { getPhase2Data } from "@/lib/db/vision";
import { getProfile } from "@/lib/db/profiles";
import { getCoachingData } from "@/lib/db/coaching";
import { feedbackForAnalysis } from "@/lib/db/feedback";
import { evidenceForObservations } from "@/lib/db/evidence";
import { getBlueprintsForAnalysis } from "@/lib/db/blueprints";
import { getPracticePlan } from "@/lib/db/practice-plan";
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
import { BlueprintPanel } from "@/components/dashboard/BlueprintPanel";
import { PracticeSessionPanel } from "@/components/dashboard/PracticeSessionPanel";
import { PlaystyleMatchPanel } from "@/components/dashboard/PlaystyleMatchPanel";
import { PositioningPanel } from "@/components/dashboard/PositioningPanel";
import type { PlaystyleMatch } from "@/lib/coaching/pro-playstyles";
import { ShotsPanel } from "@/components/dashboard/ShotsPanel";
import { AnalysisWorkspace } from "@/components/analysis/AnalysisWorkspace";
import { EmptyState } from "@/components/analysis/EmptyState";
import { ErrorState } from "@/components/analysis/ErrorState";
import { getAnalysisView, type ViewRally } from "@/lib/db/analysis-view";
import { getAllDrills } from "@/lib/coaching/drills";
import { topPriorityObservation } from "@/lib/coaching/ranking";
import { SkillRadar } from "@/components/breakdown/SkillRadar";
import type { AnalysisFrameRow, PlayerTrackRow } from "@/lib/db/types";

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
      hasSetup={Boolean(setup && (setup.court || setup.players.length > 0))}
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
                  <div className="row g2" style={{ alignItems: "center" }}>
                    <h1 className="player-title">{analysis.title}</h1>
                    <StatusBadge status={analysis.status} />
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
  // Computed once and shared, so the workspace and the read below cannot
  // disagree about which point leads — if they did, it would print twice.
  const hero = topPriorityObservation(coachingData.observations);
  // The footage behind each claim. After the parallel fetch above because it
  // needs the observations it is evidence for.
  const evidence = await evidenceForObservations(supabase, analysis.id, coachingData.observations);

  const video = analysis.video;
  let videoUrl: string | null = null;
  if (video) {
    videoUrl = await getSignedDownloadUrl(video.storage_path).catch(() => null);
  }

  const hasRead = coachingData.read !== null;
  const selfLabels = (analysis.self_player_label ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  const tagSection = (
    <TagSection
      supabase={supabase}
      analysis={analysis}
      phase2Tracks={phase2.tracks}
      phase2Frames={phase2.frames}
      profile={profile}
      hasExistingRead={hasRead}
      frameless={hasRead}
    />
  );

  return (
    <div className="stack g6">
      {!hasRead ? (
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
          {hasRead && phase2.tracks.length > 0 ? (
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
        />
      ) : (
        <ErrorState
          title="The video for this clip couldn't be loaded"
          body="Everything Baseline measured is still below, but the film itself is unavailable right now. This is usually temporary — reloading the page often fixes it."
        />
      )}

      {coachingData.read ? (
        <section className="stack g4">
          <CoachingReadPanel
            read={coachingData.read}
            observations={coachingData.observations}
            skills={coachingData.skills}
            analysisId={analysis.id}
            skillKeysWithBlueprint={skillKeysWithBlueprint}
            drillNames={drillNames}
            feedback={feedback}
            evidence={evidence}
          />
        </section>
      ) : (
        <EmptyState
          title="Your coaching read goes here"
          body="Tag which player is you above and Baseline will write it — strengths, the one fix that matters most, and a drill to start with."
        />
      )}

      {/* Where they stood. Above the pro comparison because it is a fact about
          this clip rather than an interpretation of it, and because kitchen
          time is the number most likely to change what someone does at their
          next session. */}
      <PositioningPanel movement={phase2.movement} selfLabels={selfLabels} />

      {/* Directly after the skill radar, and that placement is the argument:
          the match IS the radar, read as a shape. Somebody who has just looked
          at their own profile can see why a particular pro came back, which is
          what stops "you play like X" from being a horoscope. */}
      <PlaystyleMatchPanel
        matches={playstyleMatches(coachingData.read?.coaching_json ?? null)}
        hasRead={hasRead}
      />

      {coachingData.skills.length > 0 ? (
        <section className="stack g4">
          <h2 className="eyebrow">Where those ratings sit against each other</h2>
          <div className="card">
            <SkillRadar skills={coachingData.skills} />
          </div>
          <p className="note">
            The numbers themselves are in the breakdown above. This is the shape they make.{" "}
            <Link href="/dashboard/practice" className="crumb" style={{ color: "var(--blue)" }}>
              See how each skill is trending across your games →
            </Link>
          </p>
        </section>
      ) : null}

      {/* The session plan, written by every run that produces a coaching read.
          It goes ABOVE the per-skill blueprints because it answers the more
          immediate question -- "what do I do at practice on Tuesday" -- while a
          blueprint answers "how do I get good at dinking over six weeks". The
          blueprints are also opt-in (someone has to press Build), so most
          analyses have none and this is the only plan on the page. */}
      {practice && practice.blocks.length > 0 ? (
        <section className="stack g4">
          <PracticeSessionPanel
            plan={practice.plan}
            blocks={practice.blocks}
            drillNames={drillNames}
          />
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
      <details className="card">
        <summary className="sm" style={{ cursor: "pointer" }}>
          The measurements behind this page
        </summary>
        <div className="stack g5" style={{ marginTop: 16 }}>
          <AnalysisResultPanel result={analysis.result!} />
          <MovementMetricsPanel calibration={phase2.calibration} movement={phase2.movement} selfLabels={selfLabels} />
          {phase2.shots.length > 0 ? (
            <ShotsPanel shots={phase2.shots} ballTrack={phase2.ballTrack} selfLabels={selfLabels} />
          ) : null}
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

const REFERENCE_FRAME_COUNT = 3;

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
  profile,
  hasExistingRead,
  frameless,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  analysis: AnalysisWithVideo;
  phase2Tracks: PlayerTrackRow[];
  phase2Frames: AnalysisFrameRow[];
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

  const debugFrames = phase2Frames.filter((f) => f.debug_storage_path);
  const sampleIndices = pickSpreadIndices(debugFrames.length, REFERENCE_FRAME_COUNT);
  const referenceFrames = await Promise.all(
    sampleIndices.map(async (i) => {
      const f = debugFrames[i];
      const { data } = await supabase.storage.from("videos").createSignedUrl(f.debug_storage_path!, 3600);
      if (!data?.signedUrl) return null;
      const boxes = boxesAtTimestamp(phase2Tracks, f.timestamp_s);
      return { url: data.signedUrl, timestampSeconds: f.timestamp_s, boxes } satisfies TagPickerFrame;
    })
  );

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
  return `${longest.toFixed(1)}s`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** `count` roughly-evenly-spaced indices into [0, length) — first and last included when length allows. */
function pickSpreadIndices(length: number, count: number): number[] {
  if (length === 0) return [];
  if (length <= count) return Array.from({ length }, (_, i) => i);
  const indices = new Set<number>();
  for (let i = 0; i < count; i++) {
    indices.add(Math.round((i * (length - 1)) / (count - 1)));
  }
  return [...indices].sort((a, b) => a - b);
}

function boxesAtTimestamp(
  tracks: PlayerTrackRow[],
  timestampSeconds: number
): Array<{ playerLabel: string; box: { x: number; y: number; width: number; height: number } }> {
  const boxes: Array<{ playerLabel: string; box: { x: number; y: number; width: number; height: number } }> = [];
  for (const t of tracks) {
    const points = t.points as Array<{
      timestampSeconds: number;
      boxImageNorm: { x: number; y: number; width: number; height: number };
    }>;
    const point = points.find((p) => Math.abs(p.timestampSeconds - timestampSeconds) < 0.05);
    if (point) boxes.push({ playerLabel: t.player_label, box: point.boxImageNorm });
  }
  return boxes;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * The stored playstyle matches, or none.
 *
 * Read defensively because coaching_json is a text blob written by a previous
 * version of the pipeline as often as the current one: every read produced
 * before this feature existed has no `playstyle_match` key at all, and that is
 * a normal state rather than a corrupt row.
 */
function playstyleMatches(coachingJson: string | null): PlaystyleMatch[] {
  if (!coachingJson) return [];
  try {
    const parsed = JSON.parse(coachingJson) as { playstyle_match?: PlaystyleMatch[] };
    return Array.isArray(parsed.playstyle_match) ? parsed.playstyle_match : [];
  } catch {
    return [];
  }
}

/** "doubles_match" -> "Doubles match". */
function prettyKind(kind: string): string {
  const s = kind.replace(/[_-]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
