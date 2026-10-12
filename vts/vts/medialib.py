"""Media bin: the library of imported video / audio / image assets.

Premiere-style "Project" panel. Assets are **referenced in place** - the bin
remembers the path on disk and never copies gigabytes into the work folder -
except for files the user *uploads* through the browser, which have to land
somewhere and go into ``work/bin``.

    kind    "video" (picture + optional sound), "audio" (sound only) or
            "image" (one still frame, given IMAGE_DEFAULT_DURATION on drop)

Every asset is probed with ffprobe once, gets a poster thumbnail and - when a
browser cannot decode it - its own H.264/AAC preview proxy, exactly like the
main source (see :mod:`vts.preview`). The editor's timeline references assets
by id; the special id :data:`MAIN_ID` is always the video the project was
opened with, so timelines saved before the bin existed keep working.
"""

from __future__ import annotations

import os
import shutil
import threading
import uuid

from . import preview as preview_mod
from .ffprobe import VIDEO_EXTS, probe, run
from .media import waveform_peaks

#: Id of the asset that is the project's main video.
MAIN_ID = "src"

IMAGE_EXTS = {
    ".png", ".jpg", ".jpeg", ".jpe", ".bmp", ".gif", ".webp",
    ".tif", ".tiff", ".svg", ".avif", ".ppm", ".pgm",
}
AUDIO_EXTS = {
    ".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg", ".oga", ".opus",
    ".aiff", ".aif", ".wma", ".ac3", ".dts", ".mka", ".amr", ".caf",
}

#: How long a still image lasts when it is dropped on the timeline.
IMAGE_DEFAULT_DURATION = 5.0
#: Longest single media clip the bin will create from a still image.
IMAGE_MAX_DURATION = 600.0

MAX_ASSETS = 64
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024      # 2 GB, matches the app's limits
MAX_NAME = 120


class MediaError(ValueError):
    """The asset cannot be imported (400 to the client)."""


def kind_of_ext(path: str) -> str | None:
    ext = os.path.splitext(path)[1].lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in AUDIO_EXTS:
        return "audio"
    if ext in VIDEO_EXTS:
        return "video"
    return None


def kind_of_info(info: dict) -> str:
    if info.get("video") and not info.get("audio"):
        return "video"
    if info.get("video"):
        return "video"
    if info.get("audio"):
        return "audio"
    return "unknown"


def _safe_name(name: str) -> str:
    cleaned = "".join(ch for ch in os.path.basename(name or "")
                      if ch not in '<>:"/\\|?*').strip()
    return (cleaned or "media")[:MAX_NAME]


