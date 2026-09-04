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
  const [dragOver, setDragOver] = useState(false);
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

  const STEP_LABEL: Partial<Record<Phase, string>> = {
    creating: "Starting your analysis…",
    attaching: "Finishing upload…",
    processing: "Handing off to the court tracker…",
    done: "Opening your analysis…",
  };

  return (
    <div className="stack g4">
      <label
        htmlFor="video-file"
        className={`dropzone${dragOver ? " over" : ""}${busy ? " disabled" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (busy) return;
          onFileChange(e.dataTransfer.files?.[0] ?? null);
        }}
      >
        <span className="ttl">{file ? "Choose a different video" : "Drop your game video here"}</span>
        <span className="sm">or click to browse</span>
        <span className="xs">MP4, MOV, WebM, AVI or MKV · up to 2 GB</span>
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
        <div className="filecard">
          <div className="stack" style={{ minWidth: 0, gap: 2 }}>
            <span className="nm">{file.name}</span>
            <span className="xs">{formatBytes(file.size)}</span>
          </div>
          {!busy ? (
            <button type="button" onClick={() => onFileChange(null)} className="x" aria-label="Remove file">
              ✕
            </button>
          ) : null}
        </div>
      ) : null}

      {validationError ? <div className="error">{validationError}</div> : null}

      {phase === "uploading" ? (
        <div className="stack g2">
          <div className="progress">
            <div className="bar" style={{ width: `${progress}%` }} />
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="status-line">
              <span className="dot" />
              Uploading — {progress}%
            </span>
            <button type="button" onClick={cancel} className="crumb" style={{ color: "var(--bad)" }}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {STEP_LABEL[phase] ? (
        <div className="stack g2">
          <div className="progress indet">
            <div className="bar" />
          </div>
          <span className="status-line">
            <span className="dot" />
            {STEP_LABEL[phase]}
          </span>
        </div>
      ) : null}

      {error ? <div className="error">{error}</div> : null}

      <button
        type="button"
        onClick={startUpload}
        disabled={!file || Boolean(validationError) || busy}
        className="btn btn-optic"
        style={{ width: "100%" }}
      >
        {busy ? "Please wait…" : "Upload and analyze"}
      </button>
    </div>
  );
}
