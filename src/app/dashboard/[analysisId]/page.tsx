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
import { CoachingReadPanel } from "@/components/dashboard/CoachingReadPanel";
import { BlueprintPanel } from "@/components/dashboard/BlueprintPanel";
import Player, { type RallyMark } from "@/components/breakdown/Player";
import { SkillMeter } from "@/components/breakdown/SkillMeter";
import { SkillRadar } from "@/components/breakdown/SkillRadar";
import { skillName } from "@/lib/coaching/types";
import { formatBytes } from "@/lib/video/validation";
import type { CoachingObservationRow, PlayerTrackRow } from "@/lib/db/types";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "summary", label: "Summary" },
  { key: "movement", label: "Movement" },
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
  return { title: `Analysis ${analysisId.slice(0, 8)} — Baseline` };
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
      <Link href="/dashboard" className="crumb">← All analyses</Link>

      <div className="stack g3">
        <div className="row g3">
          <h1 className="d2">{analysis.title}</h1>
          <StatusBadge status={analysis.status} />
        </div>

        {video ? (
          <div className="card figs">
            <Fig label="File" value={video.original_filename} />
            <Fig label="Size" value={formatBytes(video.size_bytes)} />
            <Fig label="Duration" value={video.duration_seconds ? formatDuration(video.duration_seconds) : "—"} />
            <Fig label="Resolution" value={video.width && video.height ? `${video.width}×${video.height}` : "—"} />
          </div>
        ) : null}
      </div>

      {analysis.status === "failed" && analysis.error_message ? (
        <div className="error">{analysis.error_message}</div>
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

  return (
    <div className="stack g6">
      {videoUrl ? (
        <Player videoUrl={videoUrl} rallies={rallies} durationS={video?.duration_seconds ?? 0} />
      ) : null}

      <div className="tabs">
        {TABS.map((t) => (
          <Link key={t.key} href={`/dashboard/${analysis.id}?tab=${t.key}`} className={t.key === tab ? "on" : ""}>
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "summary" ? (
        <div className="stack g6">
          {rallies.length > 0 ? (
            <div className="card figs">
              <Fig label="Rallies detected" value={String(rallies.length)} />
              <Fig
                label="Paddle contacts counted"
                value={rallies.some((r) => r.shots > 0) ? String(rallies.reduce((sum, r) => sum + r.shots, 0)) : "—"}
              />
              <Fig label="Median contacts / rally" value={String(median(rallies.map((r) => r.shots))) || "—"} />
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
              <h3 className="h2">No coaching read yet</h3>
              <p className="body measure">Tag which player is you below to get one.</p>
            </div>
          )}
        </div>
      ) : null}

      {tab === "movement" ? (
        <div className="card stack g5">
          <AnalysisResultPanel result={analysis.result!} />
          <MovementMetricsPanel calibration={phase2.calibration} movement={phase2.movement} />
          <Link href={`/dashboard/${analysis.id}/debug`} className="crumb">
            Open developer debug view (raw detections, court overlay, per-frame QC) →
          </Link>
        </div>
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
                These are the coach&rsquo;s read of what this one clip shows. See the Progress page
                for how a skill has moved across your matches.
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

      <TagSection supabase={supabase} analysis={analysis} phase2Tracks={phase2.tracks} profile={profile} hasExistingRead={coachingData.read !== null} />
    </div>
  );
}

const REFERENCE_FRAME_COUNT = 3;

/** Player self-tagging — see PlayerTagPicker.tsx. Kept as its own section below the tabs since it drives (re)generating the read itself, not one tab's content. */
async function TagSection({
  supabase,
  analysis,
  phase2Tracks,
  profile,
  hasExistingRead,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  analysis: AnalysisWithVideo;
  phase2Tracks: PlayerTrackRow[];
  profile: Awaited<ReturnType<typeof getProfile>>;
  hasExistingRead: boolean;
}) {
  if (phase2Tracks.length === 0) return null; // nothing to tag yet

  const phase2 = await getPhase2Data(supabase, analysis.id);
  const players = [...phase2Tracks].map((t) => t.player_label).sort();
  const width = analysis.video?.width ?? 1920;
  const height = analysis.video?.height ?? 1080;

  const debugFrames = phase2.frames.filter((f) => f.debug_storage_path);
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
    />
  );
}

function noteForRally(observations: CoachingObservationRow[], rallyIdx: number): string | null {
  const match = observations.find((o) => o.rally_idx === rallyIdx);
  return match ? match.title : null;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function Fig({ label, value }: { label: string; value: string }) {
  return (
    <div className="fig">
      <span className="v">{value}</span>
      <span className="c">{label}</span>
    </div>
  );
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