class MediaLibrary:
    """The bin for one project: imported media, thumbnails and proxies."""

    def __init__(self, work_dir: str):
        self.work_dir = str(work_dir)
        self.assets: dict[str, dict] = {}
        self.order: list[str] = []
        self.thumbs_dir = os.path.join(self.work_dir, "binthumbs")
        self.upload_dir = os.path.join(self.work_dir, "bin")
        self._proxies: dict[str, preview_mod.PreviewProxy] = {}
        self._peaks: dict[str, list[int]] = {}
        self._lock = threading.RLock()
        os.makedirs(self.thumbs_dir, exist_ok=True)
        os.makedirs(self.upload_dir, exist_ok=True)

    # ------------------------------------------------------------------ CRUD

    def has(self, asset_id: str) -> bool:
        return asset_id in self.assets

    def get(self, asset_id: str) -> dict | None:
        return self.assets.get(asset_id)

    def list(self) -> list[dict]:
        with self._lock:
            return [self._public(a) for a in
                    (self.assets[i] for i in self.order if i in self.assets)]

    def _public(self, asset: dict) -> dict:
        proxy = self._proxies.get(asset["id"])
        state = proxy.to_dict() if proxy else None
        return {
            **{k: asset[k] for k in (
                "id", "name", "kind", "duration", "has_video", "has_audio",
                "width", "height", "fps", "codec", "audio_codec",
                "sample_rate", "channels", "size_bytes", "main", "uploaded",
            )},
            "ready": bool(state and state["ready"]),
            "preview": state or {"state": "none", "ready": False, "progress": 0},
            "thumb": f"/api/bin/{asset['id']}/thumb" if asset["kind"] != "audio" else "",
        }

    def clear(self) -> None:
        with self._lock:
            self.assets.clear()
            self.order.clear()
            self._proxies.clear()
            self._peaks.clear()

    # ---------------------------------------------------------------- import

    def add_path(self, path: str, name: str | None = None,
                 main: bool = False, asset_id: str | None = None) -> dict:
        """Register a file on disk. Re-importing the same path is a no-op."""
        full = os.path.abspath(os.path.expanduser(path))
        if not os.path.isfile(full):
            raise MediaError(f"File not found: {path}")
        with self._lock:
            for existing in self.assets.values():
                if os.path.normcase(existing["path"]) == os.path.normcase(full):
                    if main and not existing["main"]:
                        existing["main"] = True
                    return existing
            if len(self.assets) >= MAX_ASSETS:
                raise MediaError(f"The bin holds at most {MAX_ASSETS} assets.")

        try:
            info = probe(full)
        except FileNotFoundError:
            raise MediaError(f"File not found: {path}")
        except Exception as exc:                     # ffprobe failed / bad file
            raise MediaError(f"Could not read {os.path.basename(full)}: {exc}")

        kind = kind_of_ext(full) or kind_of_info(info)
        if kind == "unknown":
            raise MediaError(f"{os.path.basename(full)} has no video or audio stream.")
        if kind == "image" and not info.get("video"):
            # ffprobe reports PNG/JPG as a video stream; SVG does not decode.
            raise MediaError(f"{os.path.basename(full)} could not be decoded as an image.")

        vinfo = info.get("video") or {}
        ainfo = info.get("audio") or {}
        duration = float(info.get("duration") or 0.0)
        if kind == "image":
            duration = IMAGE_DEFAULT_DURATION
        mode, reason = preview_mod.browser_support(info)

        asset = {
            "id": asset_id or f"a{uuid.uuid4().hex[:10]}",
            "name": _safe_name(name or info.get("name") or os.path.basename(full)),
            "path": full,
            "kind": kind,
            "duration": max(0.0, duration),
            "has_video": kind in ("video", "image"),
            "has_audio": bool(ainfo) and kind != "image",
            "width": int(vinfo.get("width") or 0),
            "height": int(vinfo.get("height") or 0),
            "fps": float(vinfo.get("fps") or 0),
            "codec": vinfo.get("codec"),
            "audio_codec": ainfo.get("codec"),
            "sample_rate": int(ainfo.get("sample_rate") or 48000),
            "channels": int(ainfo.get("channels") or 2),
            "size_bytes": int(info.get("size_bytes") or 0),
            "main": bool(main),
            "uploaded": False,
            "info": info,
            "preview_mode": mode,
            "preview_reason": reason,
        }
        with self._lock:
            self.assets[asset["id"]] = asset
            if asset["id"] not in self.order:
                self.order.append(asset["id"])
        self._make_thumb(asset)
        # The main video's preview proxy is owned by the Project (see
        # server.Project.start_preview); building a second one here would make
        # the two transcodes race over the same output file.
        if mode == "proxy" and not main:
            self.proxy(asset["id"]).start(reason)
        return asset

    def add_upload(self, data: bytes, filename: str) -> dict:
        """Store an uploaded file in the work folder, then reference it."""
        name = _safe_name(filename)
        ext = os.path.splitext(name)[1].lower()
        if not ext:
            raise MediaError("The uploaded file has no extension.")
        if kind_of_ext(name) is None:
            raise MediaError(f"Unsupported media type '{ext}'.")
        if len(data) > MAX_UPLOAD_BYTES:
            raise MediaError("That file is larger than 2 GB.")
        os.makedirs(self.upload_dir, exist_ok=True)
        stem = os.path.splitext(name)[0][:60] or "media"
        dest = os.path.join(self.upload_dir, f"{stem}_{uuid.uuid4().hex[:8]}{ext}")
        with open(dest, "wb") as fh:
            fh.write(data)
        try:
            return self.add_path(dest, name=name)
        except MediaError:
            try:
                os.remove(dest)
            except OSError:
                pass
            raise

    def remove(self, asset_id: str) -> None:
        with self._lock:
            asset = self.assets.pop(asset_id, None)
            self.order = [i for i in self.order if i != asset_id]
            self._proxies.pop(asset_id, None)
            self._peaks.pop(asset_id, None)
        if not asset:
            raise MediaError("That asset is not in the bin.")
        if asset.get("uploaded"):
            try:
                os.remove(asset["path"])
            except OSError:
                pass

    # -------------------------------------------------------------- serving

    def path_of(self, asset_id: str) -> str:
        asset = self.assets.get(asset_id)
        if not asset:
            raise MediaError(f"Unknown media asset '{asset_id}'.")
        return asset["path"]

    def proxy(self, asset_id: str) -> preview_mod.PreviewProxy:
        with self._lock:
            proxy = self._proxies.get(asset_id)
            if proxy is None:
                asset = self.assets.get(asset_id)
                if not asset:
                    raise MediaError(f"Unknown media asset '{asset_id}'.")
                proxy = preview_mod.PreviewProxy(
                    asset["path"], self.work_dir, asset["duration"])
                self._proxies[asset_id] = proxy
            return proxy

    def proxy_status(self, asset_id: str) -> dict:
        proxy = self._proxies.get(asset_id)
        return proxy.to_dict() if proxy else {"state": "none", "ready": False,
                                              "progress": 0.0}

    def serve_path(self, asset_id: str) -> str:
        """The file to hand to a <video>/<audio> tag: proxy when there is one."""
        proxy = self._proxies.get(asset_id)
        served = proxy.serve_path() if proxy else None
        return served or self.path_of(asset_id)

    # ---------------------------------------------------------- decorations

    def thumb_path(self, asset_id: str) -> str | None:
        asset = self.assets.get(asset_id)
        if not asset or asset["kind"] == "audio":
            return None
        path = os.path.join(self.thumbs_dir, f"{asset['id']}.jpg")
        return path if os.path.isfile(path) else None

    def _make_thumb(self, asset: dict) -> None:
        if asset["kind"] == "audio":
            return
        os.makedirs(self.thumbs_dir, exist_ok=True)
        dest = os.path.join(self.thumbs_dir, f"{asset['id']}.jpg")
        src = asset["path"]
        if asset["kind"] == "image":
            cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                   "-i", src, "-vf", "scale=320:-2", "-frames:v", "1",
                   "-q:v", "5", dest]
        else:
            seek = min(max(0.0, asset["duration"] * 0.1), 2.0)
            cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                   "-ss", f"{seek:.3f}", "-i", src,
                   "-vf", "scale=320:-2", "-frames:v", "1", "-q:v", "5", dest]
        try:
            run(cmd, timeout=60)
        except Exception:
            # Cosmetic only: the bin shows a placeholder tile instead.
            if os.path.isfile(dest):
                try:
                    os.remove(dest)
                except OSError:
                    pass

    def peaks(self, asset_id: str, buckets: int = 1200) -> list[int]:
        asset = self.assets.get(asset_id)
        if not asset or not asset["has_audio"]:
            return []
        with self._lock:
            cached = self._peaks.get(asset_id)
        if cached and len(cached) == buckets:
            return cached
        computed = waveform_peaks(asset["path"], buckets=buckets)
        with self._lock:
            self._peaks[asset_id] = computed
        return computed

    def filmstrip(self, asset_id: str, count: int = 40) -> dict:
        """Thumbnails for an asset's own filmstrip (unused for the main video)."""
        asset = self.assets.get(asset_id)
        if not asset or asset["kind"] == "audio":
            return {"interval": 0, "count": 0, "files": []}
        return {"interval": max(0.5, asset["duration"] / count), "count": count,
                "asset": asset_id}
