"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import SetupCanvas from "@/components/setup/SetupCanvas";
import { FilmingGuide } from "@/components/upload/FilmingGuide";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatBytes, validateVideoFile, UPLOAD_PART_SIZE_BYTES, partCountFor } from "@/lib/video/validation";
import { mapWithConcurrency } from "@/lib/coaching/concurrency";
import { transcodeForUpload } from "@/lib/video/transcode";
import { opfsNameFor, readBack, remove as removeOpfs, sweep as sweepOpfs } from "@/lib/video/opfs";
import { TrimPicker } from "./TrimPicker";
import {
  clearRecord,
  completedParts,
  fingerprint,
  liveOpfsNames,
  isResumable,
  readRecord,
  remainingParts,
  resumedFraction,
  writeRecord,
  UPLOAD_RECORD_VERSION,
  type RecordStore,
} from "@/lib/video/upload-resume";

type Phase = "idle" | "compressing" | "creating" | "uploading" | "attaching" | "done" | "error";

/**
 * localStorage, or something shaped like it that does nothing.
 *
 * Reading `localStorage` THROWS in Safari private browsing -- not returns
 * null, throws -- and this runs on a page a first-time user reaches from a
 * link at a court. Losing the ability to resume is acceptable; failing to
 * render the upload page is not.
 */
function recordStore(): RecordStore {
  try {
    const ls = window.localStorage;
    ls.getItem("baseline.probe");
    return ls;
  } catch {
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  }
}

/** Length of one part, which is a full part except for the last one. */
function partLength(partNumber: number, totalBytes: number): number {
  const start = (partNumber - 1) * UPLOAD_PART_SIZE_BYTES;
  return Math.max(0, Math.min(UPLOAD_PART_SIZE_BYTES, totalBytes - start));
}

class UploadCancelledError extends Error {}

interface UploadPart {
  partNumber: number;
  url: string;
}

/**
 * How many parts go up at once.
 *
 * Four. One stream does not fill a mobile uplink; past four a phone competes
 * with itself for radio and the curve flattens, while each extra stream is
 * another thing to abort on cancel.
 */
