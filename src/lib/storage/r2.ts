import fs from "node:fs";
import fsp from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";
import { UPLOAD_PART_SIZE_BYTES } from "@/lib/video/validation";

export { UPLOAD_PART_SIZE_BYTES };

/**
 * Video storage lives in Cloudflare R2, not Supabase Storage — Supabase's
 * per-file cap is enforced at the project level regardless of what a
 * bucket's own `file_size_limit` says (50MB on Free, 500GB on Pro), and R2
 * charges nothing for egress, which matters because the vision pipeline
 * downloads the full video back down for every processing run. Auth and
 * the Postgres data model stay on Supabase — only the bytes moved.
 *
 * Uploads go multipart, straight from the browser to R2 via presigned
 * per-part URLs (see the upload-init/upload-complete routes), so large
 * match footage never passes through this server and a dropped connection
 * only has to retry the failed part, not the whole file.
 */

let client: S3Client | null = null;

function r2(): S3Client {
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: `https://${env.r2AccountId}.r2.cloudflarestorage.com`,
      // R2's endpoint doesn't support AWS's virtual-hosted-style bucket
      // subdomains (<bucket>.<account>.r2.cloudflarestorage.com) — without
      // this the SDK tries to resolve that subdomain and fails DNS lookup
      // before the request is even sent.
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.r2AccessKeyId,
        secretAccessKey: env.r2SecretAccessKey,
      },
    });
  }
  return client;
}

export async function createMultipartUpload(key: string, contentType: string): Promise<string> {
  const res = await r2().send(
    new CreateMultipartUploadCommand({ Bucket: env.r2Bucket, Key: key, ContentType: contentType })
  );
  if (!res.UploadId) throw new Error("R2 did not return an upload id.");
  return res.UploadId;
}

/** Presigned PUT URL for one part, valid for an hour — plenty for a slow home upload. */
export async function presignUploadPart(
  key: string,
  uploadId: string,
  partNumber: number
): Promise<string> {
  return getSignedUrl(
    r2(),
    new UploadPartCommand({ Bucket: env.r2Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn: 3600 }
  );
}

export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: Array<{ ETag: string; PartNumber: number }>
): Promise<void> {
  await r2().send(
    new CompleteMultipartUploadCommand({
      Bucket: env.r2Bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.sort((a, b) => a.PartNumber - b.PartNumber) },
    })
  );
}

export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  await r2()
    .send(new AbortMultipartUploadCommand({ Bucket: env.r2Bucket, Key: key, UploadId: uploadId }))
    .catch(() => {
      // Best-effort — an already-completed or already-aborted upload 404s here, which is fine.
    });
}

/** Signed GET URL for browser playback (the library grid and the analysis player). */
export async function getSignedDownloadUrl(key: string, expiresInSeconds = 3600): Promise<string> {
  return getSignedUrl(r2(), new GetObjectCommand({ Bucket: env.r2Bucket, Key: key }), {
    expiresIn: expiresInSeconds,
  });
}

export async function downloadToFile(key: string, localPath: string): Promise<void> {
  const res = await r2().send(new GetObjectCommand({ Bucket: env.r2Bucket, Key: key }));
  const body = res.Body;
  if (!body) throw new Error("R2 returned no data for this video.");
  await pipeline(body as NodeJS.ReadableStream, fs.createWriteStream(localPath));
}

export async function deleteObject(key: string): Promise<void> {
  await r2().send(new DeleteObjectCommand({ Bucket: env.r2Bucket, Key: key }));
}

/**
 * Put a local file into R2 in one request.
 *
 * The browser upload path is multipart because it streams from a user's
 * machine over an unreliable link and has to survive a dropped connection.
 * A server-side fetch has already got the whole file on local disk, so the
 * simple form is the honest one.
 */
export async function uploadFileFromDisk(
  key: string,
  localPath: string,
  contentType: string
): Promise<void> {
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const body = await fsp.readFile(localPath);
  await r2().send(new PutObjectCommand({
    Bucket: env.r2Bucket, Key: key, Body: body, ContentType: contentType,
  }));
}
