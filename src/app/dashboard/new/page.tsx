import type { Metadata } from "next";
import { VideoUploader } from "@/components/upload/VideoUploader";

export const metadata: Metadata = { title: "Analyze Your Game — Baseline" };

export default function NewAnalysisPage() {
  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-2xl font-bold text-slate-900">Analyze your game</h1>
      <p className="mt-1 text-sm text-slate-500">
        Upload a recording of your match. We&apos;ll process it and let you know when it&apos;s ready.
      </p>
      <div className="mt-8 rounded-xl border border-slate-200 bg-white p-6">
        <VideoUploader />
      </div>
    </div>
  );
}
