/**
 * Gemini client — dependency-free REST, same shape as claude.ts.
 *
 * This exists because the coaching layer now needs a model that can watch the
 * overlay video, and Claude takes images but not video. It is deliberately
 * NOT a replacement for claude.ts: that one writes from a compact facts JSON
 * and is cheap and fast at it. This one carries a 19MB upload.
 *
 * Two dialect differences from Claude's structured outputs, both of which
 * have already cost a round trip each:
 *   - "may be null" is `nullable: true`, NOT a ["string","null"] type array.
 *   - `additionalProperties` is not part of the dialect at all; sending it is
 *     rejected rather than ignored.
 * sanitiseSchema() enforces both, so a schema written in the Claude dialect
 * cannot silently reach the wire.
 */

const BASE = "https://generativelanguage.googleapis.com";
const UPLOAD_BASE = `${BASE}/upload/v1beta/files`;

export class GeminiError extends Error {}

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  if (!key) {
    throw new GeminiError(
      "No GEMINI_API_KEY set. Create a key at https://aistudio.google.com/apikey " +
        "and put it in .env.local as GEMINI_API_KEY=..."
    );
  }
  return key;
}

/**
 * Model names move, and a hardcoded default is a bug with a delay on it: the
 * first attempt at this shipped "gemini-3-pro", which 404s. Overridable, and
 * the failure path lists what the key can actually call.
 */
export function analystModel(): string {
  return process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash";
}

export async function listModels(): Promise<string[]> {
  const res = await fetch(`${BASE}/v1beta/models?key=${apiKey()}&pageSize=200`);
  if (!res.ok) return [];
  const body = (await res.json()) as {
    models?: Array<{ name: string; supportedGenerationMethods?: string[] }>;
  };
  return (body.models ?? [])
    .filter((m) => !m.supportedGenerationMethods
      || m.supportedGenerationMethods.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""));
}

/**
 * Gemini rejects a schema carrying Claude's dialect rather than ignoring the
 * parts it does not know, so this rewrites rather than hopes.
 */
export function sanitiseSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitiseSchema);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "additionalProperties") continue;   // not in this dialect
    if (key === "type" && Array.isArray(value)) {
      // ["string","null"] -> type: "string", nullable: true
      const types = value.filter((t) => t !== "null");
      out.type = types[0] ?? "string";
      if (types.length !== value.length) out.nullable = true;
      continue;
    }
    out[key] = sanitiseSchema(value);
  }
  return out;
}

export interface UploadedFile {
  uri: string;
  mimeType: string;
  name: string;
}

/**
 * Upload a file with the resumable protocol and wait until Gemini has finished
 * processing it.
 *
 * Generating against a file still in PROCESSING fails with an opaque error, and
 * video processing on a long clip is measured in minutes, so this polls rather
 * than sleeping a fixed amount and hoping.
 */
export async function uploadVideo(
  bytes: Uint8Array,
  displayName: string,
  mimeType = "video/mp4",
  onLog?: (line: string) => void
): Promise<UploadedFile> {
  const key = apiKey();
  const start = await fetch(`${UPLOAD_BASE}?key=${key}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (!start.ok) {
    throw new GeminiError(`Gemini refused the upload (${start.status}): ${(await start.text()).slice(0, 300)}`);
  }
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new GeminiError("Gemini accepted the upload request but returned no upload URL.");

  const put = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes as unknown as BodyInit,
  });
  if (!put.ok) {
    throw new GeminiError(`Upload failed (${put.status}): ${(await put.text()).slice(0, 300)}`);
  }
  const done = (await put.json()) as { file?: { uri?: string; name?: string; state?: string } };
  let file = done.file;
  if (!file?.uri || !file?.name) throw new GeminiError("Upload finished but returned no file handle.");

  const startedAt = Date.now();
  while (file.state === "PROCESSING") {
    if (Date.now() - startedAt > 10 * 60_000) {
      throw new GeminiError("Gemini was still processing the video after 10 minutes.");
    }
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await fetch(`${BASE}/v1beta/${file.name}?key=${key}`);
    file = (await poll.json()) as typeof file;
    onLog?.(`upload processing… ${Math.round((Date.now() - startedAt) / 1000)}s`);
  }
  if (file.state && file.state !== "ACTIVE") {
    throw new GeminiError(`Upload ended in state ${file.state}, not ACTIVE.`);
  }
  return { uri: file.uri!, mimeType, name: file.name! };
}

/** Best-effort tidy-up. A leaked file expires on its own after 48h. */
export async function deleteFile(name: string): Promise<void> {
  await fetch(`${BASE}/v1beta/${name}?key=${apiKey()}`, { method: "DELETE" }).catch(() => {});
}

const RETRYABLE = new Set([429, 500, 502, 503]);
const MAX_ATTEMPTS = 4;

/**
 * One structured-JSON generation over a video plus a prompt.
 *
 * A 429 carrying "limit: 0" is NOT rate limiting — it means the key may not
 * call that model at all without billing, and no amount of waiting fixes it.
 * Retrying one is a slower way to fail, so it is not retried.
 */
export async function generateJSON<T>(opts: {
  model: string;
  file: UploadedFile;
  prompt: string;
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
  onLog?: (line: string) => void;
}): Promise<T> {
  const body = {
    contents: [{
      parts: [
        { file_data: { mime_type: opts.file.mimeType, file_uri: opts.file.uri } },
        { text: opts.prompt },
      ],
    }],
    generationConfig: {
      response_mime_type: "application/json",
      response_schema: sanitiseSchema(opts.schema),
      maxOutputTokens: opts.maxOutputTokens ?? 32000,
    },
  };

  let delay = 5000;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(
      `${BASE}/v1beta/models/${opts.model}:generateContent?key=${apiKey()}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    if (res.ok) {
      const json = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (!text) throw new GeminiError("Gemini returned no content — the response may have been truncated.");
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new GeminiError(`Gemini returned text that is not JSON: ${text.slice(0, 200)}`);
      }
    }

    const detail = (await res.text()).slice(0, 500);
    if (res.status === 404) {
      const available = await listModels();
      throw new GeminiError(
        `${opts.model} is not a model this key can call. Available: ${available.join(", ") || "(none listed)"}`
      );
    }
    if (res.status === 429 && detail.includes("limit: 0")) {
      throw new GeminiError(
        `${opts.model} has no free-tier quota (limit: 0) — this key cannot call it without billing. `
        + "Retrying will not help. Enable billing, or set GEMINI_MODEL to a flash-tier model."
      );
    }
    if (!RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS) {
      throw new GeminiError(`Gemini failed (${res.status}): ${detail}`);
    }
    opts.onLog?.(`${opts.model} busy (${res.status}, attempt ${attempt}/${MAX_ATTEMPTS}) — retrying in ${delay / 1000}s`);
    await new Promise((r) => setTimeout(r, delay));
    delay *= 3;   // a demand spike outlasts a tight loop
  }
  throw new GeminiError("unreachable");
}
