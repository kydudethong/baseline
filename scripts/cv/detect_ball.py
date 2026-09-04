#!/usr/bin/env python3
"""
Ball detection over a video, at (up to) the video's native frame rate, only
inside the time windows the caller asks for (the audio-segmented rallies —
there is no reason to look for a ball between points).

Why this is its own script and not part of the 5 fps player pass: a
pickleball is a handful of pixels in 1080p baseline footage and moves
several of its own diameters per frame. Shot classification needs the
ball's actual arc — apex, bounce, direction changes — which is not
recoverable from 5 sampled frames per second. So players stay at
VISION_FPS, the ball gets every frame in a rally.

Model source (in order of preference; see README "Ball detector"):
  --model-id <project/version>  a Roboflow model — a public Roboflow
       Universe model or one you trained. Run locally through the
       `inference` package (pip install inference), which downloads the
       weights once with ROBOFLOW_API_KEY and then runs offline. Pass
       --hosted (or BALL_INFERENCE=hosted) to call Roboflow's serverless
       API per frame instead — the right call when the model is too heavy
       for the machine (RF-DETR on a laptop CPU runs ~3 s/frame; hosted is
       ~0.2 s/frame) at the cost of one inference credit per frame.
  --model-path <weights.pt>  an Ultralytics YOLO weights file.

Honesty contract: no model → exit 2 with a clear message; the caller
records "shots unavailable" rather than inventing a ball. Every detection
in the output came out of the model on real pixels, with its confidence
passed through unmodified. Up to --top-k candidates per frame are kept
(the tracker on the TypeScript side decides which one is the ball) —
never just "the first one".

Usage:
  detect_ball.py <video> [--windows '[[s,e],...]'] [--model-id ID | --model-path P]
                 [--hosted] [--confidence 0.25] [--fps-cap 30] [--top-k 3]
                 [--imgsz 1280] [--out result.json]
Output JSON:
  { "fps": float, "width": int, "height": int, "framesProcessed": int,
    "detections": [ {"t": s, "frame": n, "x": 0-1, "y": 0-1, "w": 0-1, "h": 0-1, "conf": 0-1}, ... ],
    "diagnostics": {...} }
Coordinates are the box CENTER, normalized to frame width/height.
"""
import argparse
import base64
import json
import os
import sys
import time

import cv2
import numpy as np

BALL_CLASS_HINTS = ("ball", "pickleball", "sports ball", "sports_ball")


def is_ball_class(name: str) -> bool:
    n = (name or "").lower()
    return any(h in n for h in BALL_CLASS_HINTS) or n == ""


class RoboflowLocal:
    """Roboflow model run on this machine via the `inference` package."""

    def __init__(self, model_id: str, api_key: str, confidence: float):
        try:
            from inference import get_model  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise SystemExit(
                "The `inference` package is not installed. Run: pip install inference\n"
                "(or pass --hosted to use Roboflow's hosted API instead)"
            ) from exc
        self.model = get_model(model_id=model_id, api_key=api_key)
        self.confidence = confidence

    def predict(self, frame_bgr):
        results = self.model.infer(frame_bgr, confidence=self.confidence)
        res = results[0] if isinstance(results, list) else results
        out = []
        for p in getattr(res, "predictions", []) or []:
            if not is_ball_class(getattr(p, "class_name", "")):
                continue
            out.append((float(p.x), float(p.y), float(p.width), float(p.height), float(p.confidence)))
        return out


