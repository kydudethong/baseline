"""
Write an mp4 QuickTime will actually play.

cv2.VideoWriter with the `mp4v` FourCC produces MPEG-4 Part 2. It is the
example every OpenCV tutorial uses and it is fine in VLC, but QuickTime
decodes it badly -- the picture breaks into drifting macroblocks that look
exactly like a corrupted download. The video is not corrupt; the codec is
wrong for the player.

So frames are piped to ffmpeg and encoded as H.264 with yuv420p, which is what
every player and browser expects. ffmpeg is already a hard dependency of this
project (the pipeline shells out to it for audio and frame extraction), so this
adds nothing to install.

`-pix_fmt yuv420p` is not optional. Without it ffmpeg picks yuv444p for RGB
input, which QuickTime and Safari both refuse, and the failure is a black
window rather than an error.
"""
from __future__ import annotations

import shutil
import subprocess
import sys


class FfmpegWriter:
    """Same shape as cv2.VideoWriter: .write(frame), .release()."""

    def __init__(self, path: str, fps: float, width: int, height: int, crf: int = 20):
        self.path = path
        # H.264 needs even dimensions; an odd one is silently mangled rather
        # than refused.
        assert width % 2 == 0 and height % 2 == 0, f"odd frame size {width}x{height}"
        self.expect = (height, width, 3)
        self.proc = subprocess.Popen(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-f", "rawvideo", "-vcodec", "rawvideo",
                "-s", f"{width}x{height}", "-pix_fmt", "bgr24",
                "-r", f"{fps:.6f}", "-i", "-",
                "-an",
                "-vcodec", "libx264", "-pix_fmt", "yuv420p",
                "-crf", str(crf), "-preset", "veryfast",
                # Lets a player start before the whole file is read, which
                # matters when these are opened straight off disk.
                "-movflags", "+faststart",
                path,
            ],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )

    def write(self, frame) -> None:
        # rawvideo has no framing: ffmpeg reads exactly width*height*3 bytes per
        # frame and trusts you. Hand it a frame of a different size and every
        # subsequent frame is read at the wrong offset, which decodes as
        # drifting colour blocks -- indistinguishable from a bad codec, and the
        # reason to check rather than assume.
        if frame.shape != self.expect:
            raise RuntimeError(
                f"frame is {frame.shape}, writer expects {self.expect}. "
                "Every frame must be exactly the size the writer was opened with."
            )
        try:
            self.proc.stdin.write(frame.tobytes())
        except BrokenPipeError:
            err = self.proc.stderr.read().decode("utf-8", "replace")[-800:]
            raise RuntimeError(f"ffmpeg died while encoding:\n{err}") from None

    def release(self) -> None:
        if self.proc.stdin:
            self.proc.stdin.close()
        self.proc.wait()
        if self.proc.returncode not in (0, None):
            err = self.proc.stderr.read().decode("utf-8", "replace")[-800:]
            print(f"ffmpeg exited {self.proc.returncode}:\n{err}", file=sys.stderr)

    def isOpened(self) -> bool:  # noqa: N802 — matches cv2.VideoWriter
        return self.proc.poll() is None


def open_writer(path: str, fps: float, width: int, height: int):
    """FfmpegWriter when ffmpeg is on PATH, else cv2's mp4v as a last resort."""
    if shutil.which("ffmpeg"):
        return FfmpegWriter(path, fps, width, height)
    import cv2
    print("ffmpeg not found — falling back to mp4v, which some players show as "
          "coloured blocks. Install ffmpeg for a clean file.", file=sys.stderr)
    return cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
