#!/usr/bin/env python3
"""Bake-off: several ball detectors, two ways of feeding each one frames.

Answers two questions in one run:

  1. Is some other Roboflow Universe model better than the one in use?
  2. Does tiled inference get more out of a model than a whole-frame pass?

Whole-frame inference is what pb-analyzer's detect_ball.py does. Tiled
inference cuts the frame into overlapping crops and runs each at native scale.
The claim being tested is specific: a detector letterboxes whatever you give it
down to roughly 640 px internally, so a ball 8 px across in a 1280-wide frame is
about 4 px by the time the network sees it -- below what a stride-8 detection
head can represent at all. Cutting the frame in half in each direction doubles
the ball's size at the point it matters.

The metric is **in-play coverage**: of the frames inside a labelled rally, how
many had the ball found at all. Raw detection count is the wrong metric -- a
model that fires on every fence post scores well on it -- so dead-time
detections per frame are reported alongside as the cost side. A model that
gains 10 points of coverage while doubling its dead-time firing has not
necessarily won.

Runs on the system python (needs `inference`, `opencv-python`, `numpy`) -- the
same interpreter that ran detect_ball.py.

    python3 tools/compare_detection.py ~/Downloads/ky-720p.mp4 \\
        --labels ~/Downloads/pb-analyzer/shot-results/ky-720p/truth.json \\
        --start 25 --end 36
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np


# --- inference ---------------------------------------------------------------


def load_model(model_id: str, api_key: str, confidence: float):
    from inference import get_model

    return get_model(model_id=model_id, api_key=api_key)


#: Multi-class models exist -- pickleball-vision detects Ball *and* Court -- so
#: a comparison that counts every box would credit one model for finding a court
#: and call it ball detection.  Matched loosely because class names vary
#: ("ball", "Ball", "pickleball", "sports ball"), and an empty name means a
#: single-class model where everything it emits is the ball.
BALL_CLASS_HINTS = ("ball", "pickleball", "sports ball", "sports_ball")


def is_ball_class(name: str) -> bool:
    n = (name or "").strip().lower()
    return n == "" or any(h in n for h in BALL_CLASS_HINTS)


class ModelFailed(Exception):
    """This model could not process this frame."""


def infer(model, image: np.ndarray, confidence: float) -> List[Tuple[float, float, float, float, float]]:
    """-> [(cx, cy, w, h, conf)] in this image's pixel coordinates."""
    try:
        res = model.infer(image, confidence=confidence)
    except Exception as exc:                      # noqa: BLE001 - see below
        # Deliberately broad. Some models die mid-run on a specific frame --
        # an RF-DETR export hitting an unsupported CoreML op, for instance.
        # A bake-off that throws away three working models because a fourth
        # crashed on frame 150 is worse than useless, so a failing model is
        # dropped from the comparison and the rest carry on.
        raise ModelFailed(str(exc)[:200]) from exc
    res = res[0] if isinstance(res, list) else res
    out = []
    for p in getattr(res, "predictions", []) or []:
        if not is_ball_class(getattr(p, "class_name", "") or getattr(p, "class", "")):
            continue
        out.append((float(p.x), float(p.y), float(p.width), float(p.height), float(p.confidence)))
    return out


def tiles(image: np.ndarray, rows: int, cols: int, overlap: float):
    h, w = image.shape[:2]
    th, tw = int(np.ceil(h / rows)), int(np.ceil(w / cols))
    py, px = int(th * overlap), int(tw * overlap)
    for r in range(rows):
        for c in range(cols):
            y0, y1 = max(0, r * th - py), min(h, (r + 1) * th + py)
            x0, x1 = max(0, c * tw - px), min(w, (c + 1) * tw + px)
            yield image[y0:y1, x0:x1], x0, y0


def nms(dets, iou_thresh=0.45):
    if not dets:
        return []
    boxes = np.array([[d[0] - d[2] / 2, d[1] - d[3] / 2, d[0] + d[2] / 2, d[1] + d[3] / 2] for d in dets])
    scores = np.array([d[4] for d in dets])
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = int(order[0])
        keep.append(i)
        if order.size == 1:
            break
        rest = order[1:]
        xx1 = np.maximum(boxes[i, 0], boxes[rest, 0])
        yy1 = np.maximum(boxes[i, 1], boxes[rest, 1])
        xx2 = np.minimum(boxes[i, 2], boxes[rest, 2])
        yy2 = np.minimum(boxes[i, 3], boxes[rest, 3])
        inter = np.clip(xx2 - xx1, 0, None) * np.clip(yy2 - yy1, 0, None)
        a_i = (boxes[i, 2] - boxes[i, 0]) * (boxes[i, 3] - boxes[i, 1])
        a_r = (boxes[rest, 2] - boxes[rest, 0]) * (boxes[rest, 3] - boxes[rest, 1])
        order = rest[(inter / np.maximum(1e-6, a_i + a_r - inter)) <= iou_thresh]
    return [dets[i] for i in keep]


# --- comparison --------------------------------------------------------------


