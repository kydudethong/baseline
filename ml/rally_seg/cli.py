"""Command line entry point.

    python -m rally_seg segment  match.mp4 --out rallies.json
    python -m rally_seg debug    match.mp4 --out debug.mp4
    python -m rally_seg clips    match.mp4 --out-dir clips/
    python -m rally_seg eval     match.mp4 --truth labels.json
    python -m rally_seg calibrate --clips match.mp4:labels.json --out tuned.yaml
    python -m rally_seg court    match.mp4 --out court.png
    python -m rally_seg features match.mp4 --out features.npz
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from typing import Dict, List, Optional

import numpy as np

from .config import Config, load_config
from .calibrate import LabelledClip, calibrate, overrides_to_yaml
from .evaluate import evaluate, load_ground_truth
from .pipeline import build_features, segment_video
from .schema import SegmentationResult


def _parse_overrides(items: Optional[List[str]]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for item in items or []:
        if "=" not in item:
            raise SystemExit(f"--set expects key=value, got {item!r}")
        key, value = item.split("=", 1)
        out[key.strip()] = value.strip()
    return out


def _config_from_args(args) -> Config:
    cfg = load_config(getattr(args, "config", None), _parse_overrides(getattr(args, "set", None)))
    if getattr(args, "weights", None):
        cfg.ball.weights = args.weights
    if getattr(args, "device", None):
        cfg.ball.device = args.device
        cfg.players.device = args.device
    if getattr(args, "start", None) is not None:
        cfg.video.start_s = args.start
    if getattr(args, "end", None) is not None:
        cfg.video.end_s = args.end
    if getattr(args, "audio_contacts", None):
        cfg.audio_contacts_path = args.audio_contacts
    if getattr(args, "cache_dir", None):
        cfg.cache_dir = args.cache_dir
    return cfg


def _progress(done: int, total: int, stage: str) -> None:
    if total:
        pct = 100.0 * done / total
        sys.stderr.write(f"\r  {stage}: {done}/{total} ({pct:5.1f}%)")
    else:
        sys.stderr.write(f"\r  {stage}: {done} frames")
    sys.stderr.flush()


# --- commands ----------------------------------------------------------------


def cmd_segment(args) -> int:
    cfg = _config_from_args(args)
    result, stream = segment_video(args.video, cfg, progress=None if args.quiet else _progress,
                                   use_cache=not args.no_cache)
    sys.stderr.write("\n")
    payload = result.to_json()
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(payload)
        _print_summary(result)
        print(f"\nwrote {args.out}", file=sys.stderr)
    else:
        print(payload)
    return 0


def cmd_debug(args) -> int:
    from .debug_video import render_debug_video
    from .models.temporal import build_segmenter

    cfg = _config_from_args(args)
    result, stream = segment_video(args.video, cfg, progress=None if args.quiet else _progress,
                                   use_cache=not args.no_cache)
    sys.stderr.write("\n")
    seg = build_segmenter(cfg)
    prob = seg.frame_probability(stream)
    out = args.out or os.path.splitext(args.video)[0] + ".debug.mp4"
    render_debug_video(args.video, out, stream, result, cfg, frame_probability=prob)
    _print_summary(result)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            fh.write(result.to_json())
    print(f"\nwrote {out}", file=sys.stderr)
    return 0


def cmd_clips(args) -> int:
    from .video import ffmpeg_bin

    cfg = _config_from_args(args)
    result, _stream = segment_video(args.video, cfg, progress=None if args.quiet else _progress,
                                    use_cache=not args.no_cache)
    sys.stderr.write("\n")
    os.makedirs(args.out_dir, exist_ok=True)
    written = []
    for seg in result.rallies:
        if seg.confidence < args.min_confidence:
            continue
        out = os.path.join(args.out_dir, f"rally_{seg.idx + 1:03d}.mp4")
        cmd = [
            ffmpeg_bin(), "-nostdin", "-v", "error", "-y",
            "-ss", f"{seg.clip_start_s:.3f}", "-i", args.video,
            "-t", f"{max(0.1, seg.clip_end_s - seg.clip_start_s):.3f}",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
            "-c:a", "aac", "-movflags", "+faststart", out,
        ]
        subprocess.run(cmd, check=True)
        written.append(out)
    print(f"wrote {len(written)} clips to {args.out_dir}", file=sys.stderr)
    with open(os.path.join(args.out_dir, "rallies.json"), "w", encoding="utf-8") as fh:
        fh.write(result.to_json())
    return 0


def cmd_eval(args) -> int:
    cfg = _config_from_args(args)
    result, _stream = segment_video(args.video, cfg, progress=None if args.quiet else _progress,
                                    use_cache=not args.no_cache)
    sys.stderr.write("\n")
    truth = load_ground_truth(args.truth)
    report = evaluate(result.rallies, truth, iou_threshold=args.iou)
    print(report.summary())
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(report.to_dict(), fh, indent=2)
    return 0


def cmd_calibrate(args) -> int:
    cfg = _config_from_args(args)
    clips: List[LabelledClip] = []
    for spec in args.clips:
        if ":" not in spec:
            raise SystemExit(f"--clips expects video.mp4:labels.json, got {spec!r}")
        video, labels = spec.rsplit(":", 1)
        print(f"perception: {video}", file=sys.stderr)
        stream, _info = build_features(video, cfg, progress=None if args.quiet else _progress,
                                       use_cache=True)
        sys.stderr.write("\n")
        clips.append(LabelledClip(os.path.basename(video), stream, load_ground_truth(labels)))

    print(f"calibrating over {len(clips)} clip(s)...", file=sys.stderr)
    result = calibrate(cfg, clips, passes=args.passes, verbose=not args.quiet)
    print("\n" + (result.report.summary() if result.report else ""))
    print(f"\nbaseline {result.baseline_score:.4f} -> tuned {result.best_score:.4f}")
    fragment = overrides_to_yaml(result.best_overrides)
    print("\n--- tuned config ---")
    print(fragment or "(defaults already optimal on this label set)")
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(fragment + "\n")
        with open(os.path.splitext(args.out)[0] + ".report.json", "w", encoding="utf-8") as fh:
            json.dump(result.to_dict(), fh, indent=2)
    return 0


def _court_payload(court) -> dict:
    """Everything a caller needs to draw and reason about a fitted court.

    The corners alone are enough to rebuild the homography, but a UI that wants
    to show the fit the way the debug overlay does would have to reimplement
    the court's geometry to do it.  Projecting the lines here means one
    definition of where the kitchen line is, shared by the overlay, the web app
    and anything else that draws a court.

    Lines beyond ``observable_max_y`` are omitted rather than extrapolated: on a
    near-half fit the far half was never seen, and drawing a confident far
    baseline across a region the fit knows nothing about is exactly the kind of
    quiet fiction this pipeline is built to avoid.
    """
    from .detect.court import (COURT_W, COURT_L, NET_Y, KITCHEN_NEAR_Y, KITCHEN_FAR_Y)

    def seg(a, b):
        pts = court.to_image(np.array([a, b], dtype=np.float32))
        if not np.all(np.isfinite(pts)):
            return None
        return [[float(pts[0][0]), float(pts[0][1])], [float(pts[1][0]), float(pts[1][1])]]

    far_y = court.observable_max_y
    lines = {
        "baselineNear": seg((0, 0), (COURT_W, 0)),
        "sidelineLeft": seg((0, 0), (0, far_y)),
        "sidelineRight": seg((COURT_W, 0), (COURT_W, far_y)),
        "kitchenNear": seg((0, KITCHEN_NEAR_Y), (COURT_W, KITCHEN_NEAR_Y)),
        "centreNear": seg((COURT_W / 2, 0), (COURT_W / 2, KITCHEN_NEAR_Y)),
        "net": seg((0, NET_Y), (COURT_W, NET_Y)),
    }
    if far_y >= COURT_L:
        lines["baselineFar"] = seg((0, COURT_L), (COURT_W, COURT_L))
        lines["kitchenFar"] = seg((0, KITCHEN_FAR_Y), (COURT_W, KITCHEN_FAR_Y))
        lines["centreFar"] = seg((COURT_W / 2, KITCHEN_FAR_Y), (COURT_W / 2, COURT_L))

    return {
        "corners_px": court.corners_px.tolist(),
        "confidence": float(court.confidence),
        "agreement": float(getattr(court, "agreement", 1.0)),
        "extent": court.extent,
        "source": court.source,
        "image_size": list(court.image_size),
        "lines_px": {k: v for k, v in lines.items() if v is not None},
    }


def cmd_court(args) -> int:
    import cv2
    from .detect.court import CourtDetector, FallbackCourt, line_mask
    from .debug_video import _draw_court
    from .video import VideoSource

    cfg = _config_from_args(args)
    source = VideoSource(args.video, cfg.video)
    frames = source.sample_frames(cfg.court.fit_samples)
    detector = CourtDetector(cfg.court)
    court = detector.fit([f.image for f in frames], (source.out_width, source.out_height))
    if isinstance(court, FallbackCourt):
        reason = getattr(detector, "last_rejection", None) or (
            "no quad scored well enough. If the lines are not white, set "
            "court.line_color_hex to a colour sampled from the footage. "
            "Otherwise try court.white_threshold, court.hough_threshold, "
            "or set court.manual_points_path with four corners.")
        print(f"court NOT detected. {reason}", file=sys.stderr)
        if args.json:
            with open(args.json, "w", encoding="utf-8") as fh:
                json.dump({"court": None, "reason": reason,
                           "image_size": [source.out_width, source.out_height]}, fh, indent=2)
        return 2

    payload = _court_payload(court)
    print(f"court fitted, line support {court.confidence:.3f}, "
          f"agreement {court.agreement:.0%}, extent {court.extent}", file=sys.stderr)
    print(json.dumps(payload, indent=2))

    mid = frames[len(frames) // 2] if frames else None
    if args.out and mid is not None:
        canvas = mid.image.copy()
        _draw_court(canvas, court)
        cv2.imwrite(args.out, canvas)
        print(f"wrote {args.out}", file=sys.stderr)
    # The white-line mask is what the fit actually sees.  When a fit looks
    # wrong, this says whether the lines were there to be found at all -- a
    # different question from whether the search picked the right quad.
    if args.mask and mid is not None:
        cv2.imwrite(args.mask, line_mask(mid.image, cfg.court))
        print(f"wrote {args.mask}", file=sys.stderr)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump({"court": payload,
                       "image_size": [source.out_width, source.out_height]}, fh, indent=2)
    if args.save_points:
        with open(args.save_points, "w", encoding="utf-8") as fh:
            json.dump({"corners_px": court.corners_px.tolist(),
                       "extent": court.extent,
                       "image_size": list(court.image_size)}, fh, indent=2)
    return 0


def _frame_setup_score(players, court, on_court=None) -> float:
    """How good a frame is for asking a person "which one of these is you?".

    Wanted, in order: four people ON THE COURT, one in each quadrant, none of
    them overlapping so badly that a click is ambiguous.  Four is not a
    tie-break -- a frame showing three players cannot answer the question the
    setup step exists to ask, so the count dominates everything else.

    ``on_court`` is the subset standing inside the painted lines.  It is what
    the count is taken over, because a frame with two players and two men at
    the fence used to score exactly like a frame with four players: the loose
    gate passed all four, ``n`` was 4, and the mean-confidence term at the
    bottom then PREFERRED the frame with the bystanders, since somebody
    standing still near the camera is detected far more confidently than
    somebody lunging at the far baseline.
    """
    counted = players if on_court is None else on_court
    n = len(counted)
    score = -3.0 * abs(n - 4)

    if court is not None and counted:
        sides = [court.side_of_net(court.to_court(np.array([p.feet]))[0]) for p in counted]
        near = sum(1 for s in sides if s < 0)
        n = len(counted)
        # Two a side is what a doubles rally looks like.  A frame with all four
        # detections on one side is usually two players plus two spectators.
        score -= abs(near - (n - near))

    # Overlapping boxes make "click the player you want" unanswerable.
    for i, a in enumerate(players):
        for b in players[i + 1:]:
            ox = max(0.0, min(a.x2, b.x2) - max(a.x1, b.x1))
            oy = max(0.0, min(a.y2, b.y2) - max(a.y1, b.y1))
            inter = ox * oy
            if inter <= 0:
                continue
            smaller = min((a.x2 - a.x1) * (a.y2 - a.y1), (b.x2 - b.x1) * (b.y2 - b.y1))
            if smaller > 0:
                score -= 2.0 * (inter / smaller)

    # OVER THE PEOPLE ON THE COURT, not over everybody detected. That is the
    # whole of the change here: the weight is left at 1.0, because the count
    # term is 3.0 per player and no confidence swing can buy back a missing
    # player. Taken over everybody, though, this term actively PREFERRED the
    # frame full of bystanders -- proximity to the camera and detector
    # confidence are very nearly the same measurement, and the people nearest
    # the camera are the ones not playing.
    if counted:
        score += float(np.mean([p.conf for p in counted]))
    return score


def cmd_setup(args) -> int:
    """Pick the frame to run pre-analysis setup on, and say who is in it.

    The frame is chosen, not asked for.  Scrubbing a video hunting for the
    moment all four players are visible is a chore, and it is a chore a
    detector can do exhaustively in the time it takes to explain it.
    """
    import cv2
    from .detect.court import CourtDetector, FallbackCourt
    from .detect.players import build_player_detector
    from .pipeline import _player_gate_polygon, _player_gate_polygon_strict
    from .video import VideoSource

    cfg = _config_from_args(args)
    source = VideoSource(args.video, cfg.video)
    image_size = (source.out_width, source.out_height)

    n = max(args.samples, cfg.court.fit_samples)
    frames = source.sample_frames(n)
    if not frames:
        print("no frames could be read", file=sys.stderr)
        return 2

    detector = CourtDetector(cfg.court)
    court = detector.fit([f.image for f in frames], image_size)
    fitted = None if isinstance(court, FallbackCourt) else court

    out: dict = {
        "image_size": list(image_size),
        "court": _court_payload(fitted) if fitted is not None else None,
        "court_reason": None if fitted is not None else getattr(detector, "last_rejection", None),
    }

    player_detector = build_player_detector(cfg.players)
    gate = (_player_gate_polygon(fitted, cfg, image_size)
            if fitted is not None and cfg.players.court_gate else None)
    # THE SECOND, TIGHTER GATE, which is what decides who the players are.
    # See _player_gate_polygon_strict: the loose one runs to 1.6x the image
    # height so a player at the camera is not lost, and that same generosity
    # admits the queue at the fence.
    strict_gate = (_player_gate_polygon_strict(fitted, cfg, image_size)
                   if fitted is not None and cfg.players.court_gate else None)

    def inside(polygon, d) -> bool:
        return cv2.pointPolygonTest(polygon, (float(d.feet[0]), float(d.feet[1])), False) >= 0

    best = None
    for frame in frames:
        found = player_detector.detect(frame.image)
        kept = found
        if gate is not None:
            kept = [d for d in found if inside(gate, d)]
        # Counted, not just discarded.  "4 people found, 2 of them off court"
        # is the difference between the gate working and the detector failing,
        # and without the number the setup screen cannot tell the user which
        # one happened.
        dropped = len(found) - len(kept)

        on_court = [d for d in kept if inside(strict_gate, d)] if strict_gate is not None else kept
        on_court_ids = {id(d) for d in on_court}
        # ON THE COURT FIRST, CONFIDENCE SECOND.  This was confidence alone,
        # and confidence is very nearly a measure of how close somebody is to
        # the camera -- so on a clip where the rally is at the far end, two
        # men standing at the near fence with drinks beat four players and
        # took every slot.  Ordering this way still fills the remaining slots
        # from the loose set, so a genuine player standing behind the baseline
        # is not dropped; they simply queue behind the people on the paint.
        dets = sorted(kept, key=lambda d: (id(d) not in on_court_ids, -d.conf))[: cfg.players.max_players]
        chosen_on_court = [d for d in dets if id(d) in on_court_ids]
        score = _frame_setup_score(dets, fitted, chosen_on_court)
        if best is None or score > best[0]:
            best = (score, frame, dets, dropped)

    score, frame, dets, off_court = best
    if player_detector.name == "motion":
        # No usable detections, so the score ranked noise.  A frame from the
        # middle of the clip is a better place to start clicking than whichever
        # one the noise happened to like.
        mid = frames[len(frames) // 2]
        score, frame, dets, off_court = 0.0, mid, [], 0
    # The motion fallback subtracts a *background* it builds from consecutive
    # frames, and these frames are seconds apart, so its boxes here are noise
    # wearing a detector's clothes.  Say so rather than presenting them: the
    # setup UI can fall back to asking the user to click, which is a small
    # chore, where four confident wrong boxes are a trap.
    reliable = player_detector.name != "motion"
    out["frame"] = {
        "timestamp_s": float(frame.t_s),
        "index": int(frame.index),
        "score": float(score),
        "detector": player_detector.name,
        "players_reliable": reliable,
        #: People the detector found who are not standing on this court --
        #: spectators, the queue behind the fence, the neighbours' game.
        "players_off_court": int(off_court),
        #: False when no court was fitted, in which case NOTHING was excluded
        #: and every person in the frame is a candidate.  Worth saying out
        #: loud: a zero above means "none were dropped" only when this is true.
        "court_gate": gate is not None,
    }
    if not reliable:
        dets = []
    out["players"] = [
        {"box_px": [float(d.x1), float(d.y1), float(d.x2), float(d.y2)],
         "feet_px": [float(d.feet[0]), float(d.feet[1])],
         "confidence": float(d.conf),
         "side": (None if fitted is None else
                  ("near" if fitted.side_of_net(fitted.to_court(np.array([d.feet]))[0]) < 0
                   else "far"))}
        for d in dets
    ]

    if args.out_frame:
        os.makedirs(os.path.dirname(os.path.abspath(args.out_frame)) or ".", exist_ok=True)
        cv2.imwrite(args.out_frame, frame.image, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
        out["frame"]["path"] = os.path.abspath(args.out_frame)

    print(f"picked t={frame.t_s:.2f}s with {len(dets)} players "
          f"({player_detector.name}); court "
          f"{'fitted' if fitted is not None else 'NOT fitted'}", file=sys.stderr)
    text = json.dumps(out, indent=2)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            fh.write(text)
    else:
        print(text)
    return 0


def cmd_features(args) -> int:
    cfg = _config_from_args(args)
    stream, info = build_features(args.video, cfg, progress=None if args.quiet else _progress,
                                  use_cache=not args.no_cache)
    sys.stderr.write("\n")
    out = args.out or os.path.splitext(args.video)[0] + ".features.npz"
    stream.save(out)
    print(f"{len(stream)} frames, {stream.X.shape[1]} features -> {out}", file=sys.stderr)
    for w in info.get("warnings", []):
        print(f"warning: {w}", file=sys.stderr)
    return 0


def _print_summary(result: SegmentationResult) -> None:
    print(f"{len(result.rallies)} rallies, "
          f"{result.play_fraction:.1%} of {result.duration_s:.1f}s is live play", file=sys.stderr)
    print(f"ball detector: {result.ball_detector}, observed in "
          f"{result.ball_detection_rate:.1%} of frames; court "
          f"{'fitted' if result.court_detected else 'NOT fitted'}", file=sys.stderr)
    for w in result.warnings:
        print(f"warning: {w}", file=sys.stderr)
    low = [r for r in result.rallies if r.confidence < 0.5]
    if low:
        print(f"{len(low)} rallies below 0.5 confidence: "
              + ", ".join(f"#{r.idx + 1}@{r.start_s:.1f}s" for r in low[:10]), file=sys.stderr)


# --- parser ------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser("rally_seg", description="Pickleball rally segmentation")
    sub = p.add_subparsers(dest="command", required=True)

    def common(sp, video: bool = True):
        if video:
            sp.add_argument("video")
        sp.add_argument("--config", help="YAML or JSON config file")
        sp.add_argument("--set", action="append", metavar="key=value",
                        help="dotted config override, repeatable")
        sp.add_argument("--weights", help="ball detector weights (.pt)")
        sp.add_argument("--device", help="cpu | cuda | mps | auto")
        sp.add_argument("--start", type=float, help="start second")
        sp.add_argument("--end", type=float, help="end second")
        sp.add_argument("--audio-contacts", help="JSON of paddle-contact timestamps")
        sp.add_argument("--cache-dir")
        sp.add_argument("--no-cache", action="store_true")
        sp.add_argument("--quiet", action="store_true")
        return sp

    s = common(sub.add_parser("segment", help="write rally timestamps as JSON"))
    s.add_argument("--out", help="output JSON path (default: stdout)")
    s.set_defaults(func=cmd_segment)

    s = common(sub.add_parser("debug", help="render an annotated debug video"))
    s.add_argument("--out", help="output mp4")
    s.add_argument("--json", help="also write the segmentation JSON here")
    s.set_defaults(func=cmd_debug)

    s = common(sub.add_parser("clips", help="cut one mp4 per rally"))
    s.add_argument("--out-dir", required=True)
    s.add_argument("--min-confidence", type=float, default=0.0)
    s.set_defaults(func=cmd_clips)

    s = common(sub.add_parser("eval", help="score against labelled rallies"))
    s.add_argument("--truth", required=True)
    s.add_argument("--iou", type=float, default=0.5)
    s.add_argument("--out", help="write the report as JSON")
    s.set_defaults(func=cmd_eval)

    s = common(sub.add_parser("calibrate", help="tune thresholds on labelled clips"), video=False)
    s.add_argument("--clips", nargs="+", required=True, metavar="video.mp4:labels.json")
    s.add_argument("--passes", type=int, default=3)
    s.add_argument("--out", help="write the tuned config fragment here")
    s.set_defaults(func=cmd_calibrate)

    s = common(sub.add_parser("court", help="fit and inspect the court homography"))
    s.add_argument("--out", help="write an annotated still")
    s.add_argument("--mask", help="write the line mask the fit is searching")
    s.add_argument("--json", help="write corners, confidence and projected lines here")
    s.add_argument("--save-points", help="write the fitted corners for court.manual_points_path")
    s.set_defaults(func=cmd_court)

    s = common(sub.add_parser("setup", help="pick a frame with everyone on court, and locate them"))
    s.add_argument("--out-frame", help="write the chosen frame as a JPEG")
    s.add_argument("--json", help="write the court, the frame and the players here")
    s.add_argument("--samples", type=int, default=48,
                   help="frames to consider (more is slower and finds better ones)")
    s.set_defaults(func=cmd_setup)

    s = common(sub.add_parser("features", help="run perception and cache the feature stream"))
    s.add_argument("--out")
    s.set_defaults(func=cmd_features)
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
