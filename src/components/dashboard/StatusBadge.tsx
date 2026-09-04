import type { AnalysisStatus } from "@/lib/db/types";

const PILL_CLASS: Record<AnalysisStatus, string> = {
  uploaded: "p-neutral",
  queued: "p-live",
  processing: "p-live",
  completed: "p-good",
  failed: "p-bad",
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
    <span className={`pill ${PILL_CLASS[status]}`}>
      {(status === "processing" || status === "queued") && <span className="dot" />}
      {LABELS[status]}
    </span>
  );
}
