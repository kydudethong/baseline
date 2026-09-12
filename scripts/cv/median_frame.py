#!/usr/bin/env python3
"""
An empty court, built from a video where the court is never empty.

WHY THIS EXISTS. Every court fit in this app -- the HSV mask in
detect_court.py, rally_seg's fitter, and the human dragging corners on the
setup screen -- is trying to see painted lines. Players stand on those lines.
A baseline with someone serving off it is a broken line to a contour finder
and an ambiguous one to a person, and no amount of voting across single frames
removes the bodies: it only finds the frames where they happened to stand
somewhere else.

The camera is static and the players are not, so the per-pixel MEDIAN over a
spread of frames is the court with the people removed. A pixel is court in
most frames and a person in a few; the median takes the majority. Shadows that
move get averaged away too; shadows that do not, stay -- correctly, because a
fixed shadow is genuinely part of what the camera sees.

Median rather than mean, and that matters: a mean leaves grey smears where
people walked, which a line detector reads as edges. The median leaves nothing
at all.

Usage: median_frame.py <video> --out frame.jpg [--samples 60] [--max-dim 1280]
Prints JSON: {"out": path, "samples": n, "width": w, "height": h}
"""
import argparse
import json
import sys

import cv2
import numpy as np


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--out", required=True)
    # 60 frames is the knee of the curve: enough that four players standing
    # still for a few seconds are still a minority at every pixel, few enough
    # that the decode stays a couple of seconds. More frames stop helping once
    # any given pixel is court in most of them.
    ap.add_argument("--samples", type=int, default=60)
    ap.add_argument("--max-dim", type=int, default=0,
                    help="downscale so the long side is at most this, 0 = keep source size")
    args = ap.parse_args()

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(f"Could not open video: {args.video}", file=sys.stderr)
        return 1

    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if total <= 0:
        print("Video reports no frames; cannot sample.", file=sys.stderr)
        cap.release()
        return 1

    # Spread the samples across the WHOLE clip rather than taking a run of
    # consecutive frames. Consecutive frames are nearly identical, so their
    # median is just one frame with its players intact -- the spread is the
    # entire mechanism.
    n = max(3, min(args.samples, total))
    idxs = np.linspace(0, total - 1, n).astype(int)

    frames = []
    for i in idxs:
        # Frame seek, not POS_MSEC: millisecond seeks land on keyframes, so
        # several requests can silently return the SAME frame -- which would
        # quietly collapse the sample count and leave the players in.
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(i))
        ok, frame = cap.read()
        if not ok:
            continue
        if args.max_dim and max(frame.shape[:2]) > args.max_dim:
            scale = args.max_dim / max(frame.shape[:2])
            frame = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        frames.append(frame)
    cap.release()

    if not frames:
        print("No frames could be read.", file=sys.stderr)
        return 1

    # uint8 median over the stack. np.median returns float64 and allocates a
    # copy the size of the stack, which at 1080p x 60 is ~1.5GB -- hence the
    # max-dim downscale above being the caller's default rather than optional.
    stack = np.stack(frames, axis=0)
    median = np.median(stack, axis=0).astype(np.uint8)

    if not cv2.imwrite(args.out, median, [int(cv2.IMWRITE_JPEG_QUALITY), 95]):
        print(f"Could not write {args.out}", file=sys.stderr)
        return 1

    h, w = median.shape[:2]
    json.dump({"out": args.out, "samples": len(frames), "width": w, "height": h}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
