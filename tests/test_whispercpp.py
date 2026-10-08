"""whisper.cpp engine: CLI detection, SRT parsing, subprocess run, downloads."""
import os
import stat
import sys
import threading
import time
import wave
from pathlib import Path

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from vts import transcribe as tsc          # noqa: E402
from vts import whispercpp as wcpp         # noqa: E402

FAKE_CLI = """#!/bin/sh
# Fake whisper-cli: prints whisper.cpp-style lines and writes SRT/JSON out.
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    -of|--output-file) shift; OUT="$1" ;;
  esac
  shift
done
echo "system_info: fake build"
echo "[00:00:00.000 --> 00:00:02.000]   halo dunia"
echo "[00:00:02.000 --> 00:00:04.000]   apa kabar"
printf '1\\n00:00:00,000 --> 00:00:02,000\\nhalo dunia\\n\\n2\\n00:00:02,000 --> 00:00:04,000\\napa kabar\\n\\n' > "$OUT.srt"
echo '{}' > "$OUT.json"
exit 0
"""

FAIL_CLI = """#!/bin/sh
echo "some init output"
echo "error: failed to load model" >&2
exit 1
"""

SLEEP_CLI = """#!/bin/sh
echo "[00:00:00.000 --> 00:00:02.000]   start"
sleep 20
"""


def _mk_cli(tmp_path: Path, body: str, name: str = "whisper-cli") -> Path:
    cli = tmp_path / name
    cli.write_text(body)
    cli.chmod(cli.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return cli


def _mk_wav(path: Path, seconds: float = 4.0) -> Path:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * int(seconds * 16000))
    return path


@pytest.fixture()
def env_setup(tmp_path, monkeypatch):
    """Fake CLI + a models dir containing ggml-medium.bin."""
    cli = _mk_cli(tmp_path, FAKE_CLI)
    models = tmp_path / "models"
    models.mkdir()
    (models / "ggml-medium.bin").write_bytes(b"x" * 64)
    monkeypatch.setenv("VTS_WHISPER_CLI", str(cli))
    monkeypatch.setenv("VTS_WHISPER_MODELS", str(models))
    return cli, models


# --------------------------------------------------------------- pure helpers

def test_parse_srt_handles_crlf_and_multiline():
    text = ("1\r\n00:00:00,000 --> 00:00:02,500\r\nfirst line\r\nsecond\r\n\r\n"
            "2\r\n00:00:02,500 --> 00:00:05,000\r\nonly line\r\n")
    cues = wcpp.parse_srt(text)
    assert len(cues) == 2
    assert cues[0] == {"start": 0.0, "end": 2.5, "text": "first line second"}
    assert cues[1]["text"] == "only line"


def test_build_command_flags():
    cmd = wcpp.build_command("wc", "/m.bin", "/a.wav", "/tmp/o", "id",
                             False, "prompt text", 4)
    for flag in ("--model", "/m.bin", "--file", "/a.wav", "--language", "id",
                 "--threads", "4", "--output-file", "/tmp/o", "--output-srt",
                 "--output-json", "--prompt", "prompt text"):
        assert flag in cmd
    assert "--translate" not in cmd
    cmd = wcpp.build_command("wc", "/m.bin", "/a.wav", "/tmp/o", "auto",
                             True, None, 4)
    assert "--translate" in cmd
    assert cmd[cmd.index("--language") + 1] == "auto"
    assert "--prompt" not in cmd


def test_model_url_validation():
    assert wcpp.model_url("medium").endswith("ggml-medium.bin")
    assert wcpp.model_url("large-v3-turbo").endswith("ggml-large-v3-turbo.bin")
    with pytest.raises(tsc.CaptionError):
        wcpp.model_url("not-a-model")


def test_find_cli_env_override(tmp_path, monkeypatch):
    cli = _mk_cli(tmp_path, FAKE_CLI, name="custom-cli")
    monkeypatch.setenv("VTS_WHISPER_CLI", str(cli))
    assert wcpp.find_cli() == str(cli)
    monkeypatch.setenv("VTS_WHISPER_CLI", str(tmp_path / "missing"))
    # falls back to tools/ or PATH; neither has it in the sandbox
    assert wcpp.find_cli() in (None,) or Path(wcpp.find_cli()).exists()


def test_list_models_and_status(tmp_path, monkeypatch):
    models = tmp_path / "models"
    models.mkdir()
    (models / "ggml-tiny.bin").write_bytes(b"x" * 10)
    (models / "ggml-medium.bin").write_bytes(b"y" * 30)
    monkeypatch.setenv("VTS_WHISPER_MODELS", str(models))
    found = wcpp.list_models()
    assert [m["name"] for m in found] == ["tiny", "medium"]  # sorted by size
    st = wcpp.status()
    assert st["models_dir"] == str(models)
    names = {c["name"]: c for c in st["catalog"]}
    assert names["tiny"]["present"] and not names["base"]["present"]


# ------------------------------------------------------------------ run()

