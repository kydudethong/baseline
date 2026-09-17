/**
 * Pre-analysis setup: what the user tells us before the pipeline runs.
 *
 * Deliberately small and explicit. Everything here is something a person can
 * settle in seconds and the CV layer cannot reliably work out alone -- where
 * the court is, and which of the people on screen are playing.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface SetupPoint {
  /** Image pixels, in the frame the user was looking at. */
  x: number;
  y: number;
}

export interface SetupPlayer extends SetupPoint {
  /** Where this player's feet were on the setup frame. */
  isSelf: boolean;
  label?: string;
}

/**
 * How many people are on court. Pickleball singles and doubles are played on
 * the SAME 20x44 court, with the same lines -- there is no singles sideline as
 * there is in tennis -- so this says nothing about geometry. What it says is
 * how many players the tracker should expect, which is the whole of its job.
 */
export type MatchMode = "singles" | "doubles";

export function playersForMode(mode: MatchMode | null | undefined): number {
  return mode === "singles" ? 2 : 4;
}

/** `#rrggbb`, lowercase. Anything else is not a colour we will pass along. */
const HEX_RE = /^#[0-9a-f]{6}$/;

/**
 * A line colour, normalised, or null.
 *
 * Null means white, which is what the fitter assumes with nothing set. Bad
 * input becomes null rather than an error: a colour is a hint, and losing the
 * hint should cost the run its hint, not the run.
 */
export function normaliseLineColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let s = value.trim().toLowerCase();
  if (!s) return null;
  if (!s.startsWith("#")) s = `#${s}`;
  if (/^#[0-9a-f]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return HEX_RE.test(s) ? s : null;
}

export interface PreAnalysisSetup {
  /** Which frame the user clicked on — every coordinate below is in its space. */
  frameTimestampSeconds: number;
  frameWidthPx: number;
  frameHeightPx: number;
  /**
   * Court corners on the painted lines. "near" is the baseline closest to the
   * camera. When the far baseline is hidden behind the net, the user marks
   * where the net meets each sideline instead and sets quadKind to near-half.
   */
  court: {
    nearLeft: SetupPoint;
    nearRight: SetupPoint;
    farRight: SetupPoint;
    farLeft: SetupPoint;
    quadKind: "full" | "near-half";
  } | null;
  /** Feet positions of the people to track. Anyone else is ignored. */
  players: SetupPlayer[];
  /**
   * The colour of the painted lines, sampled off this frame by the user.
   *
   * Null means white, which is what the fitter assumes on its own. It is
   * sampled rather than named because paint fades, gyms are lit green, and a
   * phone white-balances the whole frame -- so the "yellow" line in the
   * footage is frequently nothing a colour picker would call yellow, and a
   * preset would be confidently wrong where a sampled pixel is simply right.
   */
  lineColorHex: string | null;
  /** Singles or doubles. See MatchMode: this is a player count, not geometry. */
  matchMode: MatchMode;
  savedAt: string;
}

/**
 * The rally_seg config overrides this setup implies, as dotted key/value
 * pairs ready for `--set`.
 *
 * Only what the user actually chose. An unset line colour must not become
 * `court.line_color_hex=` -- an empty override still takes the colour path
 * and would break the white default it is meant to preserve.
 */
export function rallySegOverridesForSetup(
  setup: PreAnalysisSetup | null
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (!setup) return out;
  const colour = normaliseLineColor(setup.lineColorHex);
  if (colour) out.push(["court.line_color_hex", colour]);
  if (setup.matchMode === "singles") out.push(["players.max_players", "2"]);
  return out;
}

/**
 * Whether this setup is enough to run an analysis on.
 *
 * A COURT, AND NOTHING ELSE. It used to also require marked players, which
 * stopped being a sensible bar when the players moved to after the analysis --
 * they are found by the pipeline now and tagged over its own boxes, so
 * demanding them up front would block every run on a question nobody is asked
 * any more. An older saved setup still carries a players array; it is ignored.
 *
 * The court is required, though, and that IS new. It was optional while the
 * pipeline detected its own; with court detection gone, an analysis without
 * one produces no distance, no kitchen-line time and no zones -- and, worse,
 * a court marked in the wrong place produces all three, wrong, with nothing
 * downstream able to tell. Hence a gate.
 */
export function isCompleteSetup(s: PreAnalysisSetup | null): boolean {
  return Boolean(s && s.court);
}

export async function getSetup(
  supabase: SupabaseClient,
  analysisId: string
): Promise<PreAnalysisSetup | null> {
  const { data, error } = await supabase
    .from("analyses")
    .select("pre_analysis_setup")
    .eq("id", analysisId)
    .maybeSingle();
  if (error || !data) return null;
  const raw = (data.pre_analysis_setup as Partial<PreAnalysisSetup> | null) ?? null;
  if (!raw) return null;
  // Rows saved before line colour and match mode existed have neither field.
  // The column is JSONB, so nothing migrated them and nothing will -- filling
  // the defaults on read is what keeps every caller from having to remember
  // that `matchMode` is sometimes undefined despite what the type says.
  return {
    ...raw,
    lineColorHex: normaliseLineColor(raw.lineColorHex),
    matchMode: raw.matchMode === "singles" ? "singles" : "doubles",
    players: Array.isArray(raw.players) ? raw.players : [],
  } as PreAnalysisSetup;
}

export async function saveSetup(
  supabase: SupabaseClient,
  analysisId: string,
  setup: PreAnalysisSetup
): Promise<void> {
  const { error } = await supabase
    .from("analyses")
    .update({ pre_analysis_setup: setup })
    .eq("id", analysisId);
  if (error) throw new Error(`Could not save setup: ${error.message}`);
}

