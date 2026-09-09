"""Score this segmenter against pb-analyzer's existing results.

The point of the feature stream being a contract is that anything which can
produce one can be segmented.  pb-analyzer already has ball detections, player
tracks and a court calibration on disk for its labelled clips — so those can be
lifted straight into a FeatureStream and run through the state machine without
decoding a single frame or spending a single Roboflow credit.

That isolates exactly the question worth asking first: given the *same*
perception, does different segmentation logic do better? If it does, the
detector was never the bottleneck.

    python tools/from_pb_analyzer.py ~/Downloads/pb-analyzer/shot-results/ky-720p

Reads `ball.json`, `tracks.json` and `truth.json` from the directory; writes
nothing unless asked.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from rally_seg.config import Config, load_config
from rally_seg.detect.ball import Detection
from rally_seg.detect.court import CourtModel, FallbackCourt
from rally_seg.events import EventDetector
from rally_seg.evaluate import Interval, evaluate
from rally_seg.features import FeatureBuilder, FeatureStream
from rally_seg.models.rule_based import RuleBasedSegmenter
from rally_seg.track.ball_track import BallTracker


class ImportedTrack:
    """Minimal stand-in for a tracked player, shaped like track.bytetrack.Track.

    Only the four attributes the event detector and feature builder actually
    read are provided.  Duck-typing rather than subclassing keeps this file
    honest: if the pipeline starts depending on more, this breaks loudly instead
    of silently feeding it zeros.
    """

    def __init__(self, track_id: int, x1: float, y1: float, x2: float, y2: float,
                 vx: float, vy: float):
        self.id = track_id
        self._xyxy = np.array([x1, y1, x2, y2], dtype=np.float32)
        self._v = (vx, vy)
        # x[3] is the box height, which is how activity gets scale-normalised.
        self.x = np.array([(x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1, vx, vy])

    @property
    def xyxy(self) -> np.ndarray:
        return self._xyxy

    @property
    def feet(self) -> np.ndarray:
        return np.array([(self._xyxy[0] + self._xyxy[2]) / 2, self._xyxy[3]], dtype=np.float32)

    @property
    def speed_px(self) -> float:
        return float(np.hypot(*self._v))


def court_from_calibration(cal: dict, size: Tuple[int, int], min_area_frac: float = 0.05):
    """Build a CourtModel from pb-analyzer's four image corners.

    Rejected outright when the quad is implausible, because a wrong homography
    is worse than none: it turns every out-of-bounds test into a coin flip while
    still reporting a confident-looking number.
    """
    corners = cal.get("cornersImagePx") if cal else None
    if not corners:
        return None, "no cornersImagePx in calibration"
    try:
        tl = corners["topLeft"]; tr = corners["topRight"]
        bl = corners["bottomLeft"]; br = corners["bottomRight"]
    except KeyError:
        return None, "calibration corners incomplete"

    # rally_seg's canonical order is near-left, near-right, far-right, far-left,
    # and "near" is the bottom of the image.
    quad = np.array([bl, br, tr, tl], dtype=np.float32)
    w, h = size
    area = abs(_shoelace(quad))
    frac = area / float(w * h)
    if frac < min_area_frac:
        return None, f"court quad covers only {frac:.1%} of the frame — not a court"

    ys = quad[:, 1]
    if (ys.max() - ys.min()) < 0.12 * h:
        return None, f"court quad is only {int(ys.max() - ys.min())}px tall — not a court"

    return CourtModel.from_corners(quad, size, confidence=float(cal.get("confidence", 0.5)),
                                   source="pb-analyzer"), None


def _shoelace(pts: np.ndarray) -> float:
    x, y = pts[:, 0], pts[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def load_detect_ball(path: str) -> dict:
    """Read a `scripts/cv/detect_ball.py` output file.

    Different shape from `ball.json`: raw per-frame detections with box sizes,
    no interpolation, no contacts, no calibration.  Every point is a real model
    output, which is exactly what this pipeline wants.
    """
    with open(path, "r", encoding="utf-8") as fh:
        d = json.load(fh)
    w, h = int(d["width"]), int(d["height"])
    fps = float(d.get("sourceFps") or d.get("fps") or 30.0)
    # Keep the highest-confidence candidate per frame; the tracker is what
    # decides between candidates, and it only wants one measurement per frame.
    best: Dict[int, dict] = {}
    for x in d.get("detections", []):
        f = int(x["frame"])
        if f not in best or x["conf"] > best[f]["conf"]:
            best[f] = x
    points = [
        {"t": float(x["t"]), "x": float(x["x"]), "y": float(x["y"]),
         "conf": float(x["conf"]), "interpolated": False,
         "w": float(x.get("w", 0.0)) * w, "h": float(x.get("h", 0.0)) * h}
        for x in sorted(best.values(), key=lambda v: v["t"])
    ]
    return {"size": (w, h), "fps": fps, "points": points,
            "frames": int(d.get("framesProcessed", 0))}


def load(dirpath: str, use_interpolated: bool = False) -> dict:
    with open(os.path.join(dirpath, "ball.json"), encoding="utf-8") as fh:
        ball = json.load(fh)
    with open(os.path.join(dirpath, "tracks.json"), encoding="utf-8") as fh:
        tracks = json.load(fh)
    truth_path = os.path.join(dirpath, "truth.json")
    truth = []
    if os.path.exists(truth_path):
        with open(truth_path, encoding="utf-8") as fh:
            truth = [Interval(float(a), float(b)) for a, b in json.load(fh)]

    w = int(ball.get("frameWidthPx", 1280))
    h = int(ball.get("frameHeightPx", 720))

    points = [p for p in ball.get("points", [])
              if use_interpolated or not p.get("interpolated")]
    return {
        "name": os.path.basename(dirpath.rstrip("/")),
        "size": (w, h),
        "duration_s": float(ball.get("durationSeconds", 0.0)),
        "points": points,
        "all_points": ball.get("points", []),
        "contacts": [float(t) for t in ball.get("contacts", [])],
        "tracks": tracks,
        "truth": truth,
        "calibration": ball.get("calibration"),
    }


def resample_tracks(tracks: Sequence[dict], times: np.ndarray,
                    size: Tuple[int, int]) -> List[List[ImportedTrack]]:
    """Put pb-analyzer's 5 fps player boxes onto the ball timeline.

    Linear interpolation, and a track contributes nothing outside its own time
    span — extrapolating a player's position into the dead time between points
    would manufacture exactly the activity the state machine is trying to detect
    the absence of.
    """
    w, h = size
    out: List[List[ImportedTrack]] = [[] for _ in times]
    for ti, track in enumerate(tracks):
        pts = sorted(track.get("points", []), key=lambda p: p["timestampSeconds"])
        if len(pts) < 2:
            continue
        ts = np.array([p["timestampSeconds"] for p in pts])
        boxes = np.array([[p["boxImageNorm"]["x"] * w, p["boxImageNorm"]["y"] * h,
                           p["boxImageNorm"]["width"] * w, p["boxImageNorm"]["height"] * h]
                          for p in pts])
        inside = (times >= ts[0]) & (times <= ts[-1])
        if not inside.any():
            continue
        interp = np.stack([np.interp(times, ts, boxes[:, k]) for k in range(4)], axis=1)
        for i in np.nonzero(inside)[0]:
            x, y, bw, bh = interp[i]
            if i > 0 and inside[i - 1]:
                vx = (interp[i, 0] - interp[i - 1, 0])
                vy = (interp[i, 1] - interp[i - 1, 1])
            else:
                vx = vy = 0.0
            out[i].append(ImportedTrack(ti + 1, x, y, x + bw, y + bh, vx, vy))
    return out


def build_stream(clip: dict, cfg: Config, verbose: bool = True) -> Tuple[FeatureStream, dict]:
    w, h = clip["size"]
    points = clip["points"]
    if not points:
        raise SystemExit("no ball detections in ball.json")

    times = np.array(sorted({round(float(p["t"]), 4) for p in points}))
    # Fill the timeline out to a uniform grid so gaps read as gaps rather than
    # as time that never existed.
    dt = float(np.median(np.diff(times))) if len(times) > 1 else 1 / 30.0
    fps = 1.0 / dt
    n = int(round(clip["duration_s"] / dt)) + 1
    grid = np.arange(n) * dt

    by_frame: Dict[int, List[Detection]] = {}
    for p in points:
        i = int(round(float(p["t"]) / dt))
        if 0 <= i < n:
            by_frame.setdefault(i, []).append(
                Detection(float(p["x"]) * w, float(p["y"]) * h, float(p.get("conf", 0.5)), 8.0, 8.0)
            )

    notes: List[str] = []
    if cfg.court.manual_points_path and os.path.exists(cfg.court.manual_points_path):
        from rally_seg.detect.court import CourtDetector
        court = CourtDetector(cfg.court).fit([], (w, h))
        why = None if hasattr(court, "H") else "manual calibration failed to load"
        if not hasattr(court, "H"):
            court = None
    else:
        court, why = court_from_calibration(clip["calibration"], (w, h))
    if court is None:
        notes.append(f"court rejected: {why}")
        court = FallbackCourt((w, h), cfg.court.fallback_net_y_frac)

    players_per_frame = resample_tracks(clip["tracks"], grid, (w, h))

    tracker = BallTracker(cfg.ball_track, fps)
    events = EventDetector(cfg.events, court, fps, (w, h), cfg.court.out_margin_ft)
    builder = FeatureBuilder(fps, w, h, court, audio_contacts=clip["contacts"])

    for i in range(n):
        dets = by_frame.get(i, [])
        players = players_per_frame[i]
        state = tracker.update(dets, float(grid[i]), i)
        frame_events = events.update(state, players, float(grid[i]), i)
        builder.add(float(grid[i]), i, state, players, frame_events, gray=None)

    stream = builder.build(meta={"source": "pb-analyzer", "clip": clip["name"], "fps": fps})
    info = {
        "fps": fps,
        "frames": n,
        "real_detections": len(points),
        "detection_rate": len(points) / max(1, n),
        "court": court.source if hasattr(court, "source") else "fallback",
        "notes": notes,
    }
    if verbose:
        print(f"  {clip['name']}: {n} frames at {fps:.1f} fps, "
              f"{len(points)} real ball detections ({info['detection_rate']:.0%} of frames)")
        print(f"  court: {info['court']}")
        for note in notes:
            print(f"  ! {note}")
    return stream, info


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser("from_pb_analyzer")
    ap.add_argument("dirs", nargs="+", help="pb-analyzer shot-results/<clip> directories")
    ap.add_argument("--config")
    ap.add_argument("--set", action="append", metavar="key=value", default=[])
    ap.add_argument("--interpolated", action="store_true",
                    help="also feed pb-analyzer's interpolated points as detections")
    ap.add_argument("--detections", metavar="PATH",
                    help="use a scripts/cv/detect_ball.py output instead of ball.json")
    ap.add_argument("--court", metavar="PATH", help="manual court calibration JSON")
    ap.add_argument("--save-features", metavar="DIR",
                    help="write each clip's feature stream here for calibration")
    ap.add_argument("--json", metavar="PATH", help="write the scores as JSON")
    args = ap.parse_args(argv)

    overrides = {}
    for item in args.set:
        k, v = item.split("=", 1)
        overrides[k.strip()] = v.strip()
    cfg = load_config(args.config, overrides)

    rows = []
    if args.court:
        cfg.court.manual_points_path = args.court

    for d in args.dirs:
        clip = load(d, use_interpolated=args.interpolated)
        if args.detections:
            swap = load_detect_ball(args.detections)
            clip["points"] = swap["points"]
            clip["size"] = swap["size"]
            clip["contacts"] = []          # detect_ball.py reports no contacts
            print(f"  using {len(swap['points'])} detections from {os.path.basename(args.detections)} "
                  f"at {swap['fps']:.1f} fps")
        print(f"\n=== {clip['name']} ===")
        stream, info = build_stream(clip, cfg)

        if args.save_features:
            os.makedirs(args.save_features, exist_ok=True)
            path = os.path.join(args.save_features, f"{clip['name']}.npz")
            stream.save(path)
            with open(os.path.join(args.save_features, f"{clip['name']}.truth.json"),
                      "w", encoding="utf-8") as fh:
                json.dump({"rallies": [{"start_s": t.start_s, "end_s": t.end_s}
                                       for t in clip["truth"]]}, fh, indent=2)
            print(f"  wrote {path}")

        segments = RuleBasedSegmenter(cfg.state).segment(stream)
        from collections import Counter
        kinds = Counter(e.kind for e in stream.events)
        print(f"  events: {dict(kinds)}")
        print(f"  {len(segments)} rallies predicted vs {len(clip['truth'])} labelled")
        for s in segments:
            print(f"    {s.start_s:7.2f} → {s.end_s:7.2f}  "
                  f"{s.start_reason.value:17s} {s.end_reason.value:17s} conf {s.confidence:.2f}")

        if clip["truth"]:
            report = evaluate(segments, clip["truth"])
            print("  " + report.summary().replace("\n", "\n  "))
            rows.append({"clip": clip["name"], "f1": report.f1,
                         "jump_accuracy": report.jump_accuracy,
                         "precision": report.precision, "recall": report.recall,
                         "mean_iou": report.mean_iou, **info})

    if rows:
        print("\n=== summary ===")
        for r in rows:
            print(f"  {r['clip']:28s} F1 {r['f1']:.3f}  jump {r['jump_accuracy']:.3f}  "
                  f"P {r['precision']:.3f}  R {r['recall']:.3f}")
        print(f"  worst-clip F1 {min(r['f1'] for r in rows):.3f} · "
              f"worst-clip jump {min(r['jump_accuracy'] for r in rows):.3f}")
    if args.json and rows:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
