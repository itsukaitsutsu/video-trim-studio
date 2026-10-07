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
import sys
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from vts import detect as detect_mod          # noqa: E402
from vts import export as export_mod         # noqa: E402
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

app = FastAPI(title="Video Trim Studio", version="1.0.0")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


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


class CaptionRequest(BaseModel):
    """Auto-caption options; every field has a working default."""
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
    return {
        "sections": proj.sections,
        "summary": detect_mod.summary(sections),
        "silence_count": len(silences),
        "cue_count": len(cues),
        "settings": req.model_dump() if hasattr(req, "model_dump") else req.dict(),
    }


@app.post("/api/parse-subtitles")
async def parse_subtitles(file: UploadFile = File(...)):
    text = (await file.read()).decode("utf-8-sig", errors="replace")
    cues = detect_mod.parse_subtitles(text)
    if not cues:
        raise HTTPException(400, "No cues found - is this an .srt or .vtt file?")
    return {"cues": cues, "count": len(cues),
            "first": cues[0], "last": cues[-1]}


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
    try:
        job = export_mod.export(proj.path, proj.info, dels, opts, output)
    except export_mod.JobError as exc:
        raise HTTPException(400, str(exc))
    except (RuntimeError, OSError) as exc:
        raise HTTPException(500, str(exc))
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
    device, compute = caption_mod.pick_device_and_compute(
        opts.get("device", "auto"), opts.get("compute_type", "auto"))
    opts["device"], opts["compute_type"] = device, compute
    try:
        return caption_mod.start_caption(proj.path, opts)
    except caption_mod.CaptionError as exc:
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
