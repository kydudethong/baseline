"""Generate a synthetic pickleball clip plus exact rally labels.

Not a substitute for real footage -- it cannot tell you whether the ball
detector generalises.  What it can do, and what real footage cannot do cheaply,
is give the temporal logic a test with *known-exact* boundaries: rallies that
start on a specific frame, end on out-of-bounds or into the net, and contain
deliberate occlusion gaps.  That is what the state machine's regression tests
need.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
from dataclasses import dataclass
from typing import Iterator, List, Optional, Tuple

import cv2
import numpy as np

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from rally_seg.detect.court import (
    COURT_CORNERS, COURT_L, COURT_W, KITCHEN_FAR_Y, KITCHEN_NEAR_Y, NET_Y,
)
from rally_seg.video import write_video

W, H = 960, 540
CAMERA_QUAD = np.array(
    [[150.0, 505.0], [810.0, 505.0], [612.0, 150.0], [348.0, 150.0]], dtype=np.float32
)


#: Height at which a paddle meets the ball, in feet.  Everything about the
#: bounce detector keys off the ball reaching zero height, so contact height and
#: ground height must be genuinely different in the simulation.
CONTACT_HEIGHT_FT = 2.2


def arc(u: float, h0: float, h1: float, apex: float) -> float:
    """Parabola with ``h0`` at u=0, ``h1`` at u=1 and ``apex`` at the midpoint."""
    return h0 + (h1 - h0) * u + 4.0 * (apex - 0.5 * (h0 + h1)) * u * (1.0 - u)


@dataclass
class Shot:
    t0: float
    t1: float
    p0: Tuple[float, float]      # court ft
    p1: Tuple[float, float]
    apex_ft: float
    #: Fraction of the shot at which the ball bounces, or None for a volley.
    bounce_at: Optional[float] = None


@dataclass
class Rally:
    start_s: float
    end_s: float
    shots: List[Shot]
    ending: str
    occlusion: Tuple[float, float] = (0.0, 0.0)   # a stretch with no ball drawn


def homography() -> np.ndarray:
    return cv2.getPerspectiveTransform(COURT_CORNERS, CAMERA_QUAD)


def to_image(H: np.ndarray, pt_ft) -> np.ndarray:
    p = np.array([[pt_ft[0], pt_ft[1]]], dtype=np.float32).reshape(-1, 1, 2)
    return cv2.perspectiveTransform(p, H).reshape(2)


def px_per_ft(H: np.ndarray, pt_ft) -> float:
    a = to_image(H, pt_ft)
    b = to_image(H, (min(pt_ft[0] + 1, COURT_W), pt_ft[1]))
    return float(np.linalg.norm(b - a)) or 6.0


def build_script(duration_s: float, seed: int = 7) -> List[Rally]:
    rng = random.Random(seed)
    rallies: List[Rally] = []
    t = 3.0
    while t < duration_s - 14.0:
        n_shots = rng.randint(3, 9)
        shots: List[Shot] = []
        start = t
        near = True
        for k in range(n_shots):
            dur = rng.uniform(0.55, 0.95)
            if k == 0:
                p0 = (rng.uniform(4, 16), rng.uniform(0.5, 2.0))
                p1 = (rng.uniform(4, 16), rng.uniform(30, 41))
                apex = rng.uniform(7, 10)
            else:
                y0 = rng.uniform(30, 41) if not near else rng.uniform(2, 14)
                y1 = rng.uniform(2, 14) if not near else rng.uniform(30, 41)
                p0 = (rng.uniform(3, 17), y0)
                p1 = (rng.uniform(3, 17), y1)
                apex = rng.uniform(4, 9)
            # Groundstrokes bounce; volleys do not.  Both are common, and a
            # bounce detector that has only seen one of them is untested.
            bounce_at = rng.uniform(0.55, 0.72) if (k == 0 or rng.random() < 0.6) else None
            shots.append(Shot(t, t + dur, p0, p1, apex, bounce_at))
            t += dur
            near = not near

        ending = rng.choice(["out", "out", "net", "ground"])
        last = shots[-1]
        if ending == "out":
            side = rng.choice([-1, 1])
            x_out = -2.5 if side < 0 else COURT_W + 2.5
            shots[-1] = Shot(last.t0, last.t1, last.p0, (x_out, last.p1[1]), last.apex_ft, None)
        elif ending == "net":
            shots[-1] = Shot(last.t0, last.t0 + 0.45, last.p0,
                             (rng.uniform(6, 14), NET_Y + (0.4 if last.p0[1] < NET_Y else -0.4)),
                             3.2, None)
            t = shots[-1].t1
        else:
            shots[-1] = Shot(last.t0, last.t1, last.p0, last.p1, last.apex_ft, None)
        # The rally is over when the ball lands, not when it stops rolling.
        end = t + 0.30

        occ = (0.0, 0.0)
        if n_shots >= 5 and rng.random() < 0.6:
            mid = shots[len(shots) // 2]
            occ = (mid.t0 + 0.1, mid.t0 + 0.1 + rng.uniform(0.25, 0.55))

        rallies.append(Rally(start, end, shots, ending, occ))
        t = end + rng.uniform(4.0, 9.0)
    return rallies


def shot_height(s: Shot, u: float) -> float:
    """Ball height through one shot, in feet."""
    if s.bounce_at is None:
        return max(0.05, arc(u, CONTACT_HEIGHT_FT, CONTACT_HEIGHT_FT, s.apex_ft))
    b = s.bounce_at
    if u <= b:
        return max(0.0, arc(u / b, CONTACT_HEIGHT_FT, 0.0, s.apex_ft))
    return max(0.0, arc((u - b) / (1.0 - b), 0.0, CONTACT_HEIGHT_FT, s.apex_ft * 0.45))


def landing_height(dt: float) -> float:
    """Two decaying bounces after the final shot, then the ball sits there."""
    b1, b2 = 0.52, 0.34
    if dt < b1:
        return arc(dt / b1, 0.0, 0.0, 2.1)
    if dt < b1 + b2:
        return arc((dt - b1) / b2, 0.0, 0.0, 0.75)
    return 0.06


def ball_at(rallies: List[Rally], t: float) -> Optional[Tuple[float, float, float]]:
    for r in rallies:
        if not (r.start_s - 0.1 <= t <= r.end_s + 3.0):
            continue
        if r.occlusion[0] <= t <= r.occlusion[1]:
            return None
        for s in r.shots:
            if s.t0 <= t <= s.t1:
                u = (t - s.t0) / max(1e-6, s.t1 - s.t0)
                x = s.p0[0] + u * (s.p1[0] - s.p0[0])
                y = s.p0[1] + u * (s.p1[1] - s.p0[1])
                return x, y, shot_height(s, u)
        last = r.shots[-1]
        if t > last.t1:
            return last.p1[0], last.p1[1], landing_height(t - last.t1)
    return None


def players_at(rallies: List[Rally], t: float) -> List[Tuple[float, float]]:
    active = any(r.start_s - 0.5 <= t <= r.end_s + 0.3 for r in rallies)
    amp = 3.2 if active else 0.35
    speed = 1.6 if active else 0.25
    base = [(6.0, 6.0), (14.0, 6.0), (6.0, 38.0), (14.0, 38.0)]
    out = []
    for i, (x, y) in enumerate(base):
        out.append((
            float(np.clip(x + amp * math.sin(speed * t + i * 1.7), 0.5, COURT_W - 0.5)),
            float(np.clip(y + amp * 0.8 * math.cos(speed * t * 0.9 + i), 1.0, COURT_L - 1.0)),
        ))
    return out


def draw_frame(H: np.ndarray, rallies: List[Rally], t: float, rng: random.Random) -> np.ndarray:
    img = np.full((H_SIZE[1], H_SIZE[0], 3), (58, 92, 46), dtype=np.uint8)
    cv2.rectangle(img, (0, 0), (H_SIZE[0], 132), (72, 68, 64), -1)

    quad = CAMERA_QUAD.astype(np.int32)
    cv2.fillPoly(img, [quad], (118, 86, 52))

    def line(a, b, color=(238, 238, 238), th=2):
        p0 = to_image(H, a).astype(int)
        p1 = to_image(H, b).astype(int)
        cv2.line(img, tuple(p0), tuple(p1), color, th, cv2.LINE_AA)

    line((0, 0), (COURT_W, 0)); line((0, COURT_L), (COURT_W, COURT_L))
    line((0, 0), (0, COURT_L)); line((COURT_W, 0), (COURT_W, COURT_L))
    line((0, KITCHEN_NEAR_Y), (COURT_W, KITCHEN_NEAR_Y))
    line((0, KITCHEN_FAR_Y), (COURT_W, KITCHEN_FAR_Y))
    line((COURT_W / 2, 0), (COURT_W / 2, KITCHEN_NEAR_Y))
    line((COURT_W / 2, KITCHEN_FAR_Y), (COURT_W / 2, COURT_L))

    # Net: a band above the net line.
    p0 = to_image(H, (0, NET_Y)); p1 = to_image(H, (COURT_W, NET_Y))
    scale = px_per_ft(H, (COURT_W / 2, NET_Y))
    top = np.array([[p0[0], p0[1] - 2.9 * scale], [p1[0], p1[1] - 2.9 * scale]])
    cv2.fillPoly(img, [np.array([p0, p1, top[1], top[0]], dtype=np.int32)], (66, 66, 70))
    cv2.line(img, tuple(top[0].astype(int)), tuple(top[1].astype(int)), (236, 236, 236), 2)

    for i, (x, y) in enumerate(players_at(rallies, t)):
        foot = to_image(H, (x, y))
        s = px_per_ft(H, (x, y))
        h = 5.8 * s
        w = 1.6 * s
        colour = [(196, 84, 62), (72, 132, 210), (86, 176, 96), (188, 148, 60)][i]
        cv2.rectangle(img, (int(foot[0] - w / 2), int(foot[1] - h)),
                      (int(foot[0] + w / 2), int(foot[1])), colour, -1)
        cv2.circle(img, (int(foot[0]), int(foot[1] - h)), int(0.55 * s), (206, 178, 152), -1)

    ball = ball_at(rallies, t)
    if ball is not None:
        x, y, h_ft = ball
        ground = to_image(H, (float(np.clip(x, -6, COURT_W + 6)), float(np.clip(y, -6, COURT_L + 6))))
        s = px_per_ft(H, (float(np.clip(x, 0, COURT_W)), float(np.clip(y, 0, COURT_L))))
        px = (int(ground[0]), int(ground[1] - h_ft * s))
        r = max(2, int(0.32 * s))
        cv2.circle(img, px, r, (86, 236, 246), -1, cv2.LINE_AA)

    noise = rng.gauss(0, 1)
    if abs(noise) > 2.2:            # occasional sensor noise, so nothing is too clean
        img = cv2.add(img, np.random.randint(0, 9, img.shape, dtype=np.uint8))
    return img


H_SIZE = (W, H)


def ball_pixel(H: np.ndarray, rallies: List[Rally], t: float) -> Optional[Tuple[float, float, float]]:
    """Where the ball is drawn, and how big -- the detector's ground truth."""
    ball = ball_at(rallies, t)
    if ball is None:
        return None
    x, y, h_ft = ball
    ground = to_image(H, (float(np.clip(x, -6, COURT_W + 6)), float(np.clip(y, -6, COURT_L + 6))))
    s = px_per_ft(H, (float(np.clip(x, 0, COURT_W)), float(np.clip(y, 0, COURT_L))))
    r = max(2.0, 0.32 * s)
    return float(ground[0]), float(ground[1] - h_ft * s), 2 * r


