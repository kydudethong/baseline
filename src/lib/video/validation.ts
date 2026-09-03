/**
 * Shared between the client (pre-upload checks, so users get instant
 * feedback) and the server (defense in depth — never trust the client).
 * Keep this file free of Node-only imports so it can run in the browser.
 */

export const ALLOWED_VIDEO_MIME_TYPES = [
  "video/mp4",
  "video/quicktime", // .mov
  "video/webm",
  "video/x-msvideo", // .avi
  "video/x-matroska", // .mkv
] as const;

export const ALLOWED_VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".avi", ".mkv"];

// Keep in sync with the storage bucket's file_size_limit in
// supabase/migrations/0002_storage.sql.
export const MAX_VIDEO_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
export const MIN_VIDEO_SIZE_BYTES = 100 * 1024; // 100 KiB — filters out empty/corrupt uploads

export type FileLike = { name: string; type: string; size: number };

export function validateVideoFile(file: FileLike): { valid: true } | { valid: false; error: string } {
  const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  const mimeOk =
    ALLOWED_VIDEO_MIME_TYPES.includes(file.type as (typeof ALLOWED_VIDEO_MIME_TYPES)[number]) ||
    ALLOWED_VIDEO_EXTENSIONS.includes(extension);

  if (!mimeOk) {
    return {
      valid: false,
      error: `"${file.name}" isn't a supported video format. Use MP4, MOV, WebM, AVI, or MKV.`,
    };
  }

  if (file.size < MIN_VIDEO_SIZE_BYTES) {
    return { valid: false, error: "That file is too small to be a real video." };
  }

  if (file.size > MAX_VIDEO_SIZE_BYTES) {
    return {
      valid: false,
      error: `That file is too large (${formatBytes(file.size)}). The limit is ${formatBytes(MAX_VIDEO_SIZE_BYTES)}.`,
    };
  }

  return { valid: true };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
