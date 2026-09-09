"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import SetupCanvas from "@/components/setup/SetupCanvas";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatBytes, validateVideoFile, UPLOAD_PART_SIZE_BYTES } from "@/lib/video/validation";

type Phase = "idle" | "creating" | "uploading" | "attaching" | "done" | "error";

class UploadCancelledError extends Error {}

interface UploadPart {
  partNumber: number;
  url: string;
}

/** Uploads one part with XHR (not fetch) so we get real upload-progress events. */
function uploadPart(
  url: string,
  blob: Blob,
  onProgress: (loadedBytes: number) => void,
  onStart: (abort: () => void) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    onStart(() => xhr.abort());
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        // R2's CORS policy has to expose ETag or this comes back empty —
        // see the R2 setup note in .env.example.
        const etag = xhr.getResponseHeader("ETag");
        if (!etag) {
          reject(new Error("R2 didn't return an ETag for this part — check the bucket's CORS ExposeHeaders."));
          return;
        }
        resolve(etag);
      } else {
        reject(new Error(`Part upload failed (${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error("The connection dropped uploading this part."));
    xhr.onabort = () => reject(new UploadCancelledError());
    xhr.send(blob);
  });
}

async function uploadPartWithRetry(
  url: string,
  blob: Blob,
  onProgress: (loadedBytes: number) => void,
  onStart: (abort: () => void) => void,
  attempts = 4
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await uploadPart(url, blob, onProgress, onStart);
    } catch (err) {
      if (err instanceof UploadCancelledError) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Part upload failed.");
}

/**
 * Upload flow:
 *   1. Create the analysis row (gets us an id to namespace the storage path).
 *   2. Ask the server to start a multipart upload on R2 and hand back a
 *      presigned URL per part.
 *   3. Upload every part straight to R2 from the browser — the file never
 *      passes through our server — retrying a failed part instead of the
 *      whole upload.
 *   4. Tell the server to complete the multipart upload, then attach the
 *      file's metadata to the analysis row.
 *   5. Hand off to the setup page, where the court is fitted and the players
 *      located before any analysis is paid for. Processing starts from there.
 */
export function VideoUploader({ linkFetchWorks = true }: { linkFetchWorks?: boolean }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Set once the upload lands. The page then becomes the confirm step rather
  // than navigating away: the file is already here, in the browser, at full
  // quality, so there is nothing to fetch and nothing to wait for.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkStart, setLinkStart] = useState("");
  const [linkLength, setLinkLength] = useState("90");
  const [linkBusy, setLinkBusy] = useState(false);
  const [localVideoUrl, setLocalVideoUrl] = useState<string | null>(null);

  useEffect(() => {
    // A blob URL holds the whole file in memory until it is revoked.
    return () => { if (localVideoUrl) URL.revokeObjectURL(localVideoUrl); };
  }, [localVideoUrl]);
  // Lets cancel() abort whatever part is in flight and stop the loop before
  // the next one starts.
  const cancelledRef = useRef(false);
  const inFlightXhrAbort = useRef<(() => void) | null>(null);

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
    cancelledRef.current = true;
    inFlightXhrAbort.current?.();
    setPhase("idle");
    setProgress(0);
  }, []);

  const startUpload = useCallback(async () => {
    if (!file || validationError) return;
    setError(null);
    cancelledRef.current = false;

    let analysisId: string | null = null;
    let storagePath: string | null = null;
    let uploadId: string | null = null;

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
      analysisId = analysis.id;

      setPhase("uploading");
      const initRes = await fetch(`/api/analyses/${analysis.id}/video/upload-init`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
        }),
      });
      if (!initRes.ok) throw new Error((await initRes.json()).error ?? "Could not start the upload.");
      const init = (await initRes.json()) as { storagePath: string; uploadId: string; parts: UploadPart[] };
      storagePath = init.storagePath;
      uploadId = init.uploadId;

      const loadedByPart = new Array<number>(init.parts.length).fill(0);
      const reportProgress = () => {
        const loaded = loadedByPart.reduce((a, b) => a + b, 0);
        setProgress(Math.round((loaded / file.size) * 100));
      };

      const completedParts: Array<{ ETag: string; PartNumber: number }> = [];
      for (const part of init.parts) {
        if (cancelledRef.current) throw new UploadCancelledError();
        const start = (part.partNumber - 1) * UPLOAD_PART_SIZE_BYTES;
        const end = Math.min(start + UPLOAD_PART_SIZE_BYTES, file.size);
        const blob = file.slice(start, end);
        const etag = await uploadPartWithRetry(
          part.url,
          blob,
          (loaded) => {
            loadedByPart[part.partNumber - 1] = loaded;
            reportProgress();
          },
          (abort) => {
            inFlightXhrAbort.current = abort;
          }
        );
        inFlightXhrAbort.current = null;
        loadedByPart[part.partNumber - 1] = blob.size;
        reportProgress();
        completedParts.push({ ETag: etag, PartNumber: part.partNumber });
      }

      const completeRes = await fetch(`/api/analyses/${analysis.id}/video/upload-complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ storagePath, uploadId, parts: completedParts }),
      });
      if (!completeRes.ok) throw new Error((await completeRes.json()).error ?? "Could not finish the upload.");

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

      // Confirm, then analyse -- and without leaving this page.
      //
      // The court, the net and the four players are all found automatically;
      // what is left is the one judgement only the user can make, which is
      // which player is them. Sending them to a separate page to do that
      // reads as another chore in a flow that is already several minutes
      // long. The video plays from the local file they just chose, so this
      // costs no download and no wait.
      setPhase("done");
      setLocalVideoUrl(URL.createObjectURL(file));
      setConfirmId(analysis.id);
    } catch (err) {
      if (err instanceof UploadCancelledError) {
        // Best-effort cleanup so an abandoned upload doesn't sit around
        // costing storage — failure here isn't worth surfacing to the user.
        if (analysisId && storagePath && uploadId) {
          void fetch(`/api/analyses/${analysisId}/video/upload-abort`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ storagePath, uploadId }),
          }).catch(() => {});
        }
        return;
      }
      setPhase("error");
      setError(err instanceof Error ? err.message : "Upload failed.");
    }
  }, [file, validationError]);

  const busy = phase !== "idle" && phase !== "error";

  const STEP_LABEL: Partial<Record<Phase, string>> = {
    creating: "Starting your analysis…",
    attaching: "Finishing upload…",
    done: "Opening your analysis…",
  };

  /**
   * Fetch by link instead of uploading.
   *
   * Everything after the fetch is the ordinary path -- same storage, same
   * pipeline, same setup step -- because a clip's origin should not change how
   * it is measured. A start time and length are offered because the footage
   * this is most useful for is match footage an hour long, and analysing an
   * hour to look at one game is the wrong shape.
   */
  async function fetchFromLink() {
    if (!linkUrl.trim()) return;
    setLinkBusy(true);
    setError(null);
    try {
      const createRes = await fetch("/api/analyses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Imported clip" }),
      });
      if (!createRes.ok) throw new Error((await createRes.json()).error ?? "Could not create the analysis.");
      const { analysis } = await createRes.json();

      const start = linkStart.trim() ? Number(linkStart) : undefined;
      const length = linkLength.trim() ? Number(linkLength) : undefined;
      const res = await fetch(`/api/analyses/${analysis.id}/video/from-url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: linkUrl.trim(),
          ...(start !== undefined && length !== undefined
            ? { startSeconds: start, durationSeconds: length }
            : {}),
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not fetch that video.");

      // No local file to play from, so the confirm step streams it back from
      // storage the way the standalone setup page does.
      router.push(`/dashboard/${analysis.id}/setup`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not fetch that video.");
    } finally {
      setLinkBusy(false);
    }
  }

  if (confirmId && localVideoUrl) {
    return (
      <div className="stack g4">
        <div className="stack g2">
          <span className="status-line" style={{ color: "var(--good, #5ce08c)" }}>
            <span className="dot" /> Uploaded — {file?.name}
          </span>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
            Check the court, then tell us which player is you
          </h2>
          <p className="sm measure" style={{ opacity: 0.75, margin: 0 }}>
            The court lines, the net and the players were found for you. Check
            the blue lines sit on the painted ones and the pink net looks the
            right height, then click yourself. Drag any corner to correct it —
            everything else moves with it.
          </p>
        </div>
        <SetupCanvas
          analysisId={confirmId}
          videoUrl={localVideoUrl}
          initial={null}
          embedded
          onSaved={() => {
            router.push(`/dashboard/${confirmId}`);
            router.refresh();
          }}
        />
      </div>
    );
  }

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

      {!linkFetchWorks ? null : (
      <>
      <div className="row g3" style={{ gap: 12 }}>
        <div className="dashline" style={{ flex: 1 }} />
        <span className="eyebrow">or paste a link</span>
        <div className="dashline" style={{ flex: 1 }} />
      </div>

      <div className="stack g2">
        <input
          className="input"
          type="url"
          inputMode="url"
          placeholder="https://www.youtube.com/watch?v=…"
          value={linkUrl}
          onChange={(e) => setLinkUrl(e.target.value)}
          disabled={busy || linkBusy}
        />
        <div className="row g2">
          <label className="field" style={{ flex: "0 0 130px" }}>
            <span className="hint">Start (seconds)</span>
            <input className="input" type="number" min={0} placeholder="e.g. 620"
              value={linkStart} onChange={(e) => setLinkStart(e.target.value)} disabled={busy || linkBusy} />
          </label>
          <label className="field" style={{ flex: "0 0 130px" }}>
            <span className="hint">Length (seconds)</span>
            <input className="input" type="number" min={5} max={3600}
              value={linkLength} onChange={(e) => setLinkLength(e.target.value)} disabled={busy || linkBusy} />
          </label>
          <button
            type="button"
            className="btn btn-soft mla"
            onClick={fetchFromLink}
            disabled={busy || linkBusy || !linkUrl.trim()}
          >
            {linkBusy ? "Fetching…" : "Fetch and set up"}
          </button>
        </div>
        <p className="sm" style={{ opacity: 0.7, margin: 0 }}>
          Leave the times blank to take the whole video. A full match is an hour
          or more, so grabbing one game is usually what you want — and it is the
          difference between a two-minute run and a very long one.
        </p>
      </div>
      </>
      )}

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
