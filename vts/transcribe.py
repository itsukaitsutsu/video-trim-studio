"""Auto-caption: faster-whisper transcription turned into caption files.

An in-app version of the standalone `auto_caption.py` script. A video is turned
into `.srt` / `.vtt` / `.json` captions (all 99 Whisper languages, optional
translation to English, optional burned-in copy), with live progress instead of
a console log.

faster-whisper is an *optional* dependency: everything here imports it lazily,
inside the worker thread, so the app runs fine without it. `dependency_status()`
tells the UI what to show when it is missing.

Word timestamps are always requested through faster-whisper's own
`word_timestamps=True`, which works for every language (WhisperX-style forced
alignment only covers ~14), so the JSON is karaoke-ready everywhere.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
import wave
from collections import deque
from pathlib import Path

# Keep HuggingFace's cosmetic Windows symlink warning out of the log.
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

# ---------------------------------------------------------------------------
# Registry of transcription jobs (in memory: local single-user tool)
# ---------------------------------------------------------------------------

JOBS: dict[str, dict] = {}
_JOBS_LOCK = threading.Lock()
MAX_JOBS = 20


class CaptionError(RuntimeError):
    pass


class Cancelled(CaptionError):
    pass


def get_job(job_id: str) -> dict | None:
    """Serialisable snapshot of a job. The full segment list stays server-side
    (the UI gets `cues`, the editable start/end/text list, which is also what
    detection needs)."""
    with _JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return None
        snapshot = {k: v for k, v in job.items() if k not in ("_cancel", "segments")}
        snapshot["tail"] = list(job["tail"])
        snapshot["segment_count"] = len(job.get("cues") or job.get("segments") or [])
        return snapshot


def cancel_job(job_id: str) -> dict | None:
    """Ask a running job to stop; the worker exits at the next checkpoint."""
    with _JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return None
        if job["state"] == "running":
            job["_cancel"].set()
            job["note"] = "cancelling…"
    return get_job(job_id)


def _new_job(kind: str, source: str) -> dict:
    job = {
        "id": uuid.uuid4().hex[:12],
        "kind": kind,
        "source": source,
        "state": "running",          # running | done | error | cancelled
        "stage": "queued",           # queued | audio | model | transcribe | writing | burn
        "progress": 0.0,
        "speed": None,               # x realtime
        "elapsed": 0.0,
        "eta": None,
        "error": None,
        "note": "",
        "started": time.time(),
        "outputs": {},
        "meta": {},
        "cues": [],                  # editable [{start, end, text}]
        "edited": False,
        "edited_at": None,
        "tail": deque(maxlen=8),     # last transcript lines, for the live view
        "tail_total": 0,
        "_cancel": threading.Event(),
    }
    with _JOBS_LOCK:
        JOBS[job["id"]] = job
        # Keep the registry from growing forever.
        if len(JOBS) > MAX_JOBS:
            for old_id in [k for k in JOBS if k != job["id"]][:len(JOBS) - MAX_JOBS]:
                if JOBS[old_id]["state"] != "running":
                    JOBS.pop(old_id, None)
    return job


# ---------------------------------------------------------------------------
# Languages, models, devices
# ---------------------------------------------------------------------------

# Whisper's language table (code -> English name). Exposed to the UI so the
# language picker is complete without a hard-coded <select> in the HTML.
LANGUAGES: dict[str, str] = {
    "auto": "Auto-detect",
    "af": "Afrikaans", "am": "Amharic", "ar": "Arabic", "as": "Assamese",
    "az": "Azerbaijani", "ba": "Bashkir", "be": "Belarusian", "bg": "Bulgarian",
    "bn": "Bengali", "bo": "Tibetan", "br": "Breton", "bs": "Bosnian",
    "ca": "Catalan", "cs": "Czech", "cy": "Welsh", "da": "Danish",
    "de": "German", "el": "Greek", "en": "English", "es": "Spanish",
    "et": "Estonian", "eu": "Basque", "fa": "Persian", "fi": "Finnish",
    "fo": "Faroese", "fr": "French", "gl": "Galician", "gu": "Gujarati",
    "ha": "Hausa", "haw": "Hawaiian", "he": "Hebrew", "hi": "Hindi",
    "hr": "Croatian", "ht": "Haitian Creole", "hu": "Hungarian",
    "hy": "Armenian", "id": "Indonesian", "is": "Icelandic", "it": "Italian",
    "ja": "Japanese", "jw": "Javanese", "ka": "Georgian", "kk": "Kazakh",
    "km": "Khmer", "kn": "Kannada", "ko": "Korean", "la": "Latin",
    "lb": "Luxembourgish", "ln": "Lingala", "lo": "Lao", "lt": "Lithuanian",
    "lv": "Latvian", "mg": "Malagasy", "mi": "Maori", "mk": "Macedonian",
    "ml": "Malayalam", "mn": "Mongolian", "mr": "Marathi", "ms": "Malay",
    "mt": "Maltese", "my": "Myanmar", "ne": "Nepali", "nl": "Dutch",
    "nn": "Norwegian Nynorsk", "no": "Norwegian", "oc": "Occitan",
    "pa": "Punjabi", "pl": "Polish", "ps": "Pashto", "pt": "Portuguese",
    "ro": "Romanian", "ru": "Russian", "sa": "Sanskrit", "sd": "Sindhi",
    "si": "Sinhala", "sk": "Slovak", "sl": "Slovenian", "sn": "Shona",
    "so": "Somali", "sq": "Albanian", "sr": "Serbian", "su": "Sundanese",
    "sv": "Swedish", "sw": "Swahili", "ta": "Tamil", "te": "Telugu",
    "tg": "Tajik", "th": "Thai", "tk": "Turkmen", "tl": "Tagalog",
    "tr": "Turkish", "tt": "Tatar", "uk": "Ukrainian", "ur": "Urdu",
    "uz": "Uzbek", "vi": "Vietnamese", "yi": "Yiddish", "yo": "Yoruba",
    "zh": "Chinese",
}

# Approximate first-run download sizes (cached by HuggingFace afterwards).
MODELS: dict[str, dict] = {
    "tiny": {"size": "75 MB", "note": "fastest, roughest"},
    "base": {"size": "142 MB", "note": "quick"},
    "small": {"size": "466 MB", "note": "good balance for CPU"},
    "medium": {"size": "~1.5 GB", "note": "recommended default"},
    "large-v3-turbo": {"size": "~1.5 GB", "note": "fast, best for English"},
    "turbo": {"size": "~1.5 GB", "note": "alias of large-v3-turbo"},
    "large-v1": {"size": "~2.9 GB", "note": "older"},
    "large-v2": {"size": "~2.9 GB", "note": "older"},
    "large-v3": {"size": "~2.9 GB", "note": "max accuracy, slow on CPU"},
}

# Generic per-language hints (names, punctuation style) - no per-video tuning.
DEFAULT_PROMPTS = {
    "id": "Halo, ini adalah transkripsi video berbahasa Indonesia yang rapi "
          "dengan tanda baca yang benar.",
    "en": "Hello, this is a clean, properly punctuated English video transcript.",
    "ms": "Hello, ini adalah transkripsi video berbahasa Melayu yang kemas "
          "dengan tanda baca yang betul.",
    "jw": "Halo, iki transkripsi video nganggo basa Jawa sing rapi.",
}

DEVICES = ("auto", "cuda", "cpu")
COMPUTE_TYPES = ("auto", "int8", "int8_float16", "float16", "float32")


def install_hint() -> str:
    """Command that installs the caption engine into *this* interpreter.

    The quoted interpreter is deliberate: on Windows the app normally runs from
    its own `.venv` (run.bat), so a bare `pip install faster-whisper` with the
    system Python does not reach it. That mismatch is the usual reason the card
    keeps saying the package is missing after installing it.
    """
    return f'"{sys.executable}" -m pip install faster-whisper'


def dependency_status() -> dict:
    """What the UI needs to know about the optional faster-whisper install."""
    try:
        import faster_whisper                                # noqa: F401
        import ctranslate2
        version = getattr(faster_whisper, "__version__", "unknown")
        cuda_devices = 0
        try:
            cuda_devices = ctranslate2.get_cuda_device_count()
        except Exception:                                    # noqa: BLE001
            cuda_devices = 0
        return {
            "available": True,
            "version": version,
            "cuda_devices": cuda_devices,
            "default_device": "cuda" if cuda_devices else "cpu",
            "error": None,
            "executable": sys.executable,
        }
    except Exception as exc:                                 # noqa: BLE001
        return {
            "available": False,
            "version": None,
            "cuda_devices": 0,
            "default_device": "cpu",
            "error": f"{type(exc).__name__}: {exc}",
            "executable": sys.executable,
            "install": install_hint(),
            "requirements": "requirements-caption.txt",
        }


def pick_device_and_compute(user_device: str, user_compute: str) -> tuple[str, str]:
    """Resolve 'auto' the way the CLI script does, without requiring torch."""
    device = (user_device or "auto").lower()
    if device == "auto":
        device = "cuda" if dependency_status()["cuda_devices"] else "cpu"
    compute = (user_compute or "auto").lower()
    if compute == "auto":
        compute = "float16" if device == "cuda" else "int8"
    return device, compute


# ---------------------------------------------------------------------------
# Timestamps + caption writers (same output as the CLI script)
# ---------------------------------------------------------------------------

def to_srt_time(seconds: float) -> str:
    seconds = max(0.0, seconds)
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", ",")


def to_vtt_time(seconds: float) -> str:
    seconds = max(0.0, seconds)
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def fmt_clock(seconds: float) -> str:
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def write_srt(segments: list[dict], path: str | Path) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for i, seg in enumerate(segments, 1):
            f.write(f"{i}\n")
            f.write(f"{to_srt_time(seg['start'])} --> {to_srt_time(seg['end'])}\n")
            f.write(f"{seg['text'].strip()}\n\n")


def write_vtt(segments: list[dict], path: str | Path) -> None:
    with open(path, "w", encoding="utf-8") as f:
        f.write("WEBVTT\n\n")
        for seg in segments:
            f.write(f"{to_vtt_time(seg['start'])} --> {to_vtt_time(seg['end'])}\n")
            f.write(f"{seg['text'].strip()}\n\n")


def write_json(segments: list[dict], info: dict, path: str | Path) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"info": info, "segments": segments}, f,
                  ensure_ascii=False, indent=2)


def srt_to_cues_text(segments: list[dict]) -> str:
    """The .srt body as text, so it can feed detection without a re-read."""
    return "".join(
        f"{i}\n{to_srt_time(s['start'])} --> {to_srt_time(s['end'])}\n"
        f"{s['text'].strip()}\n\n"
        for i, s in enumerate(segments, 1)
    )


# ---------------------------------------------------------------------------
# Cue editing (transcripts arrive read-only; the user corrects them)
# ---------------------------------------------------------------------------

MAX_CUES = 5000
MAX_CUE_SECONDS = 24 * 3600.0


def validate_cues(raw) -> list[dict]:
    """Normalise user-supplied cues into sorted [{'start','end','text'}].

    The editor accepts anything JSON-able, so every shape problem is reported
    with the offending cue number instead of a traceback."""
    if not isinstance(raw, list):
        raise CaptionError("cues must be a list of {start, end, text} objects.")
    if len(raw) > MAX_CUES:
        raise CaptionError(f"Too many cues ({len(raw)}); the limit is {MAX_CUES}.")
    clean: list[dict] = []
    for i, cue in enumerate(raw, 1):
        if not isinstance(cue, dict):
            raise CaptionError(f"Cue {i}: expected an object with start/end/text.")
        try:
            start = float(cue["start"])
            end = float(cue["end"])
        except (KeyError, TypeError, ValueError):
            raise CaptionError(f"Cue {i}: start and end must be numbers (seconds).")
        text = cue.get("text", "")
        if text is None:
            text = ""
        if not isinstance(text, str):
            raise CaptionError(f"Cue {i}: text must be a string.")
        for name, value in (("start", start), ("end", end)):
            if not math.isfinite(value):
                raise CaptionError(f"Cue {i}: {name} is not a valid number.")
        if start < 0:
            raise CaptionError(f"Cue {i}: start must be 0 or later.")
        if end <= start:
            raise CaptionError(f"Cue {i}: end ({end:.3f}) must be after start "
                               f"({start:.3f}).")
        if end > MAX_CUE_SECONDS:
            raise CaptionError(f"Cue {i}: end goes beyond the 24-hour limit.")
        clean.append({"start": round(start, 3), "end": round(end, 3),
                      "text": text.strip()})
    clean.sort(key=lambda c: (c["start"], c["end"]))
    return clean


def write_outputs(job: dict, cues: list[dict]) -> None:
    """(Re)write the .srt/.vtt/.json trio from the current cue list."""
    out = job.get("outputs") or {}
    if not out.get("srt"):
        raise CaptionError("This caption set has no output files to write.")
    write_srt(cues, out["srt"])
    if out.get("vtt"):
        write_vtt(cues, out["vtt"])
    meta = dict(job.get("meta") or {})
    meta["edited"] = True
    meta["cue_count"] = len(cues)
    if out.get("json"):
        write_json(cues, meta, out["json"])


def update_cues(job_id: str, cues) -> dict | None:
    """Replace a job's cues and rewrite the caption files on disk.

    Returns None for an unknown job; raises CaptionError for shape problems or
    a job that cannot be edited (still running, or never produced files)."""
    with _JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return None
        if job["state"] == "running":
            raise CaptionError("Transcription is still running — wait for it "
                               "to finish before editing its captions.")
    clean = validate_cues(cues)
    write_outputs(job, clean)
    with _JOBS_LOCK:
        job["cues"] = clean
        job["cues_text"] = srt_to_cues_text(clean)
        job["edited"] = True
        job["edited_at"] = time.time()
        job["progress"] = 100.0
        job["note"] = f"{len(clean)} cue(s) saved to {job['outputs'].get('srt')}"
    return get_job(job_id)


def start_manual_captions(source: str, output_dir: str | None = None,
                          sidecar: str | None = None) -> dict:
    """An editable caption set without faster-whisper.

    Starts empty, or pre-filled from an existing .srt/.vtt (`sidecar`), so the
    user can fix timings and text even when the audio cannot be transcribed.
    The three caption files are (re)written every time the set is saved."""
    if not source or not os.path.isfile(source):
        raise CaptionError(f"Video not found: {source}")
    out_dir = output_dir or default_output_dir(source)
    os.makedirs(out_dir, exist_ok=True)
    stem = Path(source).stem

    job = _new_job("manual", source)
    job["state"] = "manual"
    job["stage"] = "ready"
    job["progress"] = 100.0
    job["outputs"] = {
        "srt": os.path.join(out_dir, f"{stem}.srt"),
        "vtt": os.path.join(out_dir, f"{stem}.vtt"),
        "json": os.path.join(out_dir, f"{stem}.json"),
    }
    job["options"] = {"output_dir": out_dir}

    cues: list[dict] = []
    if sidecar:
        try:
            text = Path(sidecar).read_text(encoding="utf-8-sig", errors="replace")
        except OSError as exc:
            with _JOBS_LOCK:
                JOBS.pop(job["id"], None)
            raise CaptionError(f"Cannot read '{sidecar}': {exc}")
        from vts import detect as detect_mod     # lazy: parser lives there
        cues = validate_cues(detect_mod.parse_subtitles(text))
        job["note"] = (f"Loaded {len(cues)} cue(s) from {os.path.basename(sidecar)}"
                       " — edit and press Save.")
    else:
        job["note"] = "Blank caption set — add cues, edit them, press Save."

    job["cues"] = cues
    job["cues_text"] = srt_to_cues_text(cues)
    job["meta"] = {"manual": True}
    job["elapsed"] = 0.0
    return get_job(job["id"])                       # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Audio extraction + burn-in
# ---------------------------------------------------------------------------

def check_ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if exe is None:
        raise CaptionError(
            "ffmpeg not found on PATH. Install it first:\n"
            "  Windows : winget install Gyan.FFmpeg   (then open a NEW terminal)\n"
            "  macOS   : brew install ffmpeg\n"
            "  Linux   : sudo apt install ffmpeg")
    return exe


def extract_audio(video: str, wav_path: str, normalize: bool = False,
                  on_line=None) -> None:
    """16 kHz mono WAV - Whisper's native input format."""
    check_ffmpeg()
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
           "-i", video, "-vn", "-ac", "1", "-ar", "16000"]
    if normalize:
        # Helps quiet / uneven recordings (phone mics, distant speakers).
        cmd += ["-filter:a", "loudnorm=I=-16:TP=-1.5:LRA=11"]
    cmd += ["-c:a", "pcm_s16le", wav_path]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                          errors="replace")
    if proc.returncode != 0 or not os.path.exists(wav_path):
        raise CaptionError("ffmpeg audio extraction failed:\n"
                           f"{(proc.stderr or '')[-2000:]}")
    if on_line:
        on_line(f"audio extracted{' (loudness normalized)' if normalize else ''}")


