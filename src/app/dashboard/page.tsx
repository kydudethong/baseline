import Link from "next/link";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { listAnalysesForUser } from "@/lib/db/analyses";
import { StatusBadge } from "@/components/dashboard/StatusBadge";

export const metadata: Metadata = { title: "Dashboard — Baseline" };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const analyses = user ? await listAnalysesForUser(supabase, user.id) : [];

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Your analyses</h1>
          <p className="mt-1 text-sm text-slate-500">
            {analyses.length === 0
              ? "Upload your first match to get started."
              : `${analyses.length} analysis${analyses.length === 1 ? "" : "es"}`}
          </p>
        </div>
        <Link
          href="/dashboard/new"
          className="rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800"
        >
          Analyze Your Game
        </Link>
      </div>

      {analyses.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
          {analyses.map((analysis) => {
            const video = analysis.video;
            return (
              <li key={analysis.id}>
                <Link
                  href={`/dashboard/${analysis.id}`}
                  className="flex items-center justify-between gap-4 px-5 py-4 transition hover:bg-slate-50"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-900">{analysis.title}</p>
                    <p className="mt-0.5 text-sm text-slate-500">
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
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
      <p className="text-slate-600">No analyses yet.</p>
      <Link
        href="/dashboard/new"
        className="mt-4 inline-block rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800"
      >
        Analyze Your Game
      </Link>
    </div>
  );
}
