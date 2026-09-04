import Link from "next/link";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { listAnalysesForUser } from "@/lib/db/analyses";
import { StatusBadge } from "@/components/dashboard/StatusBadge";

export const metadata: Metadata = { title: "Library — Baseline" };
export const dynamic = "force-dynamic";

export default async function LibraryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const analyses = user ? await listAnalysesForUser(supabase, user.id) : [];

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
          {analyses.map((analysis) => {
            const video = analysis.video;
            return (
              <Link
                key={analysis.id}
                href={`/dashboard/${analysis.id}`}
                className="card row g4"
                style={{ justifyContent: "space-between", textDecoration: "none", color: "inherit" }}
              >
                <div className="stack g1" style={{ minWidth: 0 }}>
                  <p className="h3" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {analysis.title}
                  </p>
                  <p className="xs">
                    {video?.original_filename ?? "No video attached"} ·{" "}
                    {new Date(analysis.created_at).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </p>
                </div>
                <StatusBadge status={analysis.status} />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