def main(argv=None) -> int:
    ap = argparse.ArgumentParser("compare_detection")
    ap.add_argument("video")
    ap.add_argument("--labels", help="truth.json — [[startS,endS], ...]")
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--end", type=float, default=None)
    ap.add_argument("--models", nargs="+", default=None,
                    help="Roboflow model ids, e.g. pickleball-video/5. Defaults to BALL_MODEL_ID.")
    ap.add_argument("--modes", nargs="+", default=["whole", "tiled"],
                    choices=["whole", "tiled"])
    ap.add_argument("--confidence", type=float, default=0.20)
    ap.add_argument("--rows", type=int, default=2)
    ap.add_argument("--cols", type=int, default=2)
    ap.add_argument("--overlap", type=float, default=0.2)
    ap.add_argument("--out", default=None, help="write the raw numbers as JSON")
    ap.add_argument("--video-out", dest="video_out", default=None,
                    help="write a side-by-side video, one panel per model/mode")
    ap.add_argument("--trail", type=int, default=12,
                    help="frames of detection history drawn behind the ball")
    args = ap.parse_args(argv)

    api_key = os.environ.get("ROBOFLOW_API_KEY", "")
    model_ids = args.models or ([os.environ["BALL_MODEL_ID"]]
                                if os.environ.get("BALL_MODEL_ID") else [])
    if not (model_ids and api_key):
        print("Need --models (or BALL_MODEL_ID) and ROBOFLOW_API_KEY in the environment.",
              file=sys.stderr)
        print("  set -a && source .env.local && set +a", file=sys.stderr)
        return 2

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(f"cannot open {args.video}", file=sys.stderr)
        return 1
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    first = int(round(args.start * fps))
    last = int(round(args.end * fps)) if args.end else int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.set(cv2.CAP_PROP_POS_FRAMES, first)

    truth = []
    if args.labels:
        with open(args.labels) as fh:
            raw = json.load(fh)
        truth = [(float(a), float(b)) for a, b in (raw.get("rallies", raw) if isinstance(raw, dict) else raw)]

    def in_rally(t):
        return any(a <= t <= b for a, b in truth)

    # Load every model up front, so a bad id fails now rather than 20 minutes in.
    models = {}
    for mid in model_ids:
        try:
            print(f"loading {mid} …")
            models[mid] = load_model(mid, api_key, args.confidence)
        except Exception as exc:
            print(f"  ! could not load {mid}: {str(exc)[:160]}")
    if not models:
        print("no models loaded", file=sys.stderr)
        return 2

    n = last - first
    combos = [(mid, mode) for mid in models for mode in args.modes]
    print(f"\n{n} frames, {args.start:.0f}s to {(args.end or last / fps):.0f}s, "
          f"{len(combos)} model/mode combinations")
    if "tiled" in args.modes:
        print(f"tiling: {args.rows}x{args.cols} at {args.overlap:.0%} overlap")
    print(f"modes: {', '.join(args.modes)}\n")

    stats = {c: {"frames": 0, "hits": 0, "dets": 0, "conf": [], "live_frames": 0,
                 "live_hits": 0, "dead_frames": 0, "dead_dets": 0, "time": 0.0}
             for c in combos}

    # --- side-by-side video ------------------------------------------------
    writer = None
    trails: Dict[tuple, list] = {c: [] for c in combos}
    panel_w, panel_h = 640, 360
    ncols = 2 if len(combos) > 1 else 1
    nrows = int(np.ceil(len(combos) / ncols))
    if args.video_out:
        for fourcc in ("avc1", "mp4v"):
            writer = cv2.VideoWriter(args.video_out, cv2.VideoWriter_fourcc(*fourcc),
                                     fps, (panel_w * ncols, panel_h * nrows))
            if writer.isOpened():
                break
            writer.release()
            writer = None
        if writer is None:
            print("! could not open a video writer; continuing without video")

    def panel(frame, combo, dets, live):
        """One model's view of this frame."""
        img = cv2.resize(frame, (panel_w, panel_h))
        sx, sy = panel_w / frame.shape[1], panel_h / frame.shape[0]

        # Detection history, oldest faintest -- makes jitter and false positives
        # obvious in a way a single frame cannot.
        hist = trails[combo]
        for age, past in enumerate(hist):
            f = (age + 1) / max(1, len(hist))
            for (x, y, _w, _h, _c) in past:
                cv2.circle(img, (int(x * sx), int(y * sy)), 2,
                           (int(60 * f), int(160 * f), int(220 * f)), -1)

        for (x, y, w, h, c) in dets:
            p = (int(x * sx), int(y * sy))
            cv2.circle(img, p, 9, (60, 235, 255), 2, cv2.LINE_AA)
            cv2.putText(img, f"{c:.2f}", (p[0] + 12, p[1] - 8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, (60, 235, 255), 1, cv2.LINE_AA)

        bar = img.copy()
        cv2.rectangle(bar, (0, 0), (panel_w, 26), (24, 24, 28), -1)
        cv2.addWeighted(bar, 0.75, img, 0.25, 0, img)
        mid, mode = combo
        label = f"{mid}  [{mode}]"
        cv2.putText(img, label[:46], (8, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.45,
                    (238, 238, 238), 1, cv2.LINE_AA)
        n = f"{len(dets)} det"
        cv2.putText(img, n, (panel_w - 66, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.45,
                    (120, 230, 150) if dets else (110, 110, 200), 1, cv2.LINE_AA)
        # Green edge while a labelled rally is in progress: the ball should be
        # findable in every one of these frames.
        cv2.rectangle(img, (0, 0), (panel_w - 1, panel_h - 1),
                      (90, 210, 120) if live else (70, 70, 80), 2)
        return img

    failed: Dict[str, str] = {}

    def detect(model, frame, mode):
        if mode == "whole":
            return infer(model, frame, args.confidence)
        merged = []
        for crop, ox, oy in tiles(frame, args.rows, args.cols, args.overlap):
            for (x, y, w, h, c) in infer(model, crop, args.confidence):
                merged.append((x + ox, y + oy, w, h, c))
        return nms(merged)

    for k in range(n):
        ok, frame = cap.read()
        if not ok:
            break
        t = (first + k) / fps
        live = in_rally(t)

        panels = []
        for combo in list(combos):
            mid, mode = combo
            if mid in failed:
                continue
            t0 = time.time()
            try:
                dets = detect(models[mid], frame, mode)
            except ModelFailed as exc:
                failed[mid] = f"frame {first + k}: {exc}"
                print(f"  ! {mid} failed and is dropped from the comparison — {exc}")
                continue
            s = stats[combo]
            s["time"] += time.time() - t0
            s["frames"] += 1
            s["dets"] += len(dets)
            if dets:
                s["hits"] += 1
                s["conf"].append(max(d[4] for d in dets))
            if live:
                s["live_frames"] += 1
                s["live_hits"] += int(bool(dets))
            else:
                s["dead_frames"] += 1
                s["dead_dets"] += len(dets)

            if writer is not None:
                panels.append(panel(frame, combo, dets, live))
                trails[combo].append(dets)
                if len(trails[combo]) > args.trail:
                    trails[combo].pop(0)

        if writer is not None and panels:
            while len(panels) < ncols * nrows:
                panels.append(np.zeros((panel_h, panel_w, 3), np.uint8))
            grid = np.vstack([np.hstack(panels[r * ncols:(r + 1) * ncols])
                              for r in range(nrows)])
            cv2.putText(grid, f"t={t:6.2f}s   {'RALLY' if live else 'dead time'}",
                        (10, grid.shape[0] - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                        (238, 238, 238), 2, cv2.LINE_AA)
            writer.write(grid)

        if (k + 1) % 25 == 0:
            best = max(combos, key=lambda c: stats[c]["live_hits"])
            print(f"  {k+1}/{n} frames · leading: {best[0]} ({best[1]}) "
                  f"{stats[best]['live_hits']}/{max(1, stats[best]['live_frames'])} in play")

    cap.release()
    if writer is not None:
        writer.release()
        print(f"\nwrote {args.video_out}")

    width = max(len(m) for m in models) + 8
    print("\n" + "=" * (width + 46))
    any_stat = next(iter(stats.values()))
    print(f"window: {any_stat['live_frames']} frames in play, "
          f"{any_stat['dead_frames']} in dead time")
    if any_stat["dead_frames"] < 20:
        print("! too few dead-time frames for the dead/frame column to mean anything —"
              " widen the window past a rally boundary")
    print(f"{'model / mode':<{width}} {'in-play':>9} {'dead/frame':>11} "
          f"{'conf':>6} {'sec/frame':>10}")
    print("-" * (width + 46))
    live = [c for c in combos if c[0] not in failed]
    ranked = sorted(live, key=lambda c: -(stats[c]["live_hits"] / max(1, stats[c]["live_frames"])))
    for combo in ranked:
        mid, mode = combo
        s = stats[combo]
        cov = s["live_hits"] / max(1, s["live_frames"])
        dead = s["dead_dets"] / max(1, s["dead_frames"])
        conf = float(np.median(s["conf"])) if s["conf"] else 0.0
        per = s["time"] / max(1, s["frames"])
        print(f"{mid + ' (' + mode + ')':<{width}} {cov:8.1%} {dead:11.2f} "
              f"{conf:6.2f} {per:9.2f}s")
    print("=" * (width + 46))
    for mid, why in failed.items():
        print(f"{mid:<{width}} DROPPED — {why}")
    print("\nin-play coverage: fraction of frames inside a labelled rally where the")
    print("ball was found at all -- the number that decides whether rally boundaries")
    print("are recoverable. dead/frame is the cost side: detections per frame between")
    print("points, most of which are false. A model that wins on coverage while")
    print("firing twice as often in dead time has not necessarily won.")

    per_frame = []
    if args.out:
        with open(args.out, "w") as fh:
            json.dump({"stats": {f"{m}|{mode}": {k: v for k, v in s.items() if k != "conf"}
                                 for (m, mode), s in stats.items()}}, fh)
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