def make_detections(H: np.ndarray, rallies: List[Rally], duration_s: float, fps: float,
                    seed: int = 11, miss_rate: float = 0.08,
                    false_rate: float = 0.015) -> dict:
    """Simulate a good-but-imperfect trained detector.

    Deliberately imperfect: a detector that never misses and never hallucinates
    would let a broken tracker and a fragile state machine pass the test.  The
    numbers here (8% misses, 1.5% false positives, sub-pixel localisation noise)
    are roughly what a well-trained small-object YOLO gives on 1080p pickleball
    footage.
    """
    rng = random.Random(seed)
    out: dict = {}
    n = int(duration_s * fps)
    for i in range(n):
        t = i / fps
        rows = []
        b = ball_pixel(H, rallies, t)
        if b is not None and rng.random() > miss_rate:
            x, y, size = b
            rows.append([
                round(x + rng.gauss(0, 0.9), 2), round(y + rng.gauss(0, 0.9), 2),
                round(rng.uniform(0.55, 0.95), 3), round(size, 1), round(size, 1),
            ])
        if rng.random() < false_rate:
            rows.append([round(rng.uniform(120, 840), 2), round(rng.uniform(140, 500), 2),
                         round(rng.uniform(0.16, 0.4), 3), 7.0, 7.0])
        if rows:
            out[str(i)] = rows
    return {"detections": out}


