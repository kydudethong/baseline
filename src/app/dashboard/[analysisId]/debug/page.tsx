import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getAnalysisForUser } from "@/lib/db/analyses";
import { getPhase2Data } from "@/lib/db/vision";
import type { PlayerTrackRow } from "@/lib/db/types";
import { colorForPlayer } from "@/lib/vision/player-colors";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ analysisId: string }>;
}): Promise<Metadata> {
  const { analysisId } = await params;
  return { title: `Debug — Analysis ${analysisId.slice(0, 8)} — Baseline` };
}

/**
 * Developer debug-overlay page: draws what the CV pipeline actually
 * detected (court quadrilateral, per-player boxes, pose keypoints) on top
 * of a sparse sample of the real sampled frames (see
 * DEBUG_FRAME_SAMPLE_COUNT in pipeline-v2.ts), so a developer can eyeball
 * whether the detections look plausible without reading raw JSON. Overlays
 * are plain SVG over the frame image — server-rendered, no client JS.
 */
export default async function DebugPage({ params }: { params: Promise<{ analysisId: string }> }) {
  const { analysisId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();

  const analysis = await getAnalysisForUser(supabase, user.id, analysisId);
  if (!analysis) notFound();

  const phase2 = await getPhase2Data(supabase, analysisId);
  const width = analysis.video?.width ?? 1920;
  const height = analysis.video?.height ?? 1080;

  const debugFrames = phase2.frames.filter((f) => f.debug_storage_path);
  const framesWithUrls = await Promise.all(
    debugFrames.map(async (f) => {
      const { data } = await supabase.storage.from("videos").createSignedUrl(f.debug_storage_path!, 3600);
      return { frame: f, url: data?.signedUrl ?? null };
    })
  );

  const trackColorIndex = new Map(phase2.tracks.map((t, i) => [t.player_label, i]));

  return (
    <div>
      <Link
        href={`/dashboard/${analysisId}`}
        className="text-sm font-medium text-slate-500 hover:text-slate-700"
      >
        ← Back to analysis
      </Link>

      <h1 className="mt-3 text-2xl font-bold text-slate-900">Developer debug view</h1>
      <p className="mt-1 max-w-2xl text-sm text-slate-600">
        Raw pipeline output, not a coaching UI. Yellow outline = detected court quadrilateral;
        colored boxes = tracked players at that exact timestamp; dots = pose keypoints
        (confidence ≥ 0.3 only). If these look wrong, the numbers on the analysis page are wrong
        for the same reason — this page exists so that&apos;s checkable, not just asserted.
      </p>

      <QualitySummary phase2={phase2} />

      {framesWithUrls.length === 0 ? (
        <p className="mt-8 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500">
          No debug frames were persisted for this analysis (mock provider run, or the CV pipeline
          hasn&apos;t completed yet).
        </p>
      ) : (
        <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2">
          {framesWithUrls.map(({ frame, url }) =>
            url ? (
              <FrameOverlay
                key={frame.id}
                imageUrl={url}
                timestampSeconds={frame.timestamp_s}
                width={width}
                height={height}
                calibration={phase2.calibration}
                tracks={phase2.tracks}
                keypoints={phase2.keypoints.filter((k) => Math.abs(k.timestamp_s - frame.timestamp_s) < 0.05)}
                trackColorIndex={trackColorIndex}
              />
            ) : null
          )}
        </div>
      )}

      <section className="mt-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Events (raw)
        </h2>
        <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50">
              <tr className="text-left text-xs uppercase text-slate-500">
                <th className="px-4 py-2">Time</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Player</th>
                <th className="px-4 py-2">Confidence</th>
                <th className="px-4 py-2">Source</th>
              </tr>
            </thead>
            <tbody>
              {phase2.events.map((e) => (
                <tr key={e.id} className="border-t border-slate-100">
                  <td className="px-4 py-2 font-mono text-xs">{e.timestamp_s.toFixed(2)}s</td>
                  <td className="px-4 py-2">{e.event_type}</td>
                  <td className="px-4 py-2">{e.player_label ?? "—"}</td>
                  <td className="px-4 py-2">{e.confidence.toFixed(2)}</td>
                  <td className="px-4 py-2 text-slate-500">{e.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function QualitySummary({ phase2 }: { phase2: Awaited<ReturnType<typeof getPhase2Data>> }) {
  const totalFrames = phase2.frames.length;
  const playerCounts = phase2.frames.map((f) => f.player_count);
  const meanPlayers = playerCounts.length
    ? (playerCounts.reduce((a, b) => a + b, 0) / playerCounts.length).toFixed(2)
    : "0";

  const items: Array<[string, string]> = [
    ["Frames sampled", String(totalFrames)],
    ["Mean players/frame", meanPlayers],
    ["Tracks produced", String(phase2.tracks.length)],
    ["Court calibration confidence", phase2.calibration ? String(phase2.calibration.confidence) : "—"],
    ["Pose rows", String(phase2.keypoints.length)],
    ["Events", String(phase2.events.length)],
  ];

  return (
    <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="text-xs text-slate-500">{label}</div>
          <div className="mt-1 text-lg font-semibold text-slate-900">{value}</div>
        </div>
      ))}
    </div>
  );
}

function FrameOverlay({
  imageUrl,
  timestampSeconds,
  width,
  height,
  calibration,
  tracks,
  keypoints,
  trackColorIndex,
}: {
  imageUrl: string;
  timestampSeconds: number;
  width: number;
  height: number;
  calibration: Awaited<ReturnType<typeof getPhase2Data>>["calibration"];
  tracks: PlayerTrackRow[];
  keypoints: Awaited<ReturnType<typeof getPhase2Data>>["keypoints"];
  trackColorIndex: Map<string, number>;
}) {
  const corners = calibration?.corners_image_px as
    | { topLeft: [number, number]; topRight: [number, number]; bottomLeft: [number, number]; bottomRight: [number, number] }
    | null
    | undefined;

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-black">
      <div className="relative" style={{ aspectRatio: `${width} / ${height}` }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt={`Frame at ${timestampSeconds}s`} className="absolute inset-0 h-full w-full object-contain" />
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="absolute inset-0 h-full w-full"
          preserveAspectRatio="xMidYMid meet"
        >
          {corners ? (
            <polygon
              points={[corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft]
                .map((p) => p.join(","))
                .join(" ")}
              fill="none"
              stroke="#facc15"
              strokeWidth={4}
            />
          ) : null}

          {tracks.map((t) => {
            const points = t.points as Array<{ timestampSeconds: number; boxImageNorm: { x: number; y: number; width: number; height: number } }>;
            const point = points.find((p) => Math.abs(p.timestampSeconds - timestampSeconds) < 0.05);
            if (!point) return null;
            const color = colorForPlayer(t.player_label, trackColorIndex.get(t.player_label) ?? 0);
            const b = point.boxImageNorm;
            return (
              <g key={t.player_label}>
                <rect
                  x={b.x * width}
                  y={b.y * height}
                  width={b.width * width}
                  height={b.height * height}
                  fill="none"
                  stroke={color}
                  strokeWidth={3}
                />
                <text x={b.x * width} y={b.y * height - 6} fill={color} fontSize={22} fontWeight={600}>
                  {t.player_label}
                </text>
              </g>
            );
          })}

          {keypoints.map((k) => {
            const color = colorForPlayer(k.player_label, trackColorIndex.get(k.player_label) ?? 0);
            const kps = k.keypoints as Array<{ xNorm: number | null; yNorm: number | null; confidence: number | null }>;
            return kps
              .filter((p) => p.xNorm !== null && p.yNorm !== null && (p.confidence ?? 0) >= 0.3)
              .map((p, i) => (
                <circle key={`${k.id}-${i}`} cx={p.xNorm! * width} cy={p.yNorm! * height} r={6} fill={color} opacity={0.85} />
              ));
          })}
        </svg>
        <div className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 font-mono text-xs text-white">
          {timestampSeconds.toFixed(2)}s
        </div>
      </div>
    </div>
  );
}