def wav_duration(wav_path: str) -> float:
    """Duration of the extracted WAV, used for progress + ETA. 0 if unknown."""
    try:
        with wave.open(wav_path, "rb") as w:
            rate = w.getframerate()
            return w.getnframes() / rate if rate else 0.0
    except Exception:                                        # noqa: BLE001
        return 0.0


def load_wav_float32(wav_path: str):
    """Our 16 kHz mono PCM WAV as the float32 array Whisper expects.

    Feeding samples straight to `model.transcribe()` skips faster-whisper's own
    decoder, which calls `av.open(..., metadata_errors=...)` - a keyword that
    newer PyAV releases no longer accept, so that import path breaks on some
    installs. ffmpeg already decoded the audio, so nothing is lost here, and it
    saves one whole decode pass. Returns None when the file is not what we
    expect (caller then falls back to handing Whisper the path).
    """
    try:
        import numpy as np
    except ImportError:
        return None
    try:
        with wave.open(wav_path, "rb") as w:
            if w.getsampwidth() != 2 or w.getnchannels() != 1:
                return None
            frames = w.readframes(w.getnframes())
    except (OSError, wave.Error):
        return None
    if not frames:
        return None
    return np.frombuffer(frames, dtype="<i2").astype("float32") / 32768.0


def burn_subtitles(video: str, srt_path: str, out_path: str) -> None:
    """Render captions into a new video file (hardsubs). Source untouched.

    ffmpeg runs with its working directory set to the subtitle's folder and is
    handed a bare filename, which sidesteps the Windows drive-colon escaping
    rules that `-vf subtitles=` normally needs. FFmpeg's default autorotate
    still applies, so a phone clip keeps its baked orientation.
    """
    check_ffmpeg()
    folder = os.path.dirname(os.path.abspath(srt_path)) or "."
    name = os.path.basename(srt_path).replace("\\", "/").replace("'", r"\'")
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
           "-i", os.path.abspath(video),
           "-vf", f"subtitles='{name}'",
           "-c:a", "copy",
           "-map_metadata", "0",
           os.path.abspath(out_path)]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", cwd=folder)
    if proc.returncode != 0 or not os.path.exists(out_path):
        raise CaptionError(
            "ffmpeg subtitle burn-in failed (ffmpeg needs libass; standard in "
            "most builds):\n" + (proc.stderr or "")[-2000:])