const UPLOAD_CONCURRENCY = 4;

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
export function VideoUploader({
  linkFetchWorks = true,
  remainingSeconds = null,
}: {
  linkFetchWorks?: boolean;
  /**
   * What is left of this month's allowance, when the page knows.
   *
   * Passed in so the trim panel can open itself on a clip that will not fit
   * and offer a cut of exactly the right length -- the difference between
   * being refused after a five-minute upload and being told before it starts.
   */
  remainingSeconds?: number | null;
}) {
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
  // "1.8 GB → 412 MB", once there is something to say. Worth showing: the
  // compression step is a minutes-long wait with no obvious purpose, and this
  // is the sentence that explains what it bought.
  const [shrunkTo, setShrunkTo] = useState<string | null>(null);
  /** The stretch to keep, when the user chose one. See TrimPicker. */
  const [trim, setTrim] = useState<{ startSeconds: number; endSeconds: number } | null>(null);
  /** An object URL for the chosen file, so the trim panel can show the frames. */
  const [pickUrl, setPickUrl] = useState<string | null>(null);

  useEffect(() => {
    // A blob URL holds the whole file in memory until it is revoked.
    return () => { if (localVideoUrl) URL.revokeObjectURL(localVideoUrl); };
  }, [localVideoUrl]);

  useEffect(() => {
    /*
     * Take out the bin on the way in.
     *
     * An upload abandoned mid-compression -- the tab closed, the phone out of
     * battery -- leaves half a gigabyte in the origin's private storage with
     * nothing pointing at it. Browsers respond to a full origin by evicting
     * it, and what they evict is not chosen kindly: on Safari that can include
     * the stored session, so leaking scratch files eventually logs the user
     * out for reasons they could never connect to uploading a video.
     */
    void sweepOpfs(liveOpfsNames(recordStore()));
  }, []);
  // Lets cancel() abort whatever part is in flight and stop the loop before
  // the next one starts.
  const cancelledRef = useRef(false);
  /**
   * Every part currently in flight, so cancel stops all of them.
   *
   * A SET, NOT ONE HANDLE. It held a single abort function back when parts
   * went up one at a time; with several in flight that handle is whichever
   * part started most recently, and pressing cancel aborted that one while the
   * rest kept uploading -- a cancel button that does not cancel.
   */
  const inFlightAborts = useRef(new Set<() => void>());
  /**
   * Stops the transcode, which the part aborts above cannot touch.
   *
   * Compression is the longest single step now and it runs before a single
   * byte is sent, so a cancel button that only aborted in-flight PUTs would
   * do nothing at all for the first few minutes of a big upload.
   */
  const transcodeAbort = useRef<AbortController | null>(null);

  const onFileChange = useCallback((selected: File | null) => {
    setError(null);
    setPhase("idle");
    setProgress(0);
    setShrunkTo(null);
    setTrim(null);
    setPickUrl((old) => { if (old) URL.revokeObjectURL(old); return null; });
    if (!selected) {
      setFile(null);
      setValidationError(null);
      return;
    }
    const result = validateVideoFile(selected);
    setFile(selected);
    setValidationError(result.valid ? null : result.error);
    if (result.valid) setPickUrl(URL.createObjectURL(selected));
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    transcodeAbort.current?.abort();
    transcodeAbort.current = null;
    for (const abort of inFlightAborts.current) abort();
    inFlightAborts.current.clear();
    setPhase("idle");
    setProgress(0);
    setShrunkTo(null);
  }, []);

  const startUpload = useCallback(async () => {
    if (!file || validationError) return;
    setError(null);
    cancelledRef.current = false;

    const store = recordStore();
    const fp = fingerprint(file);
    const abort = new AbortController();
    transcodeAbort.current = abort;

    let analysisId: string | null = null;
    let storagePath: string | null = null;
    let uploadId: string | null = null;
    // Hoisted so the catch can clean it up: a cancelled upload has had its
    // multipart id aborted, so the transcode it belongs to can never be
    // resumed and is just half a gigabyte of the user's storage.
    let opfsName: string | null = null;

    try {
      /*
       * PICK UP WHERE THE LAST ATTEMPT STOPPED, if there was one.
       *
       * A resumable record is only trusted as far as its bytes can be
       * reproduced. When it says the upload was of a transcode, the parts
       * already in R2 are parts OF THAT TRANSCODE -- and re-encoding is not
       * deterministic, so a fresh one would not line up. If the scratch file
       * is gone, so is the resume: better to pay for the whole upload again
       * than to complete an object stitched from two different encodes, which
       * R2 will happily do and which fails later as a video that stops.
       */
      const saved = readRecord(store, fp);
      let resuming = isResumable(saved, Date.now()) ? saved : null;

      let payload: File = file;
      opfsName = resuming?.opfsName ?? null;

      if (resuming?.opfsName) {
        const cached = await readBack(resuming.opfsName);
        if (cached) {
          payload = cached;
        } else {
          resuming = null;
          opfsName = null;
        }
      }
      if (!resuming) clearRecord(store, fp);

      /*
       * SHRINK IT HERE, WHERE IT IS FREE.
       *
       * The pipeline reads at most 1280 on the longest edge and the server
       * already transcodes down to that before any CV runs, so uploading
       * 1080p is pushing pixels up a phone's uplink to have them deleted
       * twice. Doing it first makes the upload four or five times smaller AND
       * stops the server-side proxy transcode from running at all.
       *
       * Optional, always. transcodeForUpload returns null for every reason it
       * might not be a good idea -- an old browser, a codec it cannot decode,
       * a clip already small enough, a saving too small to be worth the wait
       * -- and null means upload the original, which is what used to happen.
       */
      if (!resuming) {
        opfsName = opfsNameFor(fp);
        setPhase("compressing");
        setProgress(0);
        const outcome = await transcodeForUpload(file, {
          opfsName,
          signal: abort.signal,
          trim,
          onProgress: (fraction) => setProgress(Math.round(fraction * 100)),
          onSkip: (reason) => console.info(`[upload] uploading the original: ${reason}`),
        });
        // A REFUSED TRIM IS NOT A SILENT ONE. Everything else here degrades to
        // "upload the original", which is right for a compression that was
        // not worth it and wrong for a cut the user asked for: they would be
        // charged for the minutes they just told us to throw away.
        if (trim && !outcome) {
          throw new Error(
            "This browser could not cut the clip — it cannot re-encode this file. Upload the whole "
            + "clip, or trim it in your phone's Photos app first."
          );
        }
        if (cancelledRef.current) throw new UploadCancelledError();
        if (outcome) {
          payload = outcome.file;
          setShrunkTo(`${formatBytes(outcome.originalBytes)} → ${formatBytes(outcome.file.size)}`);
        } else {
          opfsName = null;
        }
      }

      // The container changed, so the name has to. Leaving a .MOV extension on
      // an MP4 is the kind of small lie that costs an hour when something
      // downstream sniffs by extension instead of by content.
      const uploadName = opfsName ? `${file.name.replace(/\.[^/.]+$/, "")}.mp4` : file.name;
      const uploadMime = opfsName ? "video/mp4" : (file.type || "application/octet-stream");

      setPhase("creating");
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired. Refresh and log in again.");

      if (resuming) {
        analysisId = resuming.analysisId;
      } else {
        const createRes = await fetch("/api/analyses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: file.name.replace(/\.[^/.]+$/, "") }),
        });
        if (!createRes.ok) throw new Error((await createRes.json()).error ?? "Could not start analysis.");
        const { analysis } = (await createRes.json()) as { analysis: { id: string } };
        analysisId = analysis.id;
      }

      setPhase("uploading");
      const etags: Record<string, string> = { ...(resuming?.etags ?? {}) };
      const wanted = remainingParts(payload.size, etags);
      setProgress(Math.round(resumedFraction(payload.size, etags) * 100));

      const initRes = await fetch(`/api/analyses/${analysisId}/video/upload-init`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: uploadName,
          mimeType: uploadMime,
          sizeBytes: payload.size,
          resumeUploadId: resuming?.uploadId,
          partNumbers: wanted,
        }),
      });
      if (!initRes.ok) throw new Error((await initRes.json()).error ?? "Could not start the upload.");
      const init = (await initRes.json()) as { storagePath: string; uploadId: string; parts: UploadPart[] };
      storagePath = init.storagePath;
      uploadId = init.uploadId;

      const totalParts = partCountFor(payload.size);
      const loadedByPart = new Array<number>(totalParts).fill(0);
      // A resumed part contributes its whole length from the start, or the bar
      // would restart at zero and tell the user nothing was saved.
      for (const n of Object.keys(etags)) {
        loadedByPart[Number(n) - 1] = partLength(Number(n), payload.size);
      }
      const reportProgress = () => {
        const loaded = loadedByPart.reduce((a, b) => a + b, 0);
        setProgress(Math.round((loaded / payload.size) * 100));
      };
      reportProgress();

      /*
       * SEVERAL PARTS AT ONCE, which is most of why this was slow on a phone.
       *
       * They went up strictly one after another: await, then start the next.
       * One connection rarely saturates a mobile uplink -- latency and packet
       * loss hold a single stream well below what the link can carry -- so
       * three or four in flight is commonly two to four times faster on
       * cellular for the same bytes. Nothing else changes: each part still
       * goes direct to R2 on its own presigned URL and still retries on its
       * own.
       *
       * mapWithConcurrency rather than a hand-rolled pool, and specifically
       * because it returns results in INPUT order. Parts now finish out of
       * order, and R2 rejects a completion whose part list is not ascending --
       * collecting ETags as they landed would break any upload of more than
       * one part, intermittently, depending on which happened to finish first.
       */
      await mapWithConcurrency(init.parts, UPLOAD_CONCURRENCY, async (part) => {
        if (cancelledRef.current) throw new UploadCancelledError();
        const start = (part.partNumber - 1) * UPLOAD_PART_SIZE_BYTES;
        const end = Math.min(start + UPLOAD_PART_SIZE_BYTES, payload.size);
        const blob = payload.slice(start, end);
        // Each attempt registers its own abort, and they are all removed once
        // this part is done however it ends -- otherwise the set grows for the
        // whole upload and cancel calls a pile of dead handles.
        const mine = new Set<() => void>();
        try {
          const etag = await uploadPartWithRetry(
            part.url,
            blob,
            (loaded) => {
              loadedByPart[part.partNumber - 1] = loaded;
              reportProgress();
            },
            (abortPart) => {
              mine.add(abortPart);
              inFlightAborts.current.add(abortPart);
            }
          );
          loadedByPart[part.partNumber - 1] = blob.size;
          reportProgress();
          /*
           * WRITTEN DOWN THE MOMENT R2 ACKNOWLEDGES IT, not at the end.
           *
           * The whole point is to survive something that gives no warning --
           * a locked screen, a suspended tab, a closed browser. Anything
           * batched up to be saved "when the upload finishes" is saved
           * exactly never in the case this exists for.
           */
          etags[String(part.partNumber)] = etag;
          writeRecord(store, fp, {
            version: UPLOAD_RECORD_VERSION,
            analysisId: analysisId!,
            storagePath: init.storagePath,
            uploadId: init.uploadId,
            filename: uploadName,
            mimeType: uploadMime,
            sizeBytes: payload.size,
            opfsName,
            etags,
            updatedAt: Date.now(),
          });
          return etag;
        } finally {
          for (const a of mine) inFlightAborts.current.delete(a);
        }
      });

      // Throws rather than completing a short list: a completion missing a
      // part does not fail, it produces an object with a hole in it.
      const completed = completedParts(payload.size, etags);

      const completeRes = await fetch(`/api/analyses/${analysisId}/video/upload-complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ storagePath, uploadId, parts: completed }),
      });
      if (!completeRes.ok) throw new Error((await completeRes.json()).error ?? "Could not finish the upload.");

      setPhase("attaching");
      const attachRes = await fetch(`/api/analyses/${analysisId}/video`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          storagePath,
          // The name the user recognises, not the one the container forced.
          originalFilename: file.name,
          mimeType: uploadMime,
          sizeBytes: payload.size,
        }),
      });
      if (!attachRes.ok) throw new Error((await attachRes.json()).error ?? "Could not save video metadata.");

      // The upload is the only copy that matters now: the record would only
      // ever resume an upload that is already finished, and the scratch file
      // is half a gigabyte of the user's storage doing nothing.
      clearRecord(store, fp);
      if (opfsName) void removeOpfs(opfsName);

      // Confirm, then analyse -- and without leaving this page.
      //
      // The court, the net and the four players are all found automatically;
      // what is left is the one judgement only the user can make, which is
      // which player is them. Sending them to a separate page to do that
      // reads as another chore in a flow that is already several minutes
      // long. The video plays from the local file, so this costs no download.
      //
      // THE TRANSCODE, not the original, when there is one -- it is the file
      // the server has, at the size and rotation the server has it, so the
      // boxes drawn over it land where the pipeline computed them.
      setPhase("done");
      setLocalVideoUrl(URL.createObjectURL(payload));
      setConfirmId(analysisId);
    } catch (err) {
      transcodeAbort.current = null;
      if (err instanceof UploadCancelledError || abort.signal.aborted) {
        // Best-effort cleanup so an abandoned upload doesn't sit around
        // costing storage — failure here isn't worth surfacing to the user.
        if (analysisId && storagePath && uploadId) {
          void fetch(`/api/analyses/${analysisId}/video/upload-abort`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ storagePath, uploadId }),
          }).catch(() => {});
        }
        // The record goes too: it points at an upload id that has just been
        // aborted, so resuming it would fail on every part -- and with the
        // record gone, nothing will ever reference the transcode again.
        clearRecord(store, fp);
        if (opfsName) void removeOpfs(opfsName);
        return;
      }
      // NOT cleared on a plain failure -- a dropped connection is exactly the
      // case this record exists for, and throwing it away here would mean the
      // retry starts from zero.
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
      {/* Before the file picker, not after: by the time somebody has chosen a
          file, the game is already filmed. Hidden once a file is chosen so it
          does not push the upload controls off a phone screen. */}
      {!file ? <FilmingGuide /> : null}
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

      {file && pickUrl && !validationError ? (
        <TrimPicker
          src={pickUrl}
          suggestedSeconds={remainingSeconds}
          value={trim}
          onChange={setTrim}
          disabled={busy}
        />
      ) : null}

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

      {phase === "compressing" || phase === "uploading" ? (
        <div className="stack g2">
          <div className="progress">
            <div className="bar" style={{ width: `${progress}%` }} />
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="status-line">
              <span className="dot" />
              {phase === "compressing"
                ? `Shrinking the video — ${progress}%`
                : `Uploading — ${progress}%`}
            </span>
            <button type="button" onClick={cancel} className="crumb" style={{ color: "var(--bad)" }}>
              Cancel
            </button>
          </div>
          {phase === "compressing" ? (
            <p className="hint">
              Doing this on your phone makes the upload several times smaller. It uses the
              video at the size the analysis actually reads, so nothing is lost.
            </p>
          ) : null}
          {phase === "uploading" && shrunkTo ? (
            <p className="hint">Compressed {shrunkTo} before uploading.</p>
          ) : null}
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
