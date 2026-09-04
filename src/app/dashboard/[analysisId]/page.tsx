import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getAnalysisForUser, type AnalysisWithVideo } from "@/lib/db/analyses";
import { getPhase2Data } from "@/lib/db/vision";
import { getProfile } from "@/lib/db/profiles";
import { getCoachingData } from "@/lib/db/coaching";
import { getBlueprintsForAnalysis } from "@/lib/db/blueprints";
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
import { ShotsPanel } from "@/components/dashboard/ShotsPanel";
import Player, { type RallyMark } from "@/components/breakdown/Player";
import { SkillMeter } from "@/components/breakdown/SkillMeter";
import { SkillRadar } from "@/components/breakdown/SkillRadar";
import { skillName } from "@/lib/coaching/types";
import type { AnalysisFrameRow, CoachingObservationRow, PlayerTrackRow } from "@/lib/db/types";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "summary", label: "Summary" },
  { key: "movement", label: "Movement" },
  { key: "shots", label: "Shots" },
  { key: "rallies", label: "Rallies" },
  { key: "skills", label: "Skills" },
  { key: "plan", label: "Plan" },
];

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
  searchParams,
}: {
  params: Promise<{ analysisId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { analysisId } = await params;
  const { tab: tabParam } = await searchParams;
  const tab = TABS.some((t) => t.key === tabParam) ? tabParam! : "summary";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();

  const analysis = await getAnalysisForUser(supabase, user.id, analysisId);
  if (!analysis) notFound();

  const video = analysis.video;

  return (
    <>
      <Link href="/dashboard/library" className="crumb">← All analyses</Link>

      <div className="stack g2">
        <div className="row g3">
          <h1 className="d2">{analysis.title}</h1>
          <StatusBadge status={analysis.status} />
        </div>
        <p className="xs">
          {[
            new Date(analysis.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
            video?.duration_seconds ? formatDuration(video.duration_seconds) : null,
            video?.width && video?.height ? `${video.width}×${video.height}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      {analysis.status === "failed" ? (
        <div className="error">
          <strong>Processing didn&apos;t finish.</strong>{" "}
          {analysis.error_message ?? "Something went wrong on our side."} You can try again below — if it keeps
          failing, a clip with the whole court in frame from a fixed camera usually fixes it.
        </div>
      ) : null}

      <ProcessingControls analysisId={analysis.id} status={analysis.status} />

      {analysis.status === "completed" && analysis.result ? (
        <AnalysisBreakdown supabase={supabase} analysis={analysis} tab={tab} />
      ) : null}
    </>
  );
}

async function AnalysisBreakdown({
  supabase,
  analysis,
  tab,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  analysis: AnalysisWithVideo;
  tab: string;
}) {
  const [phase2, profile, coachingData, blueprints] = await Promise.all([
    getPhase2Data(supabase, analysis.id),
    getProfile(supabase, analysis.user_id),
    getCoachingData(supabase, analysis.id),
    getBlueprintsForAnalysis(supabase, analysis.id),
  ]);
  const skillKeysWithBlueprint = new Set(blueprints.map((b) => b.blueprint.skill_key));

  const video = analysis.video;
  let videoUrl: string | null = null;
  if (video) {
    const { data } = await supabase.storage.from(video.storage_bucket).createSignedUrl(video.storage_path, 3600);
    videoUrl = data?.signedUrl ?? null;
  }

  const rallies: RallyMark[] = coachingData.rallies.map((r) => ({
    idx: r.idx,
    start_s: r.start_s,
    end_s: r.end_s,
    shots: r.shots,
    note: noteForRally(coachingData.observations, r.idx),
  }));

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
      {videoUrl ? (
        <Player videoUrl={videoUrl} rallies={rallies} durationS={video?.duration_seconds ?? 0} />
      ) : null}

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
        <div className="tabs">
          {TABS.map((t) => (
            <Link key={t.key} href={`/dashboard/${analysis.id}?tab=${t.key}`} className={t.key === tab ? "on" : ""}>
              {t.label}
            </Link>
          ))}
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

      {tab === "summary" ? (
        <div className="stack g6">
          {rallies.length > 0 ? (
            <div className="scoreboard-row">
              <div className="cell">
                <div className="num">{rallies.length}</div>
                <div className="lbl">Rallies</div>
              </div>
              <div className="cell">
                <div className="num">
                  {rallies.some((r) => r.shots > 0) ? rallies.reduce((sum, r) => sum + r.shots, 0) : "—"}
                </div>
                <div className="lbl">Paddle contacts</div>
              </div>
              <div className="cell">
                <div className="num">{median(rallies.map((r) => r.shots)) || "—"}</div>
                <div className="lbl">Contacts / rally</div>
              </div>
              <div className="cell">
                <div className="num">{longestRally(rallies)}</div>
                <div className="lbl">Longest rally</div>
              </div>
            </div>
          ) : null}
          {coachingData.read ? (
            <CoachingReadPanel
              read={coachingData.read}
              observations={coachingData.observations}
              skills={coachingData.skills}
              analysisId={analysis.id}
              skillKeysWithBlueprint={skillKeysWithBlueprint}
            />
          ) : (
            <div className="empty">
              <h3 className="h2">Your coaching read goes here</h3>
              <p className="body measure">
                Tag which player is you above and Baseline will write it — strengths, the one fix that matters
                most, and a drill to start with.
              </p>
            </div>
          )}
        </div>
      ) : null}

      {tab === "movement" ? (
        <div className="stack g5">
          <AnalysisResultPanel result={analysis.result!} />
          <MovementMetricsPanel calibration={phase2.calibration} movement={phase2.movement} selfLabels={selfLabels} />
          <p className="dev-note">
            Want to see what the tracker actually detected?{" "}
            <Link href={`/dashboard/${analysis.id}/debug`}>Open the raw detections view</Link>.
          </p>
        </div>
      ) : null}

      {tab === "shots" ? (
        phase2.shots.length > 0 ? (
          <ShotsPanel shots={phase2.shots} ballTrack={phase2.ballTrack} selfLabels={selfLabels} />
        ) : (
          <div className="empty">
            <h3 className="h2">No shot data for this game</h3>
            <p className="body measure">
              Shot types (dink, drive, drop, reset…) come from tracking the ball, which needs a ball-detector model
              configured for this deployment. Once one is set up, re-run processing on this game and this tab fills in.
            </p>
          </div>
        )
      ) : null}

      {tab === "rallies" ? (
        <div className="card" style={{ overflowX: "auto" }}>
          {rallies.length > 0 ? (
            <table className="tbl" style={{ minWidth: 560 }}>
              <thead>
                <tr><th>Rally</th><th>Start</th><th>Length</th><th>Contacts</th><th>Note</th></tr>
              </thead>
              <tbody>
                {rallies.map((r) => (
                  <tr key={r.idx}>
                    <td className="n"><a href={`#t=${r.start_s.toFixed(1)}`}>R{r.idx}</a></td>
                    <td className="n">{mmss(r.start_s)}</td>
                    <td className="n">{(r.end_s - r.start_s).toFixed(1)}s</td>
                    <td className="n">{r.shots}</td>
                    <td style={{ minWidth: 260 }}>{r.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="sm">No rallies were detected from the audio for this clip.</p>
          )}
        </div>
      ) : null}

      {tab === "skills" ? (
        <div className="stack g5">
          {coachingData.skills.length > 0 ? (
            <>
              <div className="card">
                <SkillRadar skills={coachingData.skills} />
              </div>
              <section className="sec">
                <h3 className="eyebrow">Every rated skill</h3>
                <div className="grid2">
                  {coachingData.skills.map((s) => (
                    <div key={s.id} className="card">
                      <SkillMeter name={skillName(s.skill_key)} raw={s.raw} basis={s.basis} />
                    </div>
                  ))}
                </div>
              </section>
              <p className="note">
                These are the coach&rsquo;s read of what this one clip shows.{" "}
                <Link href="/dashboard/practice" className="crumb" style={{ color: "var(--blue)" }}>
                  See how each skill is trending across your games →
                </Link>
              </p>
            </>
          ) : (
            <div className="empty">
              <h3 className="h2">No skill ratings yet</h3>
              <p className="body measure">These appear once a coaching read has been generated.</p>
            </div>
          )}
        </div>
      ) : null}

      {tab === "plan" ? (
        <div className="stack g4">
          {blueprints.length > 0 ? (
            blueprints.map(({ blueprint, steps }) => (
              <BlueprintPanel key={blueprint.id} analysisId={analysis.id} blueprint={blueprint} steps={steps} />
            ))
          ) : (
            <div className="empty">
              <h3 className="h2">No practice plan yet</h3>
              <p className="body measure">
                Build one from a tagged weakness on the Summary tab, once a coaching read exists.
              </p>
            </div>
          )}
        </div>
      ) : null}

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

/** Player self-tagging — see PlayerTagPicker.tsx. Kept as its own section below the tabs since it drives (re)generating the read itself, not one tab's content.
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

  const players = [...phase2Tracks].map((t) => t.player_label).sort();
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

function noteForRally(observations: CoachingObservationRow[], rallyIdx: number): string | null {
  const match = observations.find((o) => o.rally_idx === rallyIdx);
  return match ? match.title : null;
}

function longestRally(rallies: RallyMark[]): string {
  if (rallies.length === 0) return "—";
  const longest = Math.max(...rallies.map((r) => r.end_s - r.start_s));
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

function mmss(s: number): string {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
