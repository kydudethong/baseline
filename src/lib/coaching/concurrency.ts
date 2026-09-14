/**
 * Run an async mapper over a list, at most `limit` in flight at once.
 *
 * WHY THIS EXISTS. The per-shot technique pass makes one Gemini call per shot,
 * up to 40 of them, and it made them one after another. Each call re-reads a
 * ~1.8 second window of a file Gemini has ALREADY got, at 15fps -- a few
 * seconds each, and entirely independent of every other call. Run in sequence
 * that is minutes of wall clock spent waiting on a network round trip that
 * nothing depends on.
 *
 * `Promise.all` over all 40 is the obvious fix and the wrong one: it opens 40
 * simultaneous requests, which is a good way to turn a working key into a
 * rate-limited one, and the backoff in gemini.ts would then be fighting a
 * burst this function created. A small fixed pool gets almost all of the
 * speed-up with none of that.
 *
 * Results come back in INPUT order, not completion order. Callers here sort by
 * shot time and a list that reordered itself by however fast each call
 * happened to answer would be a subtle, intermittent bug in the output.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(Math.floor(limit), items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  // Shared cursor rather than fixed slices: a slice-per-worker scheme finishes
  // as slowly as its unluckiest slice, and these calls vary a lot in duration.
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await mapper(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
