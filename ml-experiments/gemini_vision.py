#!/usr/bin/env python3
"""
Ask Gemini to BE the vision pipeline, then render its answer as an overlay.

The other harness (gemini_coach.py) hands Gemini this pipeline's overlay and
asks it to coach. This one removes the pipeline: Gemini watches the raw clip
and returns the court, the players, the ball, skeletons and rally boundaries
itself. The output is converted into exactly the overlay.json that
scripts/cv/render_debug.py already reads, so its answer is drawn with the same
renderer -- which makes the two videos directly comparable frame for frame,
rather than two pictures in different styles that have to be argued about.

WHAT TO EXPECT, stated in advance so the result is not read as a surprise.
Two very different jobs are being asked for at once:

  GEOMETRY -- court corners, ball position, joint locations. Expected to be
  poor. Precise spatial grounding is the known weakness of general VLMs, and
  the ball especially: it crosses a 20ft court in well under a second, while
  video is sampled at a few frames per second. There is no version of this
  where per-frame ball tracking works. It is included anyway because "how
  wrong" is worth knowing.

  TIMING -- when a rally starts and stops. Expected to be good, and the more
  interesting half. That is a semantic judgment about whether a point is being
  played, not a measurement, and gemini-3.8-flash already caught two rally
  boundary errors in this pipeline that a human had watched past.

If that split holds, the conclusion is not "VLM beats CV" or the reverse. It
is that they are good at different halves of the same problem.

Usage:
  export GEMINI_API_KEY=...
  python ml-experiments/gemini_vision.py <video.mp4> [--hz 1] [--model ...]
      [--out-json gemini-vision.json] [--out-video public/rally-debug/gemini-cv.mp4]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# Joint names asked for, and the bones drawn between them. render_debug.py
# colours a bone by its group, and the arms are deliberately different colours
# -- a forehand and a backhand look identical otherwise.
BONES = [
    ("left_shoulder", "right_shoulder", "torso"),
    ("left_shoulder", "left_hip", "torso"),
    ("right_shoulder", "right_hip", "torso"),
    ("left_hip", "right_hip", "torso"),
    ("right_shoulder", "right_elbow", "armRight"),
    ("right_elbow", "right_wrist", "armRight"),
    ("left_shoulder", "left_elbow", "armLeft"),
    ("left_elbow", "left_wrist", "armLeft"),
    ("right_hip", "right_knee", "legRight"),
    ("right_knee", "right_ankle", "legRight"),
    ("left_hip", "left_knee", "legLeft"),
    ("left_knee", "left_ankle", "legLeft"),
]
JOINTS = sorted({j for a, b, _ in BONES for j in (a, b)})

PROMPT = """
You are a computer-vision system analysing a pickleball match filmed from a
fixed camera behind one baseline. Report what you SEE. Every coordinate is a
fraction of the frame: x from 0 (left) to 1 (right), y from 0 (top) to 1
(bottom). Never report pixels.

Report:

1. COURT — the four corners of the full court, as painted. "near" is the
   baseline closest to the camera. A corner may fall OUTSIDE the frame; give
   the coordinate anyway, even if it is negative or greater than 1, because
   the geometry is what matters and the camera's framing is incidental.
   Also the net line: the two points where the net meets each sideline.

2. RALLIES — every span where a point is actually being played, from the
   serve to the moment the point ends. Do NOT include the walking about,
   ball retrieval and resetting between points. This is the part you are
   best placed to judge, so take it seriously and be precise about the end:
   a point is over when the ball stops being played, not when the players
   stop moving.

3. OBSERVATIONS — one entry per sampled moment, at roughly every %(step).1f
   seconds across the whole clip. In each: every player you can see, with a
   bounding box and whatever joints you can locate, and the ball if you can
   see it.

Honesty rules, which matter more than completeness:
- A joint you cannot locate is omitted, not guessed. An omitted joint means
  "not visible"; a guessed one is a limb drawn where no limb was.
- If you cannot see the ball in a given moment, set ball to null. Do not
  interpolate it, do not infer where it "must" be. A null is a correct
  answer and a guess is not.
- Keep player ids stable across the whole clip: the person you call p1 at
  the start must still be p1 at the end.