# ---------------------------------------------------------------------------
# The worker
# ---------------------------------------------------------------------------

def default_output_dir(source: str) -> str:
    """Caption files land next to the video, like the CLI script's ./output."""
    return os.path.dirname(os.path.abspath(source)) or "."


def transcribe_step(wav_path: str, job: dict, model_name: str, language: str,
                    task: str, device: str, compute_type: str,
                    initial_prompt: str | None, vad: bool, word_timestamps: bool,
                    beam_size: int, temperature_fallback: bool) -> tuple[list[dict], dict]:
    """Run faster-whisper, updating `job` as segments stream in."""
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise CaptionError(
            "faster-whisper is not installed. Install it with:\n"
            "  python -m pip install faster-whisper") from exc

    job["stage"] = "model"
    size = MODELS.get(model_name, {}).get("size", "unknown size")
    job["note"] = (f"loading model '{model_name}' on {device} ({compute_type})"
                   + (f" - first run downloads {size}" if size != "unknown size" else ""))

    def load():
        return WhisperModel(model_name, device=device, compute_type=compute_type)

    try:
        model = load()
    except Exception as exc:                                 # noqa: BLE001
        if device != "cuda":
            raise CaptionError(f"Could not load model '{model_name}': {exc}") from exc
        job["note"] = f"CUDA failed ({exc}); falling back to CPU"
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
        device, compute_type = "cpu", "int8"
    if job["_cancel"].is_set():
        raise Cancelled("cancelled")

    languages = None if language in ("auto", "", None) else language
    temperatures: float | list[float] = (
        [0.0, 0.2, 0.4, 0.6, 0.8, 1.0] if temperature_fallback else 0.0)

    job["stage"] = "transcribe"
    job["device"] = device
    job["compute_type"] = compute_type
    total = wav_duration(wav_path)
    t_loop = time.time()

    audio = load_wav_float32(wav_path)
    segments_gen, info = model.transcribe(
        audio if audio is not None else wav_path,
        language=languages,
        task=task,                       # "transcribe" | "translate" (to English)
        beam_size=beam_size,
        temperature=temperatures,
        vad_filter=vad,
        vad_parameters=dict(min_silence_duration_ms=500),
        word_timestamps=word_timestamps,
        initial_prompt=initial_prompt,
        condition_on_previous_text=True,
    )

    segments: list[dict] = []
    for seg in segments_gen:
        if job["_cancel"].is_set():
            raise Cancelled("cancelled")
        words = None
        if word_timestamps and getattr(seg, "words", None):
            words = [{"word": w.word, "start": round(w.start, 3),
                      "end": round(w.end, 3),
                      "probability": round(float(w.probability), 3)}
                     for w in seg.words]
        text = (seg.text or "").strip()
        segments.append({
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "text": text,
            "avg_logprob": round(float(seg.avg_logprob), 3),
            "no_speech_prob": round(float(seg.no_speech_prob), 3),
            "words": words,
        })

        elapsed_loop = time.time() - t_loop
        job["elapsed"] = round(time.time() - job["started"], 1)
        if total > 0 and seg.end > 0:
            frac = min(0.999, seg.end / total)
            job["progress"] = round(frac * 100, 2)
            job["speed"] = round(seg.end / elapsed_loop, 2) if elapsed_loop > 0.5 else None
            if frac > 0.005:
                job["eta"] = round(elapsed_loop / frac - elapsed_loop, 1)
        job["tail"].append({"t": to_srt_time(seg.start), "text": text})
        job["tail_total"] += 1
        job["note"] = (f"{len(segments)} segments · "
                       f"audio {fmt_clock(total) if total else '?'}")

    elapsed = time.time() - job["started"]
    meta = {
        "model": model_name,
        "language": getattr(info, "language", languages) or "unknown",
        "language_probability": round(float(getattr(info, "language_probability", 0.0)), 3),
        "duration": round(float(getattr(info, "duration", 0.0)) or total, 2),
        "device": device,
        "compute_type": compute_type,
        "task": task,
        "transcribe_seconds": round(elapsed, 1),
        "segments": len(segments),
    }
    return segments, meta


