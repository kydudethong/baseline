"use client";

/**
 * Court and player setup, done on a real frame of the user's own video.
 *
 * The video streams from a signed URL and everything is drawn in the browser,
 * so scrubbing costs nothing and the coordinates the user clicks are already in
 * the video's own pixel space.
 *
 * The frame is chosen for them. Hunting through a clip for the moment all four
 * players are on court and none is stood in front of another is a chore, and it
 * is one a detector can do exhaustively over the whole video in less time than
 * it takes to explain -- so the page opens by asking the server for that frame,
 * with the court already fitted and the players already located. What is left
 * is the part only a person can do: saying which of them is you, and correcting
 * anything the fit got wrong.
 *
 * Two things are being captured, and both are things a person settles in
 * seconds that the CV layer cannot reliably settle at all:
 *
 *   Court    Automatic fitting is genuinely hard from a low camera behind the
 *            baseline -- the far half is often hidden by the net, neighbouring
 *            courts contribute their own lines, and a wrong homography is worse
 *            than none because it corrupts every out-of-bounds call while still
 *            reporting a confident number.
 *   Players  Public courts come with spectators, a queue behind the fence, and
 *            two more games either side.
 */

import { CornerGuide } from "./CornerGuide";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";


import { computeHomography, applyHomography } from "@/lib/vision/homography";
import { courtSegments, type CourtLineRole } from "@/lib/vision/court-model";
import { playersForMode, type MatchMode } from "@/lib/db/setup";
import { SetupExamples } from "./SetupExamples";

type Corner = { x: number; y: number };
/**
 * `x`/`y` are the player's feet -- the only part of a person on the court
 * plane, and what the tracker matches against. `box` is the detector's
 * bounding box when one exists, kept purely so the click target can be the
 * whole person rather than a dot at their shoes.
 */
type Player = { x: number; y: number; isSelf: boolean; box?: [number, number, number, number] };
/**
 * MARK THE PEOPLE, THEN SAY WHICH ONE IS YOU.
 *
 * These were one stage, and the click did both jobs: land on somebody and it
 * toggled "this is me", land on empty court and it added a marker. Two
 * different intentions on one gesture, told apart by what happened to be under
 * the cursor -- so a slightly-off click aimed at yourself silently added a
 * fifth player instead.
 *
 * Separated, each stage has one meaning for a click and the step bar can say
 * which one you are in.
 *
 * "line-colour" is gone. It asked the user to sample their court's paint so the
 * automatic fitter could look for it -- a real problem, explained in a
 * paragraph, solved by a step most people skipped. The corners are marked by
 * hand anyway when the fit is wrong, which is the same fix with nothing to
 * read.
 */
type Stage = "court" | "players" | "self";

/** Everything undo restores. Small enough to copy on every change. */
interface Snapshot { corners: Corner[]; players: Player[] }

/**
 * Blank margin drawn around the video, as a fraction of its short side.
 *
 * A corner of the court is often OUTSIDE the frame -- a phone on a fence
 * catches three sidelines and loses the fourth, and the far baseline goes
 * missing constantly. Without a margin there was physically nowhere to click
 * for those corners: the canvas was exactly the video's size, so the court
 * could only ever be marked as small as the frame, which is a court that does
 * not exist.
 *
 * The geometry has no such limit. A homography is happy with corners at
 * negative coordinates or past the frame edge -- the four points define a
 * plane, and whether the camera happened to capture all four of them is
 * irrelevant to the maths. The only thing that was missing was somewhere to
 * put the cursor.
 *
 * Coordinates stay in VIDEO pixel space throughout: a point in the left
 * margin is simply negative x. Nothing downstream needs to change, and
 * frameWidthPx/frameHeightPx keep meaning the video, not the canvas.
 */
const PAD_FRAC = 0.18;

const CORNER_STEPS = [
  { key: "nearLeft", label: "Near-left corner", hint: "baseline closest to the camera, left side" },
  { key: "nearRight", label: "Near-right corner", hint: "same baseline, right side" },
  { key: "farRight", label: "Far-right corner", hint: "far baseline — or where the net meets the right sideline" },
  { key: "farLeft", label: "Far-left corner", hint: "far baseline, left side" },
] as const;

// Court in feet. Same numbers the Python side uses; a pickleball court is 20
// by 44 with a 7ft non-volley zone each side of the net.
const COURT_W = 20;
const COURT_L = 44;
const NET_Y = 22;

export interface SetupCourt {
  nearLeft: Corner;
  nearRight: Corner;
  farRight: Corner;
  farLeft: Corner;
  quadKind: "full" | "near-half";
}

interface AutoPlayer {
  boxPx: [number, number, number, number];
  feetPx: [number, number];
  confidence: number;
  side: "near" | "far" | null;
}

interface AutoSetup {
  frameUrl: string | null;
  frame: {
    timestampSeconds: number;
    detector: string;
    playersReliable: boolean;
    playersOffCourt?: number;
    courtGated?: boolean;
  } | null;
  players: AutoPlayer[];
  court: {
    corners: { topLeft: [number, number]; topRight: [number, number]; bottomLeft: [number, number]; bottomRight: [number, number] };
    quadKind: "full" | "near-half";
    confidence: number;
  } | null;
  courtReason: string | null;
  imageSize: [number, number];
}

export interface SetupCanvasProps {
  analysisId: string;
  videoUrl: string;
  initial: {
    frameTimestampSeconds: number;
    court: SetupCourt | null;
    players: Player[];
    lineColorHex?: string | null;
    matchMode?: MatchMode;
  } | null;
  /**
   * Rendered inside the upload flow rather than on its own page. The canvas
   * stops owning navigation and hands control back, so the uploader can keep
   * one continuous "upload → confirm → analyse" without a page change in the
   * middle of it.
   */
  embedded?: boolean;
  onSaved?: (didStartAnalysis: boolean) => void;
}

