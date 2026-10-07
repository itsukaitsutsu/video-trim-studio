"""ffprobe / ffmpeg capability helpers.

Everything the UI needs to know about a source file, plus the logic that
turns "export with the same format as the source" into concrete encoder
arguments.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from fractions import Fraction

VIDEO_EXTS = {
    ".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".ts", ".mts",
    ".m2ts", ".mpg", ".mpeg", ".flv", ".wmv", ".3gp", ".vob",
}


class FFmpegMissing(RuntimeError):
    pass


def require_ffmpeg() -> None:
    missing = [n for n in ("ffmpeg", "ffprobe") if shutil.which(n) is None]
    if missing:
        raise FFmpegMissing(
            f"{', '.join(missing)} not found on PATH. Install ffmpeg first:\n"
            "  Windows : winget install Gyan.FFmpeg   (then open a NEW terminal)\n"
            "  macOS   : brew install ffmpeg\n"
            "  Linux   : sudo apt install ffmpeg"
        )


def run(cmd: list[str], timeout: float | None = None) -> subprocess.CompletedProcess:
    """Run a command, raising a readable error (with stderr) on failure."""
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise FFmpegMissing(f"'{cmd[0]}' not found on PATH") from exc
    if proc.returncode != 0:
        raise RuntimeError(
            f"Command failed (exit {proc.returncode}): {' '.join(cmd)}\n"
            f"--- stderr ---\n{(proc.stderr or '')[-4000:]}"
        )
    return proc


# ---------------------------------------------------------------------------
# Probing
# ---------------------------------------------------------------------------

def _frac(value: str | None) -> float:
    if not value or value in ("0/0", "N/A"):
        return 0.0
    try:
        if "/" in value:
            num, den = value.split("/", 1)
            return float(Fraction(int(num), int(den))) if int(den) else 0.0
        return float(value)
    except (ValueError, ZeroDivisionError):
        return 0.0


def probe(path: str) -> dict:
    """Full media description of `path` (durations, streams, bitrates, colour)."""
    if not os.path.isfile(path):
        raise FileNotFoundError(f"File not found: {path}")

    out = run([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", path,
    ]).stdout
    data = json.loads(out)

    fmt = data.get("format", {})
    streams = data.get("streams", [])
    vstream = next((s for s in streams if s.get("codec_type") == "video"), None)
    astream = next((s for s in streams if s.get("codec_type") == "audio"), None)

    fmt_bitrate = _int_or_none(fmt.get("bit_rate"))
    v_bitrate = _int_or_none(vstream.get("bit_rate")) if vstream else None
    a_bitrate = _int_or_none(astream.get("bit_rate")) if astream else None

    # Many containers only report a container-level bitrate; derive video's share.
    if v_bitrate is None and fmt_bitrate:
        v_bitrate = max(0, fmt_bitrate - (a_bitrate or 0))

    duration = float(fmt.get("duration") or (vstream or {}).get("duration") or 0.0)

    avg_fps = _frac((vstream or {}).get("avg_frame_rate"))
    base_fps = _frac((vstream or {}).get("r_frame_rate"))
    # A source is treated as CFR when avg and base frame rates agree.
    is_cfr = bool(avg_fps and base_fps and abs(avg_fps - base_fps) < 0.05)

    side_data = (vstream or {}).get("side_data_list") or []
    rotation = 0
    has_display_matrix = False
    for sd in side_data:
        if sd.get("side_data_type") == "Display Matrix":
            has_display_matrix = True
        if "rotation" in sd:
            rotation = int(sd["rotation"])

    return {
        "path": os.path.abspath(path),
        "name": os.path.basename(path),
        "size_bytes": _int_or_none(fmt.get("size")) or 0,
        "container": (fmt.get("format_name") or "").split(",")[0],
        "ext": os.path.splitext(path)[1].lower(),
        "duration": duration,
        "start_time": _float_or_none(fmt.get("start_time")),
        "bitrate_bps": fmt_bitrate or 0,
        "video": {
            "codec": (vstream or {}).get("codec_name"),
            "start_time": _float_or_none((vstream or {}).get("start_time")),
            "profile": (vstream or {}).get("profile"),
            "width": _int_or_none((vstream or {}).get("width")),
            "height": _int_or_none((vstream or {}).get("height")),
            "pix_fmt": (vstream or {}).get("pix_fmt"),
            "fps": round(avg_fps or base_fps, 4),
            "avg_fps": round(avg_fps, 4),
            "base_fps": round(base_fps, 4),
            "is_cfr": is_cfr,
            "bitrate_bps": v_bitrate or 0,
            "color_range": (vstream or {}).get("color_range"),
            "color_space": (vstream or {}).get("color_space"),
            "color_primaries": (vstream or {}).get("color_primaries"),
            "color_transfer": (vstream or {}).get("color_transfer"),
            "rotation": rotation,
            "has_display_matrix": has_display_matrix,
            "nb_frames": _int_or_none((vstream or {}).get("nb_frames")),
        } if vstream else None,
        "audio": {
            "codec": (astream or {}).get("codec_name"),
            "start_time": _float_or_none((astream or {}).get("start_time")),
            "sample_rate": _int_or_none((astream or {}).get("sample_rate")),
            "channels": _int_or_none((astream or {}).get("channels")),
            "channel_layout": (astream or {}).get("channel_layout"),
            "bitrate_bps": a_bitrate or 0,
        } if astream else None,
    }


def _int_or_none(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _float_or_none(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Encoder capability
# ---------------------------------------------------------------------------

_ENCODER_CACHE: set[str] | None = None


def available_encoders() -> set[str]:
    """Names of every video encoder this ffmpeg build exposes."""
    global _ENCODER_CACHE
    if _ENCODER_CACHE is None:
        out = run(["ffmpeg", "-hide_banner", "-encoders"]).stdout
        names = set()
        started = False
        for line in out.splitlines():
            if line.strip().startswith("------"):
                started = True
                continue
            if started:
                parts = line.split()
                if len(parts) >= 2:
                    names.add(parts[1])
        _ENCODER_CACHE = names
    return _ENCODER_CACHE


def hwaccel_options() -> list[str]:
    out = run(["ffmpeg", "-hide_banner", "-hwaccels"]).stdout
    opts = [ln.strip() for ln in out.splitlines()[1:] if ln.strip()]
    return ["auto", "none"] + opts


def encoder_candidates(source_codec: str | None) -> list[dict]:
    """Encoders that reproduce `source_codec`, best (GPU) first."""
    avail = available_encoders()
    table = {
        "h264": ["h264_amf", "h264_nvenc", "h264_qsv", "h264_videotoolbox", "libx264"],
        "hevc": ["hevc_amf", "hevc_nvenc", "hevc_qsv", "hevc_videotoolbox", "libx265"],
        "h265": ["hevc_amf", "hevc_nvenc", "hevc_qsv", "hevc_videotoolbox", "libx265"],
        "vp9": ["libvpx-vp9", "libx264"],
        "av1": ["av1_amf", "av1_nvenc", "av1_qsv", "libsvtav1", "libx264"],
        "mpeg4": ["mpeg4", "libx264"],
    }
    prefs = table.get((source_codec or "").lower(), ["libx264", "libx265"])
    out = []
    for name in prefs:
        if name in avail:
            out.append({
                "name": name,
                "hw": name.endswith(("_amf", "_nvenc", "_qsv", "_videotoolbox")),
                "matches_source": name.split("_")[0].replace("lib", "") in
                                  ((source_codec or "").lower(), "x264", "x265"),
            })
    return out


def default_encoder(source_codec: str | None) -> str:
    cands = encoder_candidates(source_codec)
    return cands[0]["name"] if cands else "libx264"


# ---------------------------------------------------------------------------
# "Same as source" encode profile
# ---------------------------------------------------------------------------

# Container -> (video encoder family filter, audio codec, extra muxer flags)
CONTAINER_PROFILE = {
    ".mp4": {"audio": "aac", "flags": ["-movflags", "+faststart"]},
    ".mov": {"audio": "aac", "flags": ["-movflags", "+faststart"]},
    ".m4v": {"audio": "aac", "flags": ["-movflags", "+faststart"]},
    ".mkv": {"audio": "aac", "flags": []},
    ".webm": {"audio": "libopus", "flags": []},
    ".avi": {"audio": "libmp3lame", "flags": []},
    ".ts": {"audio": "aac", "flags": []},
    ".mts": {"audio": "aac", "flags": []},
    ".m2ts": {"audio": "aac", "flags": []},
    ".mpg": {"audio": "mp2", "flags": []},
    ".mpeg": {"audio": "mp2", "flags": []},
    ".vob": {"audio": "mp2", "flags": []},
    ".flv": {"audio": "libmp3lame", "flags": []},
    ".wmv": {"audio": "wmav2", "flags": []},
    ".3gp": {"audio": "aac", "flags": ["-movflags", "+faststart"]},
}

PRESET_TRANSLATION = {
    "h264_nvenc": {"ultrafast": "p1", "superfast": "p1", "veryfast": "p2",
                   "faster": "p3", "fast": "fast", "medium": "medium",
                   "slow": "slow", "slower": "p6", "veryslow": "p7", "placebo": "p7"},
    "hevc_nvenc": {"ultrafast": "p1", "superfast": "p1", "veryfast": "p2",
                   "faster": "p3", "fast": "fast", "medium": "medium",
                   "slow": "slow", "slower": "p6", "veryslow": "p7", "placebo": "p7"},
    "h264_amf": {"ultrafast": "speed", "superfast": "speed", "veryfast": "speed",
                 "faster": "speed", "fast": "speed", "medium": "balanced",
                 "slow": "quality", "slower": "quality", "veryslow": "quality",
                 "placebo": "quality"},
    "hevc_amf": {"ultrafast": "speed", "superfast": "speed", "veryfast": "speed",
                 "faster": "speed", "fast": "speed", "medium": "balanced",
                 "slow": "quality", "slower": "quality", "veryslow": "quality",
                 "placebo": "quality"},
    "av1_amf": {"ultrafast": "speed", "superfast": "speed", "veryfast": "speed",
                "faster": "speed", "fast": "speed", "medium": "balanced",
                "slow": "quality", "slower": "quality", "veryslow": "quality",
                "placebo": "quality"},
}


def resolve_preset(codec: str, preset: str) -> str:
    table = PRESET_TRANSLATION.get(codec)
    return table.get(preset, preset) if table else preset


def source_match_profile(info: dict, out_ext: str | None = None) -> dict:
    """The 'keep it identical' export profile, derived from the probe."""
    ext = (out_ext or info.get("ext") or ".mp4").lower()
    if ext not in CONTAINER_PROFILE:
        ext = ".mp4"
    v = info.get("video") or {}
    a = info.get("audio") or {}

    codec = default_encoder(v.get("codec"))
    # AMF/NVENC only make sense with a matching codec family; libx264 is the floor.
    v_bitrate = v.get("bitrate_bps") or 0
    if not v_bitrate:
        h = v.get("height") or 1080
        v_bitrate = int((35 if h >= 2000 else 20 if h >= 1300 else 12) * 1_000_000)

    a_codec = CONTAINER_PROFILE[ext]["audio"]
    src_a_codec = (a.get("codec") or "").lower()
    if src_a_codec in ("mp3",) and "libmp3lame" in available_encoders():
        a_codec = "libmp3lame"
    elif src_a_codec == "opus" and "libopus" in available_encoders():
        a_codec = "libopus"

    return {
        "out_ext": ext,
        "codec": codec,
        "preset": "medium",
        "quality_mode": "bitrate",       # bitrate | crf | cq
        "video_bitrate_kbps": round(v_bitrate / 1000),
        "crf": 18,
        "maxrate_factor": 1.5,
        "pix_fmt": v.get("pix_fmt") or "yuv420p",
        "match_fps": bool(v.get("is_cfr")) and bool(v.get("fps")),
        "fps": v.get("fps") or 0,
        "match_color": True,
        "color_space": v.get("color_space"),
        "color_primaries": v.get("color_primaries"),
        "color_transfer": v.get("color_transfer"),
        "color_range": v.get("color_range"),
        "audio_codec": a_codec if a else "none",
        "audio_bitrate_kbps": round((a.get("bitrate_bps") or 192_000) / 1000),
        "audio_sample_rate": a.get("sample_rate") or 0,
        "audio_channels": a.get("channels") or 0,
        "hwaccel": "auto",
        "copy_metadata": True,
        "mux_flags": CONTAINER_PROFILE[ext]["flags"],
        "gop": 0,
        "encoder_choices": [c["name"] for c in encoder_candidates(v.get("codec"))],
    }
