import type { Metadata } from "next";
import { VideoUploader } from "@/components/upload/VideoUploader";

export const metadata: Metadata = { title: "Analyze Your Game — Baseline" };

export default function NewAnalysisPage() {
  return (
    <div className="sec" style={{ maxWidth: 640, margin: "0 auto", width: "100%" }}>
      <div className="stack g1">
        <span className="eyebrow">New analysis</span>
        <h1 className="h1">Analyze a game</h1>
        <p className="sm measure">
          Upload a recording of your match. Baseline tracks the court and every player, then you tag which
          one is you and get your coaching read.
        </p>
      </div>
      <div className="card">
        <VideoUploader />
      </div>
      <p className="xs measure">
        Best results: a fixed camera behind or above the baseline, the whole court in frame, one game per
        clip. Phone footage is fine.
      </p>
    </div>
  );
}
