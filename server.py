#!/usr/bin/env python3
"""
Video Trim Studio - local web app.

Detects the caption / silence / other sections of a video, lets you tick the
ones you want gone, then exports the clean cut matching the source format
(codec, bitrate, fps, pixel format, colour, audio parameters).

Run:
    python server.py                -> http://127.0.0.1:8765
    python server.py --port 9000 --host 0.0.0.0
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import string
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from vts import captionmap as captionmap_mod
from vts import captions as captions_mod    # noqa: E402
from vts import detect as detect_mod          # noqa: E402
from vts import export as export_mod         # noqa: E402
from vts import timeline as timeline_mod     # noqa: E402
from vts import edl as edl_mod                 # noqa: E402
from vts import media as media_mod           # noqa: E402
from vts import preview as preview_mod       # noqa: E402
from vts import transcribe as caption_mod    # noqa: E402
from vts.ffprobe import (                    # noqa: E402
    VIDEO_EXTS, available_encoders, encoder_candidates, hwaccel_options,
    probe, require_ffmpeg, source_match_profile, FFmpegMissing,
)

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
WORK_DIR = BASE_DIR / "work"
WORK_DIR.mkdir(exist_ok=True)
LAST_PROJECT_FILE = WORK_DIR / "last_project.txt"

app = FastAPI(title="Video Trim Studio", version="1.0.0")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.post("/api/send-to-filmcraft")
async def send_to_filmcraft_api(request: Request):
  data = await request.json()
  video_path = data.get("video_path")
  srt_path = data.get("srt_path")

  if not video_path or not os.path.exists(video_path):
    return JSONResponse(
        status_code=400, content={"ok": False, "error": "Video file not found"}
    )

  try:
    bridge_script = str(BASE_DIR / "send_to_filmcraft.py")
    subprocess.Popen(
        [sys.executable, bridge_script, video_path, srt_path or ""]
    )
    return {"ok": True, "message": "FilmCraft launched successfully!"}
  except Exception as e:
    return JSONResponse(
        status_code=500, content={"ok": False, "error": str(e)}
    )
# ---------------------------------------------------------------------------
# Single active project (this is a local, single-user tool)
# ---------------------------------------------------------------------------

class Project:
    def __init__(self, path: str, info: dict, profile: dict):
        self.info = info
        self.profile = profile
        self.sections: list[dict] = []
        self.cues: list[dict] = []
        self.silences: list[tuple[float, float]] = []
        # Caption timeline store (cues with id/track/style); empty until a
        # detect run seeds it from the subtitle file.
        self.captions: list[dict] = []
        self.caption_path: str | None = None
        # Edit list of the single video (clips + caption lanes); None = untouched.
        self.timeline: dict | None = None
        self.detect_min_section_ms = 120
        self.waveform: list[int] = []
        self.thumbs: dict = {}
        self.uploaded = False
        self.demo_subtitles: str | None = None
        # "direct" (play the source), "proxy" (must transcode) or "uncertain".
        self.preview_mode, self.preview_reason = preview_mod.browser_support(info)
        self.proxy = preview_mod.PreviewProxy(
            self.path, str(WORK_DIR), float(info.get("duration") or 0.0))

    @property
    def path(self) -> str:
        return self.info["path"]

    def start_preview(self, reason: str | None = None) -> None:
        """Kick off the preview transcode for sources browsers cannot play."""
        self.proxy.start(reason or self.preview_reason)

    def preview_file(self) -> str:
        """What `<video>` should be served: the proxy when there is one."""
        return self.proxy.serve_path() or self.path

    def preview_state(self) -> dict:
        state = self.proxy.to_dict()
        state["mode"] = self.preview_mode
        # Once a proxy is ready we serve it, whatever the original mode was.
        if state["ready"]:
            state["mode"] = "proxy"
        state["reason"] = self.preview_reason
        state["serving_proxy"] = bool(self.proxy.serve_path())
        return state

    def to_dict(self) -> dict:
        return {
            "info": self.info,
            "profile": self.profile,
            "preview": self.preview_state(),
            "demo_subtitles": self.demo_subtitles,
            # An .srt/.vtt sitting next to the video is the usual sidecar
            # location; the caption editor can open it with one click.
            "sidecar_subtitles": next(
                (str(p) for ext in (".srt", ".vtt")
                 if (p := Path(self.path).with_suffix(ext)).is_file()),
                None),
            "sections": self.sections,
            "summary": detect_mod.summary(
                [detect_mod.Section(**{k: s[k] for k in ("id", "kind", "start", "end", "text")})
                 for s in self.sections]
            ) if self.sections else None,
            "cues": len(self.cues),
            "silences": len(self.silences),
            "has_waveform": bool(self.waveform),
            "thumbs": {k: v for k, v in self.thumbs.items() if k != "files"},
        }


PROJECT: Project | None = None
PROJECT_LOCK = threading.Lock()


def need_project() -> Project:
    if PROJECT is None:
        raise HTTPException(409, "No video is open yet.")
    return PROJECT


def remembered_project_path() -> str | None:
    """Return the video path last opened successfully, if one was saved."""
    try:
        path = LAST_PROJECT_FILE.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError):
        return None
    return os.path.abspath(os.path.expanduser(path)) if path else None


def remember_project_path(path: str) -> None:
    """Persist the last opened video across local server restarts."""
    try:
        LAST_PROJECT_FILE.write_text(os.path.abspath(path), encoding="utf-8")
    except OSError as exc:
        # Opening the video should still succeed if this small preference file
        # cannot be written (for example, a read-only installation folder).
        print(f"Warning: could not remember last video: {exc}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class OpenRequest(BaseModel):
    path: str


class DetectRequest(BaseModel):
    silence_thresh_db: float = -45.0
    min_silence_ms: int = 800
    min_section_ms: int = 120
    detect_silence: bool = True
    use_cues: bool = True
    subtitles_path: str | None = None
    subtitles_text: str | None = None


class ExportRequest(BaseModel):
    deletions: list[list[float]]
    output: str | None = None
    opts: dict = {}
    subtitles_path: str | None = None
    caption_mode: str = "none"    # none | srt | burn | both
    caption_style: dict = {}      # {x, y, size_pct} from the preview overlay


class CaptionsUpdateRequest(BaseModel):
    cues: list[dict] = []


class SubtitleEditRequest(BaseModel):
    cue_id: str | None = None
    """Inline edit of one caption row in the section list."""
    path: str
    start: float
    end: float
    text: str


class CaptionCuesRequest(BaseModel):
    """Edited cue list: [{'start': s, 'end': s, 'text': str}, ...]."""
    cues: list


class ManualCaptionRequest(BaseModel):
    """An editable caption set without transcription."""
    load: str | None = None            # existing .srt / .vtt to open
    output_dir: str | None = None


class CaptionRequest(BaseModel):
    """Auto-caption options; every field has a working default."""
    engine: str = "faster-whisper"   # faster-whisper (CPU/CUDA) | whispercpp (Vulkan/AMD)
    language: str = "auto"
    model: str = "medium"
    translate_to_english: bool = False
    device: str = "auto"
    compute_type: str = "auto"
    vad: bool = True
    word_timestamps: bool = True
    beam_size: int = 1
    temperature_fallback: bool = False
    normalize_audio: bool = False
    initial_prompt: str | None = None
    keep_audio: bool = False
    burn: bool = False
    caption_style: dict = {}
    output_dir: str | None = None


# ---------------------------------------------------------------------------
# Routes: environment + open
# ---------------------------------------------------------------------------

@app.get("/")
def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/api/env")
def env():
    try:
        require_ffmpeg()
        ok = True
        err = None
        encoders = sorted(available_encoders())
        hwaccels = hwaccel_options()
    except (FFmpegMissing, RuntimeError) as exc:
        ok, err, encoders, hwaccels = False, str(exc), [], []
    return {
        "ffmpeg_ok": ok,
        "error": err,
        "ffmpeg_path": shutil.which("ffmpeg"),
        "python": sys.version.split()[0],
        "encoders": encoders,
        "hwaccels": hwaccels,
        "gpu_encoders": [e for e in encoders
                         if e.endswith(("_amf", "_nvenc", "_qsv", "_videotoolbox"))],
        "work_dir": str(WORK_DIR),
        "caption": caption_mod.format_for_ui(),
    }


# Sentinel `path` value that asks /api/browse for the Windows drive list.
DRIVES_VIEW = "drives:"


def _windows_drives() -> list[str]:
    """Root paths of the drives Windows reports, e.g. ['C:\\\\', 'D:\\\\'].

    Uses the same call Explorer does (GetLogicalDriveStrings), so removable and
    network drives show up when they are ready. Falls back to probing A-Z if
    ctypes is unavailable, and returns [] on POSIX (single root, no drives).
    """
    if os.name != "nt":
        return []
    try:
        import ctypes
        size = 512
        buf = ctypes.create_unicode_buffer(size)
        written = ctypes.windll.kernel32.GetLogicalDriveStringsW(size - 1, buf)
        if written:
            raw = ctypes.wstring_at(ctypes.addressof(buf), written)
            found = [d for d in raw.split("\x00") if d]
            if found:
                return found
    except Exception:                       # noqa: BLE001 - fall back to probing
        pass
    return [f"{c}:\\" for c in string.ascii_uppercase if os.path.exists(f"{c}:\\")]


@app.get("/api/browse")
def browse(path: str | None = None, exts_only: bool = False):
    """Tiny local directory browser so the user can pick a file by clicking."""
    drives = _windows_drives()

    # Windows has no single root - every drive is its own tree, and
    # Path("C:\\").parent is C:\\ itself. Without a virtual level above the
    # drive roots the browser can never leave C:, so offer one.
    if path == DRIVES_VIEW:
        if not drives:
            raise HTTPException(404, "This platform has a single root, "
                                     "so there is no drive list.")
        return {"cwd": "This PC", "parent": None, "drives": drives,
                "dirs": [], "files": []}

    target = Path(path).expanduser() if path else Path.home()
    if not target.exists():
        raise HTTPException(404, f"Not found: {target}")
    if target.is_file():
        target = target.parent

    try:
        entries = sorted(target.iterdir(), key=lambda p: p.name.lower())
    except PermissionError:
        raise HTTPException(403, f"Permission denied: {target}")

    dirs, files = [], []
    for entry in entries:
        # Hidden files, plus the Windows system folders that sit at a drive
        # root and are pure noise (and often refuse to be stat'd).
        if entry.name.startswith((".", "$")) or entry.name == "System Volume Information":
            continue
        try:
            is_dir = entry.is_dir()
            size = 0 if is_dir else entry.stat().st_size
        except OSError:
            continue        # locked / reparse point: skip, don't fail the listing
        if is_dir:
            dirs.append({"name": entry.name, "path": str(entry)})
        elif not exts_only or entry.suffix.lower() in VIDEO_EXTS:
            files.append({"name": entry.name, "path": str(entry), "size": size})

    if target.parent != target:
        parent = str(target.parent)
    elif drives:
        parent = DRIVES_VIEW        # at a drive root: "up" means the drive list
    else:
        parent = None               # POSIX: / is genuinely the top

    return {"cwd": str(target), "parent": parent, "drives": drives,
            "dirs": dirs, "files": files}


@app.post("/api/demo")
def open_demo():
    """Open the bundled 18-second demo clip; useful for a first run."""
    sample = BASE_DIR / "demo" / "sample.mp4"
    subs = BASE_DIR / "demo" / "sample.srt"
    if not sample.is_file():
        raise HTTPException(404, "Bundled demo clip is missing.")
    result = open_video(OpenRequest(path=str(sample)))
    assert PROJECT is not None
    PROJECT.demo_subtitles = str(subs)
    result["demo_subtitles"] = str(subs)
    return result


@app.post("/api/demo/speech")
def open_speech_demo():
    """The bundled clip that actually contains speech.

    The main demo has only tones and silences, so it is the wrong file to try
    auto-captioning on; this one is made for that (and has no captions yet).
    """
    sample = BASE_DIR / "demo" / "sample-speech.mp4"
    if not sample.is_file():
        raise HTTPException(404, "Bundled speech clip is missing.")
    return open_video(OpenRequest(path=str(sample)))


def open_project(info: dict, uploaded: bool = False) -> Project:
    """Install `info` as the active project and start any preview transcode."""
    global PROJECT
    with PROJECT_LOCK:
        proj = Project(info["path"], info, source_match_profile(info))
        proj.uploaded = uploaded
        PROJECT = proj
    remember_project_path(proj.path)
    if proj.preview_mode == "proxy":
        proj.start_preview()
    return proj


@app.post("/api/open")
def open_video(req: OpenRequest):
    path = os.path.abspath(os.path.expanduser(req.path.strip().strip('"')))
    if not os.path.isfile(path):
        raise HTTPException(404, f"File not found: {path}")
    try:
        require_ffmpeg()
        info = probe(path)
    except (FFmpegMissing, RuntimeError, FileNotFoundError) as exc:
        raise HTTPException(400, str(exc))
    if not info.get("video"):
        raise HTTPException(400, "That file has no video stream.")
    return open_project(info).to_dict()


@app.post("/api/upload")
async def upload_video(file: UploadFile = File(...)):
    """Drag-and-drop fallback: copy the file into ./work and open it."""
    safe = re.sub(r"[^\w.\- ]+", "_", file.filename or "video.mp4")
    dest = WORK_DIR / safe
    with open(dest, "wb") as fh:
        while chunk := await file.read(1024 * 1024):
            fh.write(chunk)
    try:
        require_ffmpeg()
        info = probe(str(dest))
    except (FFmpegMissing, RuntimeError, FileNotFoundError) as exc:
        raise HTTPException(400, str(exc))
    if not info.get("video"):
        raise HTTPException(400, "That file has no video stream.")
    return open_project(info, uploaded=True).to_dict()


# ---------------------------------------------------------------------------
# Routes: detection
# ---------------------------------------------------------------------------

@app.post("/api/detect")
def detect(req: DetectRequest):
    proj = need_project()
    duration = float(proj.info["duration"])

    cues: list[dict] = []
    if req.use_cues:
        text = req.subtitles_text
        if not text and req.subtitles_path:
            sp = os.path.abspath(os.path.expanduser(req.subtitles_path))
            if not os.path.isfile(sp):
                raise HTTPException(404, f"Subtitle file not found: {sp}")
            text = Path(sp).read_text(encoding="utf-8-sig", errors="replace")
        if text:
            cues = detect_mod.parse_subtitles(text)

    silences: list[tuple[float, float]] = []
    if req.detect_silence:
        if not proj.info.get("audio"):
            raise HTTPException(400, "This video has no audio track, so silence "
                                     "cannot be detected. Untick 'Detect silence' "
                                     "and use captions only.")
        try:
            silences = detect_mod.detect_silences(
                proj.path, req.silence_thresh_db, req.min_silence_ms, duration)
        except RuntimeError as exc:
            raise HTTPException(500, str(exc))

    sections = detect_mod.build_sections(
        duration, silences, cues, req.min_section_ms)

    proj.sections = [s.to_dict() for s in sections]
    proj.cues = cues
    proj.silences = silences
    proj.detect_min_section_ms = int(req.min_section_ms)
    proj.captions = captions_mod.from_parsed(cues)
    proj.caption_path = (os.path.abspath(os.path.expanduser(req.subtitles_path))
                         if req.subtitles_path else None)
    return {
        "captions": proj.captions,
        "sections": proj.sections,
        "summary": detect_mod.summary(sections),
        "silence_count": len(silences),
        "cue_count": len(cues),
        "settings": req.model_dump() if hasattr(req, "model_dump") else req.dict(),
    }


@app.post("/api/parse-subtitles")
async def parse_subtitles(file: UploadFile = File(...)):
    raw = await file.read()
    text = raw.decode("utf-8-sig", errors="replace")
    cues = detect_mod.parse_subtitles(text)
    if not cues:
        raise HTTPException(400, "No cues found - is this an .srt or .vtt file?")
    # Persist the upload into ./work so imported captions have a real file on
    # disk. Inline edits and caption exports save back into this file; without
    # it the imported captions would be read-only.
    name = re.sub(r"[^\w.\- ]+", "_", file.filename or "subtitles.srt")
    ext = os.path.splitext(name)[1].lower()
    if ext not in (".srt", ".vtt"):
        name = os.path.splitext(name)[0] + ".srt"
    dest = WORK_DIR / f"imported_{name}"
    dest.write_bytes(raw)
    return {"cues": cues, "count": len(cues),
            "first": cues[0], "last": cues[-1],
            "saved_path": str(dest)}


# ---------------------------------------------------------------------------
# Routes: timeline assets
# ---------------------------------------------------------------------------

@app.post("/api/waveform")
def waveform(buckets: int = 2400):
    proj = need_project()
    if not proj.info.get("audio"):
        return {"peaks": [], "note": "no audio stream"}
    proj.waveform = media_mod.waveform_peaks(proj.path, buckets=buckets)
    return {"peaks": proj.waveform, "count": len(proj.waveform)}


@app.post("/api/thumbnails")
def thumbnails(count: int = 60):
    proj = need_project()
    out_dir = WORK_DIR / "thumbs"
    proj.thumbs = media_mod.make_thumbnails(proj.path, str(out_dir), count=count)
    return {k: v for k, v in proj.thumbs.items() if k != "files"}


@app.get("/api/thumbnail/{name}")
def thumbnail(name: str):
    if not re.fullmatch(r"thumb_\d{4}\.jpg", name):
        raise HTTPException(400, "Bad thumbnail name")
    path = WORK_DIR / "thumbs" / name
    if not path.is_file():
        raise HTTPException(404, "Thumbnail not generated yet")
    return FileResponse(str(path), media_type="image/jpeg")


def _parse_byte_range(header: str, size: int) -> tuple[int, int] | None:
    """Parse a single byte-range spec against a file of `size` bytes.

    Returns inclusive (start, end), or None when the header is unusable or
    unsatisfiable. Handles the forms browsers actually send: ``bytes=0-``,
    ``bytes=100-200`` and the suffix form ``bytes=-500`` (the last 500 bytes).
    The range unit is case-insensitive per RFC 9110, and a multi-range list is
    reduced to its first range, which is all a media element needs.
    """
    if not header or size is None or size <= 0:
        return None
    m = re.match(r"\s*bytes\s*=\s*([^,]+)", header, re.IGNORECASE)
    if not m:
        return None
    spec = m.group(1).strip()
    try:
        if spec.startswith("-"):                      # suffix range
            last = int(spec[1:].strip())
            if last <= 0:
                return None
            return (max(0, size - last), size - 1)
        first, _, rest = spec.partition("-")
        start = int(first.strip())
        end = size - 1 if not rest.strip() else min(int(rest.strip()), size - 1)
    except ValueError:
        return None
    if start >= size or start > end:
        return None
    return (start, end)


@app.get("/api/media")
def media(request: Request):
    """The playable source, with HTTP Range support so <video> can seek.

    Serves the browser-friendly preview proxy when the source cannot be played
    natively, and always reports the real container's MIME type.
    """
    proj = need_project()
    path = proj.preview_file()
    if not os.path.isfile(path):
        raise HTTPException(404, f"File not found: {path}")
    size = os.path.getsize(path)
    mime = preview_mod.mime_for(path)

    span = _parse_byte_range(request.headers.get("range"), size)
    if span is None:
        if request.headers.get("range"):
            return Response(status_code=416,
                            headers={"Content-Range": f"bytes */{size}"})
        return FileResponse(path, media_type=mime)

    start, end = span
    length = end - start + 1

    def iter_chunks():
        with open(path, "rb") as fh:
            fh.seek(start)
            remaining = length
            while remaining > 0:
                chunk = fh.read(min(1024 * 512, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    return StreamingResponse(
        iter_chunks(),
        status_code=206,
        media_type=mime,
        headers={
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(length),
        },
    )


@app.get("/api/preview-status")
def preview_status():
    """Where the browser-preview transcode has got to."""
    return need_project().preview_state()


@app.post("/api/preview-proxy")
def request_preview_proxy():
    """Build the preview proxy on demand.

    The frontend calls this when a source the server believed was playable
    (HEVC/AV1 on a machine without the matching hardware decoder) still fails
    in the <video> element.
    """
    proj = need_project()
    reason = ("the browser could not decode this file, so a compatible "
              "preview is being generated")
    proj.start_preview(reason)
    return proj.preview_state()


# ---------------------------------------------------------------------------
# Routes: export
# ---------------------------------------------------------------------------

@app.post("/api/preview-plan")
def preview_plan(req: ExportRequest):
    """Dry run: what would be kept / removed, before spending encode time."""
    proj = need_project()
    duration = float(proj.info["duration"])
    dels = [(float(a), float(b)) for a, b in req.deletions if float(b) > float(a)]
    merged = detect_mod._merge([(max(0.0, s), min(duration, e)) for s, e in dels])
    kept = export_mod.kept_segments(duration, merged)
    removed = export_mod.removed_total(merged, duration)
    return {
        "duration": duration,
        "removed": removed,
        "result": round(duration - removed, 3),
        "kept_segments": len(kept),
        "deletions": [[round(s, 3), round(e, 3)] for s, e in merged],
        "warnings": (["More than 200 kept segments makes a very large filter "
                      "graph; raise 'min cut' or select fewer sections."]
                     if len(kept) > 200 else []),
    }


@app.post("/api/export")
def export(req: ExportRequest):
    proj = need_project()
    opts = {**proj.profile, **(req.opts or {})}
    opts.setdefault("mode", "reencode")
    output = req.output or export_mod.default_output_path(proj.path)
    output = os.path.abspath(os.path.expanduser(output))
    if os.path.abspath(output) == os.path.abspath(proj.path):
        raise HTTPException(400, "Output must be a different file from the source.")
    ext = os.path.splitext(output)[1].lower()
    if ext not in VIDEO_EXTS:
        raise HTTPException(400, f"Unsupported output container '{ext}'. "
                                 f"Use one of: {', '.join(sorted(VIDEO_EXTS))}")
    source_ext = proj.info.get("ext", "").lower()
    if ext != source_ext:
        raise HTTPException(400, f"Output container must match the source ({source_ext}) "
                                 "for this source-matching profile. Keep the same extension.")
    if opts.get("mode") == "reencode":
        enc = opts.get("codec")
        if enc and enc not in available_encoders():
            raise HTTPException(400, f"Encoder '{enc}' is not available in this "
                                     f"ffmpeg build. Available GPU encoders: "
                                     f"{encoder_candidates(proj.info['video']['codec'])}")
    dels = [[float(a), float(b)] for a, b in req.deletions if float(b) > float(a)]

    # Captions synced to the trimmed result: remap the cues through the same
    # cut list the exporter uses, write the shifted .srt next to the output,
    # and optionally burn it in.
    caption_mode = (req.caption_mode or "none").lower()
    if caption_mode not in ("none", "srt", "burn", "both"):
        raise HTTPException(400, "caption_mode must be none, srt, burn or both.")
    if caption_mode != "none":
        if not req.subtitles_path:
            raise HTTPException(
                400, "No subtitle file set — pick one in the Detect card first "
                     "(or run Auto-caption).")
        sp = os.path.abspath(os.path.expanduser(str(req.subtitles_path).strip().strip('"')))
        if not os.path.isfile(sp):
            raise HTTPException(404, f"Subtitle file not found: {sp}")
        if not sp.lower().endswith((".srt", ".vtt")):
            raise HTTPException(400, "Captions must come from an .srt or .vtt file.")
        if (proj is not None and proj.captions and proj.caption_path
                and os.path.samefile(sp, proj.caption_path)):
            cues = [dict(c) for c in proj.captions]   # carry per-cue styles
        else:
            cues = detect_mod.parse_subtitles(
                Path(sp).read_text(encoding="utf-8-sig", errors="replace"))
        kept = export_mod.kept_segments(float(proj.info["duration"]), dels)
        remapped = captionmap_mod.remap_cues(cues, kept)
        srt_out = os.path.splitext(output)[0] + ".srt"
        caption_mod.write_srt(remapped, srt_out)
        burn_source = srt_out
        ass_path = None
        if caption_mode in ("burn", "both"):
            style = req.caption_style or {}
            if style and (style.get("x") is not None or style.get("y") is not None
                          or style.get("size_pct") is not None):
                # The user positioned the caption box in the preview: bake that
                # exact layout by burning a positioned ASS instead of the plain
                # .srt (which libass would pin to the bottom edge).
                vinfo = proj.info.get("video") or {}
                dw, dh = media_mod.display_size(vinfo)
                fd, ass_path = tempfile.mkstemp(suffix=".ass", prefix="vts_cap_")
                os.close(fd)
                captionmap_mod.write_ass(
                    remapped, ass_path, dw, dh,
                    style={k: style[k] for k in
                           ("x", "y", "size_pct", "align", "box_w")
                           if k in style})
                burn_source = ass_path
            opts["burn_srt"] = burn_source
            opts["_burn_ass_cleanup"] = ass_path
        opts["_caption_info"] = {
            "mode": caption_mode,
            "source": sp,
            "srt": srt_out,
            "cues_in": len(cues),
            "cues_out": len(remapped),
            "positioned": bool(ass_path),
        }

    try:
        job = export_mod.export(proj.path, proj.info, dels, opts, output)
    except export_mod.JobError as exc:
        raise HTTPException(400, str(exc))
    except (RuntimeError, OSError) as exc:
        raise HTTPException(500, str(exc))
    cap_info = opts.get("_caption_info")
    if cap_info:
        job["captions"] = {k: cap_info[k] for k in
                           ("mode", "source", "srt", "cues_in", "cues_out",
                            "positioned")}
    return job


class TimelinePut(BaseModel):
    clips: list[dict] = []
    caps: list[dict] = []
    lanes: int = 1


class TimelineExportRequest(BaseModel):
    output: str | None = None
    opts: dict | None = None
    caption_mode: str | None = None      # none | srt | burn | both
    caption_style: dict | None = None
    timeline: dict | None = None         # defaults to the saved timeline


@app.get("/api/timeline")
def get_timeline():
    proj = need_project()
    return {"timeline": proj.timeline, "duration": float(proj.info["duration"])}


@app.put("/api/timeline")
def put_timeline(req: TimelinePut):
    proj = need_project()
    try:
        proj.timeline = timeline_mod.normalize(req.model_dump(), float(proj.info["duration"]))
    except timeline_mod.TimelineError as exc:
        raise HTTPException(400, str(exc))
    return {"timeline": proj.timeline}


@app.post("/api/export/timeline")
def export_timeline(req: TimelineExportRequest):
    """Export the edit list: clips in timeline order, black gaps, editor captions."""
    proj = need_project()
    duration = float(proj.info["duration"])
    raw = req.timeline if req.timeline is not None else proj.timeline
    if raw is None:
        raise HTTPException(400, "There is no timeline to export yet. Open a video first.")
    try:
        tl = timeline_mod.normalize(raw, duration)
    except timeline_mod.TimelineError as exc:
        raise HTTPException(400, str(exc))
    if not tl["clips"]:
        raise HTTPException(400, "The timeline has no video clips left to export.")

    opts = {**proj.profile, **(req.opts or {})}
    opts.setdefault("mode", "reencode")
    output = req.output or export_mod.default_output_path(proj.path)
    output = os.path.abspath(os.path.expanduser(output))
    if os.path.abspath(output) == os.path.abspath(proj.path):
        raise HTTPException(400, "Output must be a different file from the source.")
    ext = os.path.splitext(output)[1].lower()
    if ext not in VIDEO_EXTS:
        raise HTTPException(400, f"Unsupported output container '{ext}'. "
                                 f"Use one of: {', '.join(sorted(VIDEO_EXTS))}")
    source_ext = proj.info.get("ext", "").lower()
    if ext != source_ext:
        raise HTTPException(400, f"Output container must match the source ({source_ext}) "
                                 "for this source-matching profile. Keep the same extension.")
    if opts.get("mode") == "reencode":
        enc = opts.get("codec")
        if enc and enc not in available_encoders():
            raise HTTPException(400, f"Encoder '{enc}' is not available in this "
                                     f"ffmpeg build. Available GPU encoders: "
                                     f"{encoder_candidates(proj.info['video']['codec'])}")

    caption_mode = (req.caption_mode or "none").lower()
    if caption_mode not in ("none", "srt", "burn", "both"):
        raise HTTPException(400, "caption_mode must be none, srt, burn or both.")
    cap_info = None
    if caption_mode != "none":
        cues = timeline_mod.export_cues(tl, timeline_mod.video_length(tl))
        srt_out = os.path.splitext(output)[0] + ".srt"
        caption_mod.write_srt(cues, srt_out)
        burned = caption_mode in ("burn", "both") and bool(cues)
        ass_path = None
        if burned:
            style = req.caption_style or {}
            if style and (style.get("x") is not None or style.get("y") is not None
                          or style.get("size_pct") is not None):
                # Bake the box position the user dragged in the preview.
                dw, dh = media_mod.display_size(proj.info.get("video") or {})
                fd, ass_path = tempfile.mkstemp(suffix=".ass", prefix="vts_cap_")
                os.close(fd)
                captionmap_mod.write_ass(
                    cues, ass_path, dw, dh,
                    style={k: style[k] for k in ("x", "y", "size_pct", "align", "box_w")
                           if k in style})
            opts["burn_srt"] = ass_path or srt_out
            opts["_burn_ass_cleanup"] = ass_path
        cap_info = {"mode": caption_mode, "srt": srt_out, "cues": len(cues),
                    "burned": burned, "positioned": bool(ass_path)}

    try:
        job = edl_mod.export_timeline(proj.path, proj.info, tl["clips"], opts, output)
    except export_mod.JobError as exc:
        raise HTTPException(400, str(exc))
    except (RuntimeError, OSError) as exc:
        raise HTTPException(500, str(exc))
    if cap_info:
        job["captions"] = cap_info
    return job


# ---------------------------------------------------------------------------
# Routes: auto-caption (faster-whisper)
# ---------------------------------------------------------------------------

@app.post("/api/caption")
def caption(req: CaptionRequest):
    """Transcribe the open video to .srt/.vtt/.json in the background."""
    proj = need_project()
    if not proj.info.get("audio"):
        raise HTTPException(400, "This video has no audio track to transcribe.")
    opts = req.model_dump() if hasattr(req, "model_dump") else req.dict()
    if opts.get("output_dir"):
        opts["output_dir"] = os.path.abspath(
            os.path.expanduser(str(opts["output_dir"]).strip().strip('"')))
    # Device/compute 'auto' is resolved here so the choices are validated once.
    # (whisper.cpp picks its own backend - Vulkan when built with it - so the
    # CUDA/CPU choices don't apply to it.)
    if opts.get("engine", "faster-whisper") != "whispercpp":
        device, compute = caption_mod.pick_device_and_compute(
            opts.get("device", "auto"), opts.get("compute_type", "auto"))
        opts["device"], opts["compute_type"] = device, compute
    try:
        return caption_mod.start_caption(proj.path, opts)
    except caption_mod.CaptionError as exc:
        raise HTTPException(400, str(exc))


class WhisperCppDownloadRequest(BaseModel):
    model: str


@app.get("/api/whispercpp/status")
def whispercpp_status():
    """whisper-cli binary + GGML model inventory for the caption card."""
    from vts import whispercpp as wcpp
    return wcpp.status()


@app.post("/api/whispercpp/download")
def whispercpp_download(req: WhisperCppDownloadRequest):
    """Download a GGML model (streamed, polled like caption jobs)."""
    from vts import whispercpp as wcpp
    try:
        return wcpp.start_download(req.model)
    except wcpp.CaptionError as exc:
        raise HTTPException(400, str(exc))


@app.get("/api/caption/{job_id}")
def caption_job(job_id: str):
    state = caption_mod.get_job(job_id)
    if state is None:
        raise HTTPException(404, "Unknown caption job")
    return state


@app.post("/api/caption/{job_id}/cancel")
def caption_cancel(job_id: str):
    state = caption_mod.cancel_job(job_id)
    if state is None:
        raise HTTPException(404, "Unknown caption job")
    return state


@app.post("/api/caption/manual")
def caption_manual(req: ManualCaptionRequest):
    """Editable captions without faster-whisper: blank, or from an .srt/.vtt."""
    proj = need_project()
    sidecar = None
    if req.load:
        sidecar = os.path.abspath(
            os.path.expanduser(str(req.load).strip().strip('"')))
        if not os.path.isfile(sidecar):
            raise HTTPException(400, f"Subtitle file not found: {sidecar}")
        if not sidecar.lower().endswith((".srt", ".vtt")):
            raise HTTPException(400, "Open an .srt or .vtt file.")
    out_dir = None
    if req.output_dir:
        out_dir = os.path.abspath(
            os.path.expanduser(str(req.output_dir).strip().strip('"')))
    try:
        return caption_mod.start_manual_captions(proj.path, out_dir, sidecar=sidecar)
    except caption_mod.CaptionError as exc:
        raise HTTPException(400, str(exc))


@app.put("/api/caption/{job_id}/cues")
def caption_save_cues(job_id: str, req: CaptionCuesRequest):
    """Overwrite the job's cues and rewrite its .srt/.vtt/.json files."""
    try:
        state = caption_mod.update_cues(job_id, req.cues)
    except caption_mod.CaptionError as exc:
        raise HTTPException(400, str(exc))
    if state is None:
        raise HTTPException(404, "Unknown caption job")
    return state


