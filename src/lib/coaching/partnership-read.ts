import { PARTNERSHIP_DIMENSIONS, type PartnershipRead } from "./analyst";

/**
 * The stored partnership read, or null.
 *
 * DEFENSIVE BECAUSE coaching_json IS A TEXT BLOB written by whichever version
 * of the pipeline happened to run. Every read produced before this feature
 * existed has no `partnership` key, and every read of a clip with no tagged
 * partner has none either -- both are normal states, not corrupt rows.
 *
 * The validation below is not paranoia about our own writer; it is about the
 * MODEL's output surviving a schema change or a partial generation. The panel
 * calls .toFixed() on the ratings and maps over the arrays, and one missing
 * field there is a client-side exception that blanks the whole analysis page
 * -- a considerably worse outcome than no partnership section.
 */
export function partnershipFrom(coachingJson: string | null): PartnershipRead | null {
  if (!coachingJson) return null;
  let parsed: { partnership?: unknown };
  try {
    parsed = JSON.parse(coachingJson) as { partnership?: unknown };
  } catch {
    return null;
  }
  const p = parsed.partnership as Partial<PartnershipRead> | undefined | null;
  if (!p || typeof p !== "object") return null;

  // The two things the panel leads with. Without them there is nothing to
  // show, and a heading over an empty box is worse than no heading.
  if (typeof p.compatibility !== "number" || !Number.isFinite(p.compatibility)) return null;
  if (typeof p.summary !== "string" || p.summary.trim() === "") return null;

  const known = new Set<string>(PARTNERSHIP_DIMENSIONS);
  return {
    // Clamped rather than rejected: a rating slightly off the scale is a model
    // slip, and losing the whole section over it helps nobody. A bar 130% wide
    // would overflow its track, which is the only way it could actually hurt.
    compatibility: Math.max(0, Math.min(10, p.compatibility)),
    summary: p.summary,
    dimensions: (Array.isArray(p.dimensions) ? p.dimensions : [])
      // An unknown key would render as an empty label -- a blank row with a
      // bar beside it. Dropping it is the honest answer: we do not know what
      // was rated.
      .filter((d) => d && known.has(d.key) && typeof d.rating === "number" && Number.isFinite(d.rating))
      .map((d) => ({
        key: d.key,
        rating: Math.max(0, Math.min(10, d.rating)),
        basis: typeof d.basis === "string" ? d.basis : "",
      })),
    works_well: (Array.isArray(p.works_well) ? p.works_well : [])
      .filter((w) => w && typeof w.pattern === "string")
      .map((w) => ({
        pattern: w.pattern,
        why_it_works: typeof w.why_it_works === "string" ? w.why_it_works : "",
        evidence: typeof w.evidence === "string" ? w.evidence : "",
        at_s: typeof w.at_s === "number" && Number.isFinite(w.at_s) ? w.at_s : null,
      })),
    friction: (Array.isArray(p.friction) ? p.friction : [])
      .filter((f) => f && typeof f.pattern === "string")
      .map((f) => ({
        pattern: f.pattern,
        cost: typeof f.cost === "string" ? f.cost : "",
        fix: typeof f.fix === "string" ? f.fix : "",
        evidence: typeof f.evidence === "string" ? f.evidence : "",
        at_s: typeof f.at_s === "number" && Number.isFinite(f.at_s) ? f.at_s : null,
      })),
    role_split: {
      you: typeof p.role_split?.you === "string" ? p.role_split.you : "",
      partner: typeof p.role_split?.partner === "string" ? p.role_split.partner : "",
      imbalance: typeof p.role_split?.imbalance === "string" ? p.role_split.imbalance : null,
    },
    fix_together: {
      change: typeof p.fix_together?.change === "string" ? p.fix_together.change : "",
      how_to_practise: typeof p.fix_together?.how_to_practise === "string"
        ? p.fix_together.how_to_practise : "",
      at_s: typeof p.fix_together?.at_s === "number" && Number.isFinite(p.fix_together.at_s)
        ? p.fix_together.at_s : null,
    },
  };
}
