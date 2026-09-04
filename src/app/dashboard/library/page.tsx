import Link from "next/link";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { listAnalysesForUser, type AnalysisWithVideo } from "@/lib/db/analyses";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { PlayIcon } from "@/components/motifs/Motifs";

export const metadata: Metadata = { title: "Library — Baseline" };
export const dynamic = "force-dynamic";

/** A signed URL per video, so the library can show an actual frame from
 * the footage instead of just a filename. Same signing pattern the
 * analysis detail page already uses for its player -- 1hr expiry is
 * plenty for a page view. */
async function withVideoUrls(
  supabase: Awaited<ReturnType<typeof createClient>>,
  analyses: AnalysisWithVideo[]
) {
  return Promise.all(
    analyses.map(async (analysis) => {
      if (!analysis.video) return { analysis, videoUrl: null };
      const { data } = await supabase.storage
        .from(analysis.video.storage_bucket)
        .createSignedUrl(analysis.video.storage_path, 3600);
      return { analysis, videoUrl: data?.signedUrl ?? null };
    })
  );
}

function formatDuration(seconds: number | null | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default async function LibraryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const analyses = user ? await listAnalysesForUser(supabase, user.id) : [];
  const rows = await withVideoUrls(supabase, analyses);

  return (
    <div className="sec">
      <div className="sec-head">
        <div className="stack g1">
          <span className="eyebrow">Library</span>
          <h1 className="h1">Every game you&apos;ve uploaded</h1>
          <p className="sm">
            {analyses.length === 0
              ? "Upload your first match to get started."
              : `${analyses.length} game${analyses.length === 1 ? "" : "s"} analyzed`}
          </p>
        </div>
        <Link href="/dashboard/new" className="btn btn-optic mla">
          + Analyze a game
        </Link>
      </div>

      {analyses.length === 0 ? (
        <div className="empty">
          <p className="h3">No games yet</p>
          <p className="sm">Upload a recording of your match and Baseline will break it down for you.</p>
          <Link href="/dashboard/new" className="btn btn-primary">
            Analyze your first game
          </Link>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            gap: "var(--a5)",
          }}
        >
          {rows.map(({ analysis, videoUrl }) => {
            const duration = formatDuration(analysis.video?.duration_seconds);
            return (
              <Link
                key={analysis.id}
                href={`/dashboard/${analysis.id}`}
                className="stack g3"
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <div
                  style={{
                    position: "relative",
                    aspectRatio: "16 / 9",
                    borderRadius: "var(--r3)",
                    overflow: "hidden",
                    background: "var(--night)",
                    border: "1px solid var(--line)",
                  }}
                >
                  {videoUrl ? (
                    <video
                      src={`${videoUrl}#t=0.5`}
                      preload="metadata"
                      muted
                      playsInline
                      aria-hidden="true"
                      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                    />
                  ) : null}
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <span
                      style={{
                        width: 46,
                        height: 46,
                        borderRadius: "50%",
                        background: "rgba(7,13,11,.55)",
                        backdropFilter: "blur(2px)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "var(--optic)",
                      }}
                    >
                      <PlayIcon size={16} />
                    </span>
                  </div>
                  {duration ? (
                    <span
                      className="mono"
                      style={{
                        position: "absolute",
                        top: 10,
                        right: 10,
                        background: "rgba(7,13,11,.72)",
                        color: "var(--ink)",
                        fontSize: 11,
                        fontWeight: 600,
                        padding: "3px 7px",
                        borderRadius: "var(--r1)",
                      }}
                    >
                      {duration}
                    </span>
                  ) : null}
                  <span style={{ position: "absolute", top: 10, left: 10 }}>
                    <StatusBadge status={analysis.status} />
                  </span>
                </div>
                <div className="row g2" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                  <p
                    className="h3"
                    style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
                  >
                    {analysis.title}
                  </p>
                </div>
                <p className="xs">
                  {new Date(analysis.created_at).toLocaleDateString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
