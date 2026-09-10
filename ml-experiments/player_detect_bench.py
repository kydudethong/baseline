#!/usr/bin/env python3
"""
Why is player detection 41% of a run, and what makes it cheaper?

Player detection takes 181ms a frame. Pose estimation, on the same 507 frames
with a HEAVIER model, takes 35ms. Five times faster with more work to do, which
says the cost is not "detection is expensive" but something about how this
particular pass is configured.

The visible difference: detect_players.py defaults to imgsz 960, while
estimate_pose.py takes ultralytics' default of 640. That is 2.25x the pixels
-- which does not on its own explain 5x, so measuring beats reasoning here.
Reasoning has already been wrong twice on this pipeline today.

What this measures, per imgsz: wall clock, people found, and how much the
detections still agree with the 960 baseline. The last column is the one that
decides anything -- 2x faster is worthless if the far player stops being
found, and far players are exactly what shrinks first.

Usage:
  python ml-experiments/player_detect_bench.py <frames-dir-or-video> \\
      [--sizes 960,832,640,480] [--frames 60]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def frames_from_video(video: Path, n: int, fps: float, max_dim: int) -> list[Path]:
    out = Path(tempfile.mkdtemp(prefix="pdbench-"))
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(video), "-vf",
         f"fps={fps},scale='min({max_dim},iw)':-2", "-q:v", "3",
         str(out / "f%05d.jpg")],
        check=True, capture_output=True,
    )
    got = sorted(out.glob("*.jpg"))
    return got[:n]


def iou(a: dict, b: dict) -> float:
    ax2, ay2 = a["x"] + a["width"], a["y"] + a["height"]
    bx2, by2 = b["x"] + b["width"], b["y"] + b["height"]
    ix = max(0.0, min(ax2, bx2) - max(a["x"], b["x"]))
    iy = max(0.0, min(ay2, by2) - max(a["y"], b["y"]))
    inter = ix * iy
    union = a["width"] * a["height"] + b["width"] * b["height"] - inter
    return inter / union if union > 0 else 0.0


def run(paths: list[Path], imgsz: int, python: str) -> tuple[float, dict]:
    # --frames-json, not positional paths, and the key is "players". Both taken
    # from the script rather than assumed; the first draft of this guessed
    # both and would have failed on the first call.
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump([str(p) for p in paths], fh)
        frames_json = fh.name
    out_path = frames_json + ".out.json"
    started = time.time()
    proc = subprocess.run(
        [python, "scripts/cv/detect_players.py", "--frames-json", frames_json,
         "--imgsz", str(imgsz), "--out", out_path],
        capture_output=True, text=True,
    )
    elapsed = time.time() - started
    if proc.returncode != 0:
        print(proc.stderr[-800:], file=sys.stderr)
        raise SystemExit(f"detect_players.py failed at imgsz {imgsz}")
    data = json.loads(Path(out_path).read_text())
    return elapsed, {row["imagePath"]: row.get("players", []) for row in data.get("frames", [])}


def far_fraction(by_path: dict) -> float:
    """Share of boxes in the top half of the frame -- the far court.

    The documented reason for imgsz 960 is that 640 loses the player at the
    FAR baseline. A total count hides that: losing two far players and gaining
    two spectators nets to zero. This is the number the claim actually rests
    on."""
    boxes = [b for v in by_path.values() for b in v]
    if not boxes:
        return 0.0
    far = sum(1 for b in boxes if b["boxImageNorm"]["y"] + b["boxImageNorm"]["height"] < 0.55)
    return far / len(boxes)


def agreement(base: dict, other: dict, thresh: float = 0.5) -> tuple[int, int]:
    """How many baseline people the smaller size still finds."""
    found = total = 0
    for path, people in base.items():
        others = other.get(path, [])
        for p in people:
            total += 1
            if any(iou(p["boxImageNorm"], q["boxImageNorm"]) >= thresh for q in others):
                found += 1
    return found, total


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("source", help="a video, or a directory of already-extracted frames")
    ap.add_argument("--sizes", default="960,832,640,480")
    ap.add_argument("--frames", type=int, default=60)
    ap.add_argument("--fps", type=float, default=5.0)
    ap.add_argument("--max-dim", type=int, default=1280)
    args = ap.parse_args()

    # The interpreter with ultralytics, not whatever launched this.
    python = os.environ.get("CV_PYTHON")
    if not python:
        for line in Path(".env.local").read_text().splitlines() if Path(".env.local").exists() else []:
            if line.startswith("CV_PYTHON="):
                python = line.split("=", 1)[1].strip()
    python = python or sys.executable

    src = Path(args.source)
    paths = (sorted(src.glob("*.jpg"))[: args.frames] if src.is_dir()
             else frames_from_video(src, args.frames, args.fps, args.max_dim))
    if not paths:
        print("no frames", file=sys.stderr)
        return 2
    print(f"{len(paths)} frames · interpreter {python}\n", file=sys.stderr)

    sizes = [int(s) for s in args.sizes.split(",")]
    results = []
    base = None
    for size in sizes:
        elapsed, by_path = run(paths, size, python)
        people = sum(len(v) for v in by_path.values())
        if base is None:
            base = by_path
            kept, total = people, people
        else:
            kept, total = agreement(base, by_path)
        per_frame = elapsed / len(paths) * 1000
        far = far_fraction(by_path)
        results.append((size, elapsed, per_frame, people, kept, total, far))
        print(f"imgsz {size:>4}: {elapsed:6.1f}s  {per_frame:6.0f} ms/frame  "
              f"{people:>4} boxes ({far * 100:4.0f}% far court)  keeps {kept}/{total} "
              f"of the {sizes[0]} boxes ({kept / max(1, total) * 100:.0f}%)", file=sys.stderr)

    print("\nEXTRAPOLATED TO A FULL 507-FRAME RUN", file=sys.stderr)
    for size, _, per_frame, _, kept, total, far in results:
        print(f"  imgsz {size:>4}: {per_frame * 507 / 1000:6.1f}s"
              f"   agreement {kept / max(1, total) * 100:5.1f}%"
              f"   far court {far * 100:4.0f}%", file=sys.stderr)
    print("\nThe agreement column is the decision. A size that is twice as fast and\n"
          "loses the far player has not made the pipeline better, it has made it\n"
          "wrong sooner.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
