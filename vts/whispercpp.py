"""whisper.cpp engine for Auto-caption (optional, external binary).

Why this exists: faster-whisper runs on CTranslate2, whose pip builds only
support CPU and NVIDIA CUDA. AMD GPUs (e.g. an RX 6600 XT) cannot be used by
it. whisper.cpp has a **Vulkan** backend that runs on AMD/Intel/NVIDIA GPUs on
both Windows and Linux, so this engine gives AMD users real GPU transcription.

No Python package is required: we shell out to whisper.cpp's CLI binary
(`whisper-cli`, historically named `main`), searched in this order:

  1. the ``VTS_WHISPER_CLI`` environment variable (full path to the binary)
  2. ``<app>/tools/whisper-cli[.exe]`` (or ``main[.exe]``) next to the app
  3. the system PATH

GGML models (``ggml-<name>.bin``) live in ``<app>/work/whisper-models`` and can
be downloaded from the UI (HuggingFace, streaming with progress).

The transcription step plugs into the same job pipeline as faster-whisper: it
receives the extracted 16 kHz mono wav, streams progress into ``job`` while the
process runs, and returns ``(segments, meta)`` in the identical shape.
"""

from __future__ import annotations

import os
import queue
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

from vts import transcribe as tsc
from vts.transcribe import CaptionError, Cancelled

APP_ROOT = Path(__file__).resolve().parent.parent
CLI_NAMES = ("whisper-cli", "whisper-cli.exe", "main", "main.exe")
CLI_URL_HINT = ("https://github.com/ggml-org/whisper.cpp (build with "
                "-DGGML_VULKAN=ON for AMD GPU support)")

# name -> (display size, ggml file). Downloaded from the whisper.cpp HF repo.
GGML_MODELS: dict[str, tuple[str, str]] = {
    "tiny": ("75 MB", "ggml-tiny.bin"),
    "base": ("142 MB", "ggml-base.bin"),
    "small": ("466 MB", "ggml-small.bin"),
    "medium": ("1.5 GB", "ggml-medium.bin"),
    "large-v3": ("2.9 GB", "ggml-large-v3.bin"),
    "large-v3-turbo": ("1.6 GB", "ggml-large-v3-turbo.bin"),
}
HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"


def models_dir() -> Path:
    env = os.environ.get("VTS_WHISPER_MODELS", "").strip()
    return Path(env) if env else APP_ROOT / "work" / "whisper-models"


def find_cli() -> str | None:
    """Locate the whisper-cli binary (env var, ./tools, then PATH)."""
    env = os.environ.get("VTS_WHISPER_CLI", "").strip()
    if env and os.path.isfile(env) and os.access(env, os.X_OK if os.name != "nt" else os.F_OK):
        return env
    tools = APP_ROOT / "tools"
    for name in CLI_NAMES:
        cand = tools / name
        if cand.is_file():
            return str(cand)
    for name in ("whisper-cli", "main"):
        found = shutil.which(name)
        if found:
            return found
    return None


def list_models(directory: Path | None = None) -> list[dict]:
    """GGML models present on disk, sorted by size."""
    d = Path(directory or models_dir())
    out = []
    if d.is_dir():
        for f in sorted(d.glob("ggml-*.bin")):
            out.append({"name": f.stem.removeprefix("ggml-"),
                        "file": f.name,
                        "size_bytes": f.stat().st_size})
    out.sort(key=lambda m: m["size_bytes"])
    return out


def model_file(model_name: str, directory: Path | None = None) -> Path:
    d = Path(directory or models_dir())
    return d / f"ggml-{model_name}.bin"


def status() -> dict:
    """Snapshot for the UI: binary present? which models are on disk?"""
    cli = find_cli()
    present = {m["name"] for m in list_models()}
    return {
        "available": bool(cli),
        "cli_path": cli,
        "models_dir": str(models_dir()),
        "models": list_models(),
        "catalog": [{"name": n, "size": s, "file": f,
                     "present": n in present,
                     "url": f"{HF_BASE}/{f}"} for n, (s, f) in GGML_MODELS.items()],
        "hint": CLI_URL_HINT,
    }


# ---------------------------------------------------------------------------
# Transcription (whisper-cli subprocess)
# ---------------------------------------------------------------------------

_SEG_RE = re.compile(
    r"^\s*\[(\d+):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*"
    r"(\d+):(\d{2}):(\d{2})[.,](\d{1,3})\]\s*(.*)$")
_PROGRESS_RE = re.compile(r"progress\s*=?\s*(\d{1,3})\s*%", re.IGNORECASE)
_LANG_RE = re.compile(r"(?:auto-)?detected language[:\s]+(\w+)", re.IGNORECASE)


