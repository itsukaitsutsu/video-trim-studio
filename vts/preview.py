"""Browser preview support.

`<video>` only plays a handful of container/codec combinations. Everything
else - AVI, MPEG-TS, WMV, FLV, DivX, HEVC without a hardware decoder, AC3 or
DTS audio - loads over HTTP perfectly and *still* shows a black box, because
the browser refuses to demux or decode it. The server did nothing wrong, so
the failure looks like a blank preview with no error anywhere.

For those sources we build a small H.264/AAC MP4 "preview proxy" with ffmpeg
and point the player at that instead. The proxy is for on-screen scrubbing
only: detection and export always run against the original file.
"""

from __future__ import annotations

import os
import re
import subprocess
import threading
from collections import deque
from pathlib import Path

from .ffprobe import available_encoders

# Containers browsers can demux.
WEB_CONTAINERS = {".mp4", ".m4v", ".mov", ".webm"}

# Video codecs browsers can decode. HEVC/AV1 depend on the OS and hardware, so
# they are reported as "probably" and the frontend falls back if they fail.
WEB_VIDEO_CODECS = {"h264", "vp8", "vp9", "av1"}
WEB_VIDEO_CODECS_UNCERTAIN = {"hevc", "h265"}

# Audio codecs browsers can decode.
WEB_AUDIO_CODECS = {"aac", "mp3", "opus", "vorbis", "flac"}

# Prefer a supported hardware H.264 encoder, but always retain a CPU fallback.
# Encoder availability alone does not guarantee that a usable driver/device is
# present, so PreviewProxy tries the next encoder if initialization fails.
PREVIEW_ENCODER_ORDER = (
    "h264_amf",            # AMD
    "h264_nvenc",          # NVIDIA
    "h264_qsv",            # Intel Quick Sync
    "h264_videotoolbox",   # macOS
    "libx264",             # portable CPU fallback
)
PREVIEW_MAX_WIDTH = 1280

MIME_BY_EXT = {
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
    ".mkv": "video/x-matroska", ".webm": "video/webm", ".avi": "video/x-msvideo",
    ".ts": "video/mp2t", ".mts": "video/mp2t", ".m2ts": "video/mp2t",
    ".mpg": "video/mpeg", ".mpeg": "video/mpeg", ".vob": "video/dvd",
    ".flv": "video/x-flv", ".wmv": "video/x-ms-wmv", ".3gp": "video/3gpp",
}


def mime_for(path: str) -> str:
    """Content-Type for `path`, from its extension."""
    return MIME_BY_EXT.get(Path(path).suffix.lower(), "application/octet-stream")


def browser_support(info: dict) -> tuple[str, str]:
    """Classify a probe as ``("direct"|"proxy"|"uncertain", reason)``.

    ``direct``     - the browser will play the original file.
    ``proxy``      - the browser certainly cannot; a transcode is required.
    ``uncertain``  - probably plays (HEVC/AV1), but needs a hardware decoder.
                     Serve the original first and let the frontend fall back.
    """
    ext = (info.get("ext") or "").lower()
    v = info.get("video") or {}
    a = info.get("audio") or {}
    vcodec = (v.get("codec") or "").lower()
    acodec = (a.get("codec") or "").lower()

    if ext not in WEB_CONTAINERS:
        return "proxy", f"browsers cannot play the {ext or 'unknown'} container"
    if vcodec and vcodec not in WEB_VIDEO_CODECS and vcodec not in WEB_VIDEO_CODECS_UNCERTAIN:
        return "proxy", f"browsers cannot decode {vcodec} video"
    if acodec and acodec not in WEB_AUDIO_CODECS:
        return "proxy", f"browsers cannot decode {acodec} audio"
    if vcodec in WEB_VIDEO_CODECS_UNCERTAIN:
        return "uncertain", (f"{vcodec} needs a hardware decoder in the browser; "
                             "a proxy will be built if playback fails")
    return "direct", ""


def proxy_target(src: str, work_dir: str) -> str:
    """Deterministic cache location for `src`'s preview proxy."""
    src_abs = os.path.abspath(src)
    st = os.stat(src_abs)
    tag = f"{int(st.st_mtime)}-{st.st_size}"
    stem = re.sub(r"[^\w.\-]+", "_", Path(src_abs).stem)[:60] or "video"
    return os.path.join(work_dir, "preview", f"{stem}.{tag}.preview.mp4")


def preview_encoder_candidates(encoders: set[str]) -> list[str]:
    """Available H.264 encoders in preference order (hardware, then CPU)."""
    return [name for name in PREVIEW_ENCODER_ORDER if name in encoders]


def preview_encoder_args(encoder: str) -> list[str]:
    """Fast, preview-quality options for each supported H.264 encoder."""
    if encoder == "h264_amf":
        # AMF uses quantizer settings rather than x264's CRF option.
        return ["-c:v", encoder, "-quality", "speed", "-rc", "cqp",
                "-qp_i", "28", "-qp_p", "30"]
    if encoder == "h264_nvenc":
        return ["-c:v", encoder, "-preset", "p1", "-rc", "constqp", "-qp", "28"]
    if encoder == "h264_qsv":
        return ["-c:v", encoder, "-preset", "veryfast", "-global_quality", "28"]
    if encoder == "h264_videotoolbox":
        return ["-c:v", encoder, "-realtime", "1", "-q:v", "65"]
    if encoder == "libx264":
        # This is a disposable proxy, not the final export: favor speed.
        return ["-c:v", encoder, "-preset", "ultrafast", "-crf", "28"]
    raise ValueError(f"Unsupported preview encoder: {encoder}")


class ProxyBuildError(RuntimeError):
    pass