/**
 * The court, in the shape rally_seg wants.
 *
 * Corner order differs: this app names corners by where they are relative to
 * the camera, rally_seg starts at the near baseline and goes round.
 */
export function setupCourtForRallySeg(setup: PreAnalysisSetup | null): object | null {
  const c = setup?.court;
  if (!c) return null;
  return {
    corners_px: [
      [c.nearLeft.x, c.nearLeft.y],
      [c.nearRight.x, c.nearRight.y],
      [c.farRight.x, c.farRight.y],
      [c.farLeft.x, c.farLeft.y],
    ],
    extent: c.quadKind === "full" ? "full" : "near_half",
    image_size: [setup!.frameWidthPx, setup!.frameHeightPx],
  };
}


/* -------------------------------------------------------------------------
 * Matching what the user clicked to what the tracker found.
 * ------------------------------------------------------------------------- */

interface TrackLike {
  playerId: string;
  points: Array<{
    timestampSeconds: number;
    boxImageNorm: { x: number; y: number; width: number; height: number };
  }>;
}

export interface SetupTrackMatch<T extends TrackLike> {
  /** Every track. Retained in the shape for callers; nothing is dropped here. */
  keep: T[];
  /** playerId of the track the user marked as themselves, if they marked one. */
  selfPlayerId: string | null;
  droppedCount: number;
}

/**
 * Work out which tracked player is the user. Every track is kept.
 *
 * Matched on feet, at the frame the user was looking at: a person's feet are
 * the only part of them on the court plane, and that is where the user clicked.
 * Each seed claims its nearest track, and each track can only be claimed once,
 * so two seeds cannot collapse onto the same person.
 *
 * The tolerance scales with the matched track's own box height rather than
 * being a fixed pixel distance, because a player at the far baseline is a
 * fraction of the size of one near the camera, and a distance that is generous
 * up close is impossibly strict at range.
 */
export function matchTracksToSetup<T extends TrackLike>(
  tracks: T[],
  setup: PreAnalysisSetup | null,
  toleranceInHeights = 1.25
): SetupTrackMatch<T> {
  // Always hand back a NEW array, never the caller's own. Returning the same
  // reference makes `keep` an alias for `tracks`, and any caller that clears
  // `tracks` to replace its contents then finds `keep` empty too.
  if (!setup || setup.players.length === 0 || tracks.length === 0) {
    return { keep: [...tracks], selfPlayerId: null, droppedCount: 0 };
  }

  const t0 = setup.frameTimestampSeconds;
  const feetAt = (track: T): { x: number; y: number; h: number } | null => {
    let best: TrackLike["points"][number] | null = null;
    let bestDt = Infinity;
    for (const p of track.points) {
      const dt = Math.abs(p.timestampSeconds - t0);
      if (dt < bestDt) { bestDt = dt; best = p; }
    }
    // A track that is nowhere near the setup frame cannot be matched against
    // it; those are kept only if nothing else claims their slot.
    if (!best || bestDt > 2.0) return null;
    const b = best.boxImageNorm;
    return { x: (b.x + b.width / 2) * setup.frameWidthPx, y: (b.y + b.height) * setup.frameHeightPx,
             h: b.height * setup.frameHeightPx };
  };

  const positions = new Map<string, { x: number; y: number; h: number }>();
  for (const t of tracks) {
    const f = feetAt(t);
    if (f) positions.set(t.playerId, f);
  }

  // The seeds identify you. They do not decide who gets tracked.
  //
  // This filtered by default and it was wrong twice over. First attempt tied
  // filtering to "did the user mark two or more people", which reads as
  // deliberate intent -- except the setup page *seeds every detected player
  // automatically*, so four marks means the detector found four people, not
  // that the user asked for exactly those four. Measured on a real clip: the
  // tracker produced 4 tracks, 3 of the 4 seeds failed to match, and the run
  // kept 1 track. One player is not a doubles analysis. Worse, hits are
  // attributed to whichever player is nearest the ball, so throwing away three
  // players took the rallies with them.
  //
  // Filtering was never the right job for this anyway. Spectators, the queue
  // behind the fence and the next court over are excluded by the court gate
  // upstream, which tests court geometry rather than a person's guess at
  // where someone stood on one frame -- and on the same clip it correctly
  // dropped 51 off-court detections without any help from here.
  //
  // So: match seeds to tracks, use the match to answer "which one is you",
  // and keep every track either way.

  const claimed = new Map<string, boolean>();
  const keepIds = new Set<string>();
  let selfPlayerId: string | null = null;

  // Closest pair first, so a confident match is never stolen by a marginal one.
  const pairs: Array<{ d: number; seed: number; id: string }> = [];
  setup.players.forEach((seed, si) => {
    for (const [id, f] of positions) {
      const d = Math.hypot(f.x - seed.x, f.y - seed.y);
      if (d <= f.h * toleranceInHeights) pairs.push({ d, seed: si, id });
    }
  });
  pairs.sort((a, b) => a.d - b.d);

  const usedSeeds = new Set<number>();
  for (const { seed, id } of pairs) {
    if (usedSeeds.has(seed) || claimed.get(id)) continue;
    usedSeeds.add(seed);
    claimed.set(id, true);
    keepIds.add(id);
    if (setup.players[seed].isSelf) selfPlayerId = id;
  }

  // Nothing matched at all: the user's frame and the tracks disagree badly
  // enough that filtering would be guesswork. Keep everything and let the
  // caller report it, rather than silently returning an empty court.
  if (keepIds.size === 0) {
    return { keep: [...tracks], selfPlayerId: null, droppedCount: 0 };
  }

  return { keep: [...tracks], selfPlayerId, droppedCount: 0 };
}