class RoboflowHosted:
    """One HTTPS call per frame against detect.roboflow.com — slow, credit-metered."""

    def __init__(self, model_id: str, api_key: str, confidence: float, host: str):
        import urllib.request  # noqa: F401

        self.model_id = model_id
        self.api_key = api_key
        self.confidence = confidence
        self.host = host.rstrip("/")

    def predict(self, frame_bgr):
        import urllib.request

        ok, buf = cv2.imencode(".jpg", frame_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
        if not ok:
            return []
        body = base64.b64encode(buf.tobytes())
        url = f"{self.host}/{self.model_id}?api_key={self.api_key}&confidence={int(self.confidence * 100)}&overlap=30"
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        out = []
        for p in data.get("predictions", []):
            if not is_ball_class(p.get("class", "")):
                continue
            out.append((float(p["x"]), float(p["y"]), float(p["width"]), float(p["height"]), float(p["confidence"])))
        return out


class UltralyticsLocal:
    def __init__(self, weights: str, confidence: float, imgsz: int):
        try:
            from ultralytics import YOLO  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise SystemExit("ultralytics is not installed. Run: pip install ultralytics") from exc
        self.model = YOLO(weights)
        self.confidence = confidence
        self.imgsz = imgsz

    def predict(self, frame_bgr):
        results = self.model.predict(frame_bgr, conf=self.confidence, imgsz=self.imgsz, verbose=False)
        out = []
        for r in results:
            names = r.names
            for b in r.boxes:
                cls_name = names.get(int(b.cls[0]), "") if isinstance(names, dict) else ""
                if not is_ball_class(cls_name):
                    continue
                x1, y1, x2, y2 = [float(v) for v in b.xyxy[0].tolist()]
                out.append(((x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1, float(b.conf[0])))
        return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--windows", default=None, help="JSON list of [startS, endS] pairs; whole clip if omitted")
    ap.add_argument("--model-id", default=os.environ.get("BALL_MODEL_ID"))
    ap.add_argument("--model-path", default=os.environ.get("BALL_MODEL_PATH"))
    ap.add_argument("--hosted", action="store_true", default=os.environ.get("BALL_INFERENCE", "local") == "hosted")
    ap.add_argument("--host", default=os.environ.get("BALL_HOST", "https://serverless.roboflow.com"))
    ap.add_argument("--confidence", type=float, default=float(os.environ.get("BALL_CONFIDENCE", "0.25")))
    ap.add_argument("--fps-cap", type=float, default=float(os.environ.get("BALL_FPS_CAP", "15")))
    ap.add_argument("--top-k", type=int, default=3)
    ap.add_argument("--imgsz", type=int, default=int(os.environ.get("BALL_IMGSZ", "1280")))
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    api_key = os.environ.get("ROBOFLOW_API_KEY", "")
    if args.model_path:
        model = UltralyticsLocal(args.model_path, args.confidence, args.imgsz)
        source = f"ultralytics:{os.path.basename(args.model_path)}"
    elif args.model_id:
        if not api_key:
            print("ROBOFLOW_API_KEY is not set — required to load a Roboflow model.", file=sys.stderr)
            sys.exit(2)
        if args.hosted:
            model = RoboflowHosted(args.model_id, api_key, args.confidence, args.host)
            source = f"roboflow-hosted:{args.model_id}"
        else:
            model = RoboflowLocal(args.model_id, api_key, args.confidence)
            source = f"roboflow-local:{args.model_id}"
    else:
        print("No ball model configured. Set BALL_MODEL_ID (a Roboflow Universe or trained model id) or BALL_MODEL_PATH.", file=sys.stderr)
        sys.exit(2)

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(f"Could not open video: {args.video}", file=sys.stderr)
        sys.exit(1)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total / fps if fps > 0 else 0.0

    windows = json.loads(args.windows) if args.windows else [[0.0, duration]]
    windows = sorted([[max(0.0, float(s)), min(duration, float(e))] for s, e in windows if e > s])
    step = max(1, int(round(fps / args.fps_cap))) if args.fps_cap > 0 else 1

    detections = []
    frames_processed = 0
    frames_with_ball = 0
    t0 = time.time()
    total_to_process = sum(int((e - s) * fps / step) for s, e in windows)
    print(f"[ball] {source} · {len(windows)} window(s) · ~{total_to_process} frames at {fps / step:.0f} fps", file=sys.stderr, flush=True)
    for start_s, end_s in windows:
        start_f = int(start_s * fps)
        end_f = int(end_s * fps)
        cap.set(cv2.CAP_PROP_POS_FRAMES, start_f)
        f = start_f
        while f <= end_f:
            ok, frame = cap.read()
            if not ok:
                break
            if (f - start_f) % step == 0:
                preds = model.predict(frame)
                preds.sort(key=lambda p: -p[4])
                frames_processed += 1
                if frames_processed % 150 == 0:
                    rate = frames_processed / max(1e-6, time.time() - t0)
                    remaining = (total_to_process - frames_processed) / max(rate, 1e-6)
                    print(f"[ball] {frames_processed}/{total_to_process} frames · seen in {frames_with_ball} · ~{remaining / 60:.1f} min left", file=sys.stderr, flush=True)
                if preds:
                    frames_with_ball += 1
                for (cx, cy, w, h, conf) in preds[: args.top_k]:
                    detections.append(
                        {
                            "t": round(f / fps, 4),
                            "frame": f,
                            "x": round(cx / width, 5),
                            "y": round(cy / height, 5),
                            "w": round(w / width, 5),
                            "h": round(h / height, 5),
                            "conf": round(conf, 4),
                        }
                    )
            f += 1
    cap.release()

    result = {
        "fps": fps / step,
        "sourceFps": fps,
        "width": width,
        "height": height,
        "framesProcessed": frames_processed,
        "detections": detections,
        "diagnostics": {
            "modelSource": source,
            "confidenceThreshold": args.confidence,
            "windows": windows,
            "frameStep": step,
            "framesWithBall": frames_with_ball,
            "ballHitRate": round(frames_with_ball / frames_processed, 3) if frames_processed else 0.0,
            "elapsedSeconds": round(time.time() - t0, 1),
        },
    }
    out = json.dumps(result)
    if args.out:
        with open(args.out, "w") as fh:
            fh.write(out)
    else:
        print(out)


if __name__ == "__main__":
    main()
