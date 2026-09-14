/**
 * REMOVED — pass two no longer exists.
 *
 * This file held the second Gemini pass: one call per shot over a second
 * upload of the source video, at 15fps, because pass one watched at Gemini's
 * default 1fps and a pickleball stroke lasts about a third of a second. The
 * entire swing fell between two sampled frames, so a closer second look was
 * the only way to see one.
 *
 * The single pass now runs at 10fps and fills the technique fields on the
 * shots it is already reporting (see analyst.ts), which removes the second
 * upload, the extra round trips, and a real failure mode: pass two matched its
 * shots back to pass one by timestamp, and a few tenths of drift attached a
 * correction to the wrong swing.
 *
 * Kept as an empty module rather than deleted because this sandbox cannot
 * unlink files. Safe to delete along with technique.test.ts.
 *
 * technique-segments.ts is NOT dead — the single pass uses it to size its
 * windows.
 */
export {};
