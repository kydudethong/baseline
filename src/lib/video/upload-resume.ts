/**
 * Remembering an upload well enough to pick it up where it stopped.
 *
 * The parts already retried on their own, four times with backoff, which
 * covers a lift dropping out of signal for twenty seconds. It does not cover
 * what actually happens to a twenty-minute upload on a phone: the screen
 * locks, Safari suspends the tab, the page is reloaded, the browser is closed.
 * All of those threw away every byte already sent, and R2 was left holding a
 * multipart upload nobody would ever finish.
 *
 * A multipart upload is resumable by construction -- parts are independent and
 * uniquely numbered -- so all that was missing was writing down which ones R2
 * had accepted. That is what this file is: the record, and the arithmetic
 * about it. Storage is injected rather than reaching for localStorage, so the
 * arithmetic can be tested in node.
 */

import { partCountFor } from "./validation";

export const UPLOAD_RECORD_VERSION = 1;
export const RECORD_PREFIX = "baseline.upload.";

/**
 * How long a half-finished upload is worth resuming.
 *
 * R2 keeps an incomplete multipart upload until its bucket lifecycle rule
 * expires it (seven days by default), but a record that is days old almost
 * never belongs to somebody still waiting -- they gave up, or uploaded it
 * again from somewhere else. Worse, resuming one means presigning parts
 * against an upload id R2 may have already swept, which fails in a way the
 * user reads as "the upload is broken" rather than "that was yesterday's".
 *
 * A day. Long enough to cover a phone put down overnight, short enough that a
 * stale record does not become a mystery.
 */
export const RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface UploadRecord {
  version: number;
  analysisId: string;
  storagePath: string;
  uploadId: string;
  /** The name shown to the user, which is the name they chose the file under. */
  filename: string;
  mimeType: string;
  /** Size of the bytes being uploaded, which is the transcode's when there is one. */
  sizeBytes: number;
  /**
   * Name of the transcoded copy in the origin-private filesystem, when the
   * bytes being uploaded are one we made. Null means the bytes are the user's
   * own file, which a browser cannot hand back after a reload -- so that
   * upload can only resume if they pick the same file again.
   */
  opfsName: string | null;
  /** Part number to ETag, for every part R2 has already acknowledged. */
  etags: Record<string, string>;
  updatedAt: number;
}

/** Minimal shape of the fields a File gives us. Keeps this file DOM-free. */
export interface FileIdentity {
  name: string;
  size: number;
  lastModified: number;
}

/**
 * Identify a file well enough to match it to a half-finished upload.
 *
 * Name, size and modification time. Not content: hashing two gigabytes on a
 * phone to decide whether to resume would cost more than the resume saves.
 * The failure mode of this being too loose is uploading part of one file and
 * part of another under one key, so the last field matters -- two different
 * recordings are the same name and can be the same size, but a phone does not
 * write two files in the same millisecond.
 */
export function fingerprint(file: FileIdentity): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function recordKey(fp: string): string {
  return `${RECORD_PREFIX}${fp}`;
}

/**
 * Is this record worth trying to resume?
 *
 * Anything unreadable, from an older shape of this file, or older than
 * RECORD_MAX_AGE_MS is not. A record with no parts in it is also not -- there
 * is nothing to save, and starting clean avoids inheriting an upload id whose
 * fate we do not know.
 */
export function isResumable(record: UploadRecord | null, now: number): boolean {
  if (!record) return false;
  if (record.version !== UPLOAD_RECORD_VERSION) return false;
  if (!record.uploadId || !record.storagePath || !record.analysisId) return false;
  if (!(record.sizeBytes > 0)) return false;
  if (now - record.updatedAt > RECORD_MAX_AGE_MS) return false;
  return Object.keys(record.etags).length > 0;
}

/**
 * Which parts still have to go up.
 *
 * Ascending, because R2 rejects a completion whose part list is not, and
 * because uploading in order means the progress bar moves the way a person
 * expects rather than filling in from both ends.
 */