class PreviewProxy:
    """Background ffmpeg transcode of the source into a browser-friendly MP4.

    One build per project; `start()` is idempotent while a build is running.
    A compatible hardware encoder is preferred where available; libx264 is the
    cross-platform fallback. The output is cached so reopening the same source
    is fast.
    """

    def __init__(self, src: str, work_dir: str, duration: float = 0.0):
        self.src = src
        self.work_dir = work_dir
        self.duration = duration or 0.0
        self.dest = proxy_target(src, work_dir)
        self.state = "none"          # none | building | ready | error
        self.progress = 0.0          # 0..1, based on output media time
        self.reason = ""
        self.error = ""
        self.encoder: str | None = None
        self.speed: float | None = None  # output realtime multiplier, e.g. 1.2
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    # -- state ------------------------------------------------------------

    def to_dict(self) -> dict:
        with self._lock:
            return {
                "state": self.state,
                "progress": round(self.progress, 4),
                "reason": self.reason,
                "error": self.error,
                "ready": self.state == "ready",
                "encoder": self.encoder,
                "speed": round(self.speed, 2) if self.speed is not None else None,
            }

    def serve_path(self) -> str | None:
        """The proxy file, but only once it is complete and on disk."""
        with self._lock:
            ready = self.state == "ready"
        return self.dest if ready and os.path.isfile(self.dest) else None

    # -- build ------------------------------------------------------------
    def start(self, reason: str = "", force: bool = False) -> None:
        with self._lock:
            if self.state == "building":
                return
            if self.state == "ready" and not force and os.path.isfile(self.dest):
                return
            self.state = "building"
            self.progress = 0.0
            self.error = ""
            self.encoder = None
            self.speed = None
            self.reason = reason
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def wait(self, timeout: float | None = None) -> bool:
        """Block until the build finishes. Used by tests and the sync API."""
        if self._thread is None:
            return self.state == "ready"
        self._thread.join(timeout)
        return self.state == "ready"

    def _run(self) -> None:
        os.makedirs(os.path.dirname(self.dest), exist_ok=True)
        # Reuse a cache hit from a previous run of the same file.
        if os.path.isfile(self.dest):
            with self._lock:
                self.state, self.progress = "ready", 1.0
            return
        tmp = self.dest + ".part.mp4"
        try:
            self._transcode(tmp)
            os.replace(tmp, self.dest)
        except Exception as exc:                     # noqa: BLE001 - report to UI
            try:
                if os.path.isfile(tmp):
                    os.remove(tmp)
            except OSError:
                pass
            with self._lock:
                self.state = "error"
                self.error = str(exc)[:4000]
            return
        with self._lock:
            self.state, self.progress = "ready", 1.0

    def _transcode(self, tmp: str) -> None:
        encoders = preview_encoder_candidates(available_encoders())
        if not encoders:
            raise ProxyBuildError(
                "This ffmpeg build has no supported H.264 preview encoder. "
                "Install an ffmpeg build with libx264 or a supported hardware encoder.")

        failures: list[str] = []
        for encoder in encoders:
            with self._lock:
                self.encoder = encoder
                self.progress = 0.0
                self.speed = None
            try:
                self._transcode_with_encoder(tmp, encoder)
                return
            except ProxyBuildError as exc:
                failures.append(f"{encoder}: {exc}")
                try:
                    if os.path.isfile(tmp):
                        os.remove(tmp)
                except OSError:
                    pass

        detail = "\n".join(failures)[-3500:]
        raise ProxyBuildError(
            "All available H.264 preview encoders failed. "
            "The app tried hardware encoders first, then the CPU fallback.\n" + detail)

    def _transcode_with_encoder(self, tmp: str, encoder: str) -> None:
        cmd = [
            "ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error",
            "-progress", "pipe:1", "-y",
            "-i", self.src,
            "-map", "0:v:0", "-map", "0:a:0?",
            *preview_encoder_args(encoder),
            "-profile:v", "high", "-pix_fmt", "yuv420p",
            "-vf", f"scale='min({PREVIEW_MAX_WIDTH},iw)':-2",
            "-c:a", "aac", "-b:a", "128k", "-ac", "2",
            "-movflags", "+faststart",
            tmp,
        ]
        try:
            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace",
            )
        except FileNotFoundError as exc:
            raise ProxyBuildError("'ffmpeg' not found on PATH") from exc

        # Drain stderr concurrently. Otherwise a noisy decoder can fill its
        # pipe while we are consuming the progress stream from stdout.
        stderr_tail: deque[str] = deque(maxlen=200)

        def read_stderr() -> None:
            if proc.stderr is None:
                return
            for line in proc.stderr:
                stderr_tail.append(line)

        stderr_thread = threading.Thread(target=read_stderr, daemon=True)
        stderr_thread.start()
        assert proc.stdout is not None
        for line in proc.stdout:
            if line.startswith("out_time_ms=") and self.duration > 0:
                try:
                    secs = int(line.split("=", 1)[1]) / 1_000_000
                except ValueError:
                    continue
                pct = min(1.0, max(0.0, secs / self.duration))
                with self._lock:
                    self.progress = pct
            elif line.startswith("speed="):
                match = re.match(r"\s*([0-9]+(?:\.[0-9]+)?)x", line.split("=", 1)[1])
                if match:
                    with self._lock:
                        self.speed = float(match.group(1))
        proc.wait()
        stderr_thread.join()
        if proc.returncode != 0:
            stderr = "".join(stderr_tail).strip()
            raise ProxyBuildError(
                f"ffmpeg exited with code {proc.returncode}:\n{(stderr or 'no error details')[-3000:]}")
        if not os.path.isfile(tmp) or os.path.getsize(tmp) == 0:
            raise ProxyBuildError("ffmpeg produced an empty preview file")
