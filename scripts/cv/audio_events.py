#!/usr/bin/env python3
"""
Timestamped paddle-contact events from audio, not vision. This is a
deliberate choice: the spec explicitly defers shot *type* classification
("unknown_shot") but still wants contact timestamps, and audio onset
detection (a paddle striking a ball is a short, sharp transient) is a far
more reliable signal for "when did a contact happen" than trying to infer
it from low-fps sampled video frames. No shot type, spin, direction or
outcome is claimed — only "something that sounds like a contact happened
at time T", which is exactly what "unknown_shot" means per the spec.

Method: extract mono PCM audio via ffmpeg, compute a short-time energy
envelope, and pick local peaks that exceed an adaptive threshold (median +
k * MAD of the envelope) with a minimum spacing so a single contact's
ringing doesn't register twice. This is classical DSP, not a model — no
"AI" claim is being made about it.

Usage: audio_events.py <video_path> [--out <json_path>]
Prints JSON: {"events": [{"timestampSeconds": float, "strength": float}, ...],
              "diagnostics": {...}}
"""
import sys
import json
import argparse
import subprocess
import tempfile
import os
import wave
import numpy as np


def extract_mono_pcm(video_path: str, out_wav: str, sample_rate: int = 16000):
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", video_path,
            "-vn", "-ac", "1", "-ar", str(sample_rate), "-f", "wav", out_wav,
        ],
        check=True,
        capture_output=True,
    )


def read_wav_mono(path: str):
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
        sampwidth = w.getsampwidth()
    if sampwidth != 2:
        raise ValueError(f"expected 16-bit PCM, got sampwidth={sampwidth}")
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return samples, sr


def detect_onsets(samples: np.ndarray, sr: int, min_gap_seconds: float = 0.15):
    # Short-time energy envelope: 10ms hop, 20ms window.
    hop = max(1, int(sr * 0.010))
    win = max(1, int(sr * 0.020))
    n_frames = max(0, (len(samples) - win) // hop + 1)
    if n_frames <= 0:
        return [], {"reason": "audio too short to analyze"}

    envelope = np.empty(n_frames, dtype=np.float64)
    for i in range(n_frames):
        start = i * hop
        seg = samples[start:start + win]
        envelope[i] = np.sqrt(np.mean(seg.astype(np.float64) ** 2)) if len(seg) else 0.0

    # Onset strength = positive first difference of the envelope (energy
    # rising sharply = a transient just started), which responds to paddle
    # contacts specifically better than raw energy (which also fires on
    # sustained crowd/ambient noise).
    diff = np.diff(envelope, prepend=envelope[0])
    onset_strength = np.clip(diff, 0, None)

    # A global median+MAD threshold turned out to be far too permissive on
    # real gym-recorded audio (ambient noise from adjacent courts, HVAC,
    # crowd) — it fired ~4.5x/second, clearly not real contacts. Percentile
    # thresholding is more robust here: paddle contacts are rare, sharp
    # outliers relative to the bulk of the onset-strength distribution, so
    # pick a high percentile and additionally require the peak clear a
    # fraction of the loudest onset seen in the whole clip.
    percentile_threshold = float(np.percentile(onset_strength, 97.5))
    floor_threshold = 0.12 * float(onset_strength.max()) if onset_strength.max() > 0 else 0.0
    threshold = max(percentile_threshold, floor_threshold)

    min_gap_frames = max(1, int(min_gap_seconds / (hop / sr)))

    peaks = []
    i = 0
    while i < len(onset_strength):
        if onset_strength[i] > threshold:
            # walk to the local max within the refractory window, then skip past it
            window_end = min(len(onset_strength), i + min_gap_frames)
            local_max_idx = i + int(np.argmax(onset_strength[i:window_end]))
            peaks.append(local_max_idx)
            i = local_max_idx + min_gap_frames
        else:
            i += 1

    events = []
    for idx in peaks:
        t = idx * hop / sr
        events.append({"timestampSeconds": round(float(t), 3), "strength": round(float(onset_strength[idx]), 5)})

    diagnostics = {
        "sampleRate": sr,
        "durationSeconds": round(len(samples) / sr, 2),
        "envelopeFrames": int(n_frames),
        "onsetThreshold": round(threshold, 5),
        "eventCount": len(events),
    }
    return events, diagnostics


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("video_path")
    parser.add_argument("--out", default=None)
    parser.add_argument("--min-gap", type=float, default=0.15)
    args = parser.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        wav_path = os.path.join(tmp, "audio.wav")
        try:
            extract_mono_pcm(args.video_path, wav_path)
        except subprocess.CalledProcessError as exc:
            result = {"events": [], "diagnostics": {"error": f"ffmpeg audio extraction failed: {exc.stderr.decode(errors='ignore')[:500]}"}}
            print(json.dumps(result))
            return

        samples, sr = read_wav_mono(wav_path)
        events, diagnostics = detect_onsets(samples, sr, args.min_gap)

    result = {"events": events, "diagnostics": diagnostics}
    out_json = json.dumps(result)
    if args.out:
        with open(args.out, "w") as f:
            f.write(out_json)
    else:
        print(out_json)


if __name__ == "__main__":
    main()
