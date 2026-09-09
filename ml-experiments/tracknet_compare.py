#!/usr/bin/env python3
"""
Does TrackNet see the ball better than the current detector?

One number decides whether a TrackNet swap is worth doing: what fraction of
frames it finds the ball in, against the ~18% the per-frame Roboflow detector
manages on this footage. Everything else about the swap is straightforward
plumbing; this is the part that could make it pointless.

The comparison is deliberately like-for-like. Both detectors run over the SAME
frames of the SAME clip, and coverage is counted the same way -- frames with a
detection over frames processed. No court gate on either side, because that
would measure the gate rather than the detector.

Why TrackNet might do better: it takes THREE consecutive frames as one
9-channel input and predicts a heatmap, so a ball that is an invisible smear in
any single frame is an obvious streak across three. Per-frame detection cannot
use that information because it never sees it.

Why it might not: the pretrained weights are trained on TENNIS. A pickleball is
a different object -- perforated, matte, slower off the paddle. Similar size
and colour on a 720p frame, which is the reason to expect transfer, but that is
a hypothesis and this script is how it gets tested rather than assumed.

Usage:
  python tracknet_compare.py --video ky-720p.mp4 \
      --tracknet-repo ~/TrackNet --weights ~/TrackNet/model_best.pt \
      [--current-json detections.json] [--out-video compare.mp4] [--limit 900]
"""
# The app runs CV through the CommandLineTools interpreter, which is Python
# 3.9 -- `int | None` in an annotation is evaluated at def time there and
# raises. Deferring annotation evaluation keeps the modern spelling working
# on the interpreter this actually has to run on.
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import cv2
import numpy as np


def load_tracknet(repo: str, weights: str, device: str):
    """Import BallTrackerNet from the cloned repo rather than reimplementing it.

    Copying an architecture by hand to load someone else's checkpoint is how a
    silently-wrong model gets benchmarked: the weights load, the shapes agree,
    and the outputs are subtly garbage. Importing their definition means the
    checkpoint is being loaded into exactly the network it was saved from.
    """
    sys.path.insert(0, os.path.expanduser(repo))
    try:
        from model import BallTrackerNet  # type: ignore
    except ImportError as exc:
        raise SystemExit(
            f"Could not import BallTrackerNet from {repo}.\n"
            "Clone it first:  git clone https://github.com/yastrebksv/TrackNet"
        ) from exc
    import torch

    model = BallTrackerNet()
    state = torch.load(os.path.expanduser(weights), map_location=device)
    model.load_state_dict(state)
    model = model.to(device).eval()
    return model, torch


def postprocess_heatmap(feature_map, orig_w: int, orig_h: int, in_w=640, in_h=360):
    """Heatmap -> one (x, y) in ORIGINAL frame coordinates, or None.

    The network predicts at 640x360; every coordinate is scaled back so the
    result is directly comparable with the current detector's output, which is
    normalized against the source frame.
    """
    fm = feature_map.reshape((in_h, in_w)).astype(np.uint8)
    ret, heat = cv2.threshold(fm, 127, 255, cv2.THRESH_BINARY)
    circles = cv2.HoughCircles(heat, cv2.HOUGH_GRADIENT, dp=1, minDist=1,
                               param1=50, param2=2, minRadius=2, maxRadius=7)
    if circles is None or len(circles) == 0:
        return None
    x, y = float(circles[0][0][0]), float(circles[0][0][1])
    return (x * orig_w / in_w, y * orig_h / in_h)


