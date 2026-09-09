#!/usr/bin/env python3
"""
Is a stranger's paddle model good enough to build on?

The question is NOT "what fraction of frames has a paddle in it" -- a model
that finds paddles while players stand around waiting is worthless here. The
paddle matters at exactly one instant, the contact, and that is the hardest
instant: mid-swing, maximum motion blur, often crossing the player's body.

So this measures coverage in three separate places and prints them side by
side:

  overall        every sampled frame
  at contacts    within +/-0.1s of a known contact time
  elsewhere      everything else

A model that scores well overall and badly at contacts is worse than useless
for contact detection, because its errors are correlated with the moments that
matter. That distinction is the entire point of running this before wiring
anything in.

It also reports paddles-per-frame against the number of players on court. Four
players means at most four paddles; a model returning nine boxes a frame is
finding paddle-shaped noise, and its "coverage" is meaningless.

Usage:
  python paddle_benchmark.py --video ky-720p.mp4 --model-id <project/version> \\
      [--contacts contacts.json] [--limit 900] [--confidence 0.25]

--contacts takes either a JSON list of seconds, or an object with a
"contacts"/"events" list of numbers or {t}/{timestampSeconds} objects --
whatever the pipeline last wrote. Without it the contact/elsewhere split is
skipped and only overall coverage is reported.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import cv2


def load_contacts(path: str | None) -> list[float]:
    if not path or not os.path.exists(path):
        return []
    raw = json.load(open(path))
    if isinstance(raw, dict):
        raw = raw.get("contacts") or raw.get("events") or raw.get("hits") or []
    out: list[float] = []
    for item in raw:
        if isinstance(item, (int, float)):
            out.append(float(item))
        elif isinstance(item, dict):
            for key in ("t", "t_s", "timestampSeconds", "timestamp_s"):
                if isinstance(item.get(key), (int, float)):
                    out.append(float(item[key]))
                    break
    return sorted(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--model-id", default=os.environ.get("PADDLE_MODEL_ID"),
                    help="Roboflow model id, e.g. pickleball-paddle-detection/3")
    ap.add_argument("--contacts", default=None)
    ap.add_argument("--limit", type=int, default=900)
    ap.add_argument("--confidence", type=float, default=0.25)
    ap.add_argument("--near-contact-s", type=float, default=0.10)
    ap.add_argument("--out-json", default="paddle_result.json")
    args = ap.parse_args()

    if not args.model_id:
        print("Pass --model-id (or set PADDLE_MODEL_ID). Find one on Roboflow Universe.", file=sys.stderr)
        return 2
    api_key = os.environ.get("ROBOFLOW_API_KEY", "")
    if not api_key:
        print("ROBOFLOW_API_KEY is not set -- source .env.local first.", file=sys.stderr)
        return 2

    # Local inference: the weights download once and then run offline, so this
    # costs no per-frame credits. Same path detect_ball.py uses.
    try:
        from inference import get_model  # type: ignore
    except ImportError:
        print("pip install inference (into the interpreter the app uses)", file=sys.stderr)
        return 2
    model = get_model(model_id=args.model_id, api_key=api_key)

    contacts = load_contacts(args.contacts)
    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(f"cannot open {args.video}", file=sys.stderr)
        return 1
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    seen_any = near_any = far_any = 0
    near_frames = far_frames = 0
    boxes_total = 0
    per_frame: dict[int, int] = {}
    i, t0 = 0, time.time()

    while True:
        ok, img = cap.read()
        if not ok or (args.limit and i >= args.limit):
            break
        t = i / fps
        is_near = any(abs(t - c) <= args.near_contact_s for c in contacts) if contacts else False

        result = model.infer(img, confidence=args.confidence)[0]
        n = len(getattr(result, "predictions", []) or [])
        boxes_total += n
        per_frame[i] = n
        if n > 0:
            seen_any += 1
            if is_near:
                near_any += 1
            else:
                far_any += 1
        if contacts:
            near_frames += 1 if is_near else 0
            far_frames += 0 if is_near else 1

        i += 1
        if i % 100 == 0:
            print(f"[paddle] {i} frames · seen in {seen_any} · {i / max(1e-6, time.time() - t0):.1f} fps",
                  file=sys.stderr, flush=True)
    cap.release()

    pct = lambda a, b: f"{(100.0 * a / b):.1f}%" if b else "n/a"
    print()
    print(f"model         : {args.model_id}  (conf >= {args.confidence})")
    print(f"overall       : paddle in {seen_any} of {i} frames = {pct(seen_any, i)}")
    print(f"boxes/frame   : {boxes_total / max(1, i):.2f}   (4 players on court = at most 4 real paddles)")
    if contacts:
        print()
        print(f"AT CONTACTS   : {near_any} of {near_frames} = {pct(near_any, near_frames)}"
              f"   (+/-{args.near_contact_s}s of {len(contacts)} known contacts)")
        print(f"elsewhere     : {far_any} of {far_frames} = {pct(far_any, far_frames)}")
        print()
        near_rate = near_any / near_frames if near_frames else 0.0
        far_rate = far_any / far_frames if far_frames else 0.0
        if near_frames == 0:
            print("VERDICT: no frames fell near a contact -- check the --contacts file.")
        elif near_rate >= 0.6:
            print("VERDICT: usable at the moment that matters. Worth wiring in.")
        elif near_rate >= 0.35 and near_rate >= far_rate:
            print("VERDICT: marginal. Useful as a confidence bump on contacts found another\n"
                  "         way, not as a contact detector on its own.")
        else:
            print("VERDICT: not usable for contacts -- it loses the paddle exactly when the\n"
                  f"         paddle is swinging ({pct(near_any, near_frames)} at contacts vs "
                  f"{pct(far_any, far_frames)} elsewhere).\n"
                  "         The forearm-direction estimate costs nothing and would do as well.")
    else:
        print("\n(no --contacts given, so the only number here is overall coverage --\n"
              " which is NOT the number that decides whether this model is useful)")

    json.dump({"modelId": args.model_id, "framesProcessed": i, "seenAny": seen_any,
               "boxesPerFrame": boxes_total / max(1, i), "nearContact": near_any,
               "nearFrames": near_frames, "farContact": far_any, "farFrames": far_frames,
               "perFrameBoxes": per_frame}, open(args.out_json, "w"))
    print(f"\nwrote {args.out_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