def _persist_captions(proj) -> None:
    """Rewrite the subtitle sidecar from the store and rebuild sections."""
    cues = captions_mod.to_plain(proj.captions)
    if proj.caption_path and os.path.isfile(proj.caption_path):
        low = proj.caption_path.lower()
        if low.endswith(".vtt"):
            caption_mod.write_vtt(cues, proj.caption_path)
        elif low.endswith(".srt"):
            caption_mod.write_srt(cues, proj.caption_path)
    sections = detect_mod.build_sections(
        float(proj.info["duration"]), proj.silences, cues,
        proj.detect_min_section_ms)
    proj.sections = [sec.to_dict() for sec in sections]


@app.post("/api/captions/update")
def captions_update(req: CaptionsUpdateRequest):
    """Save the whole timeline: timing, tracks, text and per-cue styles."""
    proj = need_project()
    proj.captions = captions_mod.normalize(
        req.cues, float(proj.info["duration"]))
    _persist_captions(proj)
    return {"cues": proj.captions, "sections": proj.sections}


@app.post("/api/subtitles/edit")
def subtitles_edit(req: SubtitleEditRequest):
    """Save an inline caption edit back into the .srt/.vtt file.

    A caption row in the section list can cover several cues (a pause inside a
    long sentence splits it), so every cue overlapping the row's time range
    gets the new text. The file is rewritten in its own format."""
    proj = PROJECT   # optional: the store only matters when a project is open
    path = os.path.abspath(os.path.expanduser(str(req.path).strip().strip('"')))
    if not os.path.isfile(path):
        raise HTTPException(404, f"Subtitle file not found: {path}")
    low = path.lower()
    if not low.endswith((".srt", ".vtt")):
        raise HTTPException(400, "Only .srt and .vtt files can be saved back.")
    if not (req.end > req.start):
        raise HTTPException(400, "end must be after start.")
    text = " ".join(str(req.text).split())
    if (proj is not None and proj.captions and proj.caption_path
            and os.path.samefile(path, proj.caption_path)):
        # The timeline store is the source of truth: edit it, then rewrite
        # the file + sections from it (keeps list/timeline/burn in sync).
        eps = 1e-6
        updated = 0
        for cue in proj.captions:
            if req.cue_id and cue["id"] != req.cue_id:
                continue
            if not req.cue_id and not (
                    cue["start"] < req.end - eps and cue["end"] > req.start + eps):
                continue
            cue["text"] = text
            updated += 1
        _persist_captions(proj)
        return {"path": path, "updated": updated,
                "total": len(proj.captions), "sections": proj.sections,
                "captions": proj.captions}
    try:
        raw = Path(path).read_text(encoding="utf-8-sig", errors="replace")
    except OSError as exc:
        raise HTTPException(400, f"Cannot read '{path}': {exc}")
    cues = detect_mod.parse_subtitles(raw)
    # One display line per cue: SRT/VTT blocks break on raw newlines.
    text = " ".join(str(req.text).split())
    eps = 1e-6
    updated = 0
    for cue in cues:
        if cue["start"] < req.end - eps and cue["end"] > req.start + eps:
            cue["text"] = text
            updated += 1
    if low.endswith(".srt"):
        caption_mod.write_srt(cues, path)
    else:
        caption_mod.write_vtt(cues, path)
    return {"path": path, "updated": updated, "total": len(cues)}


@app.get("/api/caption")
def caption_help():
    """Language/model catalog and whether faster-whisper is installed."""
    return caption_mod.format_for_ui()


@app.get("/api/job/{job_id}")
def job(job_id: str):
    state = export_mod.get_job(job_id)
    if state is None:
        raise HTTPException(404, "Unknown job")
    return state


@app.get("/api/project")
def project():
    proj = need_project()
    return proj.to_dict()


@app.get("/api/last-project")
def last_project():
    """Return the last successfully opened video path for startup restore."""
    return {"path": remembered_project_path()}


def main():
    import uvicorn

    parser = argparse.ArgumentParser(description="Video Trim Studio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()

    missing = export_mod.check_dependencies()
    if missing:
        print(f"WARNING: {', '.join(missing)} not found on PATH. "
              "Install ffmpeg before using detection/export.", file=sys.stderr)

    print(f"\n  Video Trim Studio  ->  http://{args.host}:{args.port}\n")
    uvicorn.run("server:app", host=args.host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
