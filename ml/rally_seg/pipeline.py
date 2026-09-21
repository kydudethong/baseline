"""Orchestration: video in, segments out.

Perception is the expensive half and it is cached.  The cache key is a hash of
the video's identity plus only those config fields that can change the feature
stream, so re-tuning a state-machine threshold re-runs in milliseconds while
changing the ball detector correctly invalidates everything.  That asymmetry is
what makes calibration on real footage practical instead of an overnight job.
"""

from __future__ import annotations

import hashlib
import os
import time
from typing import Callable, List, Optional, Tuple

import cv2
import numpy as np
from . import __version__
from .config import Config
from .detect.ball import Detection, build_ball_detector
from .detect.court import CourtDetector, CourtModel, FallbackCourt
from .detect.players import build_player_detector
from .events import EventDetector
from .features import FeatureBuilder, FeatureStream, load_audio_contacts
from .models.base import RallySegmenter
from .models.temporal import build_segmenter
from .schema import SegmentationResult
from .track.ball_track import BallState, BallTracker
from .track.bytetrack import PlayerTracker
from .video import VideoSource, probe

ProgressFn = Callable[[int, int, str], None]


def _court_gate_polygon(court, cfg) -> Optional[np.ndarray]:
    """Image-space region that belongs to *this* court, including its airspace.

    Built entirely in image coordinates.  The obvious approach -- widen the
    court in feet and map that through the homography -- blows up, because a
    camera close behind the baseline puts the near corners far outside the
    frame, and extrapolating further in court space crosses the horizon and
    wraps the polygon inside out.

    Shape: the court quad, widened sideways, with the far end extended straight
    up to the top of the frame rather than converging on the vanishing point.
    A lobbed ball is high in the image but barely moves horizontally, so the
    airspace above the far court has to stay as wide as the far baseline --
    letting the sidelines converge upward would throw away every lob.
    """
    if not hasattr(court, "corners_px"):
        return None
    quad = np.asarray(court.corners_px, dtype=np.float32).reshape(4, 2)
    if not np.all(np.isfinite(quad)):
        return None

    near_l, near_r, far_r, far_l = quad
    margin = cfg.ball.court_gate_margin_frac

    def widen(a, b, frac):
        """Push two points apart along their own line."""
        d = b - a
        return a - d * frac, b + d * frac

    near_l, near_r = widen(near_l, near_r, margin)
    far_l, far_r = widen(far_l, far_r, margin)

    # Straight up from the far corners, and a little past the near baseline.
    top = min(float(far_l[1]), float(far_r[1])) - cfg.ball.court_gate_sky_px
    bottom_pad = cfg.ball.court_gate_floor_px
    return np.array([
        [near_l[0], near_l[1] + bottom_pad],
        [near_r[0], near_r[1] + bottom_pad],
        [far_r[0], far_r[1]],
        [far_r[0], top],
        [far_l[0], top],
        [far_l[0], far_l[1]],
    ], dtype=np.float32).reshape(-1, 1, 2)


def _gate_to_court(dets: List[Detection], polygon: Optional[np.ndarray]) -> List[Detection]:
    if polygon is None or not dets:
        return dets
    return [d for d in dets
            if cv2.pointPolygonTest(polygon, (float(d.x), float(d.y)), False) >= 0]


def _player_gate_polygon(court, cfg, image_size) -> Optional[np.ndarray]:
    """Ground region a player standing on this court can occupy.

    The near edge is pushed *well* below the frame, not by a fraction of the
    court's depth.  A player close to the camera has their feet at or past the
    bottom of the picture, and an earlier version of this test rejected them --
    which read, correctly, as "it loses players near the camera".  The near
    baseline is not the edge of where a player can stand; the frame is.
    """
    if not hasattr(court, "corners_px"):
        return None
    quad = np.asarray(court.corners_px, dtype=np.float32).reshape(4, 2)
    if not np.all(np.isfinite(quad)):
        return None
    near_l, near_r, far_r, far_l = quad
    m = cfg.players.court_margin_frac

    def widen(a, b, frac):
        d = b - a
        return a - d * frac, b + d * frac

    near_l, near_r = widen(near_l, near_r, m)
    far_l, far_r = widen(far_l, far_r, m)
    # Sideways the sidelines still bound things, so extend them downward along
    # their own direction rather than dropping straight down.
    height = float(image_size[1])
    def extend_down(near, far, to_y):
        d = near - far
        if abs(d[1]) < 1e-6:
            return np.array([near[0], to_y], dtype=np.float32)
        t = (to_y - far[1]) / d[1]
        return (far + d * t).astype(np.float32)

    bottom = height * 1.6
    return np.array([
        extend_down(near_l, far_l, bottom),
        extend_down(near_r, far_r, bottom),
        [far_r[0], far_r[1] - (near_r[1] - far_r[1]) * m],
        [far_l[0], far_l[1] - (near_l[1] - far_l[1]) * m],
    ], dtype=np.float32).reshape(-1, 1, 2)