def test_run_with_fake_cli_returns_segments(tmp_path, env_setup):
    _, models = env_setup
    wav = _mk_wav(tmp_path / "in.wav")
    job = tsc._new_job("caption", "fake.mp4")
    segments, meta = wcpp.transcribe_step(str(wav), job, {
        "model": "medium", "language": "id",
    })
    assert [(s["start"], s["end"], s["text"]) for s in segments] == [
        (0.0, 2.0, "halo dunia"), (2.0, 4.0, "apa kabar")]
    assert meta["engine"] == "whispercpp"
    assert meta["segments"] == 2
    assert job["progress"] > 0                       # segment-driven progress
    assert job["tail_total"] == 2
    assert any("halo dunia" in t["text"] for t in job["tail"])


def test_run_detects_vulkan_backend_line(tmp_path, monkeypatch):
    cli = _mk_cli(tmp_path, FAKE_CLI.replace(
        'echo "system_info: fake build"',
        'echo "ggml_vulkan: Found Vulkan device Radeon RX 6600 XT"'))
    models = tmp_path / "models"
    models.mkdir()
    (models / "ggml-medium.bin").write_bytes(b"x")
    monkeypatch.setenv("VTS_WHISPER_CLI", str(cli))
    monkeypatch.setenv("VTS_WHISPER_MODELS", str(models))
    wav = _mk_wav(tmp_path / "in.wav")
    job = tsc._new_job("caption", "fake.mp4")
    _, meta = wcpp.transcribe_step(str(wav), job, {"model": "medium"})
    assert meta["backend"] == "vulkan"


def test_run_missing_model_raises(tmp_path, monkeypatch):
    cli = _mk_cli(tmp_path, FAKE_CLI)
    monkeypatch.setenv("VTS_WHISPER_CLI", str(cli))
    monkeypatch.setenv("VTS_WHISPER_MODELS", str(tmp_path / "empty-models"))
    wav = _mk_wav(tmp_path / "in.wav")
    job = tsc._new_job("caption", "fake.mp4")
    with pytest.raises(tsc.CaptionError, match="GGML model"):
        wcpp.transcribe_step(str(wav), job, {"model": "medium"})


def test_run_cli_failure_reports_tail(tmp_path, monkeypatch):
    cli = _mk_cli(tmp_path, FAIL_CLI)
    models = tmp_path / "models"
    models.mkdir()
    (models / "ggml-medium.bin").write_bytes(b"x")
    monkeypatch.setenv("VTS_WHISPER_CLI", str(cli))
    monkeypatch.setenv("VTS_WHISPER_MODELS", str(models))
    wav = _mk_wav(tmp_path / "in.wav")
    job = tsc._new_job("caption", "fake.mp4")
    with pytest.raises(tsc.CaptionError, match="failed to load model"):
        wcpp.transcribe_step(str(wav), job, {"model": "medium"})


def test_run_cancels(tmp_path, monkeypatch):
    cli = _mk_cli(tmp_path, SLEEP_CLI)
    models = tmp_path / "models"
    models.mkdir()
    (models / "ggml-medium.bin").write_bytes(b"x")
    monkeypatch.setenv("VTS_WHISPER_CLI", str(cli))
    monkeypatch.setenv("VTS_WHISPER_MODELS", str(models))
    wav = _mk_wav(tmp_path / "in.wav")
    job = tsc._new_job("caption", "fake.mp4")
    threading.Timer(0.6, job["_cancel"].set).start()
    t0 = time.time()
    with pytest.raises(tsc.Cancelled):
        wcpp.transcribe_step(str(wav), job, {"model": "medium"})
    assert time.time() - t0 < 10                     # did not wait for sleep 20


# ------------------------------------------------------------- downloads

def test_start_download_unknown_model():
    with pytest.raises(tsc.CaptionError):
        wcpp.start_download("nope")


def test_start_download_existing_file_done(tmp_path, monkeypatch):
    models = tmp_path / "models"
    models.mkdir()
    (models / "ggml-tiny.bin").write_bytes(b"already here")
    monkeypatch.setenv("VTS_WHISPER_MODELS", str(models))
    job = wcpp.start_download("tiny")
    for _ in range(50):
        job = tsc.get_job(job["id"])
        if job["state"] != "running":
            break
        time.sleep(0.05)
    assert job["state"] == "done" and job["progress"] == 100.0


# -------------------------------------------------- transcribe.py dispatch

def test_start_caption_whispercpp_validates_cli(tmp_path, monkeypatch):
    monkeypatch.delenv("VTS_WHISPER_CLI", raising=False)
    monkeypatch.setenv("PATH", str(tmp_path))        # no whisper-cli anywhere
    video = tmp_path / "v.mp4"
    video.write_bytes(b"x")
    with pytest.raises(tsc.CaptionError, match="whisper-cli not found"):
        tsc.start_caption(str(video), {"engine": "whispercpp", "model": "medium"})


def test_format_for_ui_includes_whispercpp():
    ui = tsc.format_for_ui()
    assert "whispercpp" in ui
    assert "catalog" in ui["whispercpp"] and "models_dir" in ui["whispercpp"]