export function remainingParts(sizeBytes: number, etags: Record<string, string>): number[] {
  const total = partCountFor(sizeBytes);
  const out: number[] = [];
  for (let n = 1; n <= total; n++) {
    if (!etags[String(n)]) out.push(n);
  }
  return out;
}

/**
 * The full part list to hand R2 at completion, in ascending order.
 *
 * Throws rather than completing a short list. A CompleteMultipartUpload that
 * is missing a part does not fail -- it SUCCEEDS, and produces an object with
 * a hole in it, which surfaces days later as a video that decodes for ninety
 * seconds and then stops. Refusing here is the only place that mistake is
 * still cheap.
 */
export function completedParts(
  sizeBytes: number,
  etags: Record<string, string>
): Array<{ PartNumber: number; ETag: string }> {
  const total = partCountFor(sizeBytes);
  const parts: Array<{ PartNumber: number; ETag: string }> = [];
  for (let n = 1; n <= total; n++) {
    const etag = etags[String(n)];
    if (!etag) throw new Error(`Part ${n} of ${total} never finished uploading.`);
    parts.push({ PartNumber: n, ETag: etag });
  }
  return parts;
}

/** How much of the upload is already done, as a fraction, for the progress bar. */
export function resumedFraction(sizeBytes: number, etags: Record<string, string>): number {
  const total = partCountFor(sizeBytes);
  if (total === 0) return 0;
  const done = total - remainingParts(sizeBytes, etags).length;
  return done / total;
}

/** The subset of Storage this needs, so tests can pass a Map instead. */
export interface RecordStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readRecord(store: RecordStore, fp: string): UploadRecord | null {
  try {
    const raw = store.getItem(recordKey(fp));
    if (!raw) return null;
    return JSON.parse(raw) as UploadRecord;
  } catch {
    // Private browsing, a cleared store, or something that is not our JSON.
    // None of those are worth failing an upload over; the answer is the same
    // as having no record, which is to start from the beginning.
    return null;
  }
}

export function writeRecord(store: RecordStore, fp: string, record: UploadRecord): void {
  try {
    store.setItem(recordKey(fp), JSON.stringify(record));
  } catch {
    // A full or disabled store means no resume, not no upload.
  }
}

export function clearRecord(store: RecordStore, fp: string): void {
  try {
    store.removeItem(recordKey(fp));
  } catch {
    // Nothing to do, and nothing worth telling the user.
  }
}

/** A Storage, which unlike RecordStore can be walked. localStorage is one. */
export interface EnumerableStore extends RecordStore {
  readonly length: number;
  key(index: number): string | null;
}

/**
 * Every scratch file some record is still counting on.
 *
 * The complement of this set is what the sweeper may delete, so the bias has
 * to be toward keeping: a record that is merely expired still names a file
 * that a resume might want, and the sweeper's own age guard will get to it.
 * Missing a name here deletes a transcode somebody paid minutes for.
 */
export function liveOpfsNames(store: RecordStore): Set<string> {
  const names = new Set<string>();
  const walkable = store as Partial<EnumerableStore>;
  if (typeof walkable.length !== "number" || typeof walkable.key !== "function") return names;
  for (let i = 0; i < walkable.length; i++) {
    // PER RECORD, not around the loop. Wrapping the whole walk meant one
    // unparseable entry -- another library's key, a half-written value --
    // ended it, and every record after that one silently lost its protection.
    // The sweeper would then delete a transcode somebody had waited for.
    try {
      const key = walkable.key(i);
      if (!key || !key.startsWith(RECORD_PREFIX)) continue;
      const raw = store.getItem(key);
      if (!raw) continue;
      const record = JSON.parse(raw) as UploadRecord;
      if (record?.opfsName) names.add(record.opfsName);
    } catch {
      continue;
    }
  }
  return names;
}
