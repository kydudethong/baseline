#!/usr/bin/env python3
"""
Does feeding the ball detector a bigger frame find more ball?

The pipeline never decimates frames at the current settings -- BALL_FPS_CAP=60
against 24-60 fps footage gives step=1, so every frame is already looked at.
Resolution is the only input dimension still in question, and the answer is not
obvious in either direction: a bigger frame carries more pixels on a ball that
is only a few across, but every model resizes its input to a fixed size
internally, so the extra detail may be thrown away before inference -- or may
survive as a cleaner downsample. That is an empirical question.

This runs the REAL detector twice over two encodes of the same footage and
reports the numbers that matter downstream. Coverage alone is not one of them:
hit detection needs three consecutive sightings to measure a direction change,
so a track of scattered singletons is worth much less than the same count in
runs, and the benchmark that mattered here before was contiguity.

Usage:
  python3 scripts/cv/compare_resolution.py A.mp4 B.mp4 [--seconds 60] [--out dir]

Both files must be the same footage. It checks frame counts agree and refuses
if they do not, because comparing coverage across different content measures
nothing.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile


def _load_env_local() -> None:
    """Read .env.local into the environment, like the app does.

    detect_ball.py takes BALL_MODEL_ID and ROBOFLOW_API_KEY from os.environ,
    which Next.js populates for it. Run from a bare shell nothing populates
    them, and the failure is "No ball model configured" several minutes into a
    run -- long after it looked like it was working. Load them up front.

    Values are never printed. Existing environment wins, so a one-off override
    on the command line still works.
    """
    for here in (os.path.dirname(os.path.abspath(__file__)), os.getcwd()):
        root = os.path.abspath(os.path.join(here, "..", "..")) if "scripts" in here else here
        path = os.path.join(root, ".env.local")
        if not os.path.isfile(path):
            continue
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
        return


_load_env_local()

# The interpreter that has the CV stack. On a Mac the `python3` on PATH is
# usually Homebrew's or pyenv's, while opencv and the model were installed for
# the one CV_PYTHON names -- so running this file with plain `python3` fails on
# `import cv2` even though the app works fine. Re-exec into the right one
# rather than making that the user's problem.
try:
    import cv2
except ModuleNotFoundError:
    _cv_python = os.environ.get("CV_PYTHON")
    if _cv_python and os.path.exists(_cv_python) and not os.environ.get("_PB_REEXEC"):
        os.environ["_PB_REEXEC"] = "1"
        os.execv(_cv_python, [_cv_python, os.path.abspath(__file__), *sys.argv[1:]])
    sys.exit(
        "opencv (cv2) is not available to this interpreter.\n"
        f"  running as: {sys.executable}\n"
        + (f"  CV_PYTHON is set to: {_cv_python}\n" if _cv_python else
           "  CV_PYTHON is not set in .env.local\n")
        + "Run it with the interpreter that has the CV stack, e.g.\n"
          "  $CV_PYTHON scripts/cv/compare_resolution.py ...\n"
          "or install opencv for this one:  python3 -m pip install opencv-python-headless"
    )

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from video_writer import open_writer  # noqa: E402


def probe(path: str) -> dict:
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        sys.exit(f"could not open {path}")
    info = {
        "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
        "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
        "fps": cap.get(cv2.CAP_PROP_FPS) or 0.0,
        "frames": int(cap.get(cv2.CAP_PROP_FRAME_COUNT)),
    }
    cap.release()
    return info


def run_detector(video: str, seconds: float | None, out_json: str) -> dict:
    """Run the real detector. Wall time is recorded because nothing else does.

    detect_ball.py writes elapsedSeconds into its diagnostics, but the pipeline
    never persisted it, so there was no way to answer "how long will this take"
    from past runs -- only to guess. This puts throughput in the summary table.
    """
    # sys.executable, not "python3": after the re-exec above this IS the
    # interpreter with opencv and the model, and detect_ball.py needs both.
    cmd = [sys.executable, os.path.join(os.path.dirname(__file__), "detect_ball.py"),
           video, "--out", out_json]
    if seconds:
        cmd += ["--windows", json.dumps([[0, seconds]])]
    env = dict(os.environ)
    print(f"  running: {' '.join(cmd[1:])}", file=sys.stderr, flush=True)
    import time
    t0 = time.time()
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True)
    wall = time.time() - t0
    if proc.returncode != 0:
        sys.exit(f"detector failed on {video}:\n{proc.stderr[-2000:]}")
    with open(out_json) as fh:
        res = json.load(fh)
    res["_wallSeconds"] = round(wall, 1)
    return res


def contiguity(frames_with_ball: list[int], fps: float) -> dict:
    """Runs of CONSECUTIVE sampled frames, which is what hit detection needs."""
    if not frames_with_ball:
        return {"runs": 0, "singletons": 0, "runs_ge3": 0, "in_runs_ge3": 0,
                "longest": 0, "worst_gap_s": 0.0}
    s = sorted(set(frames_with_ball))
    runs, cur = [], [s[0]]
    for a, b in zip(s, s[1:]):
        if b - a == 1:
            cur.append(b)
        else:
            runs.append(cur); cur = [b]
    runs.append(cur)
    gaps = [(b - a) / fps for a, b in zip(s, s[1:])] if fps else []
    return {
        "runs": len(runs),
        "singletons": sum(1 for r in runs if len(r) == 1),
        "runs_ge3": sum(1 for r in runs if len(r) >= 3),
        "in_runs_ge3": sum(len(r) for r in runs if len(r) >= 3),
        "longest": max(len(r) for r in runs),
        "worst_gap_s": round(max(gaps), 2) if gaps else 0.0,
    }


def summarise(res: dict, label: str) -> dict:
    pts = res.get("points") or res.get("detections") or []
    processed = res.get("framesProcessed") or res.get("diagnostics", {}).get("framesProcessed") or 0
    fps = res.get("fps") or 0.0
    frames = [int(p["frame"]) for p in pts if "frame" in p]
    seen = len(set(frames))
    c = contiguity(frames, fps)
    wall = res.get("_wallSeconds") or 0.0
    return {
        "encode": label,
        "took": f"{wall / 60:.1f} min" if wall >= 90 else f"{wall:.0f}s",
        "rate": f"{processed / wall:.1f} fps" if wall else "n/a",
        "frames looked at": processed,
        "frames with ball": seen,
        "coverage": f"{100 * seen / processed:.1f}%" if processed else "n/a",
        "runs>=3": c["runs_ge3"],
        "frames in runs>=3": c["in_runs_ge3"],
        "singletons": c["singletons"],
        "longest run": c["longest"],
        "worst blind gap": f"{c['worst_gap_s']}s",
    }


# --------------------------------------------------------------------------
# The side-by-side overlay.
#
# A table of coverage percentages tells you WHICH encode won and nothing about
# why. Watching both at once tells you what kind of ball each one loses -- the
# fast drive, the one against the far wall, the one behind a player -- and that
# is the thing that decides whether resolution is worth paying for or the
# effort belongs somewhere else entirely.
#
# The two encodes are scaled to a common height and put side by side so the
# same instant is on screen twice. Frame i is the same moment in both because
# the guards upstream already refused anything that was not the same footage at
# the same frame rate.
# --------------------------------------------------------------------------

BOX_SEEN = (80, 220, 60)      # BGR: found here
BOX_FAINT = (60, 170, 255)    # found, but below the run threshold
MISS = (70, 70, 210)          # nothing this frame


def index_detections(res: dict) -> dict[int, list[dict]]:
    by_frame: dict[int, list[dict]] = {}
    for d in res.get("detections", []):
        by_frame.setdefault(int(d["frame"]), []).append(d)
    return by_frame


def run_membership(frames: list[int]) -> set[int]:
    """Frames that sit inside a run of 3+ consecutive sampled frames.

    Drawn differently because these are the ones that can actually produce a
    contact -- a lone sighting cannot show a direction change, so colouring it
    the same as a useful one would flatter the weaker encode.
    """
    s = sorted(set(frames))
    good: set[int] = set()
    run = [s[0]] if s else []
    for a, b in zip(s, s[1:]):
        if b - a == 1:
            run.append(b)
        else:
            if len(run) >= 3:
                good.update(run)
            run = [b]
    if len(run) >= 3:
        good.update(run)
    return good


def draw_panel(frame, dets: list[dict], in_run: bool, label: str, tally: tuple[int, int]):
    h, w = frame.shape[:2]
    for d in dets:
        cx, cy = d["x"] * w, d["y"] * h
        bw, bh = max(d["w"] * w, 10), max(d["h"] * h, 10)
        x1, y1 = int(cx - bw / 2), int(cy - bh / 2)
        x2, y2 = int(cx + bw / 2), int(cy + bh / 2)
        colour = BOX_SEEN if in_run else BOX_FAINT
        cv2.rectangle(frame, (x1, y1), (x2, y2), colour, 2)
        cv2.putText(frame, f"{d['conf']:.2f}", (x1, max(14, y1 - 6)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, colour, 1, cv2.LINE_AA)
    # Header band: which encode, and the running score so far.
    cv2.rectangle(frame, (0, 0), (w, 46), (24, 20, 16), -1)
    cv2.putText(frame, label, (12, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                (240, 240, 240), 2, cv2.LINE_AA)
    seen, total = tally
    pct = f"{100 * seen / total:.0f}%" if total else "--"
    # The tally is cumulative, so it must not change colour with the current
    # frame -- that read as "the running total is bad" rather than "this one
    # frame missed", which is what the caption underneath is for.
    cv2.putText(frame, f"seen {seen}/{total}  ({pct})", (w - 300, 30),
                cv2.FONT_HERSHEY_SIMPLEX, 0.65, (200, 200, 200), 2, cv2.LINE_AA)
    if not dets:
        cv2.putText(frame, "no ball", (12, h - 16), cv2.FONT_HERSHEY_SIMPLEX,
                    0.7, MISS, 2, cv2.LINE_AA)
    return frame


def render_side_by_side(video_a, res_a, video_b, res_b, seconds, out_path, panel_h=540):
    caps = [cv2.VideoCapture(video_a), cv2.VideoCapture(video_b)]
    if not all(c.isOpened() for c in caps):
        print("  could not reopen the clips for rendering", file=sys.stderr)
        return None
    idx = [index_detections(res_a), index_detections(res_b)]
    runs = [run_membership([int(d["frame"]) for d in r.get("detections", [])])
            for r in (res_a, res_b)]
    labels = [f"{res_a['width']}x{res_a['height']}", f"{res_b['width']}x{res_b['height']}"]

    fps = res_a.get("sourceFps") or caps[0].get(cv2.CAP_PROP_FPS) or 30.0
    last = int(seconds * fps) if seconds else int(caps[0].get(cv2.CAP_PROP_FRAME_COUNT))

    # Panel width from the FIRST clip's aspect; both are the same footage so
    # the aspect matches even though the pixel counts do not.
    ar = res_a["width"] / res_a["height"]
    pw = int(panel_h * ar) // 2 * 2
    writer = open_writer(out_path, fps, pw * 2, panel_h)
    if not writer.isOpened():
        print("  could not open the writer (no mp4v encoder?)", file=sys.stderr)
        return None

    tally = [0, 0]
    written = 0
    for f in range(last + 1):
        frames = []
        ok_all = True
        for i, cap in enumerate(caps):
            ok, frame = cap.read()
            if not ok:
                ok_all = False
                break
            dets = idx[i].get(f, [])
            if dets:
                tally[i] += 1
            frame = cv2.resize(frame, (pw, panel_h))
            frames.append(draw_panel(frame, dets, f in runs[i], labels[i], (tally[i], f + 1)))
        if not ok_all:
            break
        writer.write(cv2.hconcat(frames))
        written += 1
    writer.release()
    for c in caps:
        c.release()
    return out_path if written else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video_a")
    ap.add_argument("video_b")
    ap.add_argument("--seconds", type=float, default=60.0,
                    help="analyse only the first N seconds of each (0 = whole clip)")
    ap.add_argument("--out", default=None, help="directory to keep the raw detector JSON")
    ap.add_argument("--no-video", action="store_true",
                    help="skip the side-by-side overlay (it is the slow part)")
    args = ap.parse_args()

    a, b = probe(args.video_a), probe(args.video_b)
    print(f"A {os.path.basename(args.video_a)}: {a['width']}x{a['height']} @ {a['fps']:.2f} fps, {a['frames']} frames")
    print(f"B {os.path.basename(args.video_b)}: {b['width']}x{b['height']} @ {b['fps']:.2f} fps, {b['frames']} frames")

    # Same footage or the comparison means nothing. One frame of slack for
    # encoder disagreement about the final frame.
    if abs(a["frames"] - b["frames"]) > 1:
        sys.exit(f"\nREFUSING: {a['frames']} vs {b['frames']} frames — these are not the same footage.")
    if abs(a["fps"] - b["fps"]) > 0.5:
        sys.exit(f"\nREFUSING: {a['fps']:.2f} vs {b['fps']:.2f} fps — resolution is not the only difference.")
    if a["width"] == b["width"] and a["height"] == b["height"]:
        sys.exit("\nREFUSING: identical resolutions — nothing to compare.")

    outdir = args.out or tempfile.mkdtemp(prefix="ball-res-")
    os.makedirs(outdir, exist_ok=True)
    secs = args.seconds if args.seconds > 0 else None

    rows, raw = [], []
    for path, info, tag in ((args.video_a, a, "A"), (args.video_b, b, "B")):
        label = f"{info['width']}x{info['height']}"
        print(f"\n[{tag}] {label}", file=sys.stderr)
        res = run_detector(path, secs, os.path.join(outdir, f"{tag}.json"))
        raw.append(res)
        rows.append(summarise(res, label))

    if not args.no_video:
        print("\nrendering the side-by-side overlay…", file=sys.stderr)
        vid = render_side_by_side(args.video_a, raw[0], args.video_b, raw[1],
                                  secs, os.path.join(outdir, "compare.mp4"))
        if vid:
            print(f"  overlay: {vid}", file=sys.stderr)

    cols = list(rows[0].keys())
    w = [max(len(c), *(len(str(r[c])) for r in rows)) for c in cols]
    print()
    print("  ".join(c.ljust(w[i]) for i, c in enumerate(cols)))
    print("  ".join("-" * w[i] for i in range(len(cols))))
    for r in rows:
        print("  ".join(str(r[c]).ljust(w[i]) for i, c in enumerate(cols)))

    # The verdict is about usable track, not raw coverage: 40% in long runs
    # beats 45% in singletons, because a singleton cannot show a direction
    # change and so cannot produce a contact.
    ga, gb = rows[0]["frames in runs>=3"], rows[1]["frames in runs>=3"]
    print()
    if max(ga, gb) == 0:
        print("VERDICT: neither encode produced a usable track. Check the model is loading.")
    else:
        diff = 100 * (gb - ga) / max(1, ga)
        better = "B (higher res)" if gb > ga else "A (lower res)" if ga > gb else "neither"
        if abs(diff) < 5:
            print(f"VERDICT: no meaningful difference ({diff:+.0f}% usable frames). "
                  f"Resolution is not the lever — stay on the cheaper encode.")
        else:
            print(f"VERDICT: {better} gives {abs(diff):.0f}% more frames in runs of 3+.")
    print(f"\nraw detector output kept in {outdir}")


if __name__ == "__main__":
    main()
