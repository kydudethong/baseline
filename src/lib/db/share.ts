/**
 * Read-only links to one analysis, for somebody with no account.
 *
 * THE POINT IS THE PARK. Analysing a stranger's game and handing them the
 * result on their phone is the whole demo, and "first make an account" is
 * where that conversation ends. So a share link opens the read for anyone
 * holding it, and nothing else.
 *
 * A SIGNATURE RATHER THAN A STORED TOKEN, and that is a constraint talking
 * rather than a preference. A `share_token` column is the right design: it
 * lets one link be revoked without touching any other, and it records that a
 * particular analysis was deliberately shared. But this repo's CI only applies
 * migrations when RUN_MIGRATIONS is set, and it is not -- so a column would
 * ship as code reading something that does not exist, and the first anyone saw
 * would be a 500. Signing the id with a server secret needs no schema at all.
 *
 * WHAT THAT COSTS, stated plainly rather than discovered later:
 *   - Revocation is all-or-nothing. Rotating ANALYSIS_SHARE_SECRET invalidates
 *     every link ever issued, because there is nothing per-analysis to delete.
 *   - There is no record of which analyses have been shared, so nothing can
 *     show "3 people opened this" or list what is public.
 * Both are fixed by the column, the day migrations run. The signature scheme
 * stays valid alongside it, so that is an addition rather than a rewrite.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The secret the links are signed with.
 *
 * Falls back to the service-role key when unset, so the feature works on a
 * fresh deployment without another secret to remember -- that key is already
 * server-only and already fatal to leak, so it adds no new exposure. Setting
 * ANALYSIS_SHARE_SECRET separately is better: it means share links can be
 * revoked (by rotating it) without rotating database access.
 */
function shareSecret(): string {
  const explicit = process.env.ANALYSIS_SHARE_SECRET?.trim();
  if (explicit) return explicit;
  const fallback = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (fallback) return fallback;
  throw new Error(
    "Sharing needs ANALYSIS_SHARE_SECRET (or SUPABASE_SERVICE_ROLE_KEY) to sign links with."
  );
}

/**
 * How much of the digest the link carries.
 *
 * Sixteen base64url characters is 96 bits. A link is a bearer credential to
 * one person's video, so this has to be past guessing however many attempts
 * somebody is willing to make -- and it still fits in a URL somebody can read
 * out at a court.
 */
const SIG_LENGTH = 16;

function sign(analysisId: string): string {
  return createHmac("sha256", shareSecret())
    .update(`analysis:${analysisId}`)
    .digest("base64url")
    .slice(0, SIG_LENGTH);
}

/** The token that goes in the URL: the id, and proof it was issued by us. */
export function shareToken(analysisId: string): string {
  return `${analysisId}.${sign(analysisId)}`;
}

/**
 * The analysis a token refers to, or null when the signature does not hold.
 *
 * COMPARED IN CONSTANT TIME. A naive === leaks how much of the signature was
 * right through how long the comparison took, which over many attempts is a
 * way to build a valid token one character at a time. The cost of doing it
 * properly is one function call.
 */
export function analysisIdFromToken(token: string): string | null {
  const cut = token.lastIndexOf(".");
  if (cut <= 0) return null;
  const analysisId = token.slice(0, cut);
  const given = token.slice(cut + 1);
  if (!analysisId || !given) return null;

  let expected: string;
  try {
    expected = sign(analysisId);
  } catch {
    return null; // no secret configured: nothing verifies, so nothing opens
  }
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which is itself a length
  // oracle -- but length alone tells an attacker nothing they cannot see in
  // their own link, so returning early is fine.
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? analysisId : null;
}

/** The full URL to hand somebody. */
export function shareUrl(analysisId: string, siteUrl: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/share/${shareToken(analysisId)}`;
}