def _ts(h, m, s, ms) -> float:
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, "0")[:3]) / 1000.0


def parse_srt(text: str) -> list[dict]:
    """Minimal SRT parser -> [{start, end, text}]."""
    cues: list[dict] = []
    for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n").strip()):
        lines = [ln for ln in block.split("\n") if ln.strip()]
        ts_idx = next((i for i, ln in enumerate(lines) if "-->" in ln), None)
        if ts_idx is None:
            continue
        m = re.match(r"(\d+):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*"
                     r"(\d+):(\d{2}):(\d{2})[.,](\d{1,3})", lines[ts_idx])
        if not m:
            continue
        body = " ".join(ln.strip() for ln in lines[ts_idx + 1:])
        cues.append({"start": round(_ts(*m.groups()[:4]), 3),
                     "end": round(_ts(*m.groups()[4:8]), 3),
                     "text": body.strip()})
    return cues


def build_command(cli: str, model_path: str, wav_path: str, out_base: str,
                  language: str, translate: bool, initial_prompt: str | None,
                  threads: int) -> list[str]:
    # Long option names only: the short aliases have changed across
    # whisper.cpp releases (e.g. -ojson -> -oj in v1.9), long flags are stable.
    cmd = [cli, "--model", model_path, "--file", wav_path,
           "--language", language or "auto",
           "--threads", str(max(1, threads)),
           "--output-file", out_base, "--output-srt", "--output-json"]
    if translate:
        cmd.append("--translate")
    if initial_prompt:
        cmd += ["--prompt", initial_prompt]
    return cmd


def transcribe_step(wav_path: str, job: dict, opts: dict) -> tuple[list[dict], dict]:
    """Run whisper-cli on the wav; same contract as transcribe.transcribe_step."""
    cli = find_cli()
    if not cli:
        raise CaptionError(
            "whisper-cli not found. Build whisper.cpp with Vulkan support and "
            "either put the binary in <app>/tools/, add it to PATH, or set "
            "VTS_WHISPER_CLI to its full path.\nSource: " + CLI_URL_HINT)

    model_name = opts.get("model") or "medium"
    mfile = model_file(model_name)
    if not mfile.is_file():
        names = ", ".join(m["name"] for m in list_models()) or "none yet"
        raise CaptionError(
            f"GGML model '{model_name}' not found in {models_dir()}.\n"
            f"Download it with the button in the Auto-caption card, or from "
            f"{HF_BASE}/{GGML_MODELS.get(model_name, ('', 'ggml-' + model_name + '.bin'))[1]}\n"
            f"Models on disk: {names}")

    language = opts.get("language") or "auto"
    task_translate = bool(opts.get("translate_to_english"))
    initial_prompt = opts.get("initial_prompt")
    if not initial_prompt and not task_translate:
        initial_prompt = tsc.DEFAULT_PROMPTS.get(language)
    threads = int(opts.get("threads") or min(os.cpu_count() or 4, 16))

    job["stage"] = "transcribe"
    job["device"] = "whisper.cpp"
    job["compute_type"] = "ggml"
    total = tsc.wav_duration(wav_path)
    out_base = os.path.join(os.path.dirname(wav_path), "wcpp_out")
    cmd = build_command(cli, str(mfile), wav_path, out_base, language,
                        task_translate, initial_prompt, threads)
    job["note"] = f"running whisper-cli ({os.path.basename(cli)})"

    backend = "cpu"
    detected_lang: str | None = None
    segments: list[dict] = []
    t_loop = time.time()

    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", bufsize=1)

    def _reader():
        assert proc.stdout is not None
        for line in proc.stdout:
            q.put(line.rstrip("\n"))
        q.put(None)

    q: "queue.Queue[str | None]" = queue.Queue()
    threading.Thread(target=_reader, daemon=True).start()

    tail_log: list[str] = []
    try:
        while True:
            if job["_cancel"].is_set():
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
                raise Cancelled("cancelled")
            try:
                line = q.get(timeout=0.4)
            except queue.Empty:
                continue
            if line is None:
                break
            tail_log.append(line)
            if len(tail_log) > 40:
                tail_log.pop(0)
            if "vulkan" in line.lower() and backend == "cpu":
                backend = "vulkan"
                job["note"] = "whisper.cpp is using the Vulkan GPU backend"
            lm = _LANG_RE.search(line)
            if lm:
                detected_lang = lm.group(1).lower()
            m = _SEG_RE.match(line)
            if m:
                start = _ts(*m.groups()[:4])
                end = _ts(*m.groups()[4:8])
                text = m.group(9).strip()
                segments.append({"start": round(start, 3), "end": round(end, 3),
                                 "text": text, "avg_logprob": None,
                                 "no_speech_prob": None, "words": None})
                elapsed_loop = time.time() - t_loop
                job["elapsed"] = round(time.time() - job["started"], 1)
                if total > 0 and end > 0:
                    frac = min(0.999, end / total)
                    job["progress"] = round(frac * 100, 2)
                    job["speed"] = round(end / elapsed_loop, 2) if elapsed_loop > 0.5 else None
                    if frac > 0.005:
                        job["eta"] = round(elapsed_loop / frac - elapsed_loop, 1)
                job["tail"].append({"t": tsc.to_srt_time(start), "text": text})
                job["tail_total"] += 1
                job["note"] = (f"{len(segments)} segments · backend: {backend} · "
                               f"audio {tsc.fmt_clock(total) if total else '?'}")
                continue
            pm = _PROGRESS_RE.search(line)
            if pm and not segments:
                job["progress"] = min(99.0, float(pm.group(1)))
    finally:
        if proc.poll() is None:
            proc.kill()
    rc = proc.wait()
    if job["_cancel"].is_set():
        raise Cancelled("cancelled")

    srt_path = out_base + ".srt"
    if rc != 0 or not os.path.exists(srt_path):
        raise CaptionError(
            f"whisper-cli exited with code {rc}. Last output:\n"
            + "\n".join(tail_log[-15:]))

    segments = parse_srt(Path(srt_path).read_text(encoding="utf-8", errors="replace"))
    elapsed = time.time() - job["started"]
    meta = {
        "model": model_name,
        "engine": "whispercpp",
        "language": detected_lang or (None if language == "auto" else language) or "unknown",
        "language_probability": 1.0 if language != "auto" else 0.0,
        "duration": round(total, 2),
        "device": "whisper.cpp",
        "backend": backend,
        "compute_type": "ggml",
        "task": "translate" if task_translate else "transcribe",
        "transcribe_seconds": round(elapsed, 1),
        "segments": len(segments),
    }
    return segments, meta