export default function SetupCanvas({ analysisId, videoUrl, initial, embedded, onSaved }: SetupCanvasProps) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // PLAYERS FIRST, then the court.
  //
  // The old order asked for four court corners before anything else, which is
  // the harder of the two tasks and the one with no obvious right answer the
  // first time -- people hesitated over which corner counts as "near-left" and
  // whether to click the outside or inside of the line. Tagging yourself is
  // unambiguous by comparison: you click the person who is you. Doing the easy
  // one first means the frame is already familiar by the time the corners are
  // asked for, and somebody who bounces has at least told us the thing only
  // they can know.
  const [stage, setStage] = useState<Stage>("players");
  // Declared up here with the rest of the canvas state, because undo/redo
  // below need to cancel an in-flight corner drag.
  const [dragging, setDragging] = useState<number | null>(null);
  const [corners, setCorners] = useState<Corner[]>(() => {
    const c = initial?.court;
    return c ? [c.nearLeft, c.nearRight, c.farRight, c.farLeft].filter(Boolean) : [];
  });
  const [players, setPlayers] = useState<Player[]>(initial?.players ?? []);
  const [quadKind, setQuadKind] = useState<"full" | "near-half">(
    initial?.court?.quadKind ?? "full"
  );
  const [videoReady, setVideoReady] = useState(false);
  // The margin the canvas adds around the video, as a fraction of the canvas
  // width. Needed in CSS space to work out what "show the video, and nothing
  // else" means; stored rather than read off the ref because a ref cannot be
  // read during render.
  const [frameInset, setFrameInset] = useState(0);

  // UNDO AND REDO over the two things a click can change.
  //
  // Snapshots rather than inverse operations. The state being tracked is two
  // small arrays, so a snapshot costs nothing to take and nothing to reason
  // about -- where "undo an add" versus "undo a drag" versus "undo a
  // self-toggle" is three inverses to write and three to get wrong. The
  // failure this prevents is the one that makes people abandon the screen:
  // four corners placed, a mis-click on the fourth, and no way back except
  // starting over.
  // State rather than refs: `canUndo` has to be readable while rendering, to
  // grey out a button, and a ref cannot be.
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);

  /** Record the state BEFORE a change. Every mutating handler calls this first. */
  const commit = useCallback(() => {
    setPast((h) => [...h.slice(-49), { corners, players }]);
    setFuture([]);
  }, [corners, players]);

  const undo = useCallback(() => {
    setPast((h) => {
      const prev = h[h.length - 1];
      if (!prev) return h;
      setFuture((f) => [...f, { corners, players }]);
      setCorners(prev.corners);
      setPlayers(prev.players);
      setDragging(null);
      return h.slice(0, -1);
    });
  }, [corners, players]);

  const redo = useCallback(() => {
    setFuture((f) => {
      const next = f[f.length - 1];
      if (!next) return f;
      setPast((h) => [...h, { corners, players }]);
      setCorners(next.corners);
      setPlayers(next.players);
      setDragging(null);
      return f.slice(0, -1);
    });
  }, [corners, players]);

  const canUndo = past.length > 0;
  const canRedo = future.length > 0;

  const clearCourt = useCallback(() => { commit(); setCorners([]); setStage("court"); }, [commit]);
  const clearPlayers = useCallback(() => { commit(); setPlayers([]); setStage("players"); }, [commit]);

  // ZOOM AND PAN, for the two clicks this screen exists to collect.
  //
  // The far pair of players are a couple of hundred pixels tall in a 1080p
  // frame, shown in a box a few hundred CSS pixels wide -- so "click the one
  // that is you" can come down to a target the size of a fingernail, and the
  // far court corners are worse because they sit on a line a pixel or two
  // wide. Getting those right is the whole job of this screen, and everything
  // downstream is built on them.
  //
  // Implemented as a CSS transform on the canvas rather than as a redraw at a
  // different scale. toImage() already maps a cursor position through
  // getBoundingClientRect(), which reports the TRANSFORMED box, so every hit
  // test and drag keeps working with no arithmetic changed -- and the grab
  // radius, derived from the same ratio, shrinks with the zoom exactly as it
  // should.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Panning has to be a MODE rather than a drag-on-empty-space, because a
  // drag on empty space already means something here: it places a corner or a
  // player. Guessing between them would make both feel unreliable.
  const [panMode, setPanMode] = useState(false);
  const panFrom = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  /**
   * Live pointers, by id.
   *
   * POINTER EVENTS RATHER THAN MOUSE EVENTS, and this screen is the reason it
   * matters more here than anywhere else in the app. A phone synthesises a
   * click from a tap, so PLACING a corner worked -- but a browser claims a
   * drag for scrolling long before the canvas sees it, so DRAGGING a corner to
   * nudge it, which is the whole repair mechanism when the fit is slightly
   * off, silently did nothing on a phone. One code path now covers mouse,
   * touch and stylus.
   *
   * Two entries means a pinch, which is the only sensible way to zoom on a
   * phone -- there is no wheel, and the far court corners are the exact thing
   * you need to zoom in on.
   */
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  /** Distance and midpoint between two fingers when the pinch began. */
  const pinchFrom = useRef<{ dist: number; zoom: number; midX: number; midY: number } | null>(null);
  /** Where a press started, to tell a tap from a drag. */
  const pressFrom = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  // Mirrored in state purely so the cursor can change: a ref cannot be read
  // during render, and "grab" vs "grabbing" is the only feedback that the
  // drag was picked up.
  const [panning, setPanning] = useState(false);
  const frameBoxRef = useRef<HTMLDivElement | null>(null);

  const MAX_ZOOM = 6;

  // ZOOM 1 IS THE VIDEO, NOT THE CANVAS.
  //
  // The canvas is deliberately larger than the video -- PAD_FRAC of margin on
  // every side -- so that a court corner the camera did not capture can still
  // be clicked, out past the dashed edge. That margin was always on screen,
  // which meant the setup screen opened on a letterboxed, slightly shrunken
  // version of the user's own footage, and the first impression of the product
  // was a picture that looked wrong.
  //
  // So the default view fills the box with the VIDEO, and the margin is what
  // zooming out reveals -- which is exactly when it is wanted, and only then.
  const baseScale = frameInset > 0 ? 1 / (1 - 2 * frameInset) : 1;
  // Below this there is nothing further to show: the whole padded canvas fits.
  const MIN_ZOOM = frameInset > 0 ? 1 - 2 * frameInset : 1;

  /** Keeps the frame from being dragged off its own window. */
  const clampPan = useCallback((p: { x: number; y: number }, z: number) => {
    const box = frameBoxRef.current;
    if (!box) return p;
    // The canvas's drawn size at this zoom. `base` is what makes the VIDEO,
    // rather than the padded canvas, fill the box at zoom 1.
    const base = frameInset > 0 ? 1 / (1 - 2 * frameInset) : 1;
    const w = box.clientWidth, h = box.clientHeight;
    const drawnW = w * base * z, drawnH = h * base * z;
    // Bigger than the box: keep it covering the box. Smaller (zoomed out past
    // the fill point, to see the margin): centre it, because a picture
    // floating against one edge reads as a bug.
    const spanX = drawnW >= w ? { lo: w - drawnW, hi: 0 } : { lo: (w - drawnW) / 2, hi: (w - drawnW) / 2 };
    const spanY = drawnH >= h ? { lo: h - drawnH, hi: 0 } : { lo: (h - drawnH) / 2, hi: (h - drawnH) / 2 };
    return {
      x: Math.max(spanX.lo, Math.min(spanX.hi, p.x)),
      y: Math.max(spanY.lo, Math.min(spanY.hi, p.y)),
    };
  }, [frameInset]);

  /** Zoom about a point in BOX coordinates, so the pixel under the cursor stays put. */
  const zoomAbout = useCallback((nextZoom: number, boxX: number, boxY: number) => {
    setZoom((z) => {
      const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
      setPan((p) => {
        // The image point under the cursor before the zoom must be under it
        // after: solve (boxX - p.x) / z === (boxX - p'.x) / nz.
        const next = {
          x: boxX - ((boxX - p.x) * nz) / z,
          y: boxY - ((boxY - p.y) * nz) / z,
        };
        return clampPan(next, nz);
      });
      return nz;
    });
  }, [clampPan, MIN_ZOOM]);

  const onWheel = useCallback((ev: React.WheelEvent<HTMLDivElement>) => {
    const box = frameBoxRef.current;
    if (!box) return;
    ev.preventDefault();
    const r = box.getBoundingClientRect();
    zoomAbout(zoom * (ev.deltaY < 0 ? 1.15 : 1 / 1.15), ev.clientX - r.left, ev.clientY - r.top);
  }, [zoom, zoomAbout]);

  const resetView = useCallback(() => {
    setZoom(1);
    setPanMode(false);
    // At zoom 1 the video exactly fills the box, so the margin on each side is
    // scrolled off: the left edge of the VIDEO sits at the left of the box.
    const box = frameBoxRef.current;
    // BOTH OFFSETS COME FROM THE WIDTH, and the reason is worth stating
    // because using the height looked obviously right and was wrong.
    //
    // The margin is the same number of CANVAS pixels on every side, and the
    // canvas is scaled uniformly, so the margin is the same number of SCREEN
    // pixels on every side too. The box's height is not that number -- it is
    // shorter than its width on a landscape frame, so a y offset derived from
    // it was too small, and the top band of margin stayed on screen while the
    // bottom of the video was cropped away under it.
    const w = box?.clientWidth ?? 0;
    const base = frameInset > 0 ? 1 / (1 - 2 * frameInset) : 1;
    const offset = -frameInset * w * base;
    setPan({ x: offset, y: offset });
  }, [frameInset]);

  // The correction panel. Closed by default: the common case is that the
  // detection is right and the whole job is one click, so the tools for when
  // it is wrong should be one click away rather than always on screen.
  const [fixing, setFixing] = useState(false);
  const [time, setTime] = useState(initial?.frameTimestampSeconds ?? 0);
  const [duration, setDuration] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [autoNote, setAutoNote] = useState<string | null>(null);
  const [showLines, setShowLines] = useState(true);
  /**
   * The colour of the painted lines, sampled off this frame.
   *
   * Null means white, which is what the fitter assumes anyway -- so a user on
   * a normal court never has to touch this. It exists for the courts where
   * the lines are blue, yellow or black, where the fitter previously could
   * not see them at all: its mask tested for "bright and unsaturated", which
   * excludes a coloured line by construction rather than by degree, so no
   * amount of retrying or threshold-nudging would ever have found one.
   */
  // The court fitter can still be TOLD a line colour -- the API takes one, and
  // a saved preset may carry one -- but nothing asks the user for it any more.
  // The step explained a real problem (the fitter looks for white paint) in a
  // paragraph, and was solved for everybody by marking the corners themselves,
  // which is the same fix with nothing to read.
  const lineColor: string | null = initial?.lineColorHex ?? null;
  const [matchMode, setMatchMode] = useState<MatchMode>(initial?.matchMode ?? "doubles");

  /* ---------------------------------------------------------------------
   * Finding the frame.
   * ------------------------------------------------------------------- */

  const findFrame = useCallback(async (colour?: string | null) => {
    setAuto("running");
    setAutoNote(null);
    setError(null);
    try {
      // The colour goes to the server, not just into the saved setup. A court
      // that would not fit against white paint gets a second attempt against
      // the colour actually on the ground -- which is the only way picking one
      // can help before the analysis runs.
      const res = await fetch(`/api/analyses/${analysisId}/setup-frame`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineColorHex: colour ?? null }),
      });
      const json = (await res.json()) as AutoSetup & { error?: string };
      if (!res.ok) {
        setAuto("failed");
        setAutoNote(json.error ?? "The frame finder could not run.");
        return;
      }

      if (json.frame) {
        setTime(json.frame.timestampSeconds);
        const v = videoRef.current;
        if (v) v.currentTime = json.frame.timestampSeconds;
      }

      // Everything below arrives in the space the SERVER measured in, which is
      // not necessarily the canvas's. rally_seg caps its long side at 1280, and
      // the route can only pass the video's true size once processing has
      // recorded it -- on a fresh upload those columns are still null, so the
      // server falls back to its own downscaled frame. Painting 1280-space
      // coordinates onto a 1920-wide canvas squashes the whole overlay into
      // two-thirds of the frame, and saving it stamps confidence 1.0 on a
      // court that outranks every detector.
      const v = videoRef.current;
      const cw = v?.videoWidth || 0;
      const ch = v?.videoHeight || 0;
      const src = json.imageSize;
      const sx = src && src[0] > 0 && cw > 0 ? cw / src[0] : 1;
      const sy = src && src[1] > 0 && ch > 0 ? ch / src[1] : 1;
      const at = (p: [number, number]): Corner => ({ x: p[0] * sx, y: p[1] * sy });

      if (json.court) {
        const c = json.court.corners;
        setCorners([at(c.bottomLeft), at(c.bottomRight), at(c.topRight), at(c.topLeft)]);
        setQuadKind(json.court.quadKind);
      }
      // Detected players are seeded as tracked, but never as "you" -- that is
      // the one thing here nothing but the user can know, and pre-selecting a
      // guess would get confirmed without being read.
      if (json.players.length > 0 && json.frame?.playersReliable !== false) {
        setPlayers(json.players.map((p) => ({
          x: p.feetPx[0] * sx, y: p.feetPx[1] * sy, isSelf: false,
          box: [p.boxPx[0] * sx, p.boxPx[1] * sy, p.boxPx[2] * sx, p.boxPx[3] * sy] as
            [number, number, number, number],
        })));
        setStage("players");
      }

      const bits: string[] = [];
      if (json.frame) bits.push(`Frame at ${json.frame.timestampSeconds.toFixed(1)}s.`);
      if (json.court) bits.push(`Court fitted (${(json.court.confidence * 100).toFixed(0)}% line support) — drag any corner to correct it.`);
      else if (json.courtReason) bits.push(`Court not fitted: ${json.courtReason}`);
      if (json.frame?.playersReliable === false) {
        bits.push("No usable player detector here, so click the players yourself.");
      } else if (json.players.length) {
        bits.push(`${json.players.length} player${json.players.length === 1 ? "" : "s"} found — click the one that is you.`);
        // Say what the court gate did. Silence here is ambiguous in a way
        // that matters: "4 players" reads the same whether nobody else was in
        // frame or six spectators were correctly ignored, and only one of
        // those two means the court is right.
        const off = json.frame?.playersOffCourt ?? 0;
        if (json.frame?.courtGated && off > 0) {
          bits.push(`${off} more ${off === 1 ? "person was" : "people were"} ignored for standing off court.`);
        } else if (json.frame?.courtGated === false) {
          bits.push("No court was fitted, so nobody could be ruled out for standing off it — expect spectators in the list.");
        }
      }
      setAutoNote(bits.join(" "));
      setAuto("done");
    } catch (err) {
      setAuto("failed");
      setAutoNote((err as Error).message);
    }
  }, [analysisId]);

  // Run once on a fresh setup. If the user already saved one, their marks win
  // and re-running would quietly overwrite them.
  const startedRef = useRef(false);
  useEffect(() => {
    // Wait for the video's real dimensions: the rescale above is meaningless
    // until videoWidth/videoHeight are known, and running early would place
    // every corner in the wrong space.
    if (startedRef.current || initial || !videoReady) return;
    startedRef.current = true;
    // No colour on this path by construction: it only runs when there is no
    // saved setup, so nothing has been sampled yet. The first pass looks for
    // white, and the user picks a colour only if that comes back empty.
    void findFrame(null);
  }, [findFrame, initial, videoReady]);

  /* ---------------------------------------------------------------------
   * Drawing.
   * ------------------------------------------------------------------- */

  /**
   * How tall a person standing here would be, in pixels.
   *
   * Taken from the court itself: six feet, measured at that spot through the
   * same homography the overlay is drawn with, so it shrinks correctly with
   * distance -- a player at the far baseline is a fraction of the size of one
   * near the camera, and a fixed pixel height would be absurd at one end or
   * the other. Falls back to a share of the frame when there is no court yet.
   */
  const personHeightPx = useCallback((feetX: number, feetY: number): number => {
    // The VIDEO's height, not the canvas's. The canvas carries a margin on
    // every side now, so reading its height here would inflate the fallback
    // player box by the padding -- roughly a third too tall.
    const frameH = videoRef.current?.videoHeight || 720;
    if (corners.length === 4) {
      const farY = quadKind === "near-half" ? NET_Y : COURT_L;
      const toCourt = computeHomography(
        [
          [corners[0].x, corners[0].y], [corners[1].x, corners[1].y],
          [corners[2].x, corners[2].y], [corners[3].x, corners[3].y],
        ],
        [[0, 0], [COURT_W, 0], [COURT_W, farY], [0, farY]]
      );
      const toImage = computeHomography(
        [[0, 0], [COURT_W, 0], [COURT_W, farY], [0, farY]],
        [
          [corners[0].x, corners[0].y], [corners[1].x, corners[1].y],
          [corners[2].x, corners[2].y], [corners[3].x, corners[3].y],
        ]
      );
      if (toCourt && toImage) {
        const [cx, cy] = applyHomography(toCourt, [feetX, feetY]);
        if (Number.isFinite(cx) && Number.isFinite(cy)) {
          const a = applyHomography(toImage, [cx, cy]);
          const b = applyHomography(toImage, [Math.min(cx + 1, COURT_W), cy]);
          const pxPerFt = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (Number.isFinite(pxPerFt) && pxPerFt > 0.5) {
            return Math.max(24, Math.min(frameH * 0.9, pxPerFt * 6));
          }
        }
      }
    }
    return frameH * 0.14;
  }, [corners, quadKind]);

  /**
   * Sample the line colour from the pixel the user clicked.
   *
   * Read from the RAW video frame, never from the canvas. The canvas has the
   * court overlay painted on top of it, so a click on a guide line would
   * sample OUR blue rather than the paint underneath -- and the fitter would
   * then be told to look for the colour of its own overlay.
   */

  /** The rectangle that represents this player on screen, box or not. */
  const playerRect = useCallback((q: Player): [number, number, number, number] => {
    if (q.box) return q.box;
    const h = personHeightPx(q.x, q.y);
    const w = h * 0.42;
    return [q.x - w / 2, q.y - h, q.x + w / 2, q.y];
  }, [personHeightPx]);

  /**
   * The court's own lines, projected from the four corners.
   *
   * Recomputed from whatever the corners currently are, so dragging a corner
   * moves the kitchen line and the net with it. That live feedback is the whole
   * point: four dots on a picture tell you nothing about whether the geometry
   * is right, but a kitchen line that lands on the painted kitchen line tells
   * you immediately.
   */
  // Colours live here, geometry lives in court-model.ts. Both editors project
  // the same segments; only the palette differs.
  /**
   * Line weights for the marked court.
   *
   * Thicker than they were, and deliberately not uniform. These are drawn over
   * real footage of a real court, so a thin stroke competes with the painted
   * line underneath it -- on a blue court the two are close enough in
   * luminance that a 1.4px line reads as a smudge rather than a boundary, and
   * the whole point of this view is checking that the marked court sits on the
   * real one.
   *
   * The hierarchy is kept: the boundary and the net are what somebody is
   * checking, the kitchen and centre lines are confirmation that the rest
   * followed correctly. Drawing all five at one weight would make the picture
   * busier without making the important lines any easier to find.
   */
  const ROLE_STYLE: Record<CourtLineRole, [string, number]> = {
    boundary: ["#3aa0ff", 3.5],
    kitchen: ["#3aa0ff", 2.4],
    centre: ["#3aa0ff", 2.4],
    net: ["#ff43c8", 3.5],
    "net-post": ["#ff43c8", 3],
  };

  const courtLines = useCallback((): Array<[[number, number], [number, number], string, number]> => {
    return courtSegments(corners, quadKind).map((seg) => {
      const [colour, width] = ROLE_STYLE[seg.role];
      return [seg.a, seg.b, colour, width] as [[number, number], [number, number], string, number];
    });
    // ROLE_STYLE is a constant literal; corners/quadKind are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corners, quadKind]);

  const draw = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    const pad = Math.round(Math.min(vw, vh) * PAD_FRAC);
    canvas.width = vw + pad * 2;
    canvas.height = vh + pad * 2;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Everything below draws in VIDEO coordinates; the translate puts the
    // origin at the video's top-left so a click in the margin is negative and
    // no other drawing code has to know the margin exists.
    ctx.fillStyle = "#0B1220";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(pad, pad);
    ctx.drawImage(video, 0, 0, vw, vh);
    const s = vw / 1280;

    // The frame edge, so it is obvious which part is footage and which is
    // room to place a corner the camera never saw.
    ctx.strokeStyle = "rgba(255,255,255,.45)";
    ctx.setLineDash([6 * s, 5 * s]);
    ctx.lineWidth = Math.max(1, 1.5 * s);
    ctx.strokeRect(0.5, 0.5, vw - 1, vh - 1);
    ctx.setLineDash([]);

    if (showLines) {
      for (const [p, q, colour, w] of courtLines()) {
        ctx.strokeStyle = colour;
        // A floor of 2px: `s` is below 1 on footage narrower than 1280, and a
        // sub-pixel stroke on a canvas antialiases into near-invisibility.
        ctx.lineWidth = Math.max(2, w * s);
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        ctx.lineTo(q[0], q[1]);
        ctx.stroke();
      }
    } else if (corners.length > 1) {
      ctx.strokeStyle = "#3aa0ff";
      // The in-progress outline, before all four corners are down. Matches the
      // finished boundary weight so the line does not appear to thicken the
      // instant the fourth corner lands.
      ctx.lineWidth = 3.5 * s;
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
      if (corners.length === 4) ctx.closePath();
      ctx.stroke();
    }

    corners.forEach((c, i) => {
      ctx.fillStyle = "#ffd23a";
      ctx.beginPath();
      ctx.arc(c.x, c.y, 7 * s, 0, 7);
      ctx.fill();
      ctx.fillStyle = "#101216";
      ctx.font = `${12 * s}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), c.x, c.y);
    });

    players.forEach((p, i) => {
      const colour = p.isSelf ? "#ffd23a" : "#5ce08c";
      ctx.strokeStyle = colour;
      ctx.lineWidth = (p.isSelf ? 3.5 : 2) * s;

      // The box is both the label and the target. A marker at the feet is
      // where the coordinate belongs but not where anyone points -- people
      // click the person -- so draw the person.
      const [x1, y1, x2, y2] = playerRect(p);
      if (p.isSelf) {
        ctx.fillStyle = "rgba(255, 210, 58, 0.16)";
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      }
      // Dashed means "this is where a person of your height would stand",
      // solid means "the detector found a person here". Same click target,
      // different claim, and the drawing should not blur the two.
      if (!p.box) ctx.setLineDash([7 * s, 5 * s]);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.setLineDash([]);
      const labelX = (x1 + x2) / 2;
      const labelY = y1 - 8 * s;

      ctx.beginPath();
      ctx.arc(p.x, p.y, 6 * s, 0, 7);
      ctx.stroke();

      const text = p.isSelf ? "you" : `P${i + 1}`;
      ctx.font = `600 ${14 * s}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      const w = ctx.measureText(text).width + 10 * s;
      ctx.fillStyle = colour;
      ctx.fillRect(labelX - w / 2, labelY - 15 * s, w, 19 * s);
      ctx.fillStyle = "#101216";
      ctx.fillText(text, labelX, labelY);
    });

    ctx.restore();
  }, [corners, players, courtLines, showLines, playerRect]);

  useEffect(() => { draw(); }, [draw, time, videoReady]);

  /* ---------------------------------------------------------------------
   * Interaction.
   * ------------------------------------------------------------------- */

  /**
   * Which player, if any, a click landed on.
   *
   * Anywhere inside the box counts, because that is the shape of the thing a
   * person is aiming at. Boxes are tested smallest-first so a player standing
   * in front of another can still be picked -- with overlapping boxes the
   * nearer, larger one would otherwise swallow every click meant for the
   * player behind. Hand-placed markers have no box and fall back to a radius
   * around the feet.
   */
  const hitPlayer = (list: Player[], p: Corner, radius: number): number => {
    const rects = list.map((q) => playerRect(q));
    const inside = list
      .map((_q, i) => i)
      .filter((i) => {
        const [x1, y1, x2, y2] = rects[i];
        return p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
      })
      .sort((a, b) => {
        const areaOf = (i: number) => (rects[i][2] - rects[i][0]) * (rects[i][3] - rects[i][1]);
        return areaOf(a) - areaOf(b);
      });
    if (inside.length) return inside[0];
    // Missed every body, but a click just outside one is far likelier to mean
    // that player than to mean "put a new marker here".
    let best = -1;
    let bestD = radius;
    list.forEach((q, i) => {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };

  /**
   * Cursor -> VIDEO pixel coordinates.
   *
   * The canvas is larger than the video by PAD_FRAC on every side, so this
   * subtracts the margin. A click in the margin therefore yields a negative
   * coordinate, or one past the video's width -- which is exactly what is
   * wanted for a court corner the camera did not capture, and what the
   * homography consumes without complaint.
   */
  const toImage = (ev: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current!;
    const video = videoRef.current;
    const r = canvas.getBoundingClientRect();
    const pad = video?.videoWidth
      ? Math.round(Math.min(video.videoWidth, video.videoHeight) * PAD_FRAC)
      : 0;
    return {
      x: ((ev.clientX - r.left) * canvas.width) / r.width - pad,
      y: ((ev.clientY - r.top) * canvas.height) / r.height - pad,
    };
  };

  /**
   * The intent of a press, decided once and acted on at release.
   *
   * SPLIT OUT ON PURPOSE. A mouse can place on press: a mouse press that turns
   * into a drag is rare and undoable. A finger cannot -- every tap carries a
   * few pixels of travel, so placing on press means a corner appears the
   * instant you touch the screen to pan. A press only ARMS an action now, and
   * a release that has not travelled far enough to be a drag commits it.
   */
  const placeAt = (client: { clientX: number; clientY: number }) => {
    const p = toImage(client);
    const canvas = canvasRef.current!;
    const scale = canvas.width / canvas.getBoundingClientRect().width;
    const grab = 30 * scale;
    if (stage === "court") {
      if (corners.length < 4) { commit(); setCorners([...corners, p]); }
      return;
    }
    if (stage === "players") {
      // Marking WHO IS ON COURT. A tap on somebody already marked removes
      // them; empty court adds one. Nothing here says which is you.
      const hit = hitPlayer(players, p, grab * 2);
      commit();
      if (hit >= 0) setPlayers(players.filter((_, i) => i !== hit));
      else if (players.length < 8) setPlayers([...players, { x: p.x, y: p.y, isSelf: false }]);
      return;
    }
    // stage === "self": one of them is you, and only one.
    const hit = hitPlayer(players, p, grab * 2);
    if (hit < 0) return;
    commit();
    setPlayers(players.map((q, i) => ({ ...q, isSelf: i === hit ? !q.isSelf : false })));
  };

  const onDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    // The canvas keeps receiving this pointer after the finger leaves it, so a
    // drag that runs off the edge finishes instead of sticking.
    ev.currentTarget.setPointerCapture?.(ev.pointerId);

    // Two fingers is a pinch, and a pinch is never a placement.
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const box = frameBoxRef.current?.getBoundingClientRect();
      pinchFrom.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        zoom,
        midX: (a.x + b.x) / 2 - (box?.left ?? 0),
        midY: (a.y + b.y) / 2 - (box?.top ?? 0),
      };
      // Whatever the first finger armed, it is not happening now.
      pressFrom.current = null;
      panFrom.current = null;
      setDragging(null);
      return;
    }
    if (pointers.current.size > 2) return;

    // Pan mode, or a shift-drag, moves the view and places nothing. Shift is
    // there because once you are zoomed in, reaching for a toolbar button
    // between every adjustment is the slow part.
    if (panMode || ev.shiftKey) {
      panFrom.current = { x: ev.clientX, y: ev.clientY, panX: pan.x, panY: pan.y };
      setPanning(true);
      return;
    }

    pressFrom.current = { x: ev.clientX, y: ev.clientY, moved: false };

    // Grabbing an existing corner is the one thing that acts on press: it is a
    // drag by definition, and waiting for release would mean the corner never
    // followed the finger.
    if (stage === "court") {
      const p = toImage(ev);
      const canvas = canvasRef.current!;
      const scale = canvas.width / canvas.getBoundingClientRect().width;
      // A FATTER TARGET FOR A FINGER. 16 canvas-pixels is a comfortable mouse
      // target and about a third of a fingertip, and a corner you cannot
      // reliably grab is a corner you end up adding a fifth of.
      const grab = (ev.pointerType === "mouse" ? 16 : 30) * scale;
      const hit = corners.findIndex((c) => Math.hypot(c.x - p.x, c.y - p.y) < grab);
      if (hit >= 0) { commit(); setDragging(hit); }
    }
  };

  /** Below this much travel, a press is a tap rather than a drag. */
  const TAP_SLOP_PX = 8;

  const onMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointers.current.has(ev.pointerId)) {
      pointers.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    }

    // Pinch: the gap between the fingers sets the zoom and the midpoint stays
    // under them, so the picture moves with the hands rather than jumping.
    const pinch = pinchFrom.current;
    if (pinch && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      zoomAbout(pinch.zoom * (dist / pinch.dist), pinch.midX, pinch.midY);
      return;
    }

    const press = pressFrom.current;
    if (press && !press.moved
        && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > TAP_SLOP_PX) {
      press.moved = true;
    }

    const from = panFrom.current;
    if (from) {
      setPan(clampPan(
        { x: from.panX + (ev.clientX - from.x), y: from.panY + (ev.clientY - from.y) },
        zoom
      ));
      return;
    }
    if (dragging === null) return;
    const p = toImage(ev);
    setCorners(corners.map((c, i) => (i === dragging ? p : c)));
  };

  const onUp = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(ev.pointerId);
    ev.currentTarget.releasePointerCapture?.(ev.pointerId);
    if (pointers.current.size < 2) pinchFrom.current = null;

    const press = pressFrom.current;
    pressFrom.current = null;
    const wasPanning = panFrom.current !== null;
    // A press that armed a placement and did not travel is a tap, and a tap
    // places. One that dragged a corner has already done its work.
    if (press && !press.moved && dragging === null && !wasPanning) placeAt(ev);

    panFrom.current = null;
    setPanning(false);
    setDragging(null);
  };

  /** The system took the gesture (a swipe from the edge, a call). Drop it. */
  const onCancel = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(ev.pointerId);
    pinchFrom.current = null;
    pressFrom.current = null;
    panFrom.current = null;
    setPanning(false);
    setDragging(null);
  };

  const seek = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(duration || v.duration || 0, t));
  };

  const save = async (thenAnalyse: boolean) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    // The canvas keeps its 300x150 HTML default until the video has decoded a
    // frame. Saving then records frameWidthPx: 300, and the pipeline later
    // scales every corner by 1920/300 -- with confidence 1.0, outranking both
    // detectors. Refuse rather than store a coordinate space that never existed.
    // The canvas is now PAD wider than the video on each side, so the old
    // `canvas.width !== video.videoWidth` guard would reject every save. The
    // thing it was actually protecting against -- saving before the video had
    // decoded, when the canvas still had its 300x150 HTML default -- is caught
    // by videoWidth being 0.
    if (!canvas || !video?.videoWidth || !video.videoHeight) {
      setError("The video hasn't finished loading, so the frame size isn't known yet. Give it a moment and try again.");
      return;
    }
    setSaving(true);
    setError(null);
    const body = {
      frameTimestampSeconds: time,
      // The VIDEO's size, not the canvas's. Every corner is already in video
      // coordinates, and the pipeline scales by this to reach the source
      // frame -- handing it the padded canvas would stretch the court by the
      // margin on every analysis.
      frameWidthPx: video.videoWidth,
      frameHeightPx: video.videoHeight,
      court:
        corners.length === 4
          ? {
              nearLeft: corners[0], nearRight: corners[1],
              farRight: corners[2], farLeft: corners[3],
              quadKind,
            }
          : null,
      // The box was only ever a click target on this one frame; what matters
      // downstream is the feet, which is what the tracker matches against.
      players: players.map(({ x, y, isSelf }) => ({ x, y, isSelf })),
      // Null means white, which is what the fitter assumes on its own.
      lineColorHex: lineColor,
      matchMode,
    };
    // Everything from here is wrapped: an unhandled rejection (offline, a
    // proxy returning non-JSON, an aborted connection) used to leave `saving`
    // true forever, so both buttons read "Saving…" and stayed disabled with no
    // message and no way back except a reload.
    try {
      const res = await fetch(`/api/analyses/${analysisId}/setup`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Could not save.");
        return;
      }

    // Starting the run from here is the natural end of the flow: upload, pick
    // the frame, say which player is you, analyse. Making the user go back to
    // the dashboard to press a second button adds a step and nothing else.
      if (thenAnalyse) {
        const run = await fetch(`/api/analyses/${analysisId}/process`, { method: "POST" });
        if (!run.ok) {
          const j = (await run.json().catch(() => ({}))) as { error?: string };
          // The setup itself saved, so say that rather than implying it was lost.
          setError(`Setup saved, but processing would not start: ${j.error ?? "unknown error"}`);
          return;
        }
      }
      if (embedded) {
        onSaved?.(thenAnalyse);
      } else {
        router.push(`/dashboard/${analysisId}`);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  const courtDone = corners.length === 4;
  const selfChosen = players.some((p) => p.isSelf);
  /**
   * ONE REQUIREMENT: say which player is you.
   *
   * Setup used to ask for two things, and the second -- clicking the four
   * corners of the court -- was the one people gave up on. It is fiddly on a
   * phone, it has to be redone for every clip, and a player who just wants to
   * know why their third shot keeps popping up is being asked to do surveying
   * first.
   *
   * The court has NOT gone away; it moved out of the person's hands. Detection
   * finds it in the pipeline like it always did, and the geometry behind the
   * kitchen and positioning coaching is unchanged. What changed is that a
   * corner it gets slightly wrong is now a small error in one measurement
   * instead of a wall between a user and their analysis.
   *
   * The corner tools are still here, one button away, for the clip shot from
   * an angle detection cannot read. They are a repair, which is what they
   * always should have been.
   */
  const ready = selfChosen;

  /* ---------------------------------------------------------------------
   * The correction path.
   *
   * Automatic detection is right most of the time and wrong often enough
   * that "wrong" has to be a first-class answer, not something the user has
   * to work out how to express. So the page asks a plain question and gives
   * two equally weighted replies -- and choosing "something's off" opens the
   * tools rather than sending the user somewhere else to find them.
   * ------------------------------------------------------------------- */
  const startPlayersOver = () => {
    commit();
    setStage("players");
    setPlayers([]);
    setFixing(true);
    setAutoNote("Click each player at their feet. Then press \u201cPick who I am\u201d and click yourself.");
  };

  return (
    <div className="stack g4">
      <video
        ref={videoRef}
        src={videoUrl}
        preload="auto"
        playsInline
        muted
        crossOrigin={videoUrl.startsWith("blob:") ? undefined : "anonymous"}
        style={{ display: "none" }}
        onLoadedData={() => {
          setVideoReady(true);
          const v = videoRef.current;
          const box = frameBoxRef.current;
          if (v?.videoWidth) {
            const pad = Math.round(Math.min(v.videoWidth, v.videoHeight) * PAD_FRAC);
            const inset = pad / (v.videoWidth + pad * 2);
            setFrameInset(inset);
            // The opening view, set here rather than in an effect: this is the
            // moment the video's proportions become known, and the box is
            // already laid out, so the numbers are all in hand.
            const base = 1 / (1 - 2 * inset);
            // Same offset on both axes: an equal canvas-pixel margin under a
            // uniform scale is an equal screen-pixel margin.
            const offset = -inset * (box?.clientWidth ?? 0) * base;
            setPan({ x: offset, y: offset });
          }
          setDuration(videoRef.current?.duration ?? 0);
          seek(time || 5);
        }}
        onSeeked={() => { setTime(videoRef.current?.currentTime ?? 0); draw(); }}
        onError={() => setError(
          "This browser can't play this video, so the court and players can't be marked here. "
          + "MP4 (H.264) works everywhere; MKV and AVI generally do not. You can still analyse "
          + "the clip without setup from the analysis page."
        )}
      />

      {/* --- the frame ------------------------------------------------- */}
      <div
        ref={frameBoxRef}
        onWheel={onWheel}
        style={{ position: "relative", borderRadius: 12, overflow: "hidden", background: "#0b0f14", border: "1px solid var(--line)" }}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onCancel}
          style={{
            width: "100%", display: "block",
            // transform-origin at the corner so pan is in plain CSS pixels and
            // the arithmetic in zoomAbout stays readable.
            // WITHOUT THIS THE BROWSER TAKES EVERY DRAG. touch-action tells it
            // this element handles its own gestures; at the default, a finger
            // dragging a corner scrolls the page instead -- which is exactly
            // how "nudge any corner" was true on a laptop and false on a phone.
            touchAction: "none",
            transformOrigin: "0 0",
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${baseScale * zoom})`,
            cursor: panMode
              ? (panning ? "grabbing" : "grab")
              : stage === "court" ? "crosshair" : "pointer",
            opacity: videoReady ? 1 : 0,
            transition: "opacity .2s ease",
          }}
        />
        {/* Zoom controls, over the frame rather than under it: at 4x the thing
            you are aiming at is often near an edge, and a toolbar below the
            box puts the cursor a long way from it. */}
        {videoReady ? (
          <div
            className="row g1 setup-tools"
            style={{
              position: "absolute", top: 8, right: 8, gap: 4,
              background: "rgba(10,15,22,.72)", backdropFilter: "blur(4px)",
              borderRadius: 8, padding: 4, border: "1px solid rgba(255,255,255,.12)",
            }}
          >
            <button
              type="button" className="btn btn-ghost btn-sm"
              title="Zoom out — keep going to see past the edge of the video, for a corner the camera missed"
              style={{ color: "#dbe6f2", minWidth: 30 }}
              onClick={() => {
                const b = frameBoxRef.current;
                zoomAbout(zoom / 1.4, (b?.clientWidth ?? 0) / 2, (b?.clientHeight ?? 0) / 2);
              }}
            >−</button>
            <span className="num sm" style={{ color: "#dbe6f2", minWidth: 40, textAlign: "center", alignSelf: "center" }}>
              {zoom.toFixed(1)}×
            </span>
            <button
              type="button" className="btn btn-ghost btn-sm" title="Zoom in"
              style={{ color: "#dbe6f2", minWidth: 30 }}
              onClick={() => {
                const b = frameBoxRef.current;
                zoomAbout(zoom * 1.4, (b?.clientWidth ?? 0) / 2, (b?.clientHeight ?? 0) / 2);
              }}
            >+</button>
            <button
              type="button" className="btn btn-ghost btn-sm" title="Drag to move the frame (or hold Shift)"
              aria-pressed={panMode}
              style={{ color: panMode ? "#0b0f14" : "#dbe6f2", background: panMode ? "#dbe6f2" : undefined }}
              onClick={() => setPanMode((v) => !v)}
            >Pan</button>
            <button
              type="button" className="btn btn-ghost btn-sm" title="Back to the video's own frame"
              style={{ color: "#dbe6f2" }}
              onClick={resetView}
            >Fit</button>
            <span style={{ width: 1, alignSelf: "stretch", background: "rgba(255,255,255,.18)", margin: "2px 2px" }} />
            <button
              type="button" className="btn btn-ghost btn-sm" title="Undo"
              style={{ color: "#dbe6f2", minWidth: 30 }}
              disabled={!canUndo} onClick={undo}
            >↶</button>
            <button
              type="button" className="btn btn-ghost btn-sm" title="Redo"
              style={{ color: "#dbe6f2", minWidth: 30 }}
              disabled={!canRedo} onClick={redo}
            >↷</button>
          </div>
        ) : null}
        {!videoReady ? (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#8ba0b8", fontSize: 14 }}>
            Loading the video…
          </div>
        ) : null}
        {auto === "running" ? (
          <div style={{
            position: "absolute", inset: 0, display: "grid", placeItems: "center",
            background: "rgba(8,12,18,.62)", backdropFilter: "blur(2px)", color: "#fff",
          }}>
            <div className="stack g2" style={{ alignItems: "center" }}>
              <div className="progress indet" style={{ width: 200 }}><div className="bar" /></div>
              <span style={{ fontSize: 13 }}>Finding a frame with everyone on court…</span>
            </div>
          </div>
        ) : null}
      </div>

      {/* --- scrubber -------------------------------------------------- */}
      <div className="row g3">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => seek(time - 1)}>← 1s</button>
        <input
          type="range" min={0} max={duration || 0} step={0.1} value={time}
          onChange={(e) => seek(Number(e.target.value))}
          style={{ flex: 1, minWidth: 160 }}
        />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => seek(time + 1)}>1s →</button>
        <span className="num sm" style={{ opacity: 0.7, minWidth: 54, textAlign: "right" }}>{time.toFixed(1)}s</span>
      </div>

      {/* --- the verdict ----------------------------------------------- */}
      {!fixing ? (
        <div className="card stack g4">
          <div className="row g2" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <span className="eyebrow">Set up this clip</span>
            <span className={`pill ${ready ? "p-good" : "p-warn"}`}>
              <span className="dot" />
              {ready ? "Ready to analyse" : "Tap yourself to start"}
            </span>
          </div>

          {/*
            ONE TILE, because there is one thing to do.

            This was two tiles and a court-preset bar, which is three things
            competing for attention on a screen whose entire job is "tap the
            player who is you". The court moved into the pipeline; what is left
            is the only decision the software genuinely cannot make, which is
            which of these people the coaching should be about.
          */}
          <div
            className="stack g2"
            style={{
              padding: "var(--a4)",
              borderRadius: "var(--r3)",
              background: selfChosen ? "var(--good-wash)" : "var(--warn-wash)",
              border: `1px solid ${selfChosen ? "var(--good)" : "var(--warn)"}`,
            }}
          >
            <div className="row g2" style={{ alignItems: "center" }}>
              <span style={{
                width: 22, height: 22, borderRadius: "50%", display: "grid", placeItems: "center",
                background: selfChosen ? "var(--good)" : "var(--warn)", color: "#fff",
                fontSize: 12, fontWeight: 700, flex: "none",
              }}>
                {selfChosen ? "\u2713" : "1"}
              </span>
              <strong style={{ fontSize: 15 }}>Which player is you</strong>
            </div>
            <p className="sm" style={{ margin: 0, color: selfChosen ? "var(--good)" : "var(--warn)" }}>
              {selfChosen
                ? "Tagged. Everything in the coaching read is about this player."
                : players.length === 0
                  ? "No players found on this frame yet \u2014 scrub to a moment where everyone is on court, then tap yourself."
                  : `Tap yourself on the frame above. ${players.length} player${players.length === 1 ? "" : "s"} found; the one you pick turns yellow.`}
            </p>
            <div className="row g2" style={{ flexWrap: "wrap" }}>
              {selfChosen ? (
                <button type="button" className="btn btn-sm btn-soft"
                        onClick={() => { setFixing(true); setStage("players"); }}>
                  Change who is you
                </button>
              ) : null}
              {/* The repair door. Deliberately quiet and deliberately last:
                  most clips never need it, and a prominent "fix the court"
                  control is what made ordinary setup feel like error
                  recovery. */}
              <button type="button" className="btn btn-sm btn-ghost"
                      onClick={() => { setFixing(true); setStage(courtDone ? "players" : "court"); }}>
                {courtDone ? "Players or court look wrong?" : "Court not detected \u2014 mark it by hand"}
              </button>
            </div>
          </div>

          <div className="row g2" style={{ alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || !ready}
              title={ready ? undefined : "Finish both steps above first"}
              onClick={() => save(true)}
            >
              {saving ? "Saving…" : "Looks right — analyse"}
            </button>
            <button type="button" className="btn btn-soft" onClick={() => setFixing(true)}>
              More settings
            </button>
            {!embedded ? (
              <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => save(false)}>
                Save without analysing
              </button>
            ) : null}
          </div>

          {/*
            The detail that used to be three paragraphs of body copy. It is all
            still true and occasionally needed -- the off-frame corner trick in
            particular is not guessable -- but it is reference, not instruction,
            and reference that shouts drowns the two things actually being
            asked for.
          */}
          <details>
            <summary className="sm" style={{ cursor: "pointer", color: "var(--ink-3)" }}>
              What the colours mean, and marking a corner that is off-screen
            </summary>
            <div className="stack g2" style={{ marginTop: "var(--a2)" }}>
              <p className="sm measure" style={{ margin: 0, color: "var(--ink-2)" }}>
                Blue lines are the court. Pink is the net, drawn at its real height.
                Green boxes are tracked players; the one you pick turns yellow.
              </p>
              <p className="sm measure" style={{ margin: 0, color: "var(--ink-2)" }}>
                If a corner sits outside the video, click out in the dark margin where
                it would be — the dashed line marks the edge of the footage, and a
                corner beyond it works exactly the same.
              </p>
              <p className="sm" style={{ margin: 0, color: "var(--ink-3)" }}>
                {matchMode === "singles" ? "Singles" : "Doubles"} ·{" "}
                {lineColor ? (
                  <>
                    lines sampled as{" "}
                    <span style={{
                      display: "inline-block", width: 10, height: 10, borderRadius: 3,
                      background: lineColor, border: "1px solid var(--line)",
                      verticalAlign: "middle",
                    }} />{" "}
                    {lineColor}
                  </>
                ) : "white lines"}
                {" — change either under “More settings”."}
              </p>
            </div>
          </details>
        </div>
      ) : (
        <div className="card stack g4">
          <div className="row g2" style={{ justifyContent: "space-between" }}>
            <span className="eyebrow">More settings</span>
            <button
              type="button"
              className="btn btn-soft btn-sm"
              onClick={() => setFixing(false)}
              title="Close these tools and go back"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3 8.5 6.2 12 13 4.5" stroke="currentColor" strokeWidth="2"
                      strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Done fixing
            </button>
          </div>

          <div className="stepbar">
            <span className={`step ${courtDone ? "done" : stage === "court" ? "cur" : ""}`}>
              <span className="n">{courtDone ? "✓" : "1"}</span> Court &amp; net
            </span>
            <span className="step"><span className="sep" /></span>
            <span className={`step ${players.length > 0 ? "done" : stage === "players" ? "cur" : ""}`}>
              <span className="n">{players.length > 0 ? "✓" : "2"}</span> Mark the players
            </span>
            <span className="step"><span className="sep" /></span>
            <span className={`step ${selfChosen ? "done" : stage === "self" ? "cur" : ""}`}>
              <span className="n">{selfChosen ? "✓" : "3"}</span> Which one is you
            </span>
          </div>

          <div className="grid2">
            <div className="stack g2">
              <strong style={{ fontSize: 14 }}>Court &amp; net</strong>
              <p className="sm" style={{ margin: 0, opacity: 0.75 }}>
                {courtDone
                  ? "Drag any corner to nudge it. The kitchen line, centre lines and net follow the corners — when those land on the paint, the geometry is right. A corner can sit outside the video: drag it out into the margin past the dashed edge."
                  : `Click the ${CORNER_STEPS[corners.length].label.toLowerCase()} — ${CORNER_STEPS[corners.length].hint}. If it is off-screen, click out in the margin where it would be.`}
              </p>
              <div className="row g2" style={{ flexWrap: "wrap" }}>
                <button
                  type="button"
                  className={`btn btn-sm ${stage === "court" ? "btn-primary" : "btn-soft"}`}
                  onClick={() => setStage("court")}
                >
                  {stage === "court" ? "Adjusting corners" : "Adjust corners"}
                </button>
                <button
                  type="button" className="btn btn-ghost btn-sm"
                  disabled={corners.length === 0}
                  onClick={clearCourt}
                >
                  Clear the court
                </button>
              </div>
              {/* The example, shown only while the corners are actually being
                  placed. Once they are down the reader has the answer and the
                  diagram is just a thing taking up room. */}
              {stage === "court" && corners.length < 4 ? <CornerGuide compact /> : null}
              {/* The "far baseline is hidden, I marked the net" checkbox used
                  to live here. It asked the user to classify their own
                  camera angle, in a sentence that only makes sense once you
                  already understand what the fitter does with it -- and the
                  detector reports the same fact itself. It still does; nobody
                  is asked. */}
              {/* Presets live in the MAIN view now. Two copies of one control
                  in two panels is two places for the same state to disagree. */}
            </div>

            <div className="stack g2">
              <strong style={{ fontSize: 14 }}>Singles or doubles</strong>
              <p className="sm" style={{ margin: 0, opacity: 0.75 }}>
                Both are played on the same 20×44 court with the same lines, so
                this changes nothing about the geometry. What it changes is how
                many people the tracker expects to find — set it wrong and it
                either drops a player or goes looking for one who is not there.
              </p>
              <div className="row g2">
                {(["doubles", "singles"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`btn btn-sm ${matchMode === m ? "btn-primary" : "btn-soft"}`}
                    onClick={() => setMatchMode(m)}
                  >
                    {m === "doubles" ? "Doubles · 4" : "Singles · 2"}
                  </button>
                ))}
              </div>
              {players.length > 0 && players.length !== playersForMode(matchMode) ? (
                <p className="sm" style={{ margin: 0, opacity: 0.75 }}>
                  {players.length} marked, {playersForMode(matchMode)} expected for{" "}
                  {matchMode}. That is allowed — someone may be off camera — but
                  it is worth a look.
                </p>
              ) : null}
            </div>

            <div className="stack g2">
              <strong style={{ fontSize: 14 }}>The players are wrong</strong>
              <p className="sm" style={{ margin: 0, opacity: 0.75 }}>
                {stage === "self"
                  ? "Click the person who is you. Only one can be, so clicking somebody else moves the tag rather than adding a second."
                  : "Click each player at their feet. Click a marked player again to remove them. Everyone on your court is tracked either way — who is you comes next."}
              </p>
              <div className="row g2" style={{ flexWrap: "wrap" }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={startPlayersOver}>
                  Redo the players
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${stage === "players" ? "btn-primary" : "btn-soft"}`}
                  onClick={() => setStage("players")}
                >
                  {stage === "players" ? "Choosing players" : "Choose players"}
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${stage === "self" ? "btn-primary" : "btn-soft"}`}
                  disabled={players.length === 0}
                  title={players.length === 0 ? "Mark the players first" : undefined}
                  onClick={() => setStage("self")}
                >
                  {stage === "self" ? "Picking who I am" : "Pick who I am"}
                </button>
                <button
                  type="button" className="btn btn-ghost btn-sm"
                  disabled={players.length === 0}
                  onClick={clearPlayers}
                >
                  Clear all players
                </button>
              </div>
            </div>
          </div>

          <div className="dashline" />

          {/* The examples live inside "Fix it yourself" rather than on the
              main verdict card on purpose. A user whose court came back right
              does not need to be taught the failure modes, and putting three
              diagrams in front of them before they have a problem is how a
              two-click confirmation turns into a manual. Anyone who opened
              this panel has a problem. */}
          <SetupExamples />

          <div className="dashline" />

          <div className="row g2">
            <button
              type="button"
              className="btn btn-soft btn-sm"
              disabled={auto === "running"}
              onClick={() => {
                const willClobber = corners.length > 0 || players.length > 0;
                if (willClobber && !window.confirm(
                  "Replace the court corners and players you have marked with a fresh detection?"
                )) return;
                void findFrame(lineColor);
              }}
            >
              {auto === "running" ? "Looking…" : "Try a different frame"}
            </button>
            <label className="sm" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={showLines} onChange={(e) => setShowLines(e.target.checked)} />
              Show the whole court, not just the corners
            </label>
            <button
              type="button"
              className="btn btn-primary btn-sm mla"
              disabled={saving || !ready}
              onClick={() => save(true)}
            >
              {saving ? "Saving…" : "Analyse"}
            </button>
          </div>
        </div>
      )}

      {autoNote ? (
        <p className={auto === "failed" ? "error" : "note"} style={{ fontSize: 13 }}>{autoNote}</p>
      ) : null}
      {error ? <div className="error">{error}</div> : null}
    </div>
  );
}
