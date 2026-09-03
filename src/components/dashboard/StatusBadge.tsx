import type { AnalysisStatus } from "@/lib/db/types";

const STYLES: Record<AnalysisStatus, string> = {
  uploaded: "bg-slate-100 text-slate-700",
  queued: "bg-amber-100 text-amber-800",
  processing: "bg-amber-100 text-amber-800",
  completed: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-700",
};

const LABELS: Record<AnalysisStatus, string> = {
  uploaded: "Uploaded",
  queued: "Queued",
  processing: "Processing",
  completed: "Completed",
  failed: "Failed",
};

export function StatusBadge({ status }: { status: AnalysisStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${STYLES[status]}`}
    >
      {(status === "processing" || status === "queued") && (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {LABELS[status]}
    </span>
  );
}