def _run(job: dict, source: str, opts: dict) -> None:
    """Full pipeline in a worker thread; never raises to the caller."""
    tmpdir: str | None = None
    try:
        output_dir = opts.get("output_dir") or default_output_dir(source)
        os.makedirs(output_dir, exist_ok=True)
        stem = Path(source).stem

        job["stage"] = "audio"
        job["note"] = "extracting 16 kHz mono audio"
        tmpdir = tempfile.mkdtemp(prefix="vts_caption_")
        wav_path = os.path.join(tmpdir, f"{stem}.16k.wav")
        extract_audio(source, wav_path, normalize=bool(opts.get("normalize_audio")))

        if opts.get("keep_audio"):
            kept = os.path.join(output_dir, f"{stem}.16k.wav")
            shutil.copyfile(wav_path, kept)
            job["outputs"]["audio"] = kept

        language = opts.get("language") or "auto"
        task = "translate" if opts.get("translate_to_english") else "transcribe"
        initial_prompt = opts.get("initial_prompt")
        if not initial_prompt and task == "transcribe":
            initial_prompt = DEFAULT_PROMPTS.get(language)

        segments, meta = transcribe_step(
            wav_path, job,
            model_name=opts.get("model") or "medium",
            language=language,
            task=task,
            device=opts.get("device") or "cpu",
            compute_type=opts.get("compute_type") or "auto",
            initial_prompt=initial_prompt,
            vad=bool(opts.get("vad", True)),
            word_timestamps=bool(opts.get("word_timestamps", True)),
            beam_size=int(opts.get("beam_size") or 1),
            temperature_fallback=bool(opts.get("temperature_fallback", False)),
        )

        if job["_cancel"].is_set():
            raise Cancelled("cancelled")

        job["stage"] = "writing"
        job["progress"] = 100.0
        srt_path = os.path.join(output_dir, f"{stem}.srt")
        vtt_path = os.path.join(output_dir, f"{stem}.vtt")
        json_path = os.path.join(output_dir, f"{stem}.json")
        write_srt(segments, srt_path)
        write_vtt(segments, vtt_path)
        write_json(segments, meta, json_path)
        job["outputs"].update({"srt": srt_path, "vtt": vtt_path, "json": json_path})

        if opts.get("burn"):
            job["stage"] = "burn"
            burned = os.path.join(output_dir, f"{stem}.captioned.mp4")
            job["note"] = "burning subtitles into a new video file"
            burn_subtitles(source, srt_path, burned)
            job["outputs"]["video"] = burned

        job["meta"] = meta
        job["segments"] = segments
        job["cues"] = [{"start": s["start"], "end": s["end"], "text": s["text"]}
                       for s in segments]
        job["cues_text"] = srt_to_cues_text(segments)
        job["eta"] = 0
        job["state"] = "done"
        if segments:
            job["note"] = (f"{meta['segments']} segments · {meta['language']} "
                           f"({meta['language_probability']:.0%} confident) · "
                           f"{fmt_clock(meta['transcribe_seconds'])} on {meta['device']}")
        else:
            # VAD filtered everything out, or the track really is silent.
            job["note"] = ("No speech detected — the caption files are empty. "
                           "Check the audio track, or untick VAD if the speech is "
                           "very quiet.")
    except Cancelled:
        job["state"] = "cancelled"
        job["note"] = "Cancelled."
        job["eta"] = None
    except Exception as exc:                                 # noqa: BLE001 - report to UI
        job["state"] = "error"
        job["error"] = str(exc)[:4000]
        # The full trace stays server-side; library version mismatches show up
        # here as one-liners otherwise (e.g. "unexpected keyword argument").
        job["traceback"] = traceback.format_exc()[-4000:]
        job["eta"] = None
    finally:
        job["elapsed"] = round(time.time() - job["started"], 1)
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)


