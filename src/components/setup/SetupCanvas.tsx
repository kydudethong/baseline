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
import { PARTNER_SEED_LABEL } from "@/lib/db/setup";
import { nearestPlayer, samePoint } from "@/lib/vision/tap-target";
import { UpgradeOffer, type UpgradeOfferData } from "@/components/billing/UpgradeOffer";
import { useRouter } from "next/navigation";

import CourtPresetBar from "./CourtPresetBar";


import { courtSegments, type CourtLineRole } from "@/lib/vision/court-model";
import { boxRect, imageScale, scaleBox, scalePoint, type BoxPx } from "@/lib/vision/image-space";
import { type MatchMode } from "@/lib/db/setup";
import { SetupExamples } from "./SetupExamples";

type Corner = { x: number; y: number };
/**
 * `x`/`y` are the player's feet -- the only part of a person on the court
 * plane, and what the tracker matches against. `box` is the detector's
 * bounding box when one exists, kept purely so the click target can be the
 * whole person rather than a dot at their shoes.
 */
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
/**
 * THERE IS NO STAGE ANY MORE, and this type is gone with it.
 *
 * This screen ran a three-step machine: mark the court, mark the players, then
 * say which one is you. The last two moved to AFTER the analysis, where they
 * belong -- the pipeline has by then found the players itself, on the frame
 * where the most of them are visible, so the question "which of these is you"
 * is asked over real boxes instead of asking somebody to click four strangers'
 * feet from memory before anything has been detected at all.
 *
 * What is left is the one thing that has to happen BEFORE the analysis, because
 * every distance in feet depends on it: does the drawn court sit on the painted
 * one. A court is always laid down, so this is a confirmation, not a task.
 */

/** Everything undo restores. Small enough to copy on every change. */
interface Snapshot { corners: Corner[] }

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



/**
 * A court to start from, when detection did not find one.
 *
 * NOBODY SHOULD EVER FACE AN EMPTY FRAME. Placing four corners in a fixed
 * order, precisely, some of them off the edge of the picture, is the hardest
 * thing this app has ever asked anyone to do -- and the version that asked it
 * is the version people abandoned. Dragging a court that is already there onto
 * the court that is really there is a different task: you can see what you are
 * aiming at, you can see when you have arrived, and no step of it can be done
 * in the wrong order.
 *
 * The shape is a TRAPEZOID rather than a rectangle because that is what a
 * court looks like from behind a baseline -- the far end is narrower and
 * higher up the frame. Starting from roughly the right shape means the first
 * drag is a nudge instead of a rescue. The numbers are fractions of the frame,
 * from where a court sits in a phone video shot from the fence.
 */
function seedCourt(vw: number, vh: number): Corner[] {
  return [
    { x: vw * 0.06, y: vh * 0.92 },  // near-left
    { x: vw * 0.94, y: vh * 0.92 },  // near-right
    { x: vw * 0.72, y: vh * 0.30 },  // far-right
    { x: vw * 0.28, y: vh * 0.30 },  // far-left
  ];
}

/**
 * How much the magnifier enlarges, and how wide it is on screen.
 *
 * A LOUPE, because a fingertip is about forty pixels across and the line you
 * are trying to land on is two. Without one, placing a corner accurately on a
 * phone is not difficult, it is impossible: the thing you are aiming at is
 * underneath the thing you are aiming with. This is the same trick a phone
 * keyboard uses for text selection, for the same reason.
 */
const LOUPE_ZOOM = 3.5;
const LOUPE_R = 62;

export interface SetupCourt {
  nearLeft: Corner;
  nearRight: Corner;
  farRight: Corner;
  farLeft: Corner;
  quadKind: "full" | "near-half";
}

