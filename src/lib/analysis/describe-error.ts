/**
 * Turn anything a `catch` can receive into a sentence worth showing a user.
 *
 * `err instanceof Error ? err.message : "Unknown processing error"` looks
 * defensive and is the opposite. The most common failure in this pipeline is a
 * Supabase error, and those are plain objects, not Error instances -- so the
 * one branch that mattered fell through to "Unknown processing error" and threw
 * away the message, the Postgres code, and the hint. A run that failed for a
 * knowable reason became a run that failed for no stated reason.
 *
 * Postgres codes are included deliberately. "23514" is a check constraint,
 * "42703" is an undefined column, "PGRST204" is a column PostgREST cannot see
 * because its schema cache is stale -- each points at a different fix, and none
 * of them is guessable from the prose alone.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error && err.message) {
    // UNWRAP THE CAUSE CHAIN, and specifically for undici.
    //
    // Every network failure in this app arrives as a TypeError whose message
    // is the bare string "fetch failed" -- the same five characters whether
    // DNS did not resolve, the connection was refused, the socket was reset
    // mid-upload, or TLS failed. The thing that distinguishes them is
    // `err.cause`, which carries the syscall-level code, and this function
    // used to throw it away. The result was an error box reading "fetch
    // failed" and no way to tell a transient cold-start DNS blip from a
    // genuinely unreachable API, which is the difference between "press it
    // again" and "something is actually wrong".
    //
    // Node 16+ sets `cause` on wrapped errors generally, so this is not an
    // undici special case -- it just matters most there.
    const chain: string[] = [err.message];
    let cause: unknown = (err as { cause?: unknown }).cause;
    // Bounded: a cause chain is normally one or two deep, and a cycle would
    // otherwise hang the error handler -- which is a spectacularly bad place
    // for an infinite loop.
    for (let depth = 0; cause && depth < 4; depth++) {
      const c = cause as { message?: unknown; code?: unknown; errno?: unknown; cause?: unknown };
      const bits: string[] = [];
      if (typeof c.code === "string" && c.code) bits.push(c.code);
      if (typeof c.message === "string" && c.message && c.message !== chain[chain.length - 1]) {
        bits.push(c.message);
      }
      if (bits.length === 0) break;
      const next = bits.join(": ");
      if (chain.includes(next)) break;
      chain.push(next);
      cause = c.cause;
    }
    return chain.join(" — caused by ");
  }
  if (typeof err === "string" && err.trim()) return err.trim();

  if (err && typeof err === "object") {
    const e = err as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    const parts: string[] = [];
    if (typeof e.message === "string" && e.message) parts.push(e.message);
    if (typeof e.details === "string" && e.details) parts.push(e.details);
    if (typeof e.hint === "string" && e.hint) parts.push(`Hint: ${e.hint}`);
    if (parts.length) {
      const code = typeof e.code === "string" && e.code ? ` [${e.code}]` : "";
      return `${parts.join(" — ")}${code}`;
    }
    try {
      const json = JSON.stringify(err);
      if (json && json !== "{}") return json.slice(0, 500);
    } catch {
      // Circular or otherwise unserialisable; fall through.
    }
  }
  return "Processing failed, and the error carried no message.";
}

/**
 * Attach "which step" to a failure that only knows "what went wrong".
 *
 * A constraint violation reported on its own tells you a value was rejected but
 * not which of nine writes rejected it, which is most of the work of fixing it.
 */
export function failedAt<T>(step: string, run: () => Promise<T>): Promise<T> {
  return run().catch((err) => {
    throw new Error(`${step}: ${describeError(err)}`);
  });
}
