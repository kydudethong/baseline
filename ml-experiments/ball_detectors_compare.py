#!/usr/bin/env python3
"""
Run several ball detectors over one clip and say which to actually use.

WHY N-WAY AND NOT PAIRWISE. The Sept-7 TrackNet benchmark already established
the shape of this problem: two detectors each found the ball in ~41% of frames,
but only 205 of those frames overlapped, so EITHER-ONE reached 59%. The
interesting quantity is not which detector wins, it is how much a detector adds
to the ones already in hand. A third detector that finds 30% of frames but 25%
of them in the others' blind spells is worth more than one that finds 45% in
the same places. That number cannot be read off a table of per-detector
coverage, so this computes it directly.

WHAT IS MEASURED, AND WHY NOT COVERAGE. Hit detection needs three consecutive
sightings to fit a direction change either side of a contact, so a track of
scattered singletons produces no contacts at all however good its coverage
looks. Every verdict here is in "frames inside a run of 3 or more".

DETECTORS

  roboflow   The current production detector, via scripts/cv/detect_ball.py --
            the same code path the app runs, so this is a real baseline rather
            than a reimplementation of one.

  yolo-coco  YOLOv8x, COCO class 32 ("sports ball"), the approach used by
            github.com/vinod-polinati/pickleball-rally-detection (MIT). It is
            worth testing precisely BECAUSE it is not pickleball-trained: its
            mistakes are uncorrelated with a purpose-trained model's, and
            uncorrelated mistakes are what made the TrackNet union worth 59%.
            The size and shoe filters below are from that project; without them
            COCO's "sports ball" class fires on shoes constantly.

  json:PATH  Any previously-saved run, so TrackNet or an old baseline can join
            the comparison without being re-run.

Usage:
  $CV_PYTHON ml-experiments/ball_detectors_compare.py CLIP.mp4 \
      --detectors roboflow,yolo-coco --seconds 60 [--out DIR] [--video]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time


def _load_env_local() -> None:
    """detect_ball.py reads its model id and key from the environment."""
    root = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    path = os.path.join(root, ".env.local")
    if not os.path.isfile(path):
        return
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env_local()

try:
    import cv2
    import numpy as np
except ModuleNotFoundError:
    cvp = os.environ.get("CV_PYTHON")
    if cvp and os.path.exists(cvp) and not os.environ.get("_PB_REEXEC"):
        os.environ["_PB_REEXEC"] = "1"
        os.execv(cvp, [cvp, os.path.abspath(__file__), *sys.argv[1:]])
    sys.exit(f"opencv/numpy missing for {sys.executable}. Try: $CV_PYTHON {__file__} ...")

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts", "cv"))
from video_writer import open_writer  # noqa: E402

# From the pickleball-rally-detection project (MIT). Kept as named constants
# rather than inlined so a future run can see what was assumed.
COCO_BALL_CLASS = 32
COCO_PERSON_CLASS = 0
MAX_BALL_PX = 65.0        # a ball bigger than this is equipment or a body part
SHOE_BAND_FRAC = 0.45     # bottom 45% of a player box
SHOE_BUFFER_PX = 40.0     # ...plus this much below the feet
YOLO_CONF = 0.15
YOLO_IMGSZ = 1280


# --------------------------------------------------------------------------
# Detectors. Each returns {frame_index: [ {x,y,w,h,conf} normalised ]}.
# --------------------------------------------------------------------------

def det_roboflow(video: str, seconds: float | None, workdir: str,
                 model_id: str | None = None, hosted: bool | None = None,
                 tag: str = "roboflow") -> dict:
    """Any Roboflow model, through the app's own detector.

    model_id=None means "whatever BALL_MODEL_ID says", i.e. the production
    baseline. Passing one runs a challenger through the identical code path,
    so the only difference between the two columns is the weights -- which is
    the whole point of a comparison.

    hosted matters for a reason that is not obvious: a "Roboflow Instant"
    model has no downloadable weights, so the local `inference` package cannot
    load it and it must go through the hosted API. Getting this wrong looks
    like the model being broken rather than being served the wrong way.
    """
    out_json = os.path.join(workdir, f"{tag.replace('/', '_')}.json")
    cmd = [sys.executable, os.path.join(ROOT, "scripts", "cv", "detect_ball.py"),
           video, "--out", out_json]
    if model_id:
        cmd += ["--model-id", model_id]
    if hosted:
        cmd += ["--hosted"]
    if seconds:
        cmd += ["--windows", json.dumps([[0, seconds]])]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f"roboflow detector failed:\n{proc.stderr[-1500:]}")
    res = json.load(open(out_json))
    by_frame: dict[int, list] = {}
    for d in res.get("detections", []):
        by_frame.setdefault(int(d["frame"]), []).append(d)
    return by_frame


def det_yolo_coco(video: str, seconds: float | None, workdir: str) -> dict:
    try:
        from ultralytics import YOLO
    except ModuleNotFoundError:
        sys.exit("ultralytics is not installed for this interpreter.\n"
                 "  pip install ultralytics    (the YOLOv8x weights download on first use)")
    model = YOLO(os.environ.get("COCO_WEIGHTS", "yolov8x.pt"))

    cap = cv2.VideoCapture(video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    last = int(seconds * fps) if seconds else int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    by_frame: dict[int, list] = {}
    f = 0
    while f <= last:
        ok, frame = cap.read()
        if not ok:
            break
        r = model.predict(frame, conf=YOLO_CONF, imgsz=YOLO_IMGSZ,
                          classes=[COCO_BALL_CLASS, COCO_PERSON_CLASS], verbose=False)[0]
        people, balls = [], []
        for b in r.boxes:
            x1, y1, x2, y2 = (float(v) for v in b.xyxy[0])
            cls, conf = int(b.cls[0]), float(b.conf[0])
            if cls == COCO_PERSON_CLASS:
                people.append((x1, y1, x2, y2))
            elif cls == COCO_BALL_CLASS:
                balls.append((x1, y1, x2, y2, conf))

        kept = []
        for (x1, y1, x2, y2, conf) in balls:
            bw, bh = x2 - x1, y2 - y1
            if bw > MAX_BALL_PX or bh > MAX_BALL_PX:
                continue                                   # equipment, not a ball
            cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
            # The shoe filter. COCO's "sports ball" fires on shoes more than on
            # anything else in court sport footage, and a shoe sits in the
            # bottom band of a person box or just under it.
            shoe = False
            for (px1, py1, px2, py2) in people:
                band_top = py2 - (py2 - py1) * SHOE_BAND_FRAC
                if px1 <= cx <= px2 and band_top <= cy <= py2 + SHOE_BUFFER_PX:
                    shoe = True
                    break
            if shoe:
                continue
            kept.append({"frame": f, "t": round(f / fps, 4),
                         "x": round(cx / W, 5), "y": round(cy / H, 5),
                         "w": round(bw / W, 5), "h": round(bh / H, 5),
                         "conf": round(conf, 4)})
        if kept:
            by_frame[f] = sorted(kept, key=lambda d: -d["conf"])[:3]
        f += 1
        if f % 300 == 0:
            print(f"  [yolo-coco] {f}/{last}", file=sys.stderr, flush=True)
    cap.release()
    json.dump({"detections": [d for v in by_frame.values() for d in v]},
              open(os.path.join(workdir, "yolo-coco.json"), "w"))
    return by_frame


def det_from_json(path: str) -> dict:
    res = json.load(open(path))
    dets = res.get("detections") or res.get("points") or []
    by_frame: dict[int, list] = {}
    for d in dets:
        if d.get("interpolated"):
            continue          # never credit a detector with a gap-filled point
        if "frame" not in d:
            continue
        by_frame.setdefault(int(d["frame"]), []).append(d)
    return by_frame


# --------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------

def runs_of(frames: set[int], min_len: int = 3) -> tuple[int, int, int, int]:
    """(runs>=min_len, frames in them, singletons, longest run)."""
    if not frames:
        return 0, 0, 0, 0
    s = sorted(frames)
    runs, cur = [], [s[0]]
    for a, b in zip(s, s[1:]):
        if b - a == 1:
            cur.append(b)
        else:
            runs.append(cur); cur = [b]
    runs.append(cur)
    good = [r for r in runs if len(r) >= min_len]
    return len(good), sum(len(r) for r in good), sum(1 for r in runs if len(r) == 1), max(len(r) for r in runs)


def worst_gap_s(frames: set[int], fps: float) -> float:
    if len(frames) < 2:
        return 0.0
    s = sorted(frames)
    return round(max((b - a) / fps for a, b in zip(s, s[1:])), 2)


def table(rows: list[dict]) -> None:
    cols = list(rows[0].keys())
    w = [max(len(c), *(len(str(r[c])) for r in rows)) for c in cols]
    print("  ".join(c.ljust(w[i]) for i, c in enumerate(cols)))
    print("  ".join("-" * w[i] for i in range(len(cols))))
    for r in rows:
        print("  ".join(str(r[c]).ljust(w[i]) for i, c in enumerate(cols)))


# --------------------------------------------------------------------------
# The debug overlay: every detector's view of the SAME instant, side by side.
#
# The table says which model wins. The video says what kind of ball each one
# loses, which is the part that tells you what to do next -- a model that only
# misses the fast drive at the net is a different problem from one that misses
# everything on the far side of the court.
#
# One decode, N panels: it is the same clip for every detector here (unlike the
# resolution harness, where the two files differ), so the frame is read once and
# drawn on N times.
# --------------------------------------------------------------------------

BOX_RUN = (80, 220, 60)      # BGR green: in a run of 3+, so it can yield a hit
BOX_LONE = (60, 170, 255)    # orange: found, but isolated and near-useless
MISS = (70, 70, 210)


def render_panels(video_path: str, results: dict, total: int, fps: float,
                  out_path: str, panel_h: int | None = None) -> str | None:
    names = list(results)
    # Keep the whole strip within a sane width however many detectors are in
    # play. Five panels at a fixed 480px tall is a 4000px-wide video that no
    # player will show at 1:1, so the panels shrink instead of the strip
    # growing past what a screen can display.
    if panel_h is None:
        panel_h = 480 if len(names) <= 2 else 380 if len(names) == 3 else 300
    in_runs = {}
    for n, by_frame in results.items():
        s_ = sorted(f for f in by_frame if f <= total)
        good, run = set(), ([s_[0]] if s_ else [])
        for a, b in zip(s_, s_[1:]):
            if b - a == 1:
                run.append(b)
            else:
                if len(run) >= 3:
                    good.update(run)
                run = [b]
        if len(run) >= 3:
            good.update(run)
        in_runs[n] = good

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return None
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1280
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 720
    pw = int(panel_h * (W / H)) // 2 * 2
    writer = open_writer(out_path, fps, pw * len(names), panel_h)
    if not writer.isOpened():
        print("  could not open the video writer", file=sys.stderr)
        return None

    tally = {n: 0 for n in names}
    for f in range(total + 1):
        ok, frame = cap.read()
        if not ok:
            break
        small = cv2.resize(frame, (pw, panel_h))
        panels = []
        for n in names:
            panel = small.copy()
            dets = results[n].get(f, [])
            if dets:
                tally[n] += 1
            colour = BOX_RUN if f in in_runs[n] else BOX_LONE
            for d in dets:
                cx, cy = d["x"] * pw, d["y"] * panel_h
                bw = max(d["w"] * pw, 12); bh = max(d["h"] * panel_h, 12)
                cv2.rectangle(panel, (int(cx - bw / 2), int(cy - bh / 2)),
                              (int(cx + bw / 2), int(cy + bh / 2)), colour, 2)
                cv2.putText(panel, f"{d['conf']:.2f}", (int(cx - bw / 2), int(max(14, cy - bh / 2 - 6))),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, colour, 1, cv2.LINE_AA)
            cv2.rectangle(panel, (0, 0), (pw, 44), (24, 20, 16), -1)
            cv2.putText(panel, n[:34], (10, 29), cv2.FONT_HERSHEY_SIMPLEX, 0.62,
                        (240, 240, 240), 2, cv2.LINE_AA)
            pct = f"{100 * tally[n] / (f + 1):.0f}%"
            cv2.putText(panel, f"{tally[n]}  {pct}", (pw - 140, 29),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 200), 2, cv2.LINE_AA)
            if not dets:
                cv2.putText(panel, "no ball", (10, panel_h - 14),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.62, MISS, 2, cv2.LINE_AA)
            panels.append(panel)
        writer.write(cv2.hconcat(panels))
    writer.release()
    cap.release()
    return out_path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--detectors", default="roboflow,yolo-coco",
                    help="comma list: roboflow, roboflow:WS/PROJ/VER[:hosted], "
                         "yolo-coco, json:PATH")
    ap.add_argument("--seconds", type=float, default=60.0, help="0 = whole clip")
    ap.add_argument("--out", default=None)
    ap.add_argument("--no-video", action="store_true",
                    help="skip the side-by-side overlay")
    args = ap.parse_args()

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        sys.exit(f"could not open {args.video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(args.seconds * fps) if args.seconds else int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()

    workdir = args.out or os.path.join(ROOT, "ml-experiments", "detector-compare")
    os.makedirs(workdir, exist_ok=True)
    secs = args.seconds if args.seconds > 0 else None

    results: dict[str, dict] = {}
    timings: dict[str, float] = {}
    for name in [d.strip() for d in args.detectors.split(",") if d.strip()]:
        print(f"\n[{name}]", file=sys.stderr, flush=True)
        t0 = time.time()
        if name == "roboflow":
            results[name] = det_roboflow(args.video, secs, workdir)
        elif name.startswith("roboflow:"):
            # roboflow:<workspace/project/version>[:hosted|:local]
            rest = name[len("roboflow:"):]
            mode = None
            for suffix in (":hosted", ":local"):
                if rest.endswith(suffix):
                    mode, rest = suffix[1:], rest[: -len(suffix)]
            # An "-instant-" model has no downloadable weights. Default it to
            # hosted rather than letting the local loader fail confusingly.
            hosted = (mode == "hosted") or (mode is None and "-instant-" in rest)
            # The `inference` package wants PROJECT/VERSION and rejects a
            # workspace prefix outright -- InvalidModelIDError, several seconds
            # into a run, after the previous detector has already finished.
            # Universe URLs and its own docs both show the workspace, so
            # pasting the id you were given is the natural mistake. Strip it.
            parts = rest.split("/")
            if len(parts) == 3:
                print(f"  note: dropping workspace prefix {parts[0]!r} — "
                      f"inference wants project/version", file=sys.stderr)
                rest = "/".join(parts[1:])
            results[name] = det_roboflow(args.video, secs, workdir, rest, hosted, tag=rest)
        elif name == "yolo-coco":
            results[name] = det_yolo_coco(args.video, secs, workdir)
        elif name.startswith("json:"):
            results[name] = det_from_json(name[5:])
        else:
            sys.exit(f"unknown detector: {name}")
        timings[name] = time.time() - t0

    print(f"\nclip: {os.path.basename(args.video)} · {total} frames at {fps:.2f} fps\n")

    rows = []
    seen: dict[str, set[int]] = {}
    for name, by_frame in results.items():
        s = {f for f in by_frame if f <= total}
        seen[name] = s
        n_runs, in_runs, singles, longest = runs_of(s)
        rows.append({
            "detector": name,
            "frames w/ ball": len(s),
            "coverage": f"{100 * len(s) / total:.1f}%",
            "runs>=3": n_runs,
            "usable frames": in_runs,
            "singletons": singles,
            "longest": longest,
            "worst gap": f"{worst_gap_s(s, fps)}s",
            "took": f"{timings[name] / 60:.1f}m" if timings[name] >= 90 else f"{timings[name]:.0f}s",
        })
    table(rows)

    # The question the Sept-7 benchmark showed actually matters.
    names = list(seen)
    if len(names) > 1:
        print("\nWhat each ADDS to the others (frames in runs>=3):\n")
        add_rows = []
        for a in names:
            others = set().union(*(seen[b] for b in names if b != a))
            _, base, _, _ = runs_of(others)
            _, both, _, _ = runs_of(others | seen[a])
            add_rows.append({
                "detector": a,
                "others alone": base,
                "with it": both,
                "adds": f"+{both - base}",
                "adds %": f"{100 * (both - base) / base:.0f}%" if base else "n/a",
            })
        table(add_rows)

        union = set().union(*seen.values())
        _, u_in_runs, _, _ = runs_of(union)
        best = max(runs_of(seen[n])[1] for n in names)
        print(f"\nUNION of all: {len(union)} frames, {u_in_runs} usable "
              f"({100 * len(union) / total:.1f}% coverage)")
        gain = 100 * (u_in_runs - best) / max(1, best)
        if gain >= 15:
            print(f"VERDICT: merging beats the best single detector by {gain:.0f}% usable frames. "
                  f"Worth the plumbing.")
        else:
            print(f"VERDICT: merging adds only {gain:.0f}% over the best single detector. "
                  f"Not worth two passes — pick the winner and move on.")

    if not args.no_video:
        print("\nrendering the side-by-side overlay…", file=sys.stderr)
        v = render_panels(args.video, results, total, fps,
                          os.path.join(workdir, "detectors.mp4"))
        if v:
            print(f"overlay: {v}")

    print(f"\nraw detections in {workdir}")


if __name__ == "__main__":
    main()
