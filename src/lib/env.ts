/**
 * Centralised env var access. Nothing here throws at import time — only when
 * a value is actually read and missing — so `next build` succeeds even
 * before Supabase is configured (it only reads env vars while handling a
 * request, never while bundling). Running the app still requires real
 * Supabase credentials in .env.local — see .env.example.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable "${name}". Copy .env.example to ` +
        `.env.local and fill in your Supabase project credentials.`
    );
  }
  return value;
}

/**
 * Same validation as required(), but takes the value directly instead of a
 * name to look up. NEXT_PUBLIC_ vars must be read via a static, literal
 * `process.env.NEXT_PUBLIC_X` expression at the call site (not
 * `process.env[name]`) — Next.js inlines NEXT_PUBLIC_ vars into the browser
 * bundle by statically finding that exact literal form at build time. Going
 * through a dynamic lookup (as required() does) is invisible to that static
 * analysis, so the value silently comes back undefined in browser code even
 * though it's set correctly in .env.local and works fine server-side.
 */
function requiredPublic(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `Missing required environment variable "${name}". Copy .env.example to ` +
        `.env.local and fill in your Supabase project credentials.`
    );
  }
  return value;
}

export const env = {
  get supabaseUrl() {
    return requiredPublic(process.env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL");
  },
  get supabaseAnonKey() {
    return requiredPublic(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, "NEXT_PUBLIC_SUPABASE_ANON_KEY");
  },
  /** Server-only. Bypasses RLS — never expose to the client. */
  get supabaseServiceRoleKey() {
    return required("SUPABASE_SERVICE_ROLE_KEY");
  },
  get siteUrl() {
    return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  },
};
