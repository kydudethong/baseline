import Link from "next/link";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { listAnalysesForUser, type AnalysisWithVideo } from "@/lib/db/analyses";
import { StatusBadge } from "@/components/dashboard/StatusBadge";

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
        <div className="stack g2">
          {rows.map(({ analysis, videoUrl }) => (
            <Link
              key={analysis.id}
              href={`/dashboard/${analysis.id}`}
              className="card row g4"
              style={{ justifyContent: "space-between", textDecoration: "none", color: "inherit" }}
            >
              <div className="row g4" style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    width: 96,
                    height: 60,
                    borderRadius: "var(--r2)",
                    overflow: "hidden",
                    background: "var(--night)",
                    flex: "none",
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
                </div>
                <div className="stack g1" style={{ minWidth: 0 }}>
                  <p className="h3" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {analysis.title}
                  </p>
                  <p className="xs">
                    {analysis.video?.original_filename ?? "No video attached"} ·{" "}
                    {new Date(analysis.created_at).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </p>
                </div>
              </div>
              <StatusBadge status={analysis.status} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
