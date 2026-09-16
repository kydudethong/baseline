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

A time range may be given, which is what makes a coaching clip cheap: the
overlay data covers the whole clip, but only the seconds around one contact
have to be decoded and drawn. Timestamps in the data are ABSOLUTE seconds
from the start of the source video and stay that way -- a clip starting at
72.5 s looks up the same ball points it always did, so a clip and the full
overlay can never disagree about what happened.

Usage: render_debug.py <video> --data overlay.json --out debug.mp4
                              [--start 71.0] [--end 74.0]
"""
import argparse
import json
import subprocess
import sys
import os

import cv2
import numpy as np

C_COURT = (255, 210, 58)      # BGR-ish cyan/blue for the court
C_NET = (200, 67, 255)        # magenta
C_BALL = (60, 220, 255)       # amber
# A BALL RING USED TO BE DEFINED HERE, and it never drew a single pixel.
# It hung off the ball-trail code, which only runs when there are ball points --
# and ballTrack.points is initialised empty and never filled, because ball
# tracking was removed from this pipeline before the ring was written. A marker
# for a ball nothing detects.
#
# Gemini finds the ball with its own eyes, which is what it was doing all along.
C_TRAIL = (60, 180, 255)
C_PLAYER = (140, 224, 92)
C_SELF = (58, 210, 255)
C_LIVE = (92, 224, 140)
C_DEAD = (110, 110, 110)


def draw_poly(img, pts, colour, thickness=3):
    p = np.asarray(pts, dtype=np.int32).reshape(-1, 1, 2)
    cv2.polylines(img, [p], True, colour, thickness, cv2.LINE_AA)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    # ENCODER QUALITY. Lower is better and bigger; each -6 is roughly double
    # the file.
    #
    # 20 rather than 26, and the reason is not that 26 looked bad on a laptop.
    # This video is no longer only something a person scrubs -- it is the input
    # the coaching model watches, now at HIGH media resolution, which means the
    # run is paying full rate per frame to read detail that CRF 26 had already
    # smeared away on a moving player. Encoding softer than the thing reading
    # it can resolve is paying for detail twice and throwing it away once.
    #
    # The cost is roughly double the file, which lands on the upload to Gemini
    # (measured at 19s for ~18MB) rather than on the render, since CRF barely
    # moves encode time at a fixed preset. OVERLAY_CRF tunes it.
    ap.add_argument("--crf", type=int, default=int(os.environ.get("OVERLAY_CRF", "20")))
    ap.add_argument("--out-fps", type=float, default=10.0,
                    help="Frames per second to WRITE. The source is decoded in full and only "
                         "every Nth frame is drawn on and encoded. 0 keeps the source rate.")
    ap.add_argument("--start", type=float, default=None,
                    help="first second to render (absolute, from the source video)")
    ap.add_argument("--end", type=float, default=None,
                    help="last second to render")
    ap.add_argument("--hide-rallies", action="store_true",
                    help="draw no rally banner, no timeline, and no net-crossing flashes. "
                         "For handing the overlay to something that is being ASKED where the "
                         "rallies are -- otherwise the answer, and the evidence behind it, "
                         "are written across the frame")
    ap.add_argument("--boxes-only", action="store_true",
                    help="draw ONLY the player boxes and their ids -- no skeletons, no ball, "
                         "no court, no net, no rally banner. For the identity pass, which is "
                         "asking one question ('which of these ids are the same person?') and "
                         "is answered worse, not better, by everything else on the frame.")
    args = ap.parse_args()
    if args.start is not None and args.end is not None and args.end <= args.start:
        print(f"--end ({args.end}) must be after --start ({args.start})", file=sys.stderr)
        return 2

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
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    # RENDERED AT 720p, WHATEVER THE SOURCE IS, and this is the single largest
    # saving available in the whole pipeline.
    #
    # This stage is the longest one in a run and the one runs die in. On a
    # 13.7-minute clip at 15fps out it is 12,363 frames to draw on, sharpen and
    # H.264-encode -- and at 1080p each of those is 6MB of raw pixels through
    # every one of those steps.
    #
    # 1080p buys nothing. The coaching model resizes every frame it is given to
    # roughly a 768px tile before it looks at it, so rendering at 1920 wide to
    # hand it to something that immediately throws two thirds of that away is
    # 2.25x the work for no information. A person scrubbing the overlay is
    # looking at whether the boxes sit on the players, which 720p answers.
    #
    # Everything drawn below is in NORMALISED coordinates except the court, the
    # net and the ball gate, which are in source pixels -- those are scaled once,
    # here, so no drawing code has to know this happened.
    max_h = max(0, int(os.environ.get("OVERLAY_MAX_HEIGHT", "720")))
    if max_h and src_h > max_h:
        # Even dimensions: H.264 with yuv420p cannot encode an odd one.
        w = (round(src_w * max_h / src_h) // 2) * 2
        h = (max_h // 2) * 2
    else:
        w, h = src_w, src_h
    downscaled = (w, h) != (src_w, src_h)
    if downscaled:
        k = w / src_w
        corners = [[p[0] * k, p[1] * k] for p in corners] if corners else corners
        net = [[p[0] * k, p[1] * k] for p in net] if net else net
        ball_gate = [[p[0] * k, p[1] * k] for p in ball_gate] if ball_gate else ball_gate
        if band:
            band = {
                "base": [[p[0] * k, p[1] * k] for p in band["base"]],
                "top": [[p[0] * k, p[1] * k] for p in band["top"]],
            }
        print(f"[overlay] {src_w}x{src_h} source rendered at {w}x{h} "
              f"({(src_w * src_h) / (w * h):.2f}x less to draw and encode)",
              file=sys.stderr, flush=True)

    # Seek by FRAME, not by CAP_PROP_POS_MSEC.  Seeking by milliseconds lands
    # on the nearest keyframe on some containers and reports a position that
    # does not match where it actually is, which would silently offset every
    # overlay in the clip -- the ball drawn where it was a beat ago.  A frame
    # index is exact, and the frame index is also what the time is derived
    # from below, so the two cannot drift apart.
    start_frame = 0
    if args.start is not None:
        start_frame = max(0, int(round(args.start * fps)))
        cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    end_frame = None if args.end is None else int(round(args.end * fps))
    start_time = start_frame / fps

    # OUTPUT FRAME RATE, and the reason this exists.
    #
    # This used to draw on and encode EVERY source frame. On a 30fps 20-minute
    # match that is 36,000 frames of OpenCV drawing plus 36,000 frames of H.264
    # -- measured at roughly 1.8x realtime, so about eleven minutes of pure
    # rendering, and it is the stage a long run dies in.
    #
    # Nothing needs 30. The coaching model samples this video at 5fps, and a
    # person scrubbing the debug view is looking for whether the boxes sit on
    # the players, not for smooth motion. Emitting 10fps cuts the drawing and
    # encoding by two thirds and is still twice what the model reads.
    #
    # The TIMELINE IS UNCHANGED, which is the part that matters: `t` is still
    # derived from the source frame index over the source fps, so every lookup
    # is against the same clock the data was recorded on, and the output is
    # written at out_fps so a given second of output is the same second of
    # source. Decimating without also setting the writer's rate would speed the
    # video up and silently offset every timestamp the model reports.
    # SELECTED BY TIME, not by taking every Nth frame.
    #
    # Integer stepping could only ever produce source_fps divided by a whole
    # number: from 24fps footage that is 24, 12, 8, 6 and nothing in between.
    # Ask it for 15 and it quietly gives 12 -- which matters now, because the
    # coaching model samples this video at its own rate and anything the
    # renderer fails to deliver is a duplicate frame the run paid full price
    # for.
    #
    # Choosing the first source frame at or after each output slot gives the
    # requested rate exactly, for any request up to the source rate, and every
    # emitted frame is still a real distinct frame rather than an interpolated
    # one.
    out_fps = min(fps, float(args.out_fps)) if args.out_fps else fps
    if out_fps <= 0:
        out_fps = fps

    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
         "-r", f"{out_fps:.4f}", "-i", "-", "-an", "-vcodec", "libx264",
         "-preset", "veryfast", "-crf", str(args.crf), "-pix_fmt", "yuv420p", args.out],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    import time as _time
    t_start = _time.time()
    written = 0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    span = (end_frame if end_frame is not None else (total_frames or 0)) - start_frame
    total_out = max(0, int(span / fps * out_fps)) if span > 0 else 0
    print(f"[overlay] source {fps:.1f}fps -> writing {out_fps:.1f}fps, "
          f"~{total_out or '?'} frames to draw", file=sys.stderr, flush=True)

    # Index by time for cheap lookup.
    ball_sorted = sorted(ball, key=lambda p: p["t"])
    ball_ts = [p["t"] for p in ball_sorted]

    # POSES, INDEXED -- and the two bugs this replaces.
    #
    # First: the draw loop scanned every pose for every frame. On a 20-minute
    # clip that is tens of thousands of poses times thousands of frames, inside
    # the stage that already takes longest and has twice killed a run. A dict
    # of one-second buckets makes each frame look at a few dozen instead.
    #
    # Second, and the one you can SEE: it drew EVERY pose within the tolerance
    # window. Pose frames are sampled densely -- 24fps during a burst -- so a
    # single rendered frame stacked six slightly-offset skeletons on top of
    # each other, and six offset stick figures do not read as a person. They
    # read as a scribble, which is why the honest report was "there are no
    # skeletons": there were, and they did not look like skeletons.
    #
    # One pose per player per frame now, the nearest in time. A figure you can
    # recognise, or nothing.
    pose_buckets = {}
    for ps in poses:
        pose_buckets.setdefault(int(ps["t"]), []).append(ps)

    # How far a pose may be from a frame and still be drawn on it.
    #
    # Derived from the data rather than fixed, because a fixed 0.12s was
    # narrower than the gap between samples whenever the pose pass ran at
    # 5fps -- so a skeleton appeared for a quarter of each 200ms and blinked
    # out for the rest. Held for slightly longer than the sample interval, a
    # skeleton is continuous while pose data exists and absent where it does
    # not, which is the distinction worth being able to see.
    pose_times = sorted(set(ps["t"] for ps in poses))
    if len(pose_times) > 1:
        gaps = sorted(pose_times[i + 1] - pose_times[i] for i in range(len(pose_times) - 1))
        typical_gap = gaps[len(gaps) // 2]
    else:
        typical_gap = 0.0
    pose_hold = max(0.12, min(0.5, typical_gap * 0.75))

    # POSE TRAIL: how many earlier samples to ghost in behind the current one.
    #
    # This started as a BUG. The renderer drew every pose within the tolerance
    # window, so a frame stacked six slightly-offset figures at full brightness
    # and the result read as scribble. The fix was to draw one.
    #
    # Except the thing underneath the scribble was worth keeping: a swing is an
    # arm moving through an arc, and one frozen stick figure cannot show an
    # arc. Several, fading backwards in time, can. So the trail is back on
    # purpose -- dimmer and thinner with age, no joints, no outline, so the
    # current pose is unambiguously the bright one and the ghosts read as where
    # the body just was.
    #
    # OVERLAY_POSE_TRAIL=0 turns it off and leaves the single figure.
    # OFF BY DEFAULT NOW, and the reason is who the audience is.
    #
    # The trail is genuinely better to LOOK at -- a swing is an arc and one
    # frozen figure cannot show an arc. But the primary reader of this video is
    # the coaching model, and three ghost skeletons behind every player is
    # three times the drawn line competing with the thing hardest to see in the
    # frame: the ball. OVERLAY_POSE_TRAIL=3 puts it back for a human.
    pose_trail = max(0, int(os.environ.get("OVERLAY_POSE_TRAIL", "0")))

    # Unsharp mask strength. 0.6 is a visible lift on a small object without
    # the halo that starts to show around 1.0 on a high-contrast edge.
    sharpen_amount = max(0.0, float(os.environ.get("OVERLAY_SHARPEN", "0.6")))

    # LINE WEIGHTS, and the argument that set them.
    #
    # The court lines were thickened deliberately once, because a 2px stroke on
    # a blue court is exactly what H.264 smears into the surface underneath.
    # That reasoning was about a PERSON reading the overlay. The model reading
    # it has the opposite problem: every pixel of drawn line is a pixel not
    # spent on the ball, which is a dozen pixels wide and the single hardest
    # thing in the frame to see. Court markings do not move and do not need to
    # be found; the ball does and does.
    #
    # So: thin enough to stay legible, thin enough to stop shouting. Both are
    # multipliers, so either audience can be favoured without touching code.
    court_weight = max(0.1, float(os.environ.get("OVERLAY_COURT_WEIGHT", "1.0")))
    skel_weight = max(0.1, float(os.environ.get("OVERLAY_SKELETON_WEIGHT", "1.0")))
    trail_span = pose_hold + (typical_gap or 0.1) * pose_trail
    frames_with_skeletons = 0
    if poses:
        print(f"[overlay] {len(poses)} pose frame(s) at {len(pose_times)} instant(s), "
              f"drawn within {pose_hold:.2f}s of a frame", file=sys.stderr, flush=True)
    else:
        print("[overlay] NO POSE DATA in the overlay file — the video will have no skeletons",
              file=sys.stderr, flush=True)
    scale = max(0.5, w / 1280.0)
    i = start_frame
    while True:
        if end_frame is not None and i > end_frame:
            break
        # GRAB, THEN RETRIEVE ONLY WHAT IS DRAWN ON.
        #
        # cap.read() is grab + retrieve, and retrieve is the expensive half:
        # it converts the decoded frame into a BGR numpy array. On 60fps
        # footage written at 15 this loop skips three frames out of every four,
        # and it was paying full price to materialise every one of them before
        # throwing it away. grab() advances the stream without building the
        # array, so the skipped three now cost a fraction of what they did.
        #
        # The comment this replaces said decoding "is the cheap half". It is
        # not, and that assumption is a good part of why this stage is the one
        # runs die in.
        if not cap.grab():
            break
        # Absolute time in the SOURCE video, so every lookup below is against
        # the same timeline the data was recorded on.
        t = i / fps
        frame_index = i
        i += 1
        # One frame per output slot: this frame is skipped if the slot its
        # timestamp falls in has already been filled.
        if (t - start_time) * out_fps < written:
            continue
        ok, img = cap.retrieve()
        if not ok:
            break

        if downscaled:
            # After the skip, not before: there is no point shrinking a frame
            # nobody is going to draw on. INTER_AREA is the right filter for
            # shrinking -- it averages the pixels it discards rather than
            # sampling one of them, which is what keeps a twelve-pixel ball
            # visible instead of aliased away.
            img = cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA)

        # SHARPEN THE FOOTAGE, before a single overlay line is drawn on it.
        #
        # Here rather than after, deliberately: the court lines and skeletons
        # are already crisp synthetic edges and sharpening those only adds
        # ringing. What needs the help is the small, fast, low-contrast thing
        # in the footage itself -- the ball.
        #
        # Why it earns its milliseconds: the model does not see this frame at
        # its own resolution. At high media resolution a frame costs ~258
        # tokens, roughly one 768px tile, so every frame is resized down before
        # anything looks at it. A ball a dozen pixels across survives that
        # resize only if its edges are still strong, and H.264 spends its bits
        # on the large moving regions -- players -- not on a dot.
        #
        # An unsharp mask restores exactly the edge energy both of those steps
        # take away. OVERLAY_SHARPEN=0 turns it off.
        if sharpen_amount > 0:
            blurred = cv2.GaussianBlur(img, (0, 0), 1.2)
            img = cv2.addWeighted(img, 1.0 + sharpen_amount, blurred, -sharpen_amount, 0)

        # PROGRESS, because this is the longest stage and it used to report
        # nothing at all until it finished. Two runs died in here and the only
        # evidence either left was "stopped responding" -- no indication of
        # whether it was at minute one or minute fifteen, which is the
        # difference between a crash and a machine that went away.
        written += 1
        if written % 300 == 0:
            rate = written / max(1e-6, _time.time() - t_start)
            remaining = (total_out - written) / max(rate, 1e-6) if total_out else 0
            print(f"[overlay] {written}/{total_out or '?'} frames · {rate:.0f} fps · "
                  f"~{remaining / 60:.1f} min left", file=sys.stderr, flush=True)

        if corners and not args.boxes_only:
            # THICKER THAN IT LOOKS LIKE IT NEEDS TO BE. This line is drawn on
            # a 720p frame and then H.264-compressed, and a 2px stroke is
            # exactly the width that compression smears into the court surface
            # underneath it -- worst of all on a blue court, where the line and
            # the paint are close in luminance. It also has to stay readable
            # when the model is shown the frame at reduced resolution. 4px
            # survives both; the cost is a few pixels of the court it covers.
            draw_poly(img, corners, C_COURT, max(1, int(2 * scale * court_weight)))
        if ball_gate and not args.boxes_only:
            # Where a ball of THIS court can be, including its airspace.
            draw_poly(img, ball_gate, (90, 90, 110), max(1, int(scale)))

        if band and not args.boxes_only:
            # The net as a surface: base on the ground, tape above it with the
            # real sag, and the face between them shaded. A ball inside this
            # band cannot be assigned to a side -- from behind a baseline the
            # net stands between the camera and the far court -- so seeing the
            # band is seeing exactly where the crossing test declines to guess.
            bl, br = band["base"]
            tl, tc, tr = band["top"]
            # OUTLINE ONLY. This used to be a filled translucent slab, and the
            # slab sat exactly over the net -- which is where the ball is at
            # the single most important moment in a rally. A pickleball is on
            # the order of ten pixels wide once the model has resized the frame
            # to its own budget, and an 18% magenta wash over those ten pixels
            # is a large fraction of the contrast they had. The band's SHAPE is
            # what carried the meaning ("a ball in here cannot be assigned to a
            # side"), and the tape, base and verticals already draw that shape.
            cv2.polylines(img, [np.array([tl, tc, tr], np.int32).reshape(-1, 1, 2)],
                          False, C_NET, max(1, int(2 * scale * court_weight)), cv2.LINE_AA)
            cv2.line(img, tuple(np.int32(bl)), tuple(np.int32(br)), C_NET,
                     max(1, int(2 * scale * court_weight)), cv2.LINE_AA)
            # The verticals stay a touch thinner than the tape and the base:
            # they are the SHAPE of the band rather than a line on the court,
            # and drawing all three at one weight made the net read as a solid
            # box sitting on the surface.
            for a_, b_ in ((bl, tl), (br, tr)):
                cv2.line(img, tuple(np.int32(a_)), tuple(np.int32(b_)), C_NET,
                         max(1, int(1 * scale * court_weight)), cv2.LINE_AA)
            cv2.putText(img, "NET", (int(tl[0]) + 6, int(tl[1]) - 8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5 * scale, C_NET, 1, cv2.LINE_AA)
        elif net and not args.boxes_only:
            cv2.line(img, tuple(np.int32(net[0])), tuple(np.int32(net[1])),
                     C_NET, max(1, int(2 * scale * court_weight)), cv2.LINE_AA)
            cv2.putText(img, "NET", (int(net[0][0]) + 6, int(net[0][1]) - 8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5 * scale, C_NET, 1, cv2.LINE_AA)

        # Ball trail: the last ~1s, brightening toward now. Hollow circles are
        # interpolated points, so a filled run is real observation.
        lo = len(ball_ts) if args.boxes_only else np.searchsorted(ball_ts, t - 1.0)
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
            # The role name when the run supplied one ("You", "Partner",
            # "Opponent 1"), the track id otherwise. Drawn rather than the id
            # because a reader -- and the coaching model watching this video --
            # should never have to decode "player_3".
            label = tr.get("label") or ("YOU" if tr.get("isSelf") else tr.get("playerId", ""))
            if args.boxes_only:
                # BIG, AND ON A SOLID CHIP. The identity pass exists to be read
                # by a model that resizes every frame to roughly a 768px tile
                # before looking at it, and 0.45-scale text on a busy court
                # does not survive that. This label IS the question being asked
                # -- "which of these ids are the same person" is unanswerable
                # if the ids are illegible -- so it gets the weight that
                # deserves, and the clutter it would cause on the real overlay
                # is not a concern here because there is no clutter to add to.
                fs = 0.85 * scale
                (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, fs, 2)
                ly = max(th + 8, y1 - 6)
                cv2.rectangle(img, (x1, ly - th - 6), (x1 + tw + 10, ly + 4), colour, -1)
                cv2.putText(img, label, (x1 + 5, ly), cv2.FONT_HERSHEY_SIMPLEX,
                            fs, (12, 12, 12), 2, cv2.LINE_AA)
            else:
                cv2.putText(img, label, (x1, max(14, y1 - 6)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45 * scale, colour, 1, cv2.LINE_AA)

        # Skeletons. Drawn after the boxes so a limb is never hidden by one,
        # and only from keypoints the model actually saw -- joining low
        # confidence points draws limbs that were never there, which is worse
        # than an incomplete figure because it looks complete.
        # One per player, nearest in time. A dict keyed by playerId rather than
        # a list, so two poses for the same person at two nearby instants can
        # never both be drawn.
        # Per player: the pose nearest to now, plus the few before it.
        # Keyed by playerId so two samples of the same person at the same
        # instant can never both be drawn at full brightness.
        by_player = {}
        buckets = () if args.boxes_only else (int(t - trail_span - 1), int(t - 1), int(t), int(t + 1))
        for bucket in buckets:
            for ps in pose_buckets.get(bucket, ()):
                age = t - ps["t"]
                # Forward within the hold window (the nearest sample may be
                # just ahead of this frame), backward across the whole trail.
                if age < -pose_hold or age > trail_span:
                    continue
                by_player.setdefault(ps.get("playerId"), []).append((age, ps))

        if by_player:
            frames_with_skeletons += 1

        for series in by_player.values():
            # Nearest in time first; everything after it is a ghost, oldest
            # drawn first so the newest sits on top.
            series.sort(key=lambda a_ps: abs(a_ps[0]))
            current = series[0][1]
            ghosts = [ps for _age, ps in series[1 : 1 + pose_trail]]
            for depth, ps in enumerate(reversed(ghosts)):
                # Fades with age: the oldest ghost is the faintest and
                # thinnest. No outline and no joints -- those are what make the
                # current pose readable, and giving them to the trail is what
                # turned it into scribble the first time.
                fade = 0.30 + 0.20 * (depth + 1) / max(1, len(ghosts))
                for (x1, y1, x2, y2, group) in ps.get("bones", []):
                    col = limb_bgr.get(group, (200, 200, 200))
                    dim = tuple(int(c * fade) for c in col)
                    cv2.line(img, (int(x1 * w), int(y1 * h)), (int(x2 * w), int(y2 * h)),
                             dim, max(1, int(1.5 * scale * skel_weight)), cv2.LINE_AA)
            for (x1, y1, x2, y2, group) in current.get("bones", []):
                col = limb_bgr.get(group, (200, 200, 200))
                a = (int(x1 * w), int(y1 * h))
                b = (int(x2 * w), int(y2 * h))
                # A dark stroke under the bright one. Same reasoning as the
                # court lines: a thin coloured line on a sunlit court, at 720p,
                # after H.264, is the exact thing compression smears into the
                # surface underneath. An outline gives every limb an edge it
                # keeps whatever it is drawn over.
                thick = max(1, int((2 if group.startswith("arm") else 1.5) * scale * skel_weight))
                # A one-pixel dark edge rather than a two-pixel one. Enough to
                # keep a thin line off a same-coloured shirt, not enough to
                # double the skeleton's visual weight.
                cv2.line(img, a, b, (12, 12, 12), thick + 1, cv2.LINE_AA)
                cv2.line(img, a, b, col, thick, cv2.LINE_AA)
            for (jx, jy) in current.get("joints", []):
                c = (int(jx * w), int(jy * h))
                r = max(1, int(1.6 * scale * skel_weight))
                cv2.circle(img, c, r + 1, (12, 12, 12), -1, cv2.LINE_AA)
                cv2.circle(img, c, r, (255, 255, 255), -1, cv2.LINE_AA)

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
        for pd in ([] if args.boxes_only else paddles):
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
        #
        # Suppressed with the rally banner, not separately: crossings are the
        # EVIDENCE the segmenter builds rallies from, so a full-width
        # "BALL CROSSED NET -> far" is most of the answer to "where are the
        # rallies" even without the banner spelling it out.
        for c in ([] if (args.hide_rallies or args.boxes_only) else crossings):
            if 0 <= t - c["t"] <= 0.33:
                txt = "BALL CROSSED NET -> far" if c["into"] > 0 else "BALL CROSSED NET -> near"
                cv2.rectangle(img, (0, 0), (w, int(46 * scale)), C_NET, -1)
                cv2.putText(img, txt, (int(14 * scale), int(31 * scale)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.8 * scale, (255, 255, 255), 2, cv2.LINE_AA)
                break

        y0 = h - int(38 * scale)
        cv2.rectangle(img, (0, y0), (w, h), (24, 24, 28), -1)
        if args.hide_rallies or args.boxes_only:
            # The clock stays -- a model reasoning about WHEN something happened
            # needs to know where it is -- but nothing about rallies. Not even
            # "no rally", which is itself a claim about the thing being asked.
            cv2.putText(img, f"t={t:6.2f}s", (int(20 * scale), y0 + int(25 * scale)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6 * scale, (235, 235, 235), 1, cv2.LINE_AA)
        else:
            active = next((r for r in rallies if r["startS"] <= t <= r["endS"]), None)
            banner = f"RALLY {active['idx']}  {active['startS']:.1f}-{active['endS']:.1f}s" if active else "no rally"
            colour = C_LIVE if active else C_DEAD
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
    # SAID OUT LOUD, because "I don't see any skeletons" has been reported three
    # times and has had three different causes, and from outside the rendered
    # video there was no way to tell which. This line answers it before anyone
    # has to open the file: how many of the frames written actually got one.
    if written:
        pct = 100.0 * frames_with_skeletons / written
        print(f"[overlay] skeletons on {frames_with_skeletons}/{written} frames ({pct:.0f}%)",
              file=sys.stderr, flush=True)
    print(f"wrote {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
