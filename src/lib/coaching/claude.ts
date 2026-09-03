// Anthropic Claude client. Dependency-free — direct REST calls, no SDK.
//
// Replaces this module's original Gemini client with the same shape
// (textPart/generateJSON/generateText/resolveModel) so run-coaching.ts and
// prompts.ts didn't need to change how they call it — only what's on the
// other end of the wire. Switched away from Gemini because its free tier's
// hard 20-requests/minute cap kept exhausting itself during real testing
// (see gemini.ts's git history); Claude has no free tier, but at this
// module's actual volume — a compact facts JSON in, a short coaching
// narrative out, twice per analysis — the cost is a fraction of a cent per
// run.
//
// Structured JSON comes from Claude's native structured-outputs feature
// (output_config.format, GA as of Feb 2026) — a standard JSON Schema
// dialect (lowercase types, additionalProperties: false on every object,
// nullable expressed as a ["string", "null"] type array) rather than
// Gemini's own uppercase-types/nullable:true dialect — see prompts.ts.

const BASE = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

export class ClaudeError extends Error {}

function apiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    throw new ClaudeError(
      "No ANTHROPIC_API_KEY set. Create a key at https://platform.claude.com/settings/keys " +
        "and put it in .env.local as ANTHROPIC_API_KEY=..."
    );
  }
  return key;
}

interface ParsedError {
  message: string;
  /** Server-suggested wait time in seconds, from a standard 429's `retry-after` header. */
  retryAfterSeconds?: number;
}

async function readError(res: Response): Promise<ParsedError> {
  const text = await res.text().catch(() => "");
  let message: string;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    message = parsed.error?.message ?? text.slice(0, 400);
  } catch {
    message = text.slice(0, 400);
  }
  // Only an ordinary rate-limit 429 carries this header — a tier-spend-cap
  // 429 has none and keeps failing until the cap resets, which just falls
  // through to the fixed backoff below rather than a bogus instant retry.
  const retryAfterHeader = res.headers.get("retry-after");
  const retryAfterSeconds = retryAfterHeader ? Number.parseFloat(retryAfterHeader) : undefined;
  return {
    message,
    ...(retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) ? { retryAfterSeconds } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Model selection                                                     */
/* ------------------------------------------------------------------ */

// Unlike Gemini's key-dependent model zoo, there's nothing to list-and-rank
// here — this module writes a coaching read from a compact facts JSON, not
// from video, so Haiku's fast/cheap tier is the right default. Override
// with CLAUDE_MODEL for a stronger model if a read ever needs it.
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export async function resolveModel(): Promise<string> {
  return process.env.CLAUDE_MODEL?.trim() || DEFAULT_MODEL;
}

/* ------------------------------------------------------------------ */
/* Generation                                                          */
/* ------------------------------------------------------------------ */

export type Schema = Record<string, unknown>;

export interface TextPart {
  text: string;
}
export function textPart(text: string): TextPart {
  return { text };
}

export type Part = TextPart;

const RETRYABLE = new Set([429, 500, 502, 503, 529]); // 529 = Claude's "overloaded_error"
const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Claude's structured-outputs compiler requires additionalProperties:
// false on every object node — the official SDKs add this automatically
// (see prompts.ts's header comment); since this client is deliberately
// dependency-free, it's added by hand here instead.
function withNoAdditionalProperties(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withNoAdditionalProperties);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[key] = withNoAdditionalProperties(value);
  }
  if (out.type === "object" && out.properties && out.additionalProperties === undefined) {
    out.additionalProperties = false;
  }
  return out;
}

async function callModel(
  model: string,
  parts: Part[],
  temperature: number,
  schema: Schema | null
): Promise<
  { ok: true; body: unknown } | { ok: false; status: number; message: string; retryAfterSeconds?: number }
> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    temperature,
    messages: [{ role: "user", content: parts.map((p) => p.text).join("\n\n") }],
    ...(schema
      ? { output_config: { format: { type: "json_schema", schema: withNoAdditionalProperties(schema) } } }
      : {}),
  };

  const res = await fetch(`${BASE}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey(),
      "anthropic-version": ANTHROPIC_VERSION,
      // Only needed for an identity-linked/multi-workspace key (the API
      // 400s asking for this if the key needs it and it's missing); a key
      // created already scoped to one workspace ignores this header
      // entirely, so it's safe to always send when set. Find the id at
      // https://platform.claude.com/settings — Workspaces tab, ID column.
      ...(process.env.ANTHROPIC_WORKSPACE_ID?.trim()
        ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID.trim() }
        : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const { message, retryAfterSeconds } = await readError(res);
    return { ok: false, status: res.status, message, retryAfterSeconds };
  }
  return { ok: true, body: await res.json() };
}

async function generate(parts: Part[], schema: Schema | null, temperature: number): Promise<unknown> {
  const model = await resolveModel();
  let lastError = "";
  let body: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const result = await callModel(model, parts, temperature, schema);
    if (result.ok) {
      body = result.body;
      break;
    }
    lastError = result.message;
    if (!RETRYABLE.has(result.status)) break; // a real error, not congestion
    if (attempt < MAX_ATTEMPTS - 1) {
      // Honor the server's own suggested wait when a standard rate-limit
      // 429 gives one; otherwise fall back to fixed backoff (also what
      // handles the 500/502/503/529 "overloaded" cases, which carry no
      // retry-after header at all).
      const delayMs =
        result.retryAfterSeconds !== undefined
          ? Math.ceil(result.retryAfterSeconds * 1000) + 500
          : 2000 * Math.pow(3, attempt); // 2s, 6s
      await sleep(delayMs);
    }
  }

  if (body === null) {
    throw new ClaudeError(`Claude was busy or refused the request after ${MAX_ATTEMPTS} attempts. Last response — ${lastError}`);
  }

  const parsed = body as {
    content?: Array<{ type?: string; text?: string }>;
    stop_reason?: string;
  };
  const text = (parsed.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  if (!text) {
    throw new ClaudeError(`Claude returned nothing (stop_reason: ${parsed.stop_reason ?? "unknown"}).`);
  }

  if (!schema) return text;
  try {
    return JSON.parse(text);
  } catch {
    const match = /\{[\s\S]*\}/.exec(text);
    if (match) return JSON.parse(match[0]);
    throw new ClaudeError("Claude returned something that was not valid JSON.");
  }
}

export async function generateJSON<T>(parts: Part[], schema: Schema, temperature = 0.4): Promise<T> {
  return (await generate(parts, schema, temperature)) as T;
}

export async function generateText(parts: Part[], temperature = 0.6): Promise<string> {
  return (await generate(parts, null, temperature)) as string;
}