interface AutoPlayer {
  /** Two corners, [x1, y1, x2, y2] — see BoxPx. Not an origin and a size. */
  boxPx: BoxPx;
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

type TagBox = { x: number; y: number; width: number; height: number };
/**
 * A tag: where, on WHICH frame, and (when a box was tapped) which box.
 *
 * THE FRAME IS PART OF THE ANSWER. The boxes are detected on one frame, and
 * the video under them can be scrubbed. The tag used to be saved against
 * whatever time the video showed at save, while the point came from a box on
 * the detection frame -- so scrubbing after tapping moved the claim "you are
 * here" to a moment when somebody else was standing there, and the read
 * coached them. Reported from real use.
 */
type Tag = { x: number; y: number; t: number; box?: TagBox };

/** Same frame, to within a frame at 30fps. */
const sameFrame = (a: number, b: number) => Math.abs(a - b) < 0.05;

export interface SetupCanvasProps {
  analysisId: string;
  videoUrl: string;
  initial: {
    frameTimestampSeconds: number;
    court: SetupCourt | null;
    lineColorHex?: string | null;
    matchMode?: MatchMode;
    /** Seeds from a previous visit, so re-opening this page keeps the answer. */
    players?: Array<{ x: number; y: number; isSelf: boolean; label?: string; box?: TagBox }>;
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
  // Declared up here with the rest of the canvas state, because undo/redo
  // below need to cancel an in-flight corner drag.
  const [dragging, setDragging] = useState<number | null>(null);
  const [corners, setCorners] = useState<Corner[]>(() => {
    const c = initial?.court;
    return c ? [c.nearLeft, c.nearRight, c.farRight, c.farLeft].filter(Boolean) : [];
  });
  const [quadKind, setQuadKind] = useState<"full" | "near-half">(
    initial?.court?.quadKind ?? "full"
  );
  /**
   * Who the detector found. Drawn, and now tappable.
   *
   * ASKED ABOUT AGAIN, and the reason it came back is cost rather than taste.
   * Tagging moved to after the analysis because that is where the pipeline's
   * own boxes exist -- but the coaching read cannot be written without knowing
   * who the subject is, so the run had to either skip it and be re-run once
   * tagged, or write a read about a guess. Tagging HERE means the Gemini pass
   * happens once, already knowing who it is about.
   *
   * Seeing what was found still does its old job as well: it is the only check
   * on the court that has consequences in it. A quad drawn one court over, or
   * one swallowing the queue behind the fence, both look plausible as an
   * outline and both give themselves away the moment you see who is inside.
   */
  const [detected, setDetected] = useState<AutoPlayer[]>([]);
  /** Which frame `detected` belongs to. Boxes are only shown, and only snapped to, on it. */
  const [detectedAt, setDetectedAt] = useState<number | null>(null);
  /**
   * Where the user says they are, in video pixels at their own feet.
   *
   * A POINT, NOT A TRACK ID, because tracks do not exist yet -- the CV run has
   * not happened. matchTracksToSetup turns it into an identity afterwards by
   * finding whichever track's feet were nearest at this timestamp. Feet
   * specifically: they are the only part of a person on the court plane, so it
   * is the one place where a click and a track agree about where somebody is.
   */
  const fromSaved = (pl: { x: number; y: number; box?: TagBox } | undefined): Tag | null =>
    pl ? { x: pl.x, y: pl.y, t: initial?.frameTimestampSeconds ?? 0, ...(pl.box ? { box: pl.box } : {}) } : null;
  const [selfPoint, setSelfPoint] = useState<Tag | null>(
    () => fromSaved(initial?.players?.find((pl) => pl.isSelf))
  );
  const [partnerPoint, setPartnerPoint] = useState<Tag | null>(
    () => fromSaved(initial?.players?.find((pl) => !pl.isSelf && pl.label === PARTNER_SEED_LABEL))
  );
  /**
   * Which of the two the next tap fills.
   *
   * Starts on whichever is still missing, so re-opening a half-finished setup
   * carries on rather than overwriting the answer already given.
   */
  const [tagging, setTagging] = useState<"self" | "partner">(
    () => (initial?.players?.some((pl) => pl.isSelf) ? "partner" : "self")
  );
  // Read by the detection callback, which must not re-run when a tag changes.
  const tagsRef = useRef({ self: selfPoint, partner: partnerPoint });
  useEffect(() => { tagsRef.current = { self: selfPoint, partner: partnerPoint }; }, [selfPoint, partnerPoint]);
  const [offCourt, setOffCourt] = useState(0);
  /**
   * Whether the boxes were filtered against a fitted court at all.
   *
   * Null until a detection pass has run. False is the state worth shouting
   * about: with no court there is nothing to be off, so every person in the
   * frame is a candidate and the boxes fall back to whoever the detector was
   * most confident about -- which is whoever is closest to the camera, which
   * on a public court is the people waiting for the next game.
   */
  const [gated, setGated] = useState<boolean | null>(null);
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
    setPast((h) => [...h.slice(-49), { corners }]);
    setFuture([]);
  }, [corners]);

  const undo = useCallback(() => {
    setPast((h) => {
      const prev = h[h.length - 1];
      if (!prev) return h;
      setFuture((f) => [...f, { corners }]);
      setCorners(prev.corners);
      setDragging(null);
      return h.slice(0, -1);
    });
  }, [corners]);

  const redo = useCallback(() => {
    setFuture((f) => {
      const next = f[f.length - 1];
      if (!next) return f;
      setPast((h) => [...h, { corners }]);
      setCorners(next.corners);
      setDragging(null);
      return f.slice(0, -1);
    });
  }, [corners]);

  const canUndo = past.length > 0;
  const canRedo = future.length > 0;