- confidence is yours, 0 to 1, and should actually vary.
""".strip()


def schema(joint_names: list[str]) -> dict:
    pt = {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2}
    return {
        "type": "object",
        "properties": {
            "court": {
                "type": "object",
                "properties": {k: pt for k in ("near_left", "near_right", "far_right", "far_left")},
                "required": ["near_left", "near_right", "far_right", "far_left"],
            },
            "net_line": {"type": "array", "items": pt, "minItems": 2, "maxItems": 2},
            "court_confidence": {"type": "number"},
            "rallies": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "start_s": {"type": "number"},
                        "end_s": {"type": "number"},
                        "end_reason": {"type": "string"},
                    },
                    "required": ["start_s", "end_s", "end_reason"],
                },
            },
            "observations": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "t": {"type": "number"},
                        "ball": {"type": ["array", "null"], "items": {"type": "number"}},
                        "players": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "id": {"type": "string"},
                                    "box": {"type": "array", "items": {"type": "number"},
                                            "minItems": 4, "maxItems": 4},
                                    "confidence": {"type": "number"},
                                    "joints": {
                                        "type": "object",
                                        "properties": {k: pt for k in joint_names},
                                    },
                                },
                                "required": ["id", "box", "confidence"],
                            },
                        },
                    },
                    "required": ["t", "players"],
                },
            },
        },
        "required": ["court", "rallies", "observations"],
    }


def to_overlay(g: dict, width: int, height: int, duration_s: float) -> dict:
    """Gemini's answer in the shape render_debug.py reads.

    Court and net are PIXELS there; ball, boxes and bones are fractions. Mixing
    those up draws a court in the top-left corner of the frame, which looks
    like a model failure and is not one.
    """
    def px(p):
        return [float(p[0]) * width, float(p[1]) * height]

    c = g.get("court") or {}
    corners = None
    if all(k in c for k in ("near_left", "near_right", "far_right", "far_left")):
        corners = [px(c["near_left"]), px(c["near_right"]), px(c["far_right"]), px(c["far_left"])]

    net = g.get("net_line")
    net_px = [px(net[0]), px(net[1])] if net and len(net) == 2 else None

    ball_points = []
    for o in g.get("observations", []):
        b = o.get("ball")
        if b and len(b) == 2:
            ball_points.append({"t": round(float(o["t"]), 3),
                                "x": float(b[0]), "y": float(b[1]),
                                "interpolated": False})

    # One track per stable id, so the renderer labels people consistently.
    tracks: dict[str, list] = {}
    poses = []
    for o in g.get("observations", []):
        t = round(float(o["t"]), 3)
        for p in o.get("players", []):
            pid = str(p.get("id", "?"))
            box = p.get("box")
            if box and len(box) == 4:
                tracks.setdefault(pid, []).append({"t": t, "box": [float(v) for v in box]})
            joints = p.get("joints") or {}
            bones = []
            for a, b, group in BONES:
                if a in joints and b in joints:
                    ja, jb = joints[a], joints[b]
                    bones.append([float(ja[0]), float(ja[1]), float(jb[0]), float(jb[1]), group])
            if bones:
                poses.append({"t": t, "playerId": pid, "bones": bones,
                              "joints": [[float(v[0]), float(v[1])] for v in joints.values()]})

    return {
        "durationS": duration_s,
        "courtCornersPx": corners,
        "netLinePx": net_px,
        "netBandPx": None,
        "ballGatePx": None,
        "ballPoints": sorted(ball_points, key=lambda p: p["t"]),
        "crossings": [],
        "rallies": [{"idx": i + 1, "startS": float(r["start_s"]), "endS": float(r["end_s"])}
                    for i, r in enumerate(g.get("rallies", []))],
        "poses": poses,
        "paddles": [],
        "audioContacts": [],
        "tracks": [{"playerId": pid, "isSelf": False, "points": pts}
                   for pid, pts in tracks.items()],
    }


def probe(video: Path) -> tuple[int, int, float]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-show_entries", "format=duration",
         "-of", "json", str(video)],
        capture_output=True, text=True, check=True,
    )
    d = json.loads(out.stdout)
    s = d["streams"][0]
    return int(s["width"]), int(s["height"]), float(d["format"]["duration"])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--hz", type=float, default=1.0,
                    help="observations per second to ask for (default 1)")
    ap.add_argument("--model", default="gemini-3.8-flash")
    ap.add_argument("--out-json", default="gemini-vision.json")
    ap.add_argument("--out-video", default="public/rally-debug/gemini-cv.mp4")
    ap.add_argument("--max-output-tokens", type=int, default=60000)
    args = ap.parse_args()

    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        print("Set GEMINI_API_KEY", file=sys.stderr)
        return 2
    try:
        from google import genai
        from google.genai import types
    except ImportError:
        print("pip install google-genai", file=sys.stderr)
        return 2

    video = Path(args.video)
    if not video.exists():
        print(f"no such file: {video}", file=sys.stderr)
        return 2
    width, height, duration = probe(video)
    step = 1.0 / max(0.1, args.hz)
    expected = int(duration / step)
    print(f"{video.name}: {width}x{height}, {duration:.1f}s — asking for ~{expected} observations",
          file=sys.stderr)

    client = genai.Client(api_key=key)
    print("uploading…", file=sys.stderr)
    f = client.files.upload(file=str(video))
    while getattr(f.state, "name", str(f.state)) == "PROCESSING":
        time.sleep(3)
        f = client.files.get(name=f.name)

    prompt = PROMPT % {"step": step}
    started = time.time()
    resp = None
    delay = 5.0
    for attempt in range(1, 5):
        try:
            resp = client.models.generate_content(
                model=args.model,
                contents=[f, prompt],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=schema(JOINTS),
                    max_output_tokens=args.max_output_tokens,
                ),
            )
            break
        except Exception as exc:
            msg = str(exc)
            if attempt == 4 or not ("503" in msg or "UNAVAILABLE" in msg or "500" in msg):
                print(f"\n{args.model}: {msg[:300]}", file=sys.stderr)
                return 3
            print(f"  busy (attempt {attempt}/4) — retrying in {delay:.0f}s", file=sys.stderr)
            time.sleep(delay)
            delay *= 3

    g = json.loads(resp.text)
    Path(args.out_json).write_text(json.dumps(g, indent=2), encoding="utf-8")
    print(f"\n{args.model} in {time.time() - started:.0f}s -> {args.out_json}", file=sys.stderr)

    obs = g.get("observations", [])
    with_ball = sum(1 for o in obs if o.get("ball"))
    with_joints = sum(1 for o in obs for p in o.get("players", []) if p.get("joints"))
    players = sum(len(o.get("players", [])) for o in obs)
    print(f"  court:        {'yes' if g.get('court') else 'no'}"
          f"  (confidence {g.get('court_confidence', '?')})")
    print(f"  rallies:      {len(g.get('rallies', []))}")
    for r in g.get("rallies", []):
        print(f"      {r['start_s']:6.1f}-{r['end_s']:6.1f}s  {r.get('end_reason', '')}")
    print(f"  observations: {len(obs)} asked ~{expected}"
          + ("  (TRUNCATED — lower --hz)" if len(obs) < expected * 0.6 else ""))
    print(f"  ball seen in: {with_ball}/{len(obs)} ({with_ball / max(1, len(obs)) * 100:.0f}%)")
    print(f"  player boxes: {players}, of which {with_joints} carry joints")

    overlay = to_overlay(g, width, height, duration)
    tmp = Path(args.out_json).with_suffix(".overlay.json")
    tmp.write_text(json.dumps(overlay), encoding="utf-8")

    out_video = Path(args.out_video)
    out_video.parent.mkdir(parents=True, exist_ok=True)
    renderer = Path("scripts/cv/render_debug.py")
    python = os.environ.get("CV_PYTHON", sys.executable)
    print(f"\nrendering {out_video} with {python}…", file=sys.stderr)
    r = subprocess.run([python, str(renderer), str(video), "--data", str(tmp), "--out", str(out_video)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-1500:], file=sys.stderr)
        print("render failed — the JSON is still there to inspect", file=sys.stderr)
        return 4
    print(f"wrote {out_video}", file=sys.stderr)
    print("\nWatch it beside the pipeline's own overlay. Same renderer, same clip,\n"
          "so anything that differs is the two systems disagreeing, not two styles.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
