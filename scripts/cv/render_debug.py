#!/usr/bin/env python3
"""
Render the pipeline's own overlay onto the clip.

Not rally_seg's overlay -- this one draws exactly what THIS pipeline computed
and used: the court it measured with, the net line rally boundaries were read
from, the ball track it built, every confirmed net crossing, the player boxes
it kept after the court gate, and the rally bands it produced.

That distinction is the whole point. An overlay from a component that did not
decide the answer shows you a plausible picture of the wrong thing, and the
numbers and the video then disagree with no way to tell which is lying.

Usage: render_debug.py <video> --data overlay.json --out debug.mp4
"""
import argparse
import json
import subprocess
import sys

import cv2
import numpy as np

C_COURT = (255, 210, 58)      # BGR-ish cyan/blue for the court
C_NET = (200, 67, 255)        # magenta
C_BALL = (60, 220, 255)       # amber
C_TRAIL = (60, 180, 255)
C_PLAYER = (140, 224, 92)
C_SELF = (58, 210, 255)
C_LIVE = (92, 224, 140)
C_DEAD = (110, 110, 110)


def draw_poly(img, pts, colour, thickness=2):
    p = np.asarray(pts, dtype=np.int32).reshape(-1, 1, 2)
    cv2.polylines(img, [p], True, colour, thickness, cv2.LINE_AA)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--crf", type=int, default=26)
    args = ap.parse_args()

    with open(args.data, "r", encoding="utf-8") as fh:
        d = json.load(fh)

    corners = d.get("courtCornersPx")       # [[x,y] x4] near-l, near-r, far-r, far-l
    net = d.get("netLinePx")                # [[x,y],[x,y]]
    band = d.get("netBandPx")               # {base:[[x,y]x2], top:[[x,y]x3]}
    ball_gate = d.get("ballGatePx")         # [[x,y] ...] airspace polygon
    ball = d.get("ballPoints", [])          # [{t,x,y,interpolated}] normalized
    crossings = d.get("crossings", [])      # [{t, into}]
    paddles = d.get("paddles", [])          # [{t, x, y, w, h, conf}]
    audio_contacts = d.get("audioContacts", [])  # [{t, x, y}]
    rallies = d.get("rallies", [])          # [{idx,startS,endS}]
    tracks = d.get("tracks", [])            # [{playerId, isSelf, points:[{t, box:[x,y,w,h]}]}]
    poses = d.get("poses", [])              # [{t, playerId, bones:[[x1,y1,x2,y2,group]], joints:[[x,y]]}]

    # BGR. Arms brightest: the paddle arm is the thing a coach watches, and a
    # one-colour stick figure makes a forehand and a backhand look identical.
    limb_bgr = {
        "head": (187, 168, 154), "torso": (140, 224, 92),
        "armRight": (58, 210, 255), "armLeft": (255, 160, 58),
        "legRight": (176, 227, 143), "legLeft": (255, 196, 127),
    }

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(f"cannot open {args.video}", file=sys.stderr)
        return 1
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
         "-r", f"{fps:.4f}", "-i", "-", "-an", "-vcodec", "libx264",
         "-preset", "veryfast", "-crf", str(args.crf), "-pix_fmt", "yuv420p", args.out],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    # Index by time for cheap lookup.
    ball_sorted = sorted(ball, key=lambda p: p["t"])
    ball_ts = [p["t"] for p in ball_sorted]
    scale = max(0.5, w / 1280.0)
    i = 0
    while True:
        ok, img = cap.read()
        if not ok:
            break
        t = i / fps
        i += 1

        if corners:
            draw_poly(img, corners, C_COURT, int(2 * scale))
        if ball_gate:
            # Where a ball of THIS court can be, including its airspace.
            draw_poly(img, ball_gate, (90, 90, 110), max(1, int(scale)))

        if band:
            # The net as a surface: base on the ground, tape above it with the
            # real sag, and the face between them shaded. A ball inside this
            # band cannot be assigned to a side -- from behind a baseline the
            # net stands between the camera and the far court -- so seeing the
            # band is seeing exactly where the crossing test declines to guess.
            bl, br = band["base"]
            tl, tc, tr = band["top"]
            face = np.array([bl, tl, tc, tr, br], dtype=np.int32)
            overlay = img.copy()
            cv2.fillPoly(overlay, [face.reshape(-1, 1, 2)], C_NET)
            cv2.addWeighted(overlay, 0.18, img, 0.82, 0, img)
            cv2.polylines(img, [np.array([tl, tc, tr], np.int32).reshape(-1, 1, 2)],
                          False, C_NET, int(2 * scale), cv2.LINE_AA)
            cv2.line(img, tuple(np.int32(bl)), tuple(np.int32(br)), C_NET, int(2 * scale), cv2.LINE_AA)
            for a_, b_ in ((bl, tl), (br, tr)):
                cv2.line(img, tuple(np.int32(a_)), tuple(np.int32(b_)), C_NET,
                         int(2 * scale), cv2.LINE_AA)
            cv2.putText(img, "NET", (int(tl[0]) + 6, int(tl[1]) - 8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5 * scale, C_NET, 1, cv2.LINE_AA)
        elif net:
            cv2.line(img, tuple(np.int32(net[0])), tuple(np.int32(net[1])),
                     C_NET, int(3 * scale), cv2.LINE_AA)
            cv2.putText(img, "NET", (int(net[0][0]) + 6, int(net[0][1]) - 8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5 * scale, C_NET, 1, cv2.LINE_AA)

        # Ball trail: the last ~1s, brightening toward now. Hollow circles are
        # interpolated points, so a filled run is real observation.
        lo = np.searchsorted(ball_ts, t - 1.0)
        hi = np.searchsorted(ball_ts, t)
        prev = None
        for p in ball_sorted[lo:hi]:
            cx, cy = int(p["x"] * w), int(p["y"] * h)
            if prev is not None:
                cv2.line(img, prev, (cx, cy), C_TRAIL, max(1, int(scale)), cv2.LINE_AA)
            prev = (cx, cy)
        if hi > lo:
            p = ball_sorted[hi - 1]
            cx, cy = int(p["x"] * w), int(p["y"] * h)
            r = int(7 * scale)
            cv2.circle(img, (cx, cy), r, C_BALL, -1 if not p.get("interpolated") else 1, cv2.LINE_AA)

        for tr in tracks:
            pts = tr.get("points", [])
            best = None
            bdt = 0.25
            for pt in pts:
                dt = abs(pt["t"] - t)
                if dt < bdt:
                    bdt = dt
                    best = pt
            if not best:
                continue
            bx, by, bw, bh = best["box"]
            x1, y1 = int(bx * w), int(by * h)
            x2, y2 = int((bx + bw) * w), int((by + bh) * h)
            colour = C_SELF if tr.get("isSelf") else C_PLAYER
            cv2.rectangle(img, (x1, y1), (x2, y2), colour, int(2 * scale), cv2.LINE_AA)
            label = "YOU" if tr.get("isSelf") else tr.get("playerId", "")
            cv2.putText(img, label, (x1, max(14, y1 - 6)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45 * scale, colour, 1, cv2.LINE_AA)

        # Skeletons. Drawn after the boxes so a limb is never hidden by one,
        # and only from keypoints the model actually saw -- joining low
        # confidence points draws limbs that were never there, which is worse
        # than an incomplete figure because it looks complete.
        for ps in poses:
            if abs(ps["t"] - t) > 0.12:
                continue
            for (x1, y1, x2, y2, group) in ps.get("bones", []):
                col = limb_bgr.get(group, (200, 200, 200))
                thick = int((3 if group.startswith("arm") else 2) * scale)
                cv2.line(img, (int(x1 * w), int(y1 * h)), (int(x2 * w), int(y2 * h)),
                         col, max(1, thick), cv2.LINE_AA)
            for (jx, jy) in ps.get("joints", []):
                cv2.circle(img, (int(jx * w), int(jy * h)), max(2, int(2.5 * scale)),
                           (255, 255, 255), -1, cv2.LINE_AA)

        # Paddle boxes, drawn wherever the model saw one within a frame or two.
        # Drawn rather than only counted on purpose: a paddle detector that is
        # finding chairs and shoes reads as a plausible number in a log and is
        # obvious the moment you watch it.
        # Held for a beat rather than drawn on the exact sampled frame. The
        # paddle pass samples at PADDLE_FPS_CAP (12 by default) while the
        # overlay renders every frame, so an exact match would show each
        # detection for a single frame -- a flicker you cannot judge. Holding
        # it for slightly longer than the sample interval makes the box
        # continuous while a paddle is genuinely being found, and makes gaps
        # read as gaps.
        paddle_hold = 0.10
        drawn_paddles = 0
        for pd in paddles:
            if abs(t - pd["t"]) <= paddle_hold:
                px, py = int(pd["x"] * w), int(pd["y"] * h)
                pw, ph = pd.get("w"), pd.get("h")
                if pw and ph:
                    # The model's actual box, same as the player boxes above.
                    # A fixed circle at the centre looks identical whether the
                    # model boxed a paddle or half the court -- which is the
                    # one thing you need to be able to see.
                    bw, bh = int(pw * w), int(ph * h)
                    x1, y1 = px - bw // 2, py - bh // 2
                    x2, y2 = x1 + bw, y1 + bh
                    # Grey + "?" when the box sat on nobody. Those are dropped
                    # before the audio gate uses them, but they are still DRAWN:
                    # a model finding chairs and a model finding nothing look
                    # identical on an empty screen, and they need opposite fixes.
                    # Every paddle now comes from the arm -- model detection
                    # was removed after five models topped out at 14% of frames
                    # on this footage. One colour, one shape, and the purple
                    # says "derived" everywhere it appears.
                    col, label = (200, 140, 255), "paddle (from arm)"
                    th = max(1, int(2 * scale))
                    ang = pd.get("angleDeg")
                    if ang is not None:
                        # Draw the PADDLE, not a box around where one might be.
                        #
                        # A rectangle tells you an orientation. A paddle shape
                        # tells you whether the thing is somewhere a paddle
                        # could actually be -- and "does that look like it is
                        # in his hand" is the only way anyone can judge this
                        # estimate against footage.
                        #
                        # x/y is the TIP, angleDeg the long axis and h the full
                        # butt-to-tip length, so the butt lands back at the
                        # hand and the whole object is determined.
                        import math as _m
                        rad = _m.radians(float(ang))
                        ux, uy = _m.cos(rad), _m.sin(rad)
                        L = max(bh, bw)                 # butt to tip
                        face = max(6, int(min(bw, bh))) # across the face
                        butt = (int(px - ux * L), int(py - uy * L))
                        neck = (int(px - ux * L * 0.58), int(py - uy * L * 0.58))
                        centre = (int((px + neck[0]) / 2), int((py + neck[1]) / 2))
                        cv2.line(img, butt, neck, col, max(2, th), cv2.LINE_AA)
                        cv2.ellipse(img, centre, (max(3, int(L * 0.30)), max(3, face // 2)),
                                    float(ang), 0, 360, col, th, cv2.LINE_AA)
                        # A filled dot at the butt: a paddle outline is roughly
                        # symmetric, so without it you cannot tell which end is
                        # the hand.
                        cv2.circle(img, butt, max(2, int(3 * scale)), col, -1, cv2.LINE_AA)
                    else:
                        # No angle means the arm was not readable, so there is
                        # no paddle to draw -- a box would claim a position the
                        # geometry declined to give.
                        continue
                    cv2.putText(img, f'{label} {pd.get("conf", 0):.2f}',
                                (x1, max(int(12 * scale), y1 - int(6 * scale))),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.42 * scale, col, 1, cv2.LINE_AA)
                else:
                    r = max(6, int(11 * scale))
                    cv2.circle(img, (px, py), r, (60, 220, 255), 2, cv2.LINE_AA)
                    cv2.putText(img, f'{pd.get("conf", 0):.2f}', (px + r + 3, py + 4),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.42 * scale, (60, 220, 255), 1, cv2.LINE_AA)
                drawn_paddles += 1

        # Say so when the paddle pass simply was not looking here. Silence is
        # ambiguous: it could mean the model found nothing, or that this moment
        # was never sampled, and those call for opposite fixes.
        if paddles:
            near_window = any(abs(t - pd["t"]) <= 0.6 for pd in paddles)
            if drawn_paddles == 0 and near_window:
                cv2.putText(img, "no paddle found here", (int(14 * scale), int(h - 58 * scale)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45 * scale, (60, 220, 255), 1, cv2.LINE_AA)

        # A confirmed audio contact: heard AND agreed with by the ball.
        for ac in audio_contacts:
            if 0 <= t - ac["t"] <= 0.25:
                px, py = int(ac["x"] * w), int(ac["y"] * h)
                cv2.circle(img, (px, py), max(9, int(16 * scale)), (90, 255, 140), 2, cv2.LINE_AA)
                cv2.putText(img, "CONTACT (audio+ball)", (px + int(20 * scale), py + int(5 * scale)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5 * scale, (90, 255, 140), 1, cv2.LINE_AA)

        # A crossing flashes for a third of a second, with its direction.
        for c in crossings:
            if 0 <= t - c["t"] <= 0.33:
                txt = "BALL CROSSED NET -> far" if c["into"] > 0 else "BALL CROSSED NET -> near"
                cv2.rectangle(img, (0, 0), (w, int(46 * scale)), C_NET, -1)
                cv2.putText(img, txt, (int(14 * scale), int(31 * scale)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.8 * scale, (255, 255, 255), 2, cv2.LINE_AA)
                break

        active = next((r for r in rallies if r["startS"] <= t <= r["endS"]), None)
        banner = f"RALLY {active['idx']}  {active['startS']:.1f}-{active['endS']:.1f}s" if active else "no rally"
        colour = C_LIVE if active else C_DEAD
        y0 = h - int(38 * scale)
        cv2.rectangle(img, (0, y0), (w, h), (24, 24, 28), -1)
        cv2.circle(img, (int(20 * scale), y0 + int(19 * scale)), int(7 * scale), colour, -1, cv2.LINE_AA)
        cv2.putText(img, f"{banner}    t={t:6.2f}s", (int(38 * scale), y0 + int(25 * scale)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6 * scale, (235, 235, 235), 1, cv2.LINE_AA)

        # Timeline of every rally across the clip, with a playhead.
        dur = d.get("durationS") or 1
        bar_y = y0 - int(9 * scale)
        cv2.line(img, (0, bar_y), (w, bar_y), (70, 70, 76), int(5 * scale))
        for r in rallies:
            cv2.line(img, (int(r["startS"] / dur * w), bar_y), (int(r["endS"] / dur * w), bar_y),
                     C_LIVE, int(5 * scale))
        cv2.line(img, (int(t / dur * w), bar_y - int(6 * scale)),
                 (int(t / dur * w), bar_y + int(6 * scale)), (255, 255, 255), max(1, int(scale)))

        try:
            ff.stdin.write(img.tobytes())
        except BrokenPipeError:
            break

    cap.release()
    if ff.stdin:
        ff.stdin.close()
    ff.wait()
    print(f"wrote {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
