/**
 * A scratch directory in the browser, for the one file that is too big to hold
 * in memory.
 *
 * A transcoded twenty-minute game is four or five hundred megabytes. Holding
 * that as an ArrayBuffer while also holding the decoder, the encoder and the
 * source file is how a phone's browser tab gets killed -- silently, with no
 * error to catch, which the user reads as the site crashing.
 *
 * The origin-private filesystem is the escape: real files, no quota prompt, no
 * visibility to the user, and a File handle at the end that can be sliced into
 * upload parts the same way a picked file can. It also survives a reload,
 * which is what makes a transcode resumable rather than something that has to
 * be paid for twice.
 *
 * EVERY FUNCTION HERE CAN RETURN NULL. Private browsing, an old Safari, a full
 * disk and a locked-down enterprise profile all take this away, and none of
 * them should cost the user their upload -- they should cost them the
 * optimisation and nothing else.
 */

export const OPFS_DIR = "baseline-uploads";

function opfsRoot(): StorageManager | null {
  if (typeof navigator === "undefined") return null;
  if (!navigator.storage || typeof navigator.storage.getDirectory !== "function") return null;
  return navigator.storage;
}

export function opfsAvailable(): boolean {
  return opfsRoot() !== null;
}

async function directory(): Promise<FileSystemDirectoryHandle | null> {
  const storage = opfsRoot();
  if (!storage) return null;
  try {
    const root = await storage.getDirectory();
    return await root.getDirectoryHandle(OPFS_DIR, { create: true });
  } catch {
    return null;
  }
}

/**
 * A filename that is safe, stable and short.
 *
 * Stable because it is what lets a reload find the transcode it already paid
 * for; derived from the fingerprint rather than the user's filename because
 * "Ky's game 3/8 (1).MOV" is not a path component anywhere.
 */
export function opfsNameFor(fingerprint: string): string {
  let hash = 2166136261;
  for (let i = 0; i < fingerprint.length; i++) {
    hash ^= fingerprint.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `t-${(hash >>> 0).toString(36)}.mp4`;
}

export interface OpfsWriteHandle {
  name: string;
  /** Where mediabunny's output goes. Positions may be written out of order. */
  writable: FileSystemWritableFileStream;
}

export async function openForWrite(name: string): Promise<OpfsWriteHandle | null> {
  const dir = await directory();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(name, { create: true });
    // createWritable, not createSyncAccessHandle: the sync one is faster but
    // only exists inside a worker, and the conversion runs on this thread.
    if (typeof handle.createWritable !== "function") return null;
    const writable = await handle.createWritable({ keepExistingData: false });
    return { name, writable };
  } catch {
    return null;
  }
}

export async function readBack(name: string): Promise<File | null> {
  const dir = await directory();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(name, { create: false });
    const file = await handle.getFile();
    // A zero-length file is a transcode that was interrupted before it wrote
    // anything. Uploading it would produce an empty video and a confusing
    // failure two steps later.
    return file.size > 0 ? file : null;
  } catch {
    return null;
  }
}

export async function remove(name: string): Promise<void> {
  const dir = await directory();
  if (!dir) return;
  try {
    await dir.removeEntry(name);
  } catch {
    // Already gone, or never there.
  }
}

/**
 * How stale an orphan has to be before sweeping it is safe.
 *
 * NOT ZERO, and the reason is another tab. A transcode in progress has no
 * upload record yet -- the record is only written once R2 has accepted a part
 * -- so to a second tab's sweep it looks exactly like an abandoned file. An
 * hour is far longer than any transcode and far shorter than "forever".
 */
export const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Delete transcodes nothing is waiting on any more.
 *
 * Without this, every upload abandoned mid-transcode leaves half a gigabyte in
 * the origin's storage forever, and the browser eventually starts evicting
 * things to reclaim it -- including, on some of them, the site's login.
 */
export async function sweep(keep: Set<string>, now = Date.now()): Promise<void> {
  const dir = await directory();
  if (!dir) return;
  try {
    // values() is an async iterator on the handle; older type definitions do
    // not describe it, hence the cast rather than a dependency on lib version.
    const entries = (dir as unknown as {
      values(): AsyncIterableIterator<FileSystemHandle>;
    }).values();
    const doomed: string[] = [];
    for await (const entry of entries) {
      if (entry.kind !== "file" || keep.has(entry.name)) continue;
      try {
        const file = await (entry as FileSystemFileHandle).getFile();
        if (now - file.lastModified < ORPHAN_MIN_AGE_MS) continue;
      } catch {
        continue;
      }
      doomed.push(entry.name);
    }
    for (const name of doomed) await dir.removeEntry(name).catch(() => {});
  } catch {
    // Sweeping is housekeeping. Failing at it is not worth a word to anyone.
  }
}