def start_caption(source: str, opts: dict | None = None) -> dict:
    """Validate, register a job and run it in the background."""
    if not source or not os.path.isfile(source):
        raise CaptionError(f"Video not found: {source}")
    if not dependency_status()["available"]:
        raise CaptionError(
            "faster-whisper is not installed, so auto-captioning is unavailable.\n"
            "Install it with:  python -m pip install faster-whisper")
    opts = dict(opts or {})
    model = opts.get("model") or "medium"
    if model not in MODELS:
        raise CaptionError(f"Unknown model '{model}'. Choose one of: "
                           f"{', '.join(MODELS)}")
    language = opts.get("language") or "auto"
    if language not in LANGUAGES:
        raise CaptionError(f"Unknown language code '{language}'.")
    if opts.get("device") not in (None, *DEVICES):
        raise CaptionError(f"device must be one of: {', '.join(DEVICES)}")
    compute = opts.get("compute_type") or "auto"
    if compute not in COMPUTE_TYPES:
        raise CaptionError(f"compute_type must be one of: {', '.join(COMPUTE_TYPES)}")
    beam = int(opts.get("beam_size") or 1)
    if not 1 <= beam <= 10:
        raise CaptionError("beam_size must be between 1 and 10.")

    job = _new_job("caption", source)
    job["options"] = {k: opts.get(k) for k in (
        "model", "language", "translate_to_english", "device", "compute_type",
        "vad", "word_timestamps", "beam_size", "temperature_fallback",
        "normalize_audio", "initial_prompt", "keep_audio", "burn", "output_dir")}
    threading.Thread(target=_run, args=(job, source, opts), daemon=True).start()
    return get_job(job["id"])                       # type: ignore[return-value]


def format_for_ui() -> dict:
    """Language/model catalogs + install status, for the caption card."""
    return {
        "languages": [{"code": c, "name": n} for c, n in LANGUAGES.items()],
        "models": [{"name": m, "size": v["size"], "note": v["note"]}
                   for m, v in MODELS.items()],
        "devices": list(DEVICES),
        "compute_types": list(COMPUTE_TYPES),
        "status": dependency_status(),
        "python": sys.version.split()[0],
    }
