"""Debug overlay.

This is not a nicety.  Rally segmentation fails in ways a JSON file cannot
show you -- the tracker locked onto a shoe, the homography is 4 ft off, the
"serve" was someone bouncing the ball while they waited.  Watching thirty
seconds of overlay tells you which of those it is; reading timestamps does not.

Rendered purely from the cached feature stream and the segmentation result, so
producing it costs a video decode and nothing else -- no detector, no weights.
"""

from __future__ import annotations

import math
from typing import Iterator, Optional, Sequence, Tuple

import cv2
import numpy as np

from .config import Config
from .detect.court import (
    COURT_L, COURT_W, KITCHEN_FAR_Y, KITCHEN_NEAR_Y, NET_Y, CourtModel,
)
from .events import (
    BALL_ROLL, BOUNCE, DOUBLE_BOUNCE, NET_CONTACT, NET_CROSS,
    OUT_OF_BOUNDS, PADDLE_CONTACT, SERVE,
)
from .features import FeatureStream
from .schema import RallySegment, SegmentationResult
from .video import VideoSource, write_video

# BGR
C_BALL = (60, 240, 255)
C_TRAIL = (40, 190, 255)
C_COAST = (120, 120, 160)
C_PLAYER = (110, 235, 140)
C_COURT = (255, 190, 90)
C_NET = (250, 120, 240)
C_RALLY = (90, 230, 130)
C_IDLE = (150, 150, 150)
C_CUT = (70, 90, 255)
C_TEXT = (245, 245, 245)
C_PANEL = (28, 28, 32)

EVENT_COLORS = {
    SERVE: (120, 220, 255),
    NET_CROSS: (250, 160, 250),
    BOUNCE: (200, 200, 90),
    PADDLE_CONTACT: (140, 255, 200),
    NET_CONTACT: (90, 120, 255),
    OUT_OF_BOUNDS: (70, 90, 255),
    DOUBLE_BOUNCE: (70, 140, 255),
    BALL_ROLL: (120, 140, 220),
}


def render_debug_video(video_path: str, out_path: str, stream: FeatureStream,
                       result: SegmentationResult, cfg: Config,
                       frame_probability: Optional[np.ndarray] = None) -> str:
    source = VideoSource(video_path, cfg.video)
    size = (source.out_width, source.out_height)
    court = _court_from_stream(stream)

    index_by_frame = {int(f): i for i, f in enumerate(stream.frame_index)}
    events_by_index: dict = {}
    for e in stream.events:
        events_by_index.setdefault(stream.index_at(e.t_s), []).append(e)

    def frames() -> Iterator[np.ndarray]:
        for frame in source:
            i = index_by_frame.get(int(frame.index))
            canvas = frame.image.copy()
            if i is None:
                yield canvas
                continue
            _draw(canvas, stream, result, cfg, i, court, events_by_index,
                  frame_probability, size)
            yield canvas

    return write_video(frames(), out_path, source.effective_fps, size,
                       crf=cfg.debug.crf, preset=cfg.debug.preset)


# --- drawing -----------------------------------------------------------------


def _court_from_stream(stream: FeatureStream):
    if not stream.court or stream.court.get("source") in (None, "fallback"):
        return None
    try:
        return CourtModel.from_dict(stream.court)
    except Exception:
        return None


def _draw(img: np.ndarray, stream: FeatureStream, result: SegmentationResult,
          cfg: Config, i: int, court, events_by_index: dict,
          frame_prob: Optional[np.ndarray], size: Tuple[int, int]) -> None:
    t_s = float(stream.t[i])
    h, w = img.shape[:2]

    if cfg.debug.draw_court and court is not None:
        _draw_court(img, court)
    if cfg.debug.draw_players:
        _draw_players(img, stream, i)
    if cfg.debug.draw_ball:
        _draw_ball(img, stream, i, cfg.debug.trail_frames)

    active = _active_segment(result.rallies, t_s)
    _draw_state_banner(img, stream, result, i, t_s, active, frame_prob, cfg)
    _draw_events(img, stream, i, events_by_index)
    if cfg.debug.draw_evidence:
        _draw_evidence_panel(img, stream, i, active)
    if cfg.debug.draw_timeline:
        _draw_timeline(img, result, t_s)
    _flash_cut(img, result, t_s, stream.fps)