def _player_gate_polygon_strict(court, cfg, image_size) -> Optional[np.ndarray]:
    """Where somebody has to be standing to be PLAYING on this court.

    The loose gate above is deliberately enormous: it extends the sidelines to
    1.6x the image height so a player near the camera, whose feet are at or
    past the bottom of the picture, is not rejected.  That is right for KEEPING
    a player once you know who they are, and wrong for DECIDING who they are --
    the wedge is at its widest nearest the camera, so it sweeps in the people
    waiting for the next game, the queue at the fence and anyone walking past.

    Reported from real footage: on a night clip where the rally was at the far
    end, the two boxes on the setup frame landed on two men standing by the
    fence with drinks, because the loose gate admitted them and they were
    larger, sharper and more confident than the actual players.

    So this one is the painted quad plus a little, and nothing else.  Same
    split as roster.ts, which grew SEED_MARGIN_FT for exactly this reason:
    strict to choose, loose to follow.
    """
    if not hasattr(court, "corners_px"):
        return None
    quad = np.asarray(court.corners_px, dtype=np.float32).reshape(4, 2)
    if not np.all(np.isfinite(quad)):
        return None
    near_l, near_r, far_r, far_l = quad
    m = cfg.players.court_margin_strict_frac

    def widen(a, b, frac):
        d = b - a
        return a - d * frac, b + d * frac

    near_l, near_r = widen(near_l, near_r, m)
    far_l, far_r = widen(far_l, far_r, m)
    # A little room behind each baseline -- a serve is struck from behind it --
    # but measured in the court's OWN depth rather than the frame's, so it
    # cannot run away toward the camera the way the loose gate does.
    depth_l = near_l - far_l
    depth_r = near_r - far_r
    return np.array([
        near_l + depth_l * m,
        near_r + depth_r * m,
        far_r - depth_r * m,
        far_l - depth_l * m,
    ], dtype=np.float32).reshape(-1, 1, 2)


def _gate_players_to_court(boxes, polygon):
    """Keep only players standing on this court.

    Tested on the feet, not the box centre: a player's feet are the only part of
    them on the court plane, so the ground quad is the honest test for whether
    they are on it.  Spectators, the queue behind the fence and the neighbours'
    game all fail it.
    """
    if polygon is None or not boxes:
        return boxes
    return [b for b in boxes
            if cv2.pointPolygonTest(polygon, (float(b.feet[0]), float(b.feet[1])), False) >= 0]


def _scale_lookup(court, typical_ball_height_ft: float = 6.0):
    """Image y -> pixels per foot at the ball's likely ground position.

    The subtlety that matters: an airborne ball sits *above* its ground point in
    the image, so reading the perspective scale straight off its image y treats
    a lob over the near court as though it were at the far baseline -- and hands
    it the far baseline's much tighter speed limit. One fixed-point step
    corrects for it: estimate the scale, use it to guess how far the ball is
    lifted, and re-read the scale at the ground point underneath.
    """
    from .detect.court import COURT_L, COURT_W

    if not (hasattr(court, "to_image") and hasattr(court, "px_per_ft_at")):
        return None
    ys, scales = [], []
    for cy in np.linspace(0.0, COURT_L, 25):
        pt = court.to_image(np.array([[COURT_W / 2, cy]], dtype=np.float32))[0]
        sc = court.px_per_ft_at((COURT_W / 2, cy))
        if np.isfinite(pt[1]) and np.isfinite(sc) and sc > 0:
            ys.append(float(pt[1]))
            scales.append(float(sc))
    if len(ys) < 4:
        return None
    order = np.argsort(ys)
    ys = np.asarray(ys)[order]
    scales = np.asarray(scales)[order]

    def scale_at(y: float) -> float:
        raw = float(np.interp(y, ys, scales))
        ground_y = y + typical_ball_height_ft * raw
        return float(np.interp(ground_y, ys, scales))

    return scale_at


def _damp_inside_players(dets: List[Detection], boxes, penalty: float) -> List[Detection]:
    out = []
    for d in dets:
        inside = any(b.x1 <= d.x <= b.x2 and b.y1 <= d.y <= b.y2 for b in boxes)
        out.append(Detection(d.x, d.y, d.conf * penalty if inside else d.conf, d.w, d.h))
    return out


def video_fingerprint(path: str) -> str:
    st = os.stat(path)
    h = hashlib.sha1()
    h.update(os.path.abspath(path).encode())
    h.update(str(st.st_size).encode())
    h.update(str(int(st.st_mtime)).encode())
    # Hash the first and last MB so a re-encode with the same size is caught.
    with open(path, "rb") as fh:
        h.update(fh.read(1 << 20))
        if st.st_size > (2 << 20):
            fh.seek(-(1 << 20), os.SEEK_END)
            h.update(fh.read(1 << 20))
    return h.hexdigest()[:16]