def generate(out_video: str, out_labels: str, duration_s: float = 90.0,
             fps: float = 30.0, seed: int = 7) -> Tuple[str, str]:
    Hm = homography()
    rallies = build_script(duration_s, seed)
    rng = random.Random(seed + 1)

    def frames() -> Iterator[np.ndarray]:
        n = int(duration_s * fps)
        for i in range(n):
            yield draw_frame(Hm, rallies, i / fps, rng)

    write_video(frames(), out_video, fps, H_SIZE, crf=20, preset="veryfast")
    labels = [{"start_s": round(r.start_s, 3), "end_s": round(r.end_s, 3), "ending": r.ending}
              for r in rallies]
    os.makedirs(os.path.dirname(os.path.abspath(out_labels)) or ".", exist_ok=True)
    with open(out_labels, "w", encoding="utf-8") as fh:
        json.dump({"rallies": labels}, fh, indent=2)

    det_path = os.path.splitext(out_video)[0] + ".detections.json"
    with open(det_path, "w", encoding="utf-8") as fh:
        json.dump(make_detections(Hm, rallies, duration_s, fps, seed + 2), fh)
    return out_video, out_labels


def main(argv=None) -> int:
    p = argparse.ArgumentParser("make_synthetic")
    p.add_argument("--out", default="assets/synthetic.mp4")
    p.add_argument("--labels", default="assets/synthetic.labels.json")
    p.add_argument("--duration", type=float, default=90.0)
    p.add_argument("--fps", type=float, default=30.0)
    p.add_argument("--seed", type=int, default=7)
    a = p.parse_args(argv)
    v, l = generate(a.out, a.labels, a.duration, a.fps, a.seed)
    print(f"wrote {v} and {l}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
