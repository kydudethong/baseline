"""Video I/O.

Two readers.  ``cv2.VideoCapture`` is the fast path.  The ffmpeg rawvideo pipe
is the correct path: phone footage with variable frame rate, rotation metadata
or an unusual container makes OpenCV report frame counts and timestamps that are
quietly wrong, and a rally timestamp that is wrong by two seconds is worse than
no timestamp at all.  ``ffprobe`` is always the source of truth for metadata.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from typing import Iterator, Optional, Tuple

import numpy as np

try:  # pragma: no cover - import guard
    import cv2
except ImportError as exc:  # pragma: no cover
    raise RuntimeError("opencv-python-headless is required: pip install -r ml/requirements-core.txt") from exc

from .config import VideoConfig


def _tool(name: str) -> str:
    """Resolve ffmpeg/ffprobe, preferring the binaries the Node app already ships."""
    env = os.environ.get(name.upper())
    if env and os.path.exists(env):
        return env
    found = shutil.which(name)
    if found:
        return found
    # @ffmpeg-installer / @ffprobe-installer layout used by the Next.js app.
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    for base in (f"node_modules/@{name}-installer", "node_modules/ffmpeg-static"):
        cand_root = os.path.join(root, base)
        for dirpath, _dirnames, filenames in os.walk(cand_root):
            if name in filenames:
                path = os.path.join(dirpath, name)
                if os.access(path, os.X_OK):
                    return path
    raise RuntimeError(f"{name} not found on PATH; install ffmpeg or set {name.upper()}=/path/to/{name}")


def ffmpeg_bin() -> str:
    return _tool("ffmpeg")


def ffprobe_bin() -> str:
    return _tool("ffprobe")


@dataclass
class VideoMeta:
    path: str
    width: int
    height: int
    fps: float
    duration_s: float
    frame_count: int
    rotation: int = 0
    codec: str = ""

    @property
    def aspect(self) -> float:
        return self.width / max(1, self.height)


def probe(path: str) -> VideoMeta:
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    cmd = [
        ffprobe_bin(), "-v", "error", "-print_format", "json",
        "-show_streams", "-show_format", path,
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    streams = [s for s in data.get("streams", []) if s.get("codec_type") == "video"]
    if not streams:
        raise ValueError(f"no video stream in {path}")
    s = streams[0]

    width = int(s.get("width", 0))
    height = int(s.get("height", 0))

    fps = 0.0
    for key in ("avg_frame_rate", "r_frame_rate"):
        raw = s.get(key) or "0/0"
        try:
            num, den = raw.split("/")
            if float(den) > 0:
                fps = float(num) / float(den)
        except (ValueError, ZeroDivisionError):
            fps = 0.0
        if fps > 0:
            break
    if fps <= 0:
        fps = 30.0

    duration = float(s.get("duration") or data.get("format", {}).get("duration") or 0.0)
    frame_count = int(s.get("nb_frames") or 0)
    if frame_count <= 0 and duration > 0:
        frame_count = int(round(duration * fps))
    if duration <= 0 and frame_count > 0:
        duration = frame_count / fps

    rotation = 0
    for sd in s.get("side_data_list", []) or []:
        if "rotation" in sd:
            rotation = int(sd["rotation"]) % 360
    tags = s.get("tags", {}) or {}
    if not rotation and "rotate" in tags:
        try:
            rotation = int(tags["rotate"]) % 360
        except ValueError:
            rotation = 0

    # ffprobe reports the pre-rotation frame size; downstream code wants what it
    # will actually see after decoding.
    if rotation in (90, 270):
        width, height = height, width

    return VideoMeta(
        path=path, width=width, height=height, fps=fps,
        duration_s=duration, frame_count=frame_count,
        rotation=rotation, codec=s.get("codec_name", ""),
    )


@dataclass
class Frame:
    index: int          # index in the *source* video, not in the strided stream
    t_s: float
    image: np.ndarray   # BGR, possibly downscaled
    scale: float        # multiply an image-space coord by this to get source px


class VideoSource:
    """Iterate frames with a stride, downscaled to ``max_side``.

    Coordinates produced by the perception stack are in the *downscaled* frame.
    Multiply by ``Frame.scale`` for source pixels.  Everything the pipeline
    stores externally is either seconds or normalised court units, so the scale
    never leaks into the output.
    """

    def __init__(self, path: str, cfg: VideoConfig, meta: Optional[VideoMeta] = None):
        self.path = path
        self.cfg = cfg
        self.meta = meta or probe(path)
        self.scale = 1.0
        longest = max(self.meta.width, self.meta.height)
        if cfg.max_side and longest > cfg.max_side:
            self.scale = longest / float(cfg.max_side)
        self.out_width = int(round(self.meta.width / self.scale))
        self.out_height = int(round(self.meta.height / self.scale))

    @property
    def effective_fps(self) -> float:
        return self.meta.fps / max(1, self.cfg.stride)

    def __iter__(self) -> Iterator[Frame]:
        if self.cfg.use_ffmpeg_reader:
            return self._iter_ffmpeg()
        return self._iter_cv2()

    # --- readers ----------------------------------------------------------

    def _iter_cv2(self) -> Iterator[Frame]:
        cap = cv2.VideoCapture(self.path)
        if not cap.isOpened():
            raise RuntimeError(f"cannot open {self.path}")
        try:
            start_idx = int(round(self.cfg.start_s * self.meta.fps)) if self.cfg.start_s else 0
            if start_idx:
                cap.set(cv2.CAP_PROP_POS_FRAMES, start_idx)
            end_idx = (
                int(round(self.cfg.end_s * self.meta.fps))
                if self.cfg.end_s is not None else None
            )
            idx = start_idx
            stride = max(1, self.cfg.stride)
            while True:
                ok, image = cap.read()
                if not ok:
                    break
                if end_idx is not None and idx >= end_idx:
                    break
                if (idx - start_idx) % stride == 0:
                    yield self._make_frame(idx, image)
                idx += 1
        finally:
            cap.release()

    def _iter_ffmpeg(self) -> Iterator[Frame]:
        w, h = self.meta.width, self.meta.height
        cmd = [ffmpeg_bin(), "-nostdin", "-v", "error"]
        if self.cfg.start_s:
            cmd += ["-ss", f"{self.cfg.start_s:.3f}"]
        cmd += ["-i", self.path]
        if self.cfg.end_s is not None:
            cmd += ["-t", f"{max(0.0, self.cfg.end_s - self.cfg.start_s):.3f}"]
        cmd += ["-f", "rawvideo", "-pix_fmt", "bgr24", "-vsync", "0", "-"]

        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                bufsize=w * h * 3 * 4)
        assert proc.stdout is not None
        nbytes = w * h * 3
        start_idx = int(round(self.cfg.start_s * self.meta.fps)) if self.cfg.start_s else 0
        idx = start_idx
        stride = max(1, self.cfg.stride)
        try:
            while True:
                buf = proc.stdout.read(nbytes)
                if not buf or len(buf) < nbytes:
                    break
                if (idx - start_idx) % stride == 0:
                    image = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
                    yield self._make_frame(idx, image.copy())
                idx += 1
        finally:
            proc.stdout.close()
            proc.wait(timeout=5)

    def _make_frame(self, idx: int, image: np.ndarray) -> Frame:
        if self.scale != 1.0:
            image = cv2.resize(image, (self.out_width, self.out_height),
                               interpolation=cv2.INTER_AREA)
        return Frame(index=idx, t_s=idx / self.meta.fps, image=image, scale=self.scale)

    # --- helpers ----------------------------------------------------------

    def sample_frames(self, n: int) -> list:
        """``n`` frames spread across the clip, for court fitting."""
        cap = cv2.VideoCapture(self.path)
        if not cap.isOpened():
            raise RuntimeError(f"cannot open {self.path}")
        frames = []
        try:
            total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or self.meta.frame_count
            lo = int(round((self.cfg.start_s or 0.0) * self.meta.fps))
            hi = int(round(self.cfg.end_s * self.meta.fps)) if self.cfg.end_s else total
            hi = max(lo + 1, min(hi, total))
            if hi <= lo:
                return frames
            for pos in np.linspace(lo, hi - 1, num=max(1, n)).astype(int):
                cap.set(cv2.CAP_PROP_POS_FRAMES, int(pos))
                ok, image = cap.read()
                if ok:
                    frames.append(self._make_frame(int(pos), image))
        finally:
            cap.release()
        return frames


def write_video(frames: Iterator[np.ndarray], out_path: str, fps: float,
                size: Tuple[int, int], crf: int = 23, preset: str = "veryfast") -> str:
    """Encode BGR frames to H.264 by piping straight into ffmpeg.

    cv2.VideoWriter's mp4v output does not play in Safari or in a Next.js
    <video> tag without a re-encode, so skip the intermediate entirely.
    """
    w, h = size
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    cmd = [
        ffmpeg_bin(), "-nostdin", "-v", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
        "-r", f"{fps:.6f}", "-i", "-",
        "-an", "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_path,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdin is not None
    try:
        for image in frames:
            if image.shape[1] != w or image.shape[0] != h:
                image = cv2.resize(image, (w, h))
            proc.stdin.write(np.ascontiguousarray(image, dtype=np.uint8).tobytes())
    finally:
        proc.stdin.close()
        err = proc.stderr.read().decode(errors="ignore") if proc.stderr else ""
        code = proc.wait()
    if code != 0:
        raise RuntimeError(f"ffmpeg failed ({code}): {err[-500:]}")
    return out_path