def cache_path(video_path: str, cfg: Config) -> str:
    key = f"{video_fingerprint(video_path)}_{cfg.perception_digest()}"
    return os.path.join(cfg.cache_dir, f"features_{key}.npz")


def build_features(video_path: str, cfg: Config, progress: Optional[ProgressFn] = None,
                   use_cache: bool = True) -> Tuple[FeatureStream, dict]:
    """Run perception over the whole video and return the feature stream."""
    path = cache_path(video_path, cfg)
    cache_note: Optional[str] = None
    if use_cache and os.path.exists(path):
        try:
            stream = FeatureStream.load(path)
            meta = {k: v for k, v in stream.meta.items()}
            meta.update({"cached": True, "cache_path": path})
            return stream, meta
        except Exception as exc:
            # A stale or corrupt cache is never fatal, but it must not be
            # silent either: an hour of perception re-running every time is the
            # kind of thing you only notice from the warning.
            cache_note = f"ignored unreadable feature cache {path}: {exc}"

    t_start = time.time()
    meta = probe(video_path)
    source = VideoSource(video_path, cfg.video, meta)
    image_size = (source.out_width, source.out_height)
    warnings: List[str] = []
    if cache_note:
        warnings.append(cache_note)

    # --- court ---
    t0 = time.time()
    court_detector = CourtDetector(cfg.court)
    samples = [f.image for f in source.sample_frames(cfg.court.fit_samples)]
    court = court_detector.fit(samples, image_size)
    court_time = time.time() - t0
    if isinstance(court, FallbackCourt):
        warnings.append(
            court_detector.last_rejection or
            "court not detected; out-of-bounds and speed-in-mps are disabled and "
            "net crossing falls back to a fixed image line. Set court.manual_points_path "
            "to calibrate this camera position once instead."
        )

    # --- detectors ---
    ball_detector = build_ball_detector(cfg.ball)
    if hasattr(ball_detector, "set_scale"):
        ball_detector.set_scale(source.scale)
    if ball_detector.name == "motion" and cfg.ball.backend in ("yolo", "auto"):
        warnings.append(
            f"ball weights unavailable at {cfg.ball.weights}; running the motion "
            "fallback detector. Accuracy will be materially worse than a trained model."
        )
    player_detector = build_player_detector(cfg.players)
    if player_detector.name == "motion" and cfg.players.backend == "yolo":
        warnings.append("player weights unavailable; running the motion fallback detector.")

    fps = source.effective_fps
    ball_tracker = BallTracker(cfg.ball_track, fps, _scale_lookup(court))
    player_tracker = PlayerTracker(cfg.tracker)
    events = EventDetector(cfg.events, court, fps, image_size, cfg.court.out_margin_ft)
    builder = FeatureBuilder(fps, image_size[0], image_size[1], court,
                             audio_contacts=load_audio_contacts(cfg.audio_contacts_path))

    gate_polygon = _court_gate_polygon(court, cfg) if cfg.ball.court_gate else None
    player_polygon = (_player_gate_polygon(court, cfg, image_size)
                      if cfg.players.court_gate else None)
    if cfg.ball.court_gate and gate_polygon is None:
        warnings.append("no court geometry, so balls on neighbouring courts cannot be excluded")

    total = int(meta.frame_count / max(1, cfg.video.stride)) or 0
    dt = 1.0 / max(1e-6, fps)
    last_ball: Optional[BallState] = None
    last_boxes: List = []
    n_frames = 0
    n_observed = 0
    n_raw = 0
    n_gated = 0
    n_players_raw = 0
    n_players_kept = 0
    t_detect = 0.0

    for k, frame in enumerate(source):
        # Ball: follow the track with a small ROI while it is fresh, otherwise
        # sweep the whole frame.
        roi = None
        if cfg.ball.roi_tracking and last_ball is not None and last_ball.present \
                and last_ball.misses <= cfg.ball.roi_max_stale_frames and last_ball.xy is not None:
            cx, cy = last_ball.xy
            if last_ball.vel_px_s is not None:
                cx += last_ball.vel_px_s[0] * dt
                cy += last_ball.vel_px_s[1] * dt
            half = cfg.ball.roi_size / 2.0
            roi = (cx - half, cy - half, cx + half, cy + half)

        td = time.time()
        if hasattr(ball_detector, "set_frame"):
            ball_detector.set_frame(int(frame.index))
        dets: List[Detection] = ball_detector.detect(frame.image, roi=roi)
        if roi is not None and not dets:
            dets = ball_detector.detect(frame.image, roi=None)   # lost it: sweep
        n_raw += len(dets)
        dets = _gate_to_court(dets, gate_polygon)
        n_gated += len(dets)
        # Players are slow and slow-moving; detect on a cadence and let the
        # tracker's Kalman carry them in between.
        if k % max(1, cfg.players.detect_every) == 0:
            found = player_detector.detect(frame.image)
            n_players_raw += len(found)
            found = _gate_players_to_court(found, player_polygon)
            n_players_kept += len(found)
            last_boxes = found
        t_detect += time.time() - td

        # A ball-sized blob inside a person's bounding box is more often an
        # elbow, a shoe or a shirt logo than a ball.  Damp rather than drop: the
        # ball really does pass in front of players, constantly.
        if last_boxes and cfg.ball.player_box_penalty < 1.0:
            dets = _damp_inside_players(dets, last_boxes, cfg.ball.player_box_penalty)

        ball_state = ball_tracker.update(dets, frame.t_s, frame.index)
        tracks = player_tracker.update(last_boxes if k % max(1, cfg.players.detect_every) == 0 else [])
        if not tracks:
            tracks = player_tracker.active

        frame_events = events.update(ball_state, tracks, frame.t_s, frame.index)
        gray = cv2.resize(cv2.cvtColor(frame.image, cv2.COLOR_BGR2GRAY), (160, 90))
        builder.add(frame.t_s, frame.index, ball_state, tracks, frame_events, gray)

        last_ball = ball_state
        n_frames += 1
        n_observed += int(ball_state.observed)

        if progress and (n_frames % 50 == 0):
            progress(n_frames, total, "perception")

    if n_raw and n_gated < n_raw:
        warnings.append(
            f"court gate rejected {n_raw - n_gated} of {n_raw} ball candidates "
            "as off-court (neighbouring courts, spectators)"
        )
    if n_players_raw and n_players_kept < n_players_raw:
        warnings.append(
            f"court gate rejected {n_players_raw - n_players_kept} of {n_players_raw} "
            "person detections as off-court (spectators, neighbouring courts)"
        )
    detection_rate = n_observed / max(1, n_frames)
    if detection_rate < 0.15:
        warnings.append(
            f"ball observed in only {detection_rate:.1%} of frames; rally boundaries will "
            "lean on player activity and will be less precise. Check ball.conf, ball.tiled "
            "and video.max_side."
        )

    info = {
        "cached": False,
        "cache_path": path,
        "court_detected": isinstance(court, CourtModel),
        "court_confidence": float(getattr(court, "confidence", 0.0) or 0.0),
        "ball_detector": ball_detector.name,
        "player_detector": player_detector.name,
        "frames_processed": n_frames,
        "ball_detection_rate": detection_rate,
        "warnings": warnings,
        "timings_s": {
            "court_fit": court_time,
            "detection": t_detect,
            "perception_total": time.time() - t_start,
        },
        "duration_s": meta.duration_s,
        "source_fps": meta.fps,
        "width": meta.width,
        "height": meta.height,
        "scale": source.scale,
    }
    stream = builder.build(meta=info)
    if use_cache:
        try:
            stream.save(path)
        except Exception as exc:
            stream.meta.setdefault("warnings", []).append(
                f"could not write feature cache {path}: {exc}")
    return stream, info


