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
import sys
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from vts import detect as detect_mod          # noqa: E402
from vts import export as export_mod         # noqa: E402
from vts import media as media_mod           # noqa: E402
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

    @property
    def path(self) -> str:
        return self.info["path"]

    def to_dict(self) -> dict:
        return {
            "info": self.info,
            "profile": self.profile,
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
    }


@app.get("/api/browse")
def browse(path: str | None = None, exts_only: bool = False):
    """Tiny local directory browser so the user can pick a file by clicking."""
    target = Path(path).expanduser() if path else Path.home()
    if not target.exists():
        raise HTTPException(404, f"Not found: {target}")
    if target.is_file():
        target = target.parent
    dirs, files = [], []
    try:
        for entry in sorted(target.iterdir(), key=lambda p: p.name.lower()):
            if entry.name.startswith("."):
                continue
            if entry.is_dir():
                dirs.append({"name": entry.name, "path": str(entry)})
            elif not exts_only or entry.suffix.lower() in VIDEO_EXTS:
                files.append({"name": entry.name, "path": str(entry),
                              "size": entry.stat().st_size})
    except PermissionError:
        raise HTTPException(403, f"Permission denied: {target}")
    return {
        "cwd": str(target),
        "parent": str(target.parent) if target.parent != target else None,
        "dirs": dirs,
        "files": files,
    }


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


@app.post("/api/open")
def open_video(req: OpenRequest):
    global PROJECT
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
    with PROJECT_LOCK:
        PROJECT = Project(path, info, source_match_profile(info))
    return PROJECT.to_dict()


@app.post("/api/upload")
async def upload_video(file: UploadFile = File(...)):
    """Drag-and-drop fallback: copy the file into ./work and open it."""
    global PROJECT
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
    with PROJECT_LOCK:
        PROJECT = Project(str(dest), info, source_match_profile(info))
        PROJECT.uploaded = True
    return PROJECT.to_dict()


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


@app.get("/api/media")
def media(request: Request):
    """The source file, with HTTP Range support so <video> can seek."""
    proj = need_project()
    path = proj.path
    size = os.path.getsize(path)
    range_header = request.headers.get("range")

    if not range_header:
        return FileResponse(path, media_type="video/mp4")

    m = re.match(r"bytes=(\d*)-(\d*)", range_header)
    if not m:
        raise HTTPException(416, "Bad range")
    start = int(m.group(1)) if m.group(1) else 0
    end = int(m.group(2)) if m.group(2) else size - 1
    end = min(end, size - 1)
    if start > end:
        raise HTTPException(416, "Range not satisfiable")
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

    mime = {
        ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4",
        ".mkv": "video/x-matroska", ".webm": "video/webm", ".avi": "video/x-msvideo",
        ".ts": "video/mp2t", ".mts": "video/mp2t", ".mpg": "video/mpeg",
        ".mpeg": "video/mpeg", ".flv": "video/x-flv", ".wmv": "video/x-ms-wmv",
    }.get(proj.info["ext"], "video/mp4")

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