def run_tracknet(video: str, repo: str, weights: str, limit: int | None,
                 force_cpu: bool = False):
    device = "cpu"
    model, torch = load_tracknet(repo, weights, device)
    # MPS is much faster but is an escape hatch away from being a liability:
    # some conv/argmax paths on Apple's backend have shipped wrong results
    # rather than errors, which would make this benchmark quietly meaningless.
    # --cpu forces the reference path so a suspicious number can be rechecked.
    if not force_cpu:
        try:
            if torch.backends.mps.is_available():
                device = "mps"
                model = model.to(device)
        except Exception:
            pass
    print(f"[tracknet] device={device}", file=sys.stderr)

    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise SystemExit(f"cannot open {video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    frames, results = [], {}
    i, seen, t0 = 0, 0, time.time()
    while True:
        ok, img = cap.read()
        if not ok:
            break
        if limit and i >= limit:
            break
        frames.append(cv2.resize(img, (640, 360)))
        if len(frames) > 3:
            frames.pop(0)

        # Three consecutive frames, newest first -- 9 channels. This is the
        # whole point of the architecture: motion IS the signal for an object
        # too small and too blurred to identify from appearance alone.
        if len(frames) == 3:
            stack = np.concatenate([frames[2], frames[1], frames[0]], axis=2)
            x = torch.from_numpy(
                np.rollaxis(stack.astype(np.float32) / 255.0, 2, 0)
            ).unsqueeze(0).to(device)
            with torch.no_grad():
                out = model(x)
            fmap = out.argmax(dim=1).detach().cpu().numpy()
            pt = postprocess_heatmap(fmap, W, H)
            if pt:
                results[i] = pt
                seen += 1
        i += 1
        if i % 200 == 0:
            rate = i / max(1e-6, time.time() - t0)
            print(f"[tracknet] {i} frames · seen in {seen} · {rate:.0f} fps", file=sys.stderr, flush=True)

    cap.release()
    return {"framesProcessed": i, "seen": seen, "fps": fps,
            "width": W, "height": H, "points": results}


def load_current(path: str, fps: float, frames_processed: int) -> dict:
    """Read the current detector's output, whichever shape it is in.

    Two formats exist. The experiment format is a flat list of detections keyed
    by frame index. The app writes shot-results/<clip>/ball.json instead: points
    keyed by TIME, already gap-filled, with the filled ones flagged
    `interpolated`. Those filled points are not detections -- counting them
    would credit the current detector with frames it never actually saw the ball
    in, which is precisely the number under test. So they are dropped, and the
    remaining timestamps are mapped back to frame indices with the clip's own
    fps so both detectors are scored over the same frames.
    """
    cur = json.load(open(path))
    by_frame: dict = {}

    if cur.get("detections"):
        for d in cur["detections"]:
            f = int(d["frame"])
            if f < frames_processed:
                by_frame.setdefault(f, []).append(d)
        return by_frame

    for pt in cur.get("points", []):
        if pt.get("interpolated"):
            continue
        x, y = pt.get("x"), pt.get("y")
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            continue
        f = int(round(float(pt["t"]) * fps))
        if 0 <= f < frames_processed:
            by_frame.setdefault(f, []).append(pt)
    return by_frame


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--tracknet-repo", required=True)
    ap.add_argument("--weights", required=True)
    ap.add_argument("--current-json", help="detections.json from the current detector, to compare against")
    ap.add_argument("--limit", type=int, default=None, help="stop after N frames (a quick look)")
    ap.add_argument("--out-json", default="tracknet_result.json")
    ap.add_argument("--cpu", action="store_true",
                    help="force CPU instead of MPS (slower; use to verify a suspicious result)")
    args = ap.parse_args()

    res = run_tracknet(args.video, args.tracknet_repo, args.weights, args.limit,
                       force_cpu=args.cpu)
    cov = res["seen"] / max(1, res["framesProcessed"])
    print()
    print(f"TrackNet      : ball in {res['seen']} of {res['framesProcessed']} frames = {cov:.1%}")

    if args.current_json and os.path.exists(args.current_json):
        by_frame = load_current(args.current_json, res["fps"], res["framesProcessed"])
        processed = res["framesProcessed"]
        cur_cov = len(by_frame) / max(1, processed)
        print(f"Current model : ball in {len(by_frame)} of {processed} frames = {cur_cov:.1%}")
        print()

        # Where each one wins. A detector that only finds the ball where the
        # other already did is not an improvement, however good its headline
        # number looks -- the gaps are what break rally segmentation.
        tn = set(res["points"].keys())
        cu = set(by_frame.keys())
        both, only_tn, only_cur = len(tn & cu), len(tn - cu), len(cu - tn)
        union = len(tn | cu)
        union_cov = union / max(1, processed)
        print(f"  both found it      : {both}")
        print(f"  only TrackNet      : {only_tn}")
        print(f"  only current model : {only_cur}")
        print(f"  either one         : {union} = {union_cov:.1%}")
        print()

        # Headline coverage is the least interesting number here. Two detectors
        # can post the same percentage and still be worth combining, because
        # what breaks rally segmentation is the LENGTH of the gaps, not the
        # count of the hits. So the verdict is decided by whether each one
        # covers frames the other misses, and only falls back to comparing
        # totals when they largely agree.
        complementary = only_tn >= 0.25 * max(1, len(cu)) and only_cur >= 0.25 * max(1, len(tn))
        if complementary:
            print(f"VERDICT: complementary, not competing. They agree on only {both} frames but\n"
                  f"         cover {union_cov:.1%} between them vs {cur_cov:.1%} now. Running both and\n"
                  f"         merging is worth more than replacing one with the other.")
        elif cov > cur_cov * 1.3:
            print("VERDICT: clearly better. Worth wiring in as a ball backend.")
        elif cov > cur_cov * 1.05:
            print("VERDICT: modestly better. Probably worth fine-tuning on pickleball frames.")
        else:
            print("VERDICT: no better. Tennis weights do not transfer — fine-tuning or a\n"
                  "         different approach is needed before this is worth the plumbing.")

    with open(args.out_json, "w") as fh:
        json.dump({"framesProcessed": res["framesProcessed"], "seen": res["seen"],
                   "coverage": cov, "width": res["width"], "height": res["height"],
                   "points": {str(k): v for k, v in res["points"].items()}}, fh)
    print(f"\nwrote {args.out_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
