#!/usr/bin/env python3
"""
Player detection, run locally on the CPU with a pretrained YOLO model.

This replaces a hosted call per sampled frame. The hosted path used
Roboflow's public `coco/50` -- a general COCO detector whose `person` class
is the only thing that was ever read from it. yolov8n.pt is the same kind of
model, pretrained on the same dataset, and it runs here for free: a 100-second
clip sampled at 5 fps is ~500 inferences, which on a free tier is real money
and on this machine is about a minute of CPU.

Nothing about the detections changes -- same person class, same normalized
box shape -- so the tracker, the court gate and everything downstream are
untouched.

Usage:
  detect_players.py --frames-json <path> [--model models/yolov8n.pt]
                    [--conf 0.25] [--imgsz 960] [--out result.json]

`--frames-json` is a JSON array of image paths. Output:
  {"frames": [{"imagePath": "...", "players": [
      {"boxImageNorm": {"x":0-1,"y":0-1,"width":0-1,"height":0-1},
       "confidence": 0-1}, ...]}, ...]}

Everything except the final JSON goes to stderr, and --out writes to a file,
because a library on stdout corrupts the payload (see cv-scripts.ts).
"""
import argparse
import json
import os
import sys

PERSON_CLASS_ID = 0  # COCO


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames-json", required=True)
    ap.add_argument("--model", default=os.environ.get("PLAYER_MODEL_PATH", "models/yolov8n.pt"))
    ap.add_argument("--conf", type=float, default=float(os.environ.get("PLAYER_CONF", "0.25")))
    # A pickleball player at the far baseline is a small target. 640 (the
    # ultralytics default) letterboxes a 1280-wide frame down by half and
    # loses them; 960 keeps them without costing much on CPU.
    ap.add_argument("--imgsz", type=int, default=int(os.environ.get("PLAYER_IMGSZ", "960")))
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    with open(args.frames_json, "r", encoding="utf-8") as fh:
        paths = json.load(fh)
    if not isinstance(paths, list):
        print("frames-json must be a JSON array of image paths", file=sys.stderr)
        return 2

    try:
        from ultralytics import YOLO  # type: ignore
    except ImportError:
        print(
            f"ultralytics is not installed in {sys.executable} (Python {sys.version.split()[0]}).\n"
            f"Either install it there:  {sys.executable} -m pip install ultralytics\n"
            "or point the app at an interpreter that has it, with CV_PYTHON in .env.local.\n"
            "A shell where `import ultralytics` works may be a DIFFERENT python than the\n"
            "one this server inherited from PATH -- compare `which python3` against the\n"
            "path above.",
            file=sys.stderr,
        )
        return 3

    if not os.path.exists(args.model):
        print(
            f"player model weights not found at {args.model}. "
            "Download yolov8n.pt (6MB) into models/, or set PLAYER_MODEL_PATH.",
            file=sys.stderr,
        )
        return 4

    model = YOLO(args.model)
    frames = []
    done = 0
    # Progress on stderr, like detect_ball.py already does.
    #
    # This pass is the longest silent stretch in the whole pipeline -- 4,121
    # frames on a 14-minute clip, in one call, printing nothing until it
    # finishes. A quiet stage is indistinguishable from a dead one from
    # outside, which has now cost several evenings of guessing whether a run
    # was working or gone. Saying "2400/4121, ~6 min left" costs one line every
    # few seconds and removes the question.
    import time as _time
    t0 = _time.time()
    print(f"[players] {len(paths)} frames at imgsz {args.imgsz}, batch {args.batch}",
          file=sys.stderr, flush=True)
    for start in range(0, len(paths), args.batch):
        chunk = paths[start : start + args.batch]
        try:
            results = model.predict(
                chunk, conf=args.conf, imgsz=args.imgsz, classes=[PERSON_CLASS_ID],
                verbose=False,
            )
        except Exception as exc:  # noqa: BLE001 - one bad batch must not lose the run
            print(f"[players] batch at {start} failed: {type(exc).__name__}: {exc}", file=sys.stderr)
            for p in chunk:
                frames.append({"imagePath": p, "players": [], "error": str(exc)[:200]})
            done += len(chunk)
        if done % 200 < args.batch or done == len(paths):
            rate = done / max(1e-6, _time.time() - t0)
            remaining = (len(paths) - done) / max(rate, 1e-6)
            print(f"[players] {done}/{len(paths)} frames · {rate:.1f} fps · "
                  f"~{remaining / 60:.1f} min left", file=sys.stderr, flush=True)
            continue

        for path, res in zip(chunk, results):
            h, w = res.orig_shape if getattr(res, "orig_shape", None) else (0, 0)
            players = []
            boxes = getattr(res, "boxes", None)
            if boxes is not None and boxes.xyxy is not None and w and h:
                xyxy = boxes.xyxy.cpu().numpy()
                confs = boxes.conf.cpu().numpy()
                for (x1, y1, x2, y2), conf in zip(xyxy, confs):
                    players.append(
                        {
                            "boxImageNorm": {
                                "x": round(float(x1) / w, 5),
                                "y": round(float(y1) / h, 5),
                                "width": round(float(x2 - x1) / w, 5),
                                "height": round(float(y2 - y1) / h, 5),
                            },
                            "confidence": round(float(conf), 4),
                        }
                    )
            players.sort(key=lambda p: -p["confidence"])
            frames.append({"imagePath": path, "players": players})

        done += len(chunk)
        if done % 200 < args.batch or done == len(paths):
            rate = done / max(1e-6, _time.time() - t0)
            remaining = (len(paths) - done) / max(rate, 1e-6)
            print(f"[players] {done}/{len(paths)} frames · {rate:.1f} fps · "
                  f"~{remaining / 60:.1f} min left", file=sys.stderr, flush=True)
        print(f"[players] {done}/{len(paths)} frames", file=sys.stderr, flush=True)

    out = json.dumps({"frames": frames, "model": os.path.basename(args.model)})
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(out)
    else:
        print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
