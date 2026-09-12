/**
 * Saved court calibrations — mark a fixed camera once, reuse it forever.
 *
 * See supabase/migrations/0012_court_presets.sql for why these are named and
 * picked rather than matched automatically.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { normaliseLineColor, type MatchMode } from "./setup";

/**
 * The four corners, in the app's OWN vocabulary.
 *
 * near/far, not top/bottom, and deliberately so: PreAnalysisSetup, SetupCanvas
 * and rally_seg's corners_px all speak near/far already. A second naming
 * scheme here would need a translation layer at every boundary, and the
 * failure mode of getting that translation wrong is not a crash — it is a
 * court quietly flipped end for end, with every distance, zone and side label
 * confidently mirrored. One vocabulary removes the chance.
 *
 * "near" is the baseline closest to the camera, which is the BOTTOM of the
 * image; quadKind lives with the setup, not the preset, because it describes
 * what was markable in one clip rather than the venue.
 */
export interface CourtCorners {
  nearLeft: [number, number];
  nearRight: [number, number];
  farRight: [number, number];
  farLeft: [number, number];
}

export interface CourtPreset {
  id: string;
  name: string;
  corners: CourtCorners;
  frameWidthPx: number;
  frameHeightPx: number;
  lineColorHex: string | null;
  matchMode: MatchMode;
  lastUsedAt: string | null;
}

const CORNER_KEYS = ["nearLeft", "nearRight", "farRight", "farLeft"] as const;

/**
 * True when `value` is a complete set of four finite corner points.
 *
 * Checked rather than cast because this column is jsonb: Postgres will store
 * whatever shape it is handed, and a preset written by an older build, a
 * partial write, or a hand-edited row would otherwise reach the homography as
 * `undefined` coordinates and produce NaN positions across the whole analysis.
 */
export function isCourtCorners(value: unknown): value is CourtCorners {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return CORNER_KEYS.every((k) => {
    const p = c[k];
    return Array.isArray(p) && p.length === 2
      && typeof p[0] === "number" && Number.isFinite(p[0])
      && typeof p[1] === "number" && Number.isFinite(p[1]);
  });
}

/**
 * Move corners marked in one frame size onto another.
 *
 * Scaling each axis independently is correct here and a uniform scale would
 * not be: these are positions in an image, so if a 1280x720 mark is applied to
 * a 1920x1080 frame both axes happen to scale by 1.5, but a 1280x720 mark on a
 * 1280x960 frame must stretch y alone. The corners are not a rigid shape being
 * placed — they are four independent samples of where things are.
 *
 * Returns null when either size is unusable, so the caller shows the preset as
 * unavailable rather than applying a court at the origin.
 */
export function scaleCorners(
  corners: CourtCorners,
  from: { width: number; height: number },
  to: { width: number; height: number }
): CourtCorners | null {
  if (!(from.width > 0 && from.height > 0 && to.width > 0 && to.height > 0)) return null;
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  const out = {} as CourtCorners;
  for (const k of CORNER_KEYS) {
    const [x, y] = corners[k];
    // Rounded to whole pixels: the setup screen works in integer image
    // coordinates, and a corner at x=643.0000001 would render identically
    // while making every stored preset compare unequal to itself.
    out[k] = [Math.round(x * sx), Math.round(y * sy)];
  }
  return out;
}

function fromRow(row: Record<string, unknown>): CourtPreset | null {
  if (!isCourtCorners(row.corners)) return null;
  return {
    id: String(row.id),
    name: String(row.name),
    corners: row.corners,
    frameWidthPx: Number(row.frame_width_px),
    frameHeightPx: Number(row.frame_height_px),
    lineColorHex: normaliseLineColor(row.line_color_hex as string | null),
    matchMode: row.match_mode === "singles" ? "singles" : "doubles",
    lastUsedAt: (row.last_used_at as string | null) ?? null,
  };
}

/** Most recently used first — people play at the same place repeatedly. */
export async function listCourtPresets(
  supabase: SupabaseClient,
  userId: string
): Promise<CourtPreset[]> {
  const { data, error } = await supabase
    .from("court_presets")
    .select("*")
    .eq("user_id", userId)
    .order("last_used_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  // A malformed row is skipped, not thrown on: one bad preset must not make
  // the picker unopenable and hide the user's other, working courts.
  return (data ?? []).map(fromRow).filter((p): p is CourtPreset => p !== null);
}

export async function saveCourtPreset(
  supabase: SupabaseClient,
  userId: string,
  preset: Omit<CourtPreset, "id" | "lastUsedAt">
): Promise<CourtPreset> {
  const { data, error } = await supabase
    .from("court_presets")
    .upsert(
      {
        user_id: userId,
        name: preset.name.trim(),
        corners: preset.corners,
        frame_width_px: preset.frameWidthPx,
        frame_height_px: preset.frameHeightPx,
        line_color_hex: preset.lineColorHex,
        match_mode: preset.matchMode,
        last_used_at: new Date().toISOString(),
      },
      // Re-saving a name overwrites that court rather than erroring or making
      // a second one: "save" on a court you already have means the camera
      // moved and these corners are the better ones.
      { onConflict: "user_id,name" }
    )
    .select()
    .single();
  if (error) throw error;
  const out = fromRow(data as Record<string, unknown>);
  if (!out) throw new Error("Saved preset came back in a shape this build cannot read.");
  return out;
}

export async function touchCourtPreset(
  supabase: SupabaseClient,
  userId: string,
  id: string
): Promise<void> {
  // Best-effort: failing to update an ordering hint must not fail the setup
  // the user actually came here to do.
  await supabase
    .from("court_presets")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId);
}

export async function deleteCourtPreset(
  supabase: SupabaseClient,
  userId: string,
  id: string
): Promise<void> {
  const { error } = await supabase
    .from("court_presets").delete().eq("id", id).eq("user_id", userId);
  if (error) throw error;
}
