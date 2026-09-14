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
import { describeError } from "../analysis/describe-error";

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
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
}

/**
 * The model every call uses unless GEMINI_MODEL says otherwise.
 *
 * WHY NOT THE NEWEST FLASH. 3.8 Flash is $1.50 per million input tokens and
 * this pipeline is dominated by video tokens -- a 20-minute game was costing
 * about $2.50 to analyse, which is more than most consumer subscriptions
 * charge per MONTH. 3 Flash Preview is $0.50: the same API, the same video
 * handling, a third of the bill.
 *
 * It is a real trade and it is not free. An older model is generally weaker at
 * video, and this pipeline leans on that harder than most. If coaching reads
 * get vaguer after this change, GEMINI_MODEL=gemini-3.8-flash puts it back
 * with no deploy -- and the 404 path in callGemini lists exactly which models
 * a key can call, so a wrong name fails loudly rather than silently.
 */
const DEFAULT_MODEL = "gemini-3-flash-preview";

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
/**
 * A text-only call — no video, no schema.
 *
 * Shares the failure handling with generateJSON rather than duplicating it,
 * because every one of those cases was learned from a real failure and a
 * second copy would drift from the first.
 */
export async function generateText(opts: {
  model?: string;
  prompt: string;
  maxOutputTokens?: number;
  onLog?: (line: string) => void;
}): Promise<string> {
  const out = await callGemini(opts.model ?? analystModel(), {
    contents: [{ parts: [{ text: opts.prompt }] }],
    generationConfig: { maxOutputTokens: opts.maxOutputTokens ?? 4000 },
  }, opts.onLog);
  return out;
}

/** Structured JSON from text alone — the same shape as generateJSON, no file. */
export async function generateJSONFromText<T>(opts: {
  model?: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
  onLog?: (line: string) => void;
}): Promise<T> {
  const text = await callGemini(opts.model ?? analystModel(), {
    contents: [{ parts: [{ text: opts.prompt }] }],
    generationConfig: {
      response_mime_type: "application/json",
      response_schema: sanitiseSchema(opts.schema),
      maxOutputTokens: opts.maxOutputTokens ?? 8000,
    },
  }, opts.onLog);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GeminiError(`Gemini returned text that is not JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * One request, with the retry and quota handling every caller needs.
 *
 * A 429 carrying "limit: 0" is NOT rate limiting -- it means the key may not
 * call that model at all without billing, and no amount of waiting fixes it.
 * Retrying one is a slower way to fail, so it is not retried, whatever the
 * error's own "please retry in 26s" says.
 */
async function callGemini(
  model: string,
  body: Record<string, unknown>,
  onLog?: (line: string) => void,
  onUsage?: (usage: UsageInfo) => void
): Promise<string> {
  let delay = 5000;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // A NETWORK failure and an HTTP failure are both transient here, and only
    // one of them was being retried.
    //
    // fetch() rejects rather than resolving when the connection itself never
    // happens -- DNS not resolving, connection refused, socket reset mid-flight.
    // That rejection escaped this loop entirely and failed the whole coaching
    // run on the first blip, which matters more than usual on this deployment:
    // min_machines_running is 0, so the machine that serves a coaching request
    // has often just cold-started, and the first outbound DNS from a
    // just-woken Fly machine is exactly the kind of thing that fails once and
    // then works. A 503 got four attempts and a backoff; a one-off DNS failure
    // got none.
    let res: Response;
    try {
      res = await fetch(
        `${BASE}/v1beta/models/${model}:generateContent?key=${apiKey()}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      );
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        throw new GeminiError(`Could not reach Gemini after ${MAX_ATTEMPTS} attempts: ${describeError(err)}`);
      }
      onLog?.(
        `could not reach Gemini (${describeError(err)}, attempt ${attempt}/${MAX_ATTEMPTS}) — `
        + `retrying in ${delay / 1000}s`
      );
      await new Promise((r) => setTimeout(r, delay));
      delay *= 3;
      continue;
    }
    if (res.ok) {
      const json = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          thoughtsTokenCount?: number;
        };
      };
      // Reported because it is the ONLY way to confirm a video config was
      // honoured. If fps is raised from 1 to 10 and promptTokenCount does not
      // rise roughly tenfold, the API ignored the field -- which it does
      // silently, with a perfectly normal-looking answer built from one frame
      // per second. A plausible answer from the wrong frames is the failure
      // mode this exists to catch.
      onUsage?.({
        promptTokens: json.usageMetadata?.promptTokenCount ?? null,
        outputTokens: json.usageMetadata?.candidatesTokenCount ?? null,
        thoughtsTokens: json.usageMetadata?.thoughtsTokenCount ?? null,
      });
      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (!text) throw new GeminiError("Gemini returned no content — the response may have been truncated.");
      return text;
    }

    const detail = (await res.text()).slice(0, 500);
    if (res.status === 404) {
      const available = await listModels();
      throw new GeminiError(
        `${model} is not a model this key can call. Available: ${available.join(", ") || "(none listed)"}`
      );
    }
    if (res.status === 429 && detail.includes("limit: 0")) {
      throw new GeminiError(
        `${model} has no free-tier quota (limit: 0) — this key cannot call it without billing. `
        + "Retrying will not help. Enable billing, or set GEMINI_MODEL to a flash-tier model."
      );
    }
    if (!RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS) {
      throw new GeminiError(`Gemini failed (${res.status}): ${detail}`);
    }
    onLog?.(`${model} busy (${res.status}, attempt ${attempt}/${MAX_ATTEMPTS}) — retrying in ${delay / 1000}s`);
    await new Promise((r) => setTimeout(r, delay));
    delay *= 3;   // a demand spike outlasts a tight loop
  }
  throw new GeminiError("unreachable");
}


