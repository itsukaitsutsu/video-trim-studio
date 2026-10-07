"""Waveform peaks and filmstrip thumbnails for the timeline."""

from __future__ import annotations

import os
import subprocess
import tempfile

import numpy as np

from .ffprobe import run


def waveform_peaks(path: str, buckets: int = 2400, sample_rate: int = 8000) -> list[int]:
    """Peak amplitude per bucket, as ints in [-32768, 32767].

    Decodes the audio track to mono 8 kHz PCM once; for a 1 h video that is
    ~115 MB of PCM streamed through a pipe, which is fine locally.
    """
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path,
        "-vn", "-ac", "1", "-ar", str(sample_rate), "-f", "s16le", "-",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True)
    except FileNotFoundError:
        return []
    if proc.returncode != 0 or not proc.stdout:
        return []

    pcm = np.frombuffer(proc.stdout, dtype=np.int16)
    if pcm.size == 0:
        return []
    usable = (pcm.size // buckets) * buckets
    if usable == 0:
        return [int(abs(pcm).max())]
    pcm = pcm[:usable].reshape(buckets, -1)
    # Envelope: max |sample| per bucket keeps transients visible.
    peaks = np.abs(pcm.astype(np.int32)).max(axis=1)
    # Scale so the loudest peak hits full height; keep 1 LSB of floor.
    top = peaks.max() or 1
    scaled = (peaks * 1000 / top).astype(np.int32)
    return scaled.tolist()


def make_thumbnails(path: str, out_dir: str, count: int = 60,
                    width: int = 160) -> dict:
    """Filmstrip: `count` evenly spaced frames at `width` px wide.

    Returns {"interval": s, "count": n, "files": [...]} - the frontend places
    file i at t = i * interval.
    """
    os.makedirs(out_dir, exist_ok=True)
    for old in os.listdir(out_dir):
        if old.startswith("thumb_") and old.endswith(".jpg"):
            try:
                os.remove(os.path.join(out_dir, old))
            except OSError:
                pass

    duration = _duration(path)
    if duration <= 0:
        return {"interval": 0, "count": 0, "files": []}

    interval = max(0.5, duration / count)
    pattern = os.path.join(out_dir, "thumb_%04d.jpg")
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", path,
        "-an", "-sn", "-dn",
        "-vf", f"fps=1/{interval:.4f},scale={width}:-2",
        "-q:v", "6", "-frames:v", str(count), pattern,
    ]
    run(cmd)
    files = sorted(f for f in os.listdir(out_dir)
                   if f.startswith("thumb_") and f.endswith(".jpg"))
    return {"interval": interval, "count": len(files), "files": files}


def _duration(path: str) -> float:
    out = run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", path,
    ]).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return 0.0


def extract_wav(path: str, out_wav: str, sample_rate: int = 16000) -> str:
    """16 kHz mono WAV - the input format transcription tools expect."""
    run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", path,
        "-vn", "-ac", "1", "-ar", str(sample_rate), "-c:a", "pcm_s16le", out_wav,
    ])
    return out_wav


def temp_wav_path(stem: str) -> str:
    return os.path.join(tempfile.gettempdir(), f"vts_{stem}.16k.wav")