def segment_video(video_path: str, cfg: Config, progress: Optional[ProgressFn] = None,
                  use_cache: bool = True,
                  segmenter: Optional[RallySegmenter] = None
                  ) -> Tuple[SegmentationResult, FeatureStream]:
    stream, info = build_features(video_path, cfg, progress=progress, use_cache=use_cache)
    seg = segmenter or build_segmenter(cfg)

    t0 = time.time()
    rallies = seg.segment(stream)
    seg_time = time.time() - t0

    timings = dict(info.get("timings_s", {}))
    timings["segmentation"] = seg_time

    result = SegmentationResult(
        video_path=os.path.abspath(video_path),
        duration_s=float(info.get("duration_s", stream.t[-1] if len(stream) else 0.0)),
        fps=float(info.get("source_fps", stream.fps)),
        width=int(info.get("width", stream.width)),
        height=int(info.get("height", stream.height)),
        rallies=rallies,
        segmenter=seg.name,
        pipeline_version=__version__,
        court_detected=bool(info.get("court_detected", False)),
        court_confidence=float(info.get("court_confidence", 0.0)),
        ball_detector=str(info.get("ball_detector", "unknown")),
        frames_processed=int(info.get("frames_processed", len(stream))),
        ball_detection_rate=float(info.get("ball_detection_rate", 0.0)),
        warnings=list(info.get("warnings", [])),
        timings_s=timings,
        config_digest=cfg.digest(),
    )
    return result, stream
