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
        className="crumb"
      >
        ← Back to analysis
      </Link>

      <h1 className="h1" style={{ marginTop: "var(--a3)" }}>Developer debug view</h1>
      <p className="sm measure" style={{ marginTop: "var(--a2)" }}>
        Raw pipeline output, not a coaching UI. Yellow outline = detected court quadrilateral;
        colored boxes = tracked players at that exact timestamp; dots = pose keypoints
        (confidence ≥ 0.3 only). If these look wrong, the numbers on the analysis page are wrong
        for the same reason — this page exists so that&apos;s checkable, not just asserted.
      </p>

      <QualitySummary phase2={phase2} />

      {framesWithUrls.length === 0 ? (
        <p className="note" style={{ marginTop: "var(--a6)" }}>
          No debug frames were persisted for this analysis (mock provider run, or the CV pipeline
          hasn&apos;t completed yet).
        </p>
      ) : (
        <div className="grid2" style={{ marginTop: "var(--a6)" }}>
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

      <section className="sec" style={{ marginTop: "var(--a7)" }}>
        <h2 className="eyebrow">Events (raw)</h2>
        <div className="card" style={{ maxHeight: 384, overflowY: "auto", padding: "0 var(--a4)" }}>
          <table className="tbl">
            <thead style={{ position: "sticky", top: 0, background: "var(--card)" }}>
              <tr>
                <th style={{ paddingTop: "var(--a3)" }}>Time</th>
                <th style={{ paddingTop: "var(--a3)" }}>Type</th>
                <th style={{ paddingTop: "var(--a3)" }}>Player</th>
                <th style={{ paddingTop: "var(--a3)" }}>Confidence</th>
                <th style={{ paddingTop: "var(--a3)" }}>Source</th>
              </tr>
            </thead>
            <tbody>
              {phase2.events.map((e) => (
                <tr key={e.id}>
                  <td className="n">{e.timestamp_s.toFixed(2)}s</td>
                  <td>{e.event_type}</td>
                  <td>{e.player_label ?? "—"}</td>
                  <td className="n">{e.confidence.toFixed(2)}</td>
                  <td className="xs">{e.source}</td>
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
    <div className="grid2" style={{ marginTop: "var(--a5)", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "var(--a3)" }}>
      {items.map(([label, value]) => (
        <div key={label} className="card fig" style={{ padding: "var(--a3) var(--a4)" }}>
          <span className="c">{label}</span>
          <span className="v" style={{ fontSize: 22 }}>{value}</span>
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
    <div className="frame" style={{ aspectRatio: `${width} / ${height}` }}>
      <div style={{ position: "absolute", inset: 0 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt={`Frame at ${timestampSeconds}s`} />
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
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
        <span className="ts">{timestampSeconds.toFixed(2)}s</span>
      </div>
    </div>
  );
}