  /**
   * Whether the tool panel is open.
   *
   * Declared up here with the rest of the setup state because openCourt()
   * below opens it, and a hook defined before the state it touches cannot
   * reach it.
   */
  const [fixing, setFixing] = useState(false);

  /** The frame's size, or a 16:9 guess before the video has loaded. */
  const frameSize = useCallback(() => {
    const v = videoRef.current;
    return v && v.videoWidth > 0 ? { w: v.videoWidth, h: v.videoHeight } : { w: 1280, h: 720 };
  }, []);

  /**
   * RESET, not clear. The button used to empty the court and leave the user
   * facing the blank frame and the four-corners-in-order sequence again --
   * which is to say it punished a wrong drag with the hardest screen in the
   * app. It now puts the starting court back, so the worst outcome of any
   * mistake is one more drag.
   */
  const clearCourt = useCallback(() => {
    const { w, h } = frameSize();
    commit(); setCorners(seedCourt(w, h));
  }, [commit, frameSize]);

  /** Open the court tools, laying a court down first if there is none. */
  const openCourt = useCallback(() => {
    const { w, h } = frameSize();
    if (corners.length < 4) { commit(); setCorners(seedCourt(w, h)); }
    setFixing(true);
  }, [commit, corners.length, frameSize]);

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
  const [time, setTime] = useState(initial?.frameTimestampSeconds ?? 0);
  const onDetFrame = detectedAt !== null && sameFrame(time, detectedAt);
  const [duration, setDuration] = useState(0);
  const [saving, setSaving] = useState(false);
  const [upgrade, setUpgrade] = useState<UpgradeOfferData | null>(null);
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
        const at = json.frame.timestampSeconds;
        setDetectedAt(at);
        // A tag made on a box from an EARLIER detection frame now names a box
        // nobody can see, on a still that has just been replaced. Ask again
        // rather than keep a claim about a frame that is gone.
        const stale = (tg: Tag | null) => Boolean(tg?.box) && !sameFrame(tg!.t, at);
        if (stale(tagsRef.current.self)) { setSelfPoint(null); setPartnerPoint(null); setTagging("self"); }
        else if (stale(tagsRef.current.partner)) setPartnerPoint(null);
        setTime(at);
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
      const scale = imageScale(json.imageSize, cw, ch);
      const at = (p: [number, number]): Corner => {
        const [x, y] = scalePoint(p, scale);
        return { x, y };
      };

