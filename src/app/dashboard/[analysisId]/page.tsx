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
import { formatBytes } from "@/lib/video/validation";
import type { PlayerTrackRow } from "@/lib/db/types";

export const dynamic = "force-dynamic";

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

  return (
    <div>
      <Link href="/dashboard" className="text-sm font-medium text-slate-500 hover:text-slate-700">
        ← All analyses
      </Link>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-slate-900">{analysis.title}</h1>
        <StatusBadge status={analysis.status} />
      </div>

      {video ? (
        <dl className="mt-6 grid grid-cols-2 gap-4 rounded-xl border border-slate-200 bg-white p-5 sm:grid-cols-4">
          <MetaItem label="File" value={video.original_filename} />
          <MetaItem label="Size" value={formatBytes(video.size_bytes)} />
          <MetaItem
            label="Duration"
            value={video.duration_seconds ? formatDuration(video.duration_seconds) : "—"}
          />
          <MetaItem
            label="Resolution"
            value={video.width && video.height ? `${video.width}×${video.height}` : "—"}
          />
        </dl>
      ) : null}

      {analysis.status === "failed" && analysis.error_message ? (
        <p className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {analysis.error_message}
        </p>
      ) : null}

      <div className="mt-6">
        <ProcessingControls analysisId={analysis.id} status={analysis.status} />
      </div>

      {analysis.status === "completed" && analysis.result ? (
        <div className="mt-8 space-y-8">
          <AnalysisResultPanel result={analysis.result} />
          <Phase2MovementSection supabase={supabase} analysisId={analysis.id} />
          <CoachingSection supabase={supabase} analysis={analysis} />
          <Link
            href={`/dashboard/${analysis.id}/debug`}
            className="inline-block text-sm font-medium text-indigo-600 hover:text-indigo-800"
          >
            Open developer debug view (raw detections, court overlay, per-frame QC) →
          </Link>
        </div>
      ) : null}
    </div>
  );
}

async function Phase2MovementSection({
  supabase,
  analysisId,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  analysisId: string;
}) {
  const phase2 = await getPhase2Data(supabase, analysisId);
  return <MovementMetricsPanel calibration={phase2.calibration} movement={phase2.movement} />;
}

const REFERENCE_FRAME_COUNT = 3;

/**
 * Player self-tagging + the resulting coaching read, if one exists yet —
 * see PlayerTagPicker.tsx and CoachingReadPanel.tsx. A separate
 * getPhase2Data() call from Phase2MovementSection's, same tradeoff that
 * component already makes: one extra round trip of parallel queries in
 * exchange for each section owning its own data and staying independently
 * movable/removable.
 */
async function CoachingSection({
  supabase,
  analysis,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  analysis: AnalysisWithVideo;
}) {
  const [phase2, profile, coachingData, blueprints] = await Promise.all([
    getPhase2Data(supabase, analysis.id),
    getProfile(supabase, analysis.user_id),
    getCoachingData(supabase, analysis.id),
    getBlueprintsForAnalysis(supabase, analysis.id),
  ]);
  const skillKeysWithBlueprint = new Set(blueprints.map((b) => b.blueprint.skill_key));

  if (phase2.tracks.length === 0) return null; // nothing to tag yet

  const players = [...phase2.tracks].map((t) => t.player_label).sort();
  const width = analysis.video?.width ?? 1920;
  const height = analysis.video?.height ?? 1080;

  const debugFrames = phase2.frames.filter((f) => f.debug_storage_path);
  const sampleIndices = pickSpreadIndices(debugFrames.length, REFERENCE_FRAME_COUNT);
  const referenceFrames = await Promise.all(
    sampleIndices.map(async (i) => {
      const f = debugFrames[i];
      const { data } = await supabase.storage.from("videos").createSignedUrl(f.debug_storage_path!, 3600);
      if (!data?.signedUrl) return null;
      const boxes = boxesAtTimestamp(phase2.tracks, f.timestamp_s);
      return { url: data.signedUrl, timestampSeconds: f.timestamp_s, boxes } satisfies TagPickerFrame;
    })
  );

  const initialSelfLabels = (analysis.self_player_label ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-slate-900">Coaching</h2>
      {coachingData.read ? (
        <CoachingReadPanel
          read={coachingData.read}
          observations={coachingData.observations}
          skills={coachingData.skills}
          analysisId={analysis.id}
          skillKeysWithBlueprint={skillKeysWithBlueprint}
        />
      ) : null}
      {blueprints.length > 0 ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Practice plans
          </h3>
          <div className="space-y-3">
            {blueprints.map(({ blueprint, steps }) => (
              <BlueprintPanel key={blueprint.id} blueprint={blueprint} steps={steps} />
            ))}
          </div>
        </section>
      ) : null}
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
        hasExistingRead={coachingData.read !== null}
      />
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

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium text-slate-900">{value}</dd>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