def _draw_court(img: np.ndarray, court: CourtModel) -> None:
    def line(a, b, color, thickness=2):
        pts = court.to_image(np.array([a, b], dtype=np.float32))
        if not np.all(np.isfinite(pts)):
            return
        p0 = tuple(np.round(pts[0]).astype(int))
        p1 = tuple(np.round(pts[1]).astype(int))
        cv2.line(img, p0, p1, color, thickness, cv2.LINE_AA)

    line((0, 0), (COURT_W, 0), C_COURT)
    line((0, COURT_L), (COURT_W, COURT_L), C_COURT)
    line((0, 0), (0, COURT_L), C_COURT)
    line((COURT_W, 0), (COURT_W, COURT_L), C_COURT)
    line((0, KITCHEN_NEAR_Y), (COURT_W, KITCHEN_NEAR_Y), C_COURT, 1)
    line((0, KITCHEN_FAR_Y), (COURT_W, KITCHEN_FAR_Y), C_COURT, 1)
    line((COURT_W / 2, 0), (COURT_W / 2, KITCHEN_NEAR_Y), C_COURT, 1)
    line((COURT_W / 2, KITCHEN_FAR_Y), (COURT_W / 2, COURT_L), C_COURT, 1)
    line((0, NET_Y), (COURT_W, NET_Y), C_NET, 2)