      if (json.court) {
        const c = json.court.corners;
        setCorners([at(c.bottomLeft), at(c.bottomRight), at(c.topRight), at(c.topLeft)]);
        setQuadKind(json.court.quadKind);
      }
      // DRAWN, NOT COLLECTED. See `detected` above.
      //
      // SCALED LIKE EVERYTHING ELSE, which the first version of this was not.
      // The boxes arrive in the space the SERVER measured in -- rally_seg caps
      // its long side at 1280 -- so painting them straight onto a 1920-wide
      // canvas puts every player at two-thirds of their real position, bunched
      // toward the top-left. It reads as boxes scattered at random rather than
      // as a scaling bug, which is what made it worth a comment: the warning
      // was already written twenty lines above, about the court corners, and
      // the boxes were added underneath it anyway.
      setDetected(
        json.frame?.playersReliable === false
          ? []
          : json.players.map((p) => ({
              ...p,
              boxPx: scaleBox(p.boxPx, scale),
              feetPx: scalePoint(p.feetPx, scale),
            }))
      );
      setOffCourt(json.frame?.playersOffCourt ?? 0);
      setGated(json.frame?.courtGated ?? null);
      const bits: string[] = [];
      if (json.frame) bits.push(`Frame at ${json.frame.timestampSeconds.toFixed(1)}s.`);
      if (json.court) bits.push(`Court fitted (${(json.court.confidence * 100).toFixed(0)}% line support) — drag any corner to correct it.`);
      else if (json.courtReason) bits.push(`Court not fitted: ${json.courtReason}`);
      // THE PLAYER COUNT AS A CHECK ON THE COURT. Whether the people standing
      // inside the quad are the number you expect is the quickest way to catch
      // a court that is subtly wrong -- a quad drawn one court over, or one
      // that swallows the queue behind the fence, both look plausible on their
      // own and both give themselves away here.
      if (json.players.length && json.frame?.playersReliable !== false) {
        const off = json.frame?.playersOffCourt ?? 0;
        bits.push(`${json.players.length} ${json.players.length === 1 ? "person is" : "people are"} inside it.`);
        if (json.frame?.courtGated && off > 0) {
          bits.push(`${off} more ${off === 1 ? "person was" : "people were"} outside it and ignored.`);
        } else if (json.frame?.courtGated === false) {
          bits.push("Nobody could be ruled out for standing off court, because no court was fitted.");
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

    /*
     * THE PEOPLE, so they can be tapped.
     *
     * Faint until one is chosen and solid once it is: the boxes are a target
     * here, not information, and nine green rectangles competing with the
     * court lines is how the last version of this screen ended up being asked
     * to take them off. The one that is YOU is the only one that shouts.
     */
    for (const d of onDetFrame ? detected : []) {
      // TWO CORNERS, converted once. Destructured as [bx, by, bw, bh] this
      // drew every box from the player's head to a point past the bottom of
      // the frame -- reported, for the third time, as "the boxes aren't on
      // the players". boxRect is the only place that reading happens now.
      const { x: bx, y: by, width: bw, height: bh } = boxRect(d.boxPx);
      const [fx, fy] = d.feetPx;
      const isSelf = samePoint(selfPoint, { x: fx, y: fy });
      const isPartner = samePoint(partnerPoint, { x: fx, y: fy });
      ctx.strokeStyle = isSelf ? "#ffd23a" : isPartner ? "#37d0e0" : "rgba(120,220,150,.55)";
      ctx.lineWidth = Math.max(2, (isSelf || isPartner ? 4 : 2) * s);
      ctx.strokeRect(bx, by, bw, bh);
      if (isSelf || isPartner) {
        const label = isSelf ? "YOU" : "PARTNER";
        ctx.font = `${Math.max(12, 20 * s)}px system-ui, sans-serif`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = isSelf ? "#ffd23a" : "#37d0e0";
        ctx.fillRect(bx, by - Math.max(16, 26 * s), tw + 12 * s, Math.max(16, 26 * s));
        ctx.fillStyle = "#0B1220";
        ctx.fillText(label, bx + 6 * s, by - Math.max(4, 7 * s));
      }
    }

    /*
     * A HAND-PLACED MARK, when the tap matched nobody.
     *
     * Drawn differently from a snapped box on purpose. A cross on bare court
     * says "this is where you told me you were", which is the truth: there was
     * no detection under it, and the match to a real track will be made later
     * from this position alone. Showing it as a box would claim a detection
     * that does not exist.
     */
    for (const [pt, colour, label] of [
      [selfPoint, "#ffd23a", "YOU"] as const,
      [partnerPoint, "#37d0e0", "PARTNER"] as const,
    ]) {
      if (!pt || !sameFrame(pt.t, time)) continue;
      const onBox = onDetFrame && detected.some((d) => samePoint({ x: d.feetPx[0], y: d.feetPx[1] }, pt));
      if (onBox) continue;
      const r = Math.max(8, 14 * s);
      ctx.strokeStyle = colour;
      ctx.lineWidth = Math.max(2, 3 * s);
      ctx.beginPath();
      ctx.moveTo(pt.x - r, pt.y); ctx.lineTo(pt.x + r, pt.y);
      ctx.moveTo(pt.x, pt.y - r); ctx.lineTo(pt.x, pt.y + r);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = `${Math.max(12, 18 * s)}px system-ui, sans-serif`;
      ctx.fillStyle = colour;
      ctx.fillText(label, pt.x + r + 4 * s, pt.y - r);
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

    // NO PLAYER BOXES ON THIS FRAME. They were drawn here for a day and taken
    // off: this screen asks one question -- does the outline sit on the
    // painted lines -- and four green rectangles over the people standing on
    // those lines make the lines harder to see, which is the opposite of
    // helping. The count below the frame carries the same information without
    // covering the thing being judged.

    // THE MAGNIFIER, last, so nothing draws over it.
    //
    // Offset UP AND LEFT of the corner rather than centred on it, because the
    // whole point is to show the pixels the finger is covering. Flipped to the
    // other side when the corner is near an edge, so the loupe never runs off
    // the canvas -- a magnifier you cannot see is worse than none, since the
    // user assumes it is helping.
    if (dragging !== null && corners[dragging]) {
      const c = corners[dragging];
      const r = LOUPE_R * s;
      const off = (LOUPE_R + 34) * s;
      const cx = c.x - off < r ? c.x + off : c.x - off;
      const cy = c.y - off < r ? c.y + off : c.y - off;

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      // The video again, scaled up around the corner. Drawn from the video
      // element rather than from the canvas so the magnified picture is the
      // FOOTAGE and not a magnified copy of the court lines we drew on it --
      // which would be showing the user their own guess, enlarged.
      ctx.drawImage(
        video,
        cx - c.x * LOUPE_ZOOM, cy - c.y * LOUPE_ZOOM,
        vw * LOUPE_ZOOM, vh * LOUPE_ZOOM
      );
      // Crosshair at the exact pixel the corner is on. Thin, and in the court
      // colour, so it reads as the thing being placed.
      ctx.strokeStyle = "rgba(255, 210, 58, 0.95)";
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.moveTo(cx - 14 * s, cy); ctx.lineTo(cx - 4 * s, cy);
      ctx.moveTo(cx + 4 * s, cy); ctx.lineTo(cx + 14 * s, cy);
      ctx.moveTo(cx, cy - 14 * s); ctx.lineTo(cx, cy - 4 * s);
      ctx.moveTo(cx, cy + 4 * s); ctx.lineTo(cx, cy + 14 * s);
      ctx.stroke();
      ctx.restore();

      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }, [corners, courtLines, showLines, dragging, detected, selfPoint, partnerPoint, onDetFrame, time]);

  useEffect(() => { draw(); }, [draw, time, videoReady]);

  /* ---------------------------------------------------------------------
   * Interaction.
   * ------------------------------------------------------------------- */

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
    /*
     * THE COURT FIRST, ALWAYS. While a corner is missing a tap places it, and
     * only once the quad is closed does a tap mean "that is me".
     *
     * Ordering it the other way round would be ambiguous exactly when it
     * matters: a half-drawn court with people standing in it, where the same
     * tap could plausibly mean either. In practice a court is always fitted
     * when this screen opens, so the corner branch is the escape hatch for
     * somebody who cleared it and the tagging branch is the normal path.
     */
    if (corners.length < 4) { commit(); setCorners([...corners, p]); return; }

    /*
     * SNAP TO A PLAYER IF THERE IS ONE, OTHERWISE TAKE THE TAP.
     *
     * The fallback is what makes "you must tag yourself" a rule somebody can
     * always satisfy rather than a trap. The detector finds nobody on plenty
     * of real frames -- a dark court, an unusual angle, everyone bunched -- and
     * a required step with no way to complete it would leave the user on this
     * page with no route forward at all. A hand-placed point is exactly as
     * good an input as a snapped one: matchTracksToSetup takes a position
     * either way and never sees which it was.
     */
    // Only onto boxes that belong to the frame on screen. Off the detection
    // frame there are no boxes, and a tap is a hand-placed mark at this time.
    const snap = onDetFrame ? nearestPlayer(p, detected) : null;
    const at: Tag = snap
      ? { x: snap.feet.x, y: snap.feet.y, t: time, box: snap.box }
      : { x: p.x, y: p.y, t: time };
    if (tagging === "self") {
      setSelfPoint(at);
      // Clear a partner that the new self mark has just landed on, rather than
      // leaving somebody tagged as both -- which the matcher resolves by
      // silently dropping one, in an order nobody can predict. And one tagged
      // on a different frame: both tags are read against ONE timestamp.
      if (partnerPoint && (samePoint(partnerPoint, at) || !sameFrame(partnerPoint.t, time))) setPartnerPoint(null);
      setTagging("partner");
    } else {
      if (selfPoint && !sameFrame(selfPoint.t, time)) {
        setError("Tag your partner on the same frame you tagged yourself on — jumped back to it.");
        seek(selfPoint.t);
        return;
      }
      if (samePoint(selfPoint, at)) return;
      setPartnerPoint(at);
    }
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
    {
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
      // THE FRAME THE TAGS WERE MADE ON, not wherever the video was left.
      frameTimestampSeconds: selfPoint?.t ?? time,
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
      /*
       * WHO YOU ARE, AND WHO YOU ARE PLAYING WITH.
       *
       * Two seeds at most, and only ones the user actually tapped. The old
       * version of this screen seeded EVERY detected player automatically,
       * which read downstream as deliberate intent -- four marks meant the
       * detector found four people, not that anybody chose them -- and
       * matchTracksToSetup had to grow a comment explaining why it must not
       * filter on them. Nothing is sent here that a person did not point at.
       *
       * Positions, not identities: the tracks these become do not exist yet.
       * matchTracksToSetup resolves them after the CV run by finding whichever
       * track's feet were nearest at this timestamp.
       */
      players: [
        ...(selfPoint ? [{ x: selfPoint.x, y: selfPoint.y, isSelf: true, box: selfPoint.box }] : []),
        ...(partnerPoint
          ? [{ x: partnerPoint.x, y: partnerPoint.y, isSelf: false, label: PARTNER_SEED_LABEL, box: partnerPoint.box }]
          : []),
      ],
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
          const j = (await run.json().catch(() => ({}))) as { error?: string; upgrade?: UpgradeOfferData | null };
          // Out of minutes is not an error to apologise for; it is a price.
          // Show the way on rather than only the wall.
          if (run.status === 429 && j.upgrade) setUpgrade(j.upgrade);
          // The setup itself saved, so say that rather than implying it was lost.
          setError(run.status === 429
            ? (j.error ?? "You're out of free minutes this month.")
            : `Setup saved, but processing would not start: ${j.error ?? "unknown error"}`);
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
  /**
   * ONE REQUIREMENT: the court is where the court is.
   *
   * This is the only thing that has to be settled before the analysis runs,
   * and it is required rather than optional now. Everything measured in feet
   * hangs off this quad -- how far you stood off the kitchen line, how much
   * ground you covered, which zone a shot was played from -- and a court that
   * is subtly wrong does not produce missing numbers, it produces confident
   * wrong ones. There is no honest way to report that after the fact, because
   * the numbers look exactly like correct numbers.
   *
   * It is a confirmation, not a survey: a court is always drawn on the frame
   * when this screen opens, from a saved preset when there is one and a
   * sensible default otherwise. The work is looking at it, and dragging a
   * corner only if it is off.
   */
  /**
   * BOTH, NOW. The court, and which player is you.
   *
   * Tagging used to be optional here and happened after the analysis instead.
   * That cost a whole Gemini pass: the run either skipped the coaching read
   * and needed re-running once somebody tagged themselves, or wrote a read
   * about whoever the pipeline guessed. Asking the one question only the user
   * can answer BEFORE the expensive part means it is paid for once.
   *
   * Always satisfiable, which is what makes it fair to require: when the
   * detector found nobody, a tap on bare court is a valid answer and produces
   * exactly the same kind of seed.
   */
  const ready = courtDone && selfPoint !== null;

  return (
    <div className="stack g4">
      <video
        ref={videoRef}
        src={videoUrl}
        /*
         * METADATA, NOT AUTO. On a phone this is the difference between a
         * usable screen and a spinner.
         *
         * `preload="auto"` asks the browser to fetch as much of the file as it
         * can before anything happens. A phone clip of a pickleball game is
         * commonly half a gigabyte, so on a cellular connection that is a
         * multi-minute download of footage this screen never displays. What it
         * actually needs is the video's dimensions, its duration, and ONE
         * frame about five seconds in -- metadata plus a seek, which fetches a
         * few hundred kilobytes by range request instead of the whole film.
         *
         * Reported as "the website takes forever to load the video when I
         * upload on mobile", which is exactly what this was.
         */
        preload="metadata"
        playsInline
        muted
        crossOrigin={videoUrl.startsWith("blob:") ? undefined : "anonymous"}
        style={{ display: "none" }}
        /*
         * SIZING AT METADATA, which is when the dimensions are known and long
         * before any frame exists. This used to live in onLoadedData, which
         * worked only because preload="auto" meant a frame arrived at nearly
         * the same moment. With metadata-only that event comes after the seek
         * below, so leaving the layout there would leave the canvas the wrong
         * shape until a frame decoded.
         */
        onLoadedMetadata={() => {
          const v = videoRef.current;
          const box = frameBoxRef.current;
          setDuration(v?.duration ?? 0);
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
          // The seek is what fetches a frame now. Five seconds in rather than
          // zero, because the first moment of a clip is usually somebody still
          // holding the phone.
          seek(time || 5);
        }}
        onLoadedData={() => {
          // Fires once a frame is decodable, which with metadata-only preload
          // is after the seek above rather than on load.
          setVideoReady(true);
          draw();
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
              : "crosshair",
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
              {ready
                ? "Ready to analyse"
                : !courtDone ? "Place the court to start" : "Tap yourself to finish"}
            </span>
          </div>

          {/*
            TWO TILES: the court, and who you are.

            Both are answers the software cannot supply and cannot recover from
            getting wrong, and both are cheap to give HERE and expensive to give
            anywhere else. The court because every distance in the read hangs
            off it; the identity because the coaching pass cannot be written
            without it -- and asking afterwards meant either skipping that pass
            and re-running it, or writing a read about whoever the pipeline
            guessed. One Gemini call instead of two.
          */}
          <div
            className="stack g2"
            style={{
              padding: "var(--a4)",
              borderRadius: "var(--r3)",
              background: courtDone ? "var(--good-wash)" : "var(--warn-wash)",
              border: `1px solid ${courtDone ? "var(--good)" : "var(--warn)"}`,
            }}
          >
            <div className="row g2" style={{ alignItems: "center" }}>
              <span style={{
                width: 22, height: 22, borderRadius: "50%", display: "grid", placeItems: "center",
                background: courtDone ? "var(--good)" : "var(--warn)", color: "#fff",
                fontSize: 12, fontWeight: 700, flex: "none",
              }}>
                {courtDone ? "\u2713" : "1"}
              </span>
              <strong style={{ fontSize: 15 }}>Does the court line up?</strong>
            </div>
            <p className="sm" style={{ margin: 0, color: courtDone ? "var(--good)" : "var(--warn)" }}>
              {courtDone
                ? "Check the blue lines sit on the painted ones — the kitchen line and the centre line as well as the outside. Drag any yellow corner that is off."
                : "No court on the frame yet. Press “Fit the court” to lay one down, then drag its corners onto the painted lines."}
            </p>
            <div className="row g2" style={{ flexWrap: "wrap" }}>
              <button type="button" className="btn btn-sm btn-soft" onClick={openCourt}>
                {courtDone ? "Fit the court" : "Lay a court down"}
              </button>
            </div>
            {/*
              SAID OUT LOUD, because "it will be less accurate" is not what
              happens. A court that is subtly wrong produces numbers that look
              exactly like right ones -- feet off the kitchen, ground covered,
              which zone a shot came from -- and nothing downstream can tell
              they are wrong or warn anybody. That is why this screen is a gate
              now rather than a suggestion.
            */}
            <p className="sm measure" style={{ margin: 0, color: "var(--ink-3)" }}>
              Every distance in the read is measured off this outline. If it is
              in the wrong place the numbers are still produced, and they are
              still wrong — so this is worth the ten seconds.
            </p>
            {/*
              THE COURT, JUDGED BY ITS CONSEQUENCES. An outline can look
              plausible and still be a court away, or wide enough to swallow
              the people waiting behind the fence. Who ended up inside it is
              the check that catches both, and it is the same gate the
              analysis will use: anyone standing outside is a spectator and is
              never tracked.
            */}
            {detected.length > 0 || offCourt > 0 ? (
              /*
                "INSIDE IT" ONLY WHEN THERE IS AN IT.
                This read "4 people are inside it. That is the same gate the
                analysis will use." directly under "No court on the frame yet"
                -- two sentences that cannot both be true, in the same box,
                four lines apart. With no court nothing was gated, so the
                count is just how many people the detector found.
              */
              <p className="sm" style={{ margin: 0, color: "var(--ink-2)" }}>
                {gated === false ? (
                  <>
                    <strong>{detected.length}</strong>
                    {detected.length === 1 ? " person was" : " people were"} found on this
                    frame, but with no court there was nothing to rule anyone out of — so
                    that count includes anyone waiting or walking past.
                  </>
                ) : (
                  <>
                    <strong>{detected.length}</strong>
                    {detected.length === 1 ? " person is" : " people are"} inside it
                    {offCourt > 0
                      ? `, and ${offCourt} ${offCourt === 1 ? "is" : "are"} outside and will be ignored as spectators`
                      : ""}
                    . {detected.length > 4
                      ? "More than four inside means the outline is reaching past your court."
                      : "That is the same gate the analysis will use."}
                  </>
                )}
              </p>
            ) : null}
          </div>

          {/* --- step 2: who is you ---------------------------------- */}
          <div
            className="stack g2"
            style={{
              padding: "var(--a4)",
              borderRadius: "var(--r3)",
              background: selfPoint ? "var(--good-wash)" : "var(--warn-wash)",
              border: `1px solid ${selfPoint ? "var(--good)" : "var(--warn)"}`,
            }}
          >
            <div className="row g2" style={{ alignItems: "center" }}>
              <span style={{
                width: 22, height: 22, borderRadius: "50%", display: "grid", placeItems: "center",
                background: selfPoint ? "var(--good)" : "var(--warn)", color: "#fff",
                fontSize: 12, fontWeight: 700, flex: "none",
              }}>
                {selfPoint ? "\u2713" : "2"}
              </span>
              <strong style={{ fontSize: 15 }}>Which player is you?</strong>
            </div>
            <p className="sm" style={{ margin: 0, color: selfPoint ? "var(--good)" : "var(--warn)" }}>
              {!courtDone
                ? "Place the court first — while a corner is missing, a tap adds one."
                : !selfPoint
                  ? (detected.length > 0 && onDetFrame
                      ? "Tap yourself on the frame. Tap a green box, or anywhere at your feet if the box is missing."
                      : "Nobody was detected on this frame, so tap the spot on the court where you are standing.")
                  : tagging === "partner" && !partnerPoint
                    ? "Got you. Now tap your partner if you want a read on how you two play together — or skip it and analyse."
                    : "You and your partner are marked. Tap either one again to move it."}
            </p>
            {courtDone && detectedAt !== null && detected.length > 0 && !onDetFrame ? (
              <button type="button" className="btn btn-sm btn-soft" onClick={() => seek(selfPoint?.t ?? detectedAt)}>
                {selfPoint ? "Back to the frame you were tagged on" : "Back to the frame with the player boxes"}
              </button>
            ) : null}
            {(selfPoint || partnerPoint) ? (
              <div className="row g2" style={{ flexWrap: "wrap" }}>
                <button
                  type="button"
                  className={`btn btn-sm ${tagging === "self" ? "btn-soft" : "btn-ghost"}`}
                  onClick={() => setTagging("self")}
                >
                  {selfPoint ? "Re-tap me" : "Tap me"}
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${tagging === "partner" ? "btn-soft" : "btn-ghost"}`}
                  disabled={!selfPoint}
                  onClick={() => setTagging("partner")}
                >
                  {partnerPoint ? "Re-tap partner" : "Tap my partner"}
                </button>
                {partnerPoint ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => { setPartnerPoint(null); setTagging("partner"); }}
                  >
                    Remove partner
                  </button>
                ) : null}
              </div>
            ) : null}
            {/*
              THE CASE WHERE THE BOXES ARE PROBABLY WRONG, said plainly and
              where it will be read.

              With no court fitted nothing can be ruled off it, so the boxes
              are simply the detector's most confident people -- and confidence
              tracks how close somebody is to the camera, so on a public court
              they land on whoever is standing at the fence rather than on the
              four playing at the far end. That is a real reported failure, and
              the fix is in the user's hands: fit the court, then re-detect.
            */}
            {gated === false && detected.length > 0 ? (
              <p className="sm measure" style={{ margin: 0, color: "var(--warn)" }}>
                No court was fitted, so these boxes were not checked against one —
                they are just the people the detector was surest about, which is
                usually whoever is nearest the camera rather than whoever is
                playing. Fit the court above and press “Fit the court” again to
                re-detect, or just tap yourself directly.
              </p>
            ) : null}
            {/*
              WHAT THE PARTNER TAG BUYS, said rather than implied. It is
              optional and it is the only way to get the partnership section,
              so somebody who skips it should know what they skipped -- and
              somebody who cannot tell which player is their partner should not
              feel obliged to guess.
            */}
            <p className="sm measure" style={{ margin: 0, color: "var(--ink-3)" }}>
              Tagging your partner is optional. It is what unlocks the read on
              how well the two of you work together — spacing, who takes the
              middle, whether you get to the kitchen line as a pair.
            </p>
          </div>

          <div className="row g2" style={{ alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || !ready}
              title={ready ? undefined : (courtDone ? "Tap yourself on the frame first" : "Place the court first")}
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
                Green boxes are detected players; the one you tap as yourself turns
                yellow, and your partner turns cyan.
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

          {/* The three-step bar is gone with the three steps. It said
              "court, players, which one is you", and two of those moved to
              after the analysis. A stepper with one step in it is furniture. */}
          <div className="grid2">
            <div className="stack g2">
              <strong style={{ fontSize: 14 }}>Court &amp; net</strong>
              {/*
                ONE SENTENCE, AND IT IS THE SAME SENTENCE EVERY TIME.
                This used to read out a four-step script -- near-left, then
                near-right, then far-right, then far-left -- which meant the
                instruction changed under you as you worked and a corner placed
                out of order could not be placed at all. There is always a court
                on the frame now, so there is only ever one thing to say.
              */}
              <p className="sm" style={{ margin: 0, opacity: 0.75 }}>
                Drag the four yellow corners onto the corners of the court. The
                kitchen line, centre line and net follow them — when those sit on
                the painted lines, it is right.
              </p>
              <div className="row g2" style={{ flexWrap: "wrap" }}>
                <button
                  type="button" className="btn btn-ghost btn-sm"
                  onClick={clearCourt}
                >
                  Start the court over
                </button>
              </div>
              {/*
                MARK A COURT ONCE, REUSE IT FOREVER.
                Inside the court tools rather than on the front panel: someone
                filming from the same fence post every week should answer this
                question once, and someone who has never opened this panel
                should not have to read about it.
              */}
              <CourtPresetBar
                corners={corners}
                lineColorHex={lineColor}
                matchMode={matchMode}
                readFrameSize={() => {
                  const v = videoRef.current;
                  return v && v.videoWidth > 0 && v.videoHeight > 0
                    ? { width: v.videoWidth, height: v.videoHeight }
                    : null;
                }}
                onApply={(next) => { commit(); setCorners(next); }}
              />

              {/* The example, shown only while the corners are actually being
                  placed. Once they are down the reader has the answer and the
                  diagram is just a thing taking up room. */}
              {corners.length < 4 ? <CornerGuide compact /> : null}
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
                if (corners.length > 0 && !window.confirm(
                  "Replace the court you have marked with a fresh detection?"
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
      {upgrade ? <UpgradeOffer offer={upgrade} /> : null}
    </div>
  );
}
