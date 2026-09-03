/**
 * The Supabase SDK swallows the real reason a `fetch()` call fails: it
 * catches the error, keeps only `error.message` (always the generic string
 * "fetch failed" for network-level failures — DNS, TLS, connection
 * refused, timeout), and discards `error.cause`, which is where Node's
 * `fetch` (undici) actually puts the useful part (e.g. `ENOTFOUND
 * xyz.supabase.co`, `ECONNREFUSED`, a certificate error). See
 * @supabase/auth-js/dist/main/lib/fetch.js — `_handleRequest`'s catch block.
 *
 * Passing this as the client's `global.fetch` doesn't change any behavior —
 * it just logs the cause to the server terminal before re-throwing, so a
 * "fetch failed" error is actually diagnosable from `npm run dev` output
 * instead of being a dead end.
 */
export async function loggingFetch(
  ...args: Parameters<typeof fetch>
): ReturnType<typeof fetch> {
  try {
    return await fetch(...args);
  } catch (error) {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.toString();
    console.error(`[supabase fetch] request to ${url} failed:`, error);
    if (error instanceof Error && error.cause) {
      console.error(`[supabase fetch] underlying cause:`, error.cause);
    }
    throw error;
  }
}
