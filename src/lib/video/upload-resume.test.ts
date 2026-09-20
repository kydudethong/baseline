import test from "node:test";
import assert from "node:assert/strict";
import {
  fingerprint,
  liveOpfsNames,
  isResumable,
  remainingParts,
  completedParts,
  resumedFraction,
  readRecord,
  writeRecord,
  clearRecord,
  RECORD_MAX_AGE_MS,
  UPLOAD_RECORD_VERSION,
  type RecordStore,
  type UploadRecord,
} from "./upload-resume";
import { UPLOAD_PART_SIZE_BYTES, partCountFor } from "./validation";

const memoryStore = (): RecordStore & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
};

const NOW = 1_700_000_000_000;

const record = (over: Partial<UploadRecord> = {}): UploadRecord => ({
  version: UPLOAD_RECORD_VERSION,
  analysisId: "an-1",
  storagePath: "user/an-1/game.mp4",
  uploadId: "upload-1",
  filename: "game.mp4",
  mimeType: "video/mp4",
  sizeBytes: UPLOAD_PART_SIZE_BYTES * 5,
  opfsName: null,
  etags: { "1": "a", "2": "b" },
  updatedAt: NOW,
  ...over,
});

test("two recordings of the same length are still told apart", () => {
  // Phones name files by counter and a game is a game, so name and size
  // collide easily. The modification time is what actually separates them,
  // and mixing two files into one key means an object with another file's
  // bytes in the middle of it.
  const a = { name: "IMG_5642.MOV", size: 1_882_863_144, lastModified: 1_700_000_000_000 };
  const b = { name: "IMG_5642.MOV", size: 1_882_863_144, lastModified: 1_700_000_060_000 };
  assert.notEqual(fingerprint(a), fingerprint(b));
  assert.equal(fingerprint(a), fingerprint({ ...a }));
});

test("only the parts R2 has not acknowledged go up again", () => {
  const remaining = remainingParts(UPLOAD_PART_SIZE_BYTES * 5, { "1": "a", "3": "c" });
  assert.deepEqual(remaining, [2, 4, 5]);
});

test("remaining parts come back ascending, whatever order they were recorded", () => {
  // R2 rejects a completion whose part list is not ascending, and the record
  // is a plain object whose key order is whatever the network gave us.
  const remaining = remainingParts(UPLOAD_PART_SIZE_BYTES * 6, { "5": "e", "2": "b" });
  assert.deepEqual(remaining, [1, 3, 4, 6]);
});

test("a final part shorter than a full part still counts as a part", () => {
  // 2.5 parts' worth: three parts, the last one half-length.
  const size = UPLOAD_PART_SIZE_BYTES * 2 + UPLOAD_PART_SIZE_BYTES / 2;
  assert.equal(partCountFor(size), 3);
  assert.deepEqual(remainingParts(size, { "1": "a", "2": "b" }), [3],
    "the short tail is the one part most likely to be silently dropped");
});

test("completing with a missing part throws instead of making a holed object", () => {
  // The reason this is loud: CompleteMultipartUpload does not reject a short
  // list. It succeeds, and the video plays until the hole.
  assert.throws(
    () => completedParts(UPLOAD_PART_SIZE_BYTES * 3, { "1": "a", "3": "c" }),
    /Part 2 of 3/
  );
});

test("a complete set comes back ascending and whole", () => {
  const parts = completedParts(UPLOAD_PART_SIZE_BYTES * 3, { "3": "c", "1": "a", "2": "b" });
  assert.deepEqual(parts, [
    { PartNumber: 1, ETag: "a" },
    { PartNumber: 2, ETag: "b" },
    { PartNumber: 3, ETag: "c" },
  ]);
});

test("the progress bar starts where the last attempt stopped", () => {
  assert.equal(resumedFraction(UPLOAD_PART_SIZE_BYTES * 4, { "1": "a", "2": "b" }), 0.5);
  assert.equal(resumedFraction(UPLOAD_PART_SIZE_BYTES * 4, {}), 0);
});

test("a record from yesterday resumes; one from the day before does not", () => {
  assert.equal(isResumable(record({ updatedAt: NOW - RECORD_MAX_AGE_MS + 1000 }), NOW), true);
  assert.equal(isResumable(record({ updatedAt: NOW - RECORD_MAX_AGE_MS - 1000 }), NOW), false);
});