/**
 * How much of the video Gemini looks at, and how closely.
 *
 * DEFAULTS ARE 1 FPS AND LOW RESOLUTION, which is what this client did
 * implicitly before these existed. At that rate a pickleball swing -- about a
 * third of a second from backswing to contact -- falls entirely between two
 * sampled frames, so the model is not being cagey when it declines to comment
 * on technique: it genuinely never saw the stroke.
 *
 * THE CONSTRAINT IS CONTEXT, NOT COST. At low resolution a frame is ~66 tokens
 * and audio ~32/s, so 1fps is ~100 tokens per second of video and 10fps is
 * ~690. A 20-minute game at 10fps is ~830k tokens, which barely fits a 1M
 * window, and a 30-minute one does not fit at all. Raising fps over a whole
 * match is therefore not an option; raising it over a ONE-SECOND window around
 * a shot costs a few hundred tokens and shows the entire stroke. That is what
 * startOffsetSeconds/endOffsetSeconds are for.
 *
 * Field names here are the REST spellings (snake_case, "10s" strings for
 * offsets), which differ from the client SDKs' -- if the API starts rejecting
 * one, that is the first thing to check.
 */
export interface VideoConfig {
  /** Frames sampled per second of video. Omit for the API default of 1. */
  fps?: number;
  startOffsetSeconds?: number;
  endOffsetSeconds?: number;
  /** "low" is the default; "high" spends ~4x the tokens per frame on detail. */
  mediaResolution?: "low" | "medium" | "high";
}

/** Token accounting, so a caller can VERIFY a video config actually applied. */
export interface UsageInfo {
  promptTokens: number | null;
  outputTokens: number | null;
  thoughtsTokens: number | null;
}

function videoPart(file: UploadedFile, cfg?: VideoConfig) {
  const part: Record<string, unknown> = {
    file_data: { mime_type: file.mimeType, file_uri: file.uri },
  };
  if (!cfg) return part;
  const meta: Record<string, unknown> = {};
  if (cfg.fps !== undefined) meta.fps = cfg.fps;
  if (cfg.startOffsetSeconds !== undefined) meta.start_offset = `${cfg.startOffsetSeconds}s`;
  if (cfg.endOffsetSeconds !== undefined) meta.end_offset = `${cfg.endOffsetSeconds}s`;
  if (Object.keys(meta).length > 0) part.video_metadata = meta;
  return part;
}

function mediaResolutionFor(cfg?: VideoConfig): Record<string, unknown> {
  if (!cfg?.mediaResolution) return {};
  return {
    media_resolution: `MEDIA_RESOLUTION_${cfg.mediaResolution.toUpperCase()}`,
  };
}

export async function generateJSON<T>(opts: {
  model: string;
  file: UploadedFile;
  prompt: string;
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
  video?: VideoConfig;
  onLog?: (line: string) => void;
  onUsage?: (usage: UsageInfo) => void;
}): Promise<T> {
  const body = {
    contents: [{
      parts: [
        videoPart(opts.file, opts.video),
        { text: opts.prompt },
      ],
    }],
    generationConfig: {
      response_mime_type: "application/json",
      response_schema: sanitiseSchema(opts.schema),
      maxOutputTokens: opts.maxOutputTokens ?? 32000,
      ...mediaResolutionFor(opts.video),
    },
  };

  // The retry, quota and 404 handling all live in callGemini; duplicating it
  // here is how the two copies drift.
  const text = await callGemini(opts.model, body, opts.onLog, opts.onUsage);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GeminiError(`Gemini returned text that is not JSON: ${text.slice(0, 200)}`);
  }
}