def _draw_players(img: np.ndarray, stream: FeatureStream, i: int) -> None:
    if stream.players.shape[0] <= i:
        return
    for row in stream.players[i]:
        x1, y1, x2, y2, tid = row
        if x2 <= x1 or y2 <= y1:
            continue
        p0 = (int(round(x1)), int(round(y1)))
        p1 = (int(round(x2)), int(round(y2)))
        cv2.rectangle(img, p0, p1, C_PLAYER, 2, cv2.LINE_AA)
        cv2.putText(img, f"P{int(tid)}", (p0[0], max(12, p0[1] - 6)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, C_PLAYER, 1, cv2.LINE_AA)


def _draw_ball(img: np.ndarray, stream: FeatureStream, i: int, trail_frames: int) -> None:
    if stream.ball_xy.shape[0] <= i:
        return
    lo = max(0, i - trail_frames)
    pts = stream.ball_xy[lo : i + 1]
    prev = None
    for k, (x, y, observed) in enumerate(pts):
        if not (math.isfinite(x) and math.isfinite(y)):
            prev = None
            continue
        p = (int(round(x)), int(round(y)))
        if prev is not None:
            alpha = (k + 1) / max(1, len(pts))
            color = tuple(int(c * (0.35 + 0.65 * alpha)) for c in C_TRAIL)
            cv2.line(img, prev, p, color, 2, cv2.LINE_AA)
        prev = p
    x, y, observed = stream.ball_xy[i]
    if math.isfinite(x) and math.isfinite(y):
        p = (int(round(x)), int(round(y)))
        if observed > 0.5:
            cv2.circle(img, p, 9, C_BALL, 2, cv2.LINE_AA)
            cv2.circle(img, p, 2, C_BALL, -1, cv2.LINE_AA)
        else:
            # Dashed ring: the tracker is coasting, not seeing.
            for a in range(0, 360, 40):
                cv2.ellipse(img, p, (9, 9), 0, a, a + 20, C_COAST, 2, cv2.LINE_AA)


def _active_segment(rallies: Sequence[RallySegment], t_s: float) -> Optional[RallySegment]:
    for seg in rallies:
        if seg.start_s <= t_s <= seg.end_s:
            return seg
    return None


def _draw_state_banner(img, stream, result, i, t_s, active, frame_prob, cfg) -> None:
    h, w = img.shape[:2]
    bar_h = 34
    overlay = img.copy()
    cv2.rectangle(overlay, (0, 0), (w, bar_h), C_PANEL, -1)
    cv2.addWeighted(overlay, 0.72, img, 0.28, 0, img)

    if active is not None:
        label = (f"RALLY {active.idx + 1}  conf {active.confidence:.2f}  "
                 f"{t_s - active.start_s:0.1f}s / {active.duration_s:0.1f}s")
        color = C_RALLY
    else:
        label = "IDLE"
        color = C_IDLE
    cv2.rectangle(img, (0, 0), (6, bar_h), color, -1)
    cv2.putText(img, label, (14, 23), cv2.FONT_HERSHEY_SIMPLEX,
                cfg.debug.font_scale, C_TEXT, 1, cv2.LINE_AA)

    right = f"t={t_s:7.2f}s   {result.segmenter}"
    if frame_prob is not None and i < len(frame_prob):
        right = f"p={frame_prob[i]:.2f}   " + right
    (tw, _), _ = cv2.getTextSize(right, cv2.FONT_HERSHEY_SIMPLEX, cfg.debug.font_scale, 1)
    cv2.putText(img, right, (w - tw - 12, 23), cv2.FONT_HERSHEY_SIMPLEX,
                cfg.debug.font_scale, C_TEXT, 1, cv2.LINE_AA)


def _draw_events(img, stream: FeatureStream, i: int, events_by_index: dict) -> None:
    """Recent events, so a cause is visible next to its effect."""
    h, w = img.shape[:2]
    y = 56
    for back in range(0, 12):
        for e in events_by_index.get(i - back, []):
            color = EVENT_COLORS.get(e.kind, C_TEXT)
            fade = 1.0 - back / 14.0
            shade = tuple(int(c * fade) for c in color)
            text = f"{e.kind} {e.confidence:.2f}"
            if e.kind == OUT_OF_BOUNDS and "outside_by_ft" in e.detail:
                text += f"  +{e.detail['outside_by_ft']}ft"
            cv2.putText(img, text, (14, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                        shade, 1, cv2.LINE_AA)
            y += 18
            if y > h - 90:
                return


def _draw_evidence_panel(img, stream: FeatureStream, i: int, active) -> None:
    h, w = img.shape[:2]
    rows = [
        ("ball", float(stream.col("ball_observed")[i])),
        ("gap", float(stream.col("gap_norm")[i])),
        ("speed", float(min(1.0, stream.col("ball_speed")[i] / 1.5))),
        ("players", float(stream.col("player_activity_w")[i])),
        ("cross/s", float(min(1.0, stream.col("rate_net_cross")[i]))),
    ]
    pw, ph = 150, 14
    x0 = w - pw - 16
    y0 = 52
    overlay = img.copy()
    cv2.rectangle(overlay, (x0 - 10, y0 - 16), (w - 6, y0 + ph * len(rows) + 8), C_PANEL, -1)
    cv2.addWeighted(overlay, 0.62, img, 0.38, 0, img)
    for k, (name, value) in enumerate(rows):
        y = y0 + k * ph
        cv2.putText(img, name, (x0 - 4, y + 8), cv2.FONT_HERSHEY_SIMPLEX, 0.38,
                    C_TEXT, 1, cv2.LINE_AA)
        bx = x0 + 52
        cv2.rectangle(img, (bx, y), (bx + 84, y + 7), (70, 70, 76), -1)
        fill = int(84 * float(np.clip(value, 0.0, 1.0)))
        cv2.rectangle(img, (bx, y), (bx + fill, y + 7), C_RALLY, -1)


def _draw_timeline(img, result: SegmentationResult, t_s: float) -> None:
    h, w = img.shape[:2]
    y0 = h - 30
    duration = max(1e-6, result.duration_s)
    overlay = img.copy()
    cv2.rectangle(overlay, (0, y0 - 10), (w, h), C_PANEL, -1)
    cv2.addWeighted(overlay, 0.75, img, 0.25, 0, img)
    cv2.rectangle(img, (12, y0), (w - 12, y0 + 10), (62, 62, 68), -1)
    span = w - 24
    for seg in result.rallies:
        x1 = 12 + int(span * seg.start_s / duration)
        x2 = 12 + int(span * seg.end_s / duration)
        shade = 0.45 + 0.55 * seg.confidence
        color = tuple(int(c * shade) for c in C_RALLY)
        cv2.rectangle(img, (x1, y0), (max(x1 + 1, x2), y0 + 10), color, -1)
        cv2.line(img, (x1, y0 - 3), (x1, y0 + 13), C_CUT, 1)
        cv2.line(img, (x2, y0 - 3), (x2, y0 + 13), C_CUT, 1)
    xc = 12 + int(span * min(1.0, t_s / duration))
    cv2.line(img, (xc, y0 - 6), (xc, y0 + 16), C_TEXT, 2, cv2.LINE_AA)


def _flash_cut(img, result: SegmentationResult, t_s: float, fps: float) -> None:
    """A visible frame border on the exact cut points, so they can be eyeballed."""
    window = 3.0 / max(1e-6, fps)
    h, w = img.shape[:2]
    for seg in result.rallies:
        if abs(t_s - seg.start_s) <= window:
            cv2.rectangle(img, (0, 0), (w - 1, h - 1), C_RALLY, 6)
            cv2.putText(img, f"CUT IN  rally {seg.idx + 1}  ({seg.start_reason.value})",
                        (18, h - 44), cv2.FONT_HERSHEY_SIMPLEX, 0.62, C_RALLY, 2, cv2.LINE_AA)
        elif abs(t_s - seg.end_s) <= window:
            cv2.rectangle(img, (0, 0), (w - 1, h - 1), C_CUT, 6)
            cv2.putText(img, f"CUT OUT rally {seg.idx + 1}  ({seg.end_reason.value})",
                        (18, h - 44), cv2.FONT_HERSHEY_SIMPLEX, 0.62, C_CUT, 2, cv2.LINE_AA)