# ---------------------------------------------------------------------------
# Model downloads (jobs in the shared registry, polled like caption jobs)
# ---------------------------------------------------------------------------

def model_url(model_name: str) -> str:
    if model_name not in GGML_MODELS:
        raise CaptionError(f"Unknown model '{model_name}'. Choose one of: "
                           f"{', '.join(GGML_MODELS)}")
    return f"{HF_BASE}/{GGML_MODELS[model_name][1]}"


def start_download(model_name: str) -> dict:
    """Register + start a model download job (same registry as caption jobs)."""
    url = model_url(model_name)          # validates the name
    dest = model_file(model_name)
    job = tsc._new_job("download", model_name)
    job["stage"] = "download"
    job["outputs"]["model"] = str(dest)

    def _work():
        part = dest.with_suffix(".bin.part")
        try:
            if dest.is_file() and dest.stat().st_size > 0:
                job["progress"] = 100.0
                job["state"] = "done"
                job["note"] = f"{dest.name} already downloaded."
                return
            try:
                import httpx
            except ImportError as exc:
                raise CaptionError("httpx is required for downloads: "
                                   "python -m pip install httpx") from exc
            dest.parent.mkdir(parents=True, exist_ok=True)
            part = dest.with_suffix(".bin.part")
            job["note"] = f"downloading {dest.name}…"
            with httpx.Client(follow_redirects=True, timeout=60.0) as client:
                with client.stream("GET", url) as resp:
                    if resp.status_code != 200:
                        raise CaptionError(f"Download failed: HTTP {resp.status_code} "
                                           f"for {url}")
                    size = int(resp.headers.get("content-length") or 0)
                    done = 0
                    with open(part, "wb") as f:
                        for chunk in resp.iter_bytes(chunk_size=1 << 20):
                            if job["_cancel"].is_set():
                                raise Cancelled("cancelled")
                            f.write(chunk)
                            done += len(chunk)
                            if size:
                                job["progress"] = round(done / size * 100, 1)
                                job["note"] = (f"downloading {dest.name}: "
                                               f"{done // (1 << 20)} / {size // (1 << 20)} MB")
            part.rename(dest)
            job["progress"] = 100.0
            job["state"] = "done"
            job["note"] = f"{dest.name} ready in {dest.parent}."
        except Cancelled:
            job["state"] = "cancelled"
            job["note"] = "Download cancelled."
            if part and part.exists():
                part.unlink(missing_ok=True)
        except Exception as exc:                                 # noqa: BLE001
            job["state"] = "error"
            job["error"] = str(exc)[:2000]
            job["note"] = "Download failed."

    threading.Thread(target=_work, daemon=True).start()
    return tsc.get_job(job["id"])  # type: ignore[return-value]
