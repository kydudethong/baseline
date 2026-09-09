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

  // --- Cloudflare R2 (video storage) ---------------------------------
  // Video lives in R2, not Supabase Storage — see src/lib/storage/r2.ts
  // for why. Server-only; never expose these to the client.
  get r2AccountId() {
    return required("R2_ACCOUNT_ID");
  },
  get r2AccessKeyId() {
    return required("R2_ACCESS_KEY_ID");
  },
  get r2SecretAccessKey() {
    return required("R2_SECRET_ACCESS_KEY");
  },
  get r2Bucket() {
    return required("R2_BUCKET");
  },
};
