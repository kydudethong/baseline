"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as tus from "tus-js-client";
import { createClient } from "@/lib/supabase/client";
import { formatBytes, validateVideoFile } from "@/lib/video/validation";

type Phase = "idle" | "creating" | "uploading" | "attaching" | "processing" | "done" | "error";

class UploadCancelledError extends Error {}

/**
 * Upload flow:
 *   1. Create the analysis row (gets us an id to namespace the storage path).
 *   2. Resumable upload straight to Supabase Storage via TUS — the file
 *      never passes through our server, so there's no serverless payload
 *      limit and a dropped connection can resume instead of restarting.
 *   3. Attach the uploaded file's metadata to the analysis row.
 *   4. Kick off processing and hand off to the analysis detail page, which
 *      shows the state machine (queued -> processing -> completed/failed).
 */
export function VideoUploader() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const uploadRef = useRef<tus.Upload | null>(null);
  // Lets `cancel()` settle the in-flight upload promise — tus's `abort()`
  // stops the request but does not itself reject/resolve anything.
  const cancelRef = useRef<(() => void) | null>(null);

  const onFileChange = useCallback((selected: File | null) => {
    setError(null);
    setPhase("idle");
    setProgress(0);
    if (!selected) {
      setFile(null);
      setValidationError(null);
      return;
    }
    const result = validateVideoFile(selected);
    setFile(selected);
    setValidationError(result.valid ? null : result.error);
  }, []);

  const cancel = useCallback(() => {
    uploadRef.current?.abort().catch(() => {});
    uploadRef.current = null;
    cancelRef.current?.();
    cancelRef.current = null;
    setPhase("idle");
    setProgress(0);
  }, []);

  const startUpload = useCallback(async () => {
    if (!file || validationError) return;
    setError(null);

    try {
      setPhase("creating");
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired. Refresh and log in again.");

      const createRes = await fetch("/api/analyses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: file.name.replace(/\.[^/.]+$/, "") }),
      });
      if (!createRes.ok) throw new Error((await createRes.json()).error ?? "Could not start analysis.");
      const { analysis } = (await createRes.json()) as { analysis: { id: string } };

      const safeName = file.name.replace(/[^\w.-]/g, "_");
      const storagePath = `${session.user.id}/${analysis.id}/${safeName}`;

      setPhase("uploading");
      await new Promise<void>((resolve, reject) => {
        cancelRef.current = () => reject(new UploadCancelledError());
        const upload = new tus.Upload(file, {
          endpoint: `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/upload/resumable`,
          retryDelays: [0, 3000, 5000, 10000, 20000],
          chunkSize: 6 * 1024 * 1024,
          headers: {
            authorization: `Bearer ${session.access_token}`,
            "x-upsert": "false",
            apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
          },
          metadata: {
            bucketName: "videos",
            objectName: storagePath,
            contentType: file.type || "application/octet-stream",
            cacheControl: "3600",
          },
          onError: (err) => reject(err),
          onProgress: (sent, total) => setProgress(Math.round((sent / total) * 100)),
          onSuccess: () => resolve(),
        });
        uploadRef.current = upload;
        upload.start();
      });
      uploadRef.current = null;
      cancelRef.current = null;

      setPhase("attaching");
      const attachRes = await fetch(`/api/analyses/${analysis.id}/video`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          storagePath,
          originalFilename: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
        }),
      });
      if (!attachRes.ok) throw new Error((await attachRes.json()).error ?? "Could not save video metadata.");

      setPhase("processing");
      const processRes = await fetch(`/api/analyses/${analysis.id}/process`, { method: "POST" });
      if (!processRes.ok) {
        // Non-fatal: the analysis exists and can be retried from its page.
        console.error("Processing failed to start:", await processRes.json().catch(() => null));
      }

      setPhase("done");
      router.push(`/dashboard/${analysis.id}`);
    } catch (err) {
      uploadRef.current = null;
      cancelRef.current = null;
      if (err instanceof UploadCancelledError) {
        // cancel() already reset the UI to idle — nothing else to do.
        return;
      }
      setPhase("error");
      setError(err instanceof Error ? err.message : "Upload failed.");
    }
  }, [file, validationError, router]);

  const busy = phase !== "idle" && phase !== "error";

  return (
    <div className="space-y-4">
      <label
        htmlFor="video-file"
        className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 px-6 py-10 text-center transition hover:border-emerald-400"
      >
        <span className="text-sm font-medium text-slate-700">
          {file ? "Choose a different file" : "Click to choose a video"}
        </span>
        <span className="mt-1 text-xs text-slate-500">MP4, MOV, WebM, AVI, or MKV — up to 2 GB</span>
        <input
          id="video-file"
          type="file"
          accept="video/mp4,video/quicktime,video/webm,video/x-msvideo,video/x-matroska"
          className="hidden"
          disabled={busy}
          onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
        />
      </label>

      {file ? (
        <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
          <div className="min-w-0">
            <p className="truncate font-medium text-slate-900">{file.name}</p>
            <p className="text-slate-500">{formatBytes(file.size)}</p>
          </div>
          {!busy ? (
            <button
              type="button"
              onClick={() => onFileChange(null)}
              className="ml-4 shrink-0 text-slate-400 hover:text-slate-600"
              aria-label="Remove file"
            >
              ✕
            </button>
          ) : null}
        </div>
      ) : null}

      {validationError ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{validationError}</p>
      ) : null}

      {phase === "uploading" ? (
        <div className="space-y-2">
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-emerald-600 transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-sm text-slate-600">
            <span>Uploading — {progress}%</span>
            <button type="button" onClick={cancel} className="font-medium text-red-600 hover:underline">
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {phase === "creating" ? <StatusLine text="Starting analysis…" /> : null}
      {phase === "attaching" ? <StatusLine text="Finishing upload…" /> : null}
      {phase === "processing" ? <StatusLine text="Kicking off processing…" /> : null}

      {error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

      <button
        type="button"
        onClick={startUpload}
        disabled={!file || Boolean(validationError) || busy}
        className="w-full rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Please wait…" : "Upload and analyze"}
      </button>
    </div>
  );
}

function StatusLine({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-slate-600">
      <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-600" />
      {text}
    </p>
  );
}