test("a record with nothing uploaded yet is not worth resuming", () => {
  // Nothing to save, and it would inherit an upload id of unknown standing.
  assert.equal(isResumable(record({ etags: {} }), NOW), false);
});

test("a record from an older version of this file is discarded, not guessed at", () => {
  assert.equal(isResumable(record({ version: UPLOAD_RECORD_VERSION - 1 }), NOW), false);
});

test("a record missing the ids it needs is not resumable", () => {
  assert.equal(isResumable(record({ uploadId: "" }), NOW), false);
  assert.equal(isResumable(record({ storagePath: "" }), NOW), false);
  assert.equal(isResumable(record({ analysisId: "" }), NOW), false);
  assert.equal(isResumable(null, NOW), false);
});

test("a round trip through the store survives", () => {
  const store = memoryStore();
  const fp = fingerprint({ name: "a.mp4", size: 10, lastModified: 1 });
  writeRecord(store, fp, record());
  assert.deepEqual(readRecord(store, fp), record());
  clearRecord(store, fp);
  assert.equal(readRecord(store, fp), null);
});

test("a store that throws does not take the upload down with it", () => {
  // Private browsing throws on both read and write. That is a lost resume,
  // which is a worse upload, not a failed one.
  const hostile: RecordStore = {
    getItem: () => { throw new Error("SecurityError"); },
    setItem: () => { throw new Error("QuotaExceededError"); },
    removeItem: () => { throw new Error("SecurityError"); },
  };
  assert.equal(readRecord(hostile, "fp"), null);
  assert.doesNotThrow(() => writeRecord(hostile, "fp", record()));
  assert.doesNotThrow(() => clearRecord(hostile, "fp"));
});

test("junk in the store reads as no record rather than throwing", () => {
  const store = memoryStore();
  const fp = fingerprint({ name: "a.mp4", size: 10, lastModified: 1 });
  store.setItem(`baseline.upload.${fp}`, "{not json");
  assert.equal(readRecord(store, fp), null);
});

/** localStorage's own shape: a RecordStore that can also be walked. */
const walkableStore = () => {
  const map = new Map<string, string>();
  return {
    map,
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
};

test("scratch files that a record still names are protected from the sweeper", () => {
  const store = walkableStore();
  writeRecord(store, "fp-a", record({ opfsName: "t-aaa.mp4" }));
  writeRecord(store, "fp-b", record({ opfsName: "t-bbb.mp4" }));
  writeRecord(store, "fp-c", record({ opfsName: null }));
  assert.deepEqual(liveOpfsNames(store), new Set(["t-aaa.mp4", "t-bbb.mp4"]));
});

test("an EXPIRED record still protects its scratch file", () => {
  // Deliberately not filtered by isResumable. Deleting a transcode somebody
  // waited minutes for, because its record aged out an hour ago, is a much
  // worse mistake than leaving a file the sweeper's age guard will catch.
  const store = walkableStore();
  writeRecord(store, "fp-old", record({ opfsName: "t-old.mp4", updatedAt: 0, etags: {} }));
  assert.deepEqual(liveOpfsNames(store), new Set(["t-old.mp4"]));
});

test("other things in localStorage are not mistaken for upload records", () => {
  const store = walkableStore();
  store.setItem("sb-auth-token", JSON.stringify({ opfsName: "not-ours.mp4" }));
  store.setItem("theme", "night");
  writeRecord(store, "fp-a", record({ opfsName: "t-aaa.mp4" }));
  assert.deepEqual(liveOpfsNames(store), new Set(["t-aaa.mp4"]));
});

test("one corrupt record does not cost the others their protection", () => {
  const store = walkableStore();
  writeRecord(store, "fp-a", record({ opfsName: "t-aaa.mp4" }));
  store.setItem("baseline.upload.fp-broken", "{not json");
  writeRecord(store, "fp-b", record({ opfsName: "t-bbb.mp4" }));
  const names = liveOpfsNames(store);
  assert.ok(names.has("t-aaa.mp4"));
  assert.ok(names.has("t-bbb.mp4"), "a later record must survive an earlier one being junk");
});

test("a store that cannot be walked protects nothing rather than throwing", () => {
  // The private-browsing stand-in has no length or key(); the sweeper then
  // falls back to its own age guard, which is the safe direction.
  assert.deepEqual(liveOpfsNames(memoryStore()), new Set());
});
