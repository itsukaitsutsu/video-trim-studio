"""whisper.cpp engine: CLI detection, SRT parsing, subprocess run, downloads."""
import os
import stat
import sys
import threading
import time
import wave
from pathlib import Path

import json

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

# A build new enough for --output-json-full: it writes the token-level JSON
# that carries word timings (this is the shape whisper.cpp 1.8 emits).
FULL_CLI = """#!/bin/sh
OUT=""
FULL=0
while [ $# -gt 0 ]; do
  case "$1" in
    -of|--output-file) shift; OUT="$1" ;;
    --output-json-full) FULL=1 ;;
  esac
  shift
done
echo "system_info: fake build"
echo "[00:00:00.000 --> 00:00:04.000]   halo dunia"
printf '1\\n00:00:00,000 --> 00:00:04,000\\nhalo dunia\\n' > "$OUT.srt"
if [ "$FULL" = "1" ]; then
  cat > "$OUT.json" <<'JSON'
{"transcription":[{"timestamps":{"from":"00:00:00,000","to":"00:00:04,000"},
 "offsets":{"from":0,"to":4000},"text":" halo dunia.",
 "tokens":[
  {"text":"halo","timestamps":{"from":"00:00:00,000","to":"00:00:01,600"},"offsets":{"from":0,"to":1600}},
  {"text":" dunia","timestamps":{"from":"00:00:01,600","to":"00:00:03,900"},"offsets":{"from":1600,"to":3900}},
  {"text":".","timestamps":{"from":"00:00:03,900","to":"00:00:04,000"},"offsets":{"from":3900,"to":4000}}
 ]}]}
JSON
else
  echo '{}' > "$OUT.json"
fi
exit 0
"""

# An older build: it rejects the flag instead of ignoring it, which is what
# real releases do (whisper.cpp grew --output-json-full in 1.7).
OLD_CLI = """#!/bin/sh
for a in "$@"; do
  if [ "$a" = "--output-json-full" ]; then
    echo "error: unknown argument: --output-json-full" >&2
    exit 1
  fi
done
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    -of|--output-file) shift; OUT="$1" ;;
  esac
  shift
done
echo "[00:00:00.000 --> 00:00:02.000]   halo dunia"
printf '1\\n00:00:00,000 --> 00:00:02,000\\nhalo dunia\\n' > "$OUT.srt"
echo '{}' > "$OUT.json"
exit 0
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


# ------------------------------------------------- word timestamps (tokens)

def test_parse_json_full_merges_tokens_into_words():
    # whisper.cpp splits "halo" into sub-word tokens and emits "." on its own.
    text = json.dumps({"transcription": [{
        "timestamps": {"from": "00:00:00,000", "to": "00:00:04,000"},
        "offsets": {"from": 0, "to": 4000},
        "text": " halo dunia.",
        "tokens": [
            {"text": "halo", "offsets": {"from": 0, "to": 1600}},
            {"text": " dunia", "offsets": {"from": 1600, "to": 3900}},
            {"text": ".", "offsets": {"from": 3900, "to": 4000}},
        ],
    }]})
    segs = wcpp.parse_json_full(text)
    assert len(segs) == 1
    assert segs[0]["text"] == "halo dunia."
    assert segs[0]["words"] == [
        {"w": "halo", "s": 0.0, "e": 1.6},
        {"w": "dunia.", "s": 1.6, "e": 4.0},      # the "." rides along
    ]


def test_parse_json_full_returns_nothing_for_the_wrong_shape():
    assert wcpp.parse_json_full("{}") == []
    assert wcpp.parse_json_full('{"transcription": []}') == []


def test_build_command_asks_for_tokens_and_dtw_only_when_wanted():
    cmd = wcpp.build_command("wc", "/m.bin", "/a.wav", "/o", "id", False, None, 4)
    assert "--output-json-full" in cmd and "--dtw" not in cmd
    cmd = wcpp.build_command("wc", "/m.bin", "/a.wav", "/o", "id", False, None, 4,
                             words=True, dtw="medium")
    assert cmd[cmd.index("--dtw") + 1] == "medium"
    # No word timing requested -> no token output, no DTW.
    cmd = wcpp.build_command("wc", "/m.bin", "/a.wav", "/o", "id", False, None, 4,
                             words=False, dtw="medium")
    assert "--output-json-full" not in cmd and "--dtw" not in cmd


def test_dtw_preset_follows_the_model_family():
    assert wcpp.dtw_preset_for("large-v3-turbo") == "large.v3.turbo"
    assert wcpp.dtw_preset_for("Medium") == "medium"
    assert wcpp.dtw_preset_for("not-a-model") is None


def test_run_with_tokens_returns_words_and_burst_cues(tmp_path, monkeypatch):
    cli = _mk_cli(tmp_path, FULL_CLI)
    models = tmp_path / "models"
    models.mkdir()
    (models / "ggml-medium.bin").write_bytes(b"x")
    monkeypatch.setenv("VTS_WHISPER_CLI", str(cli))
    monkeypatch.setenv("VTS_WHISPER_MODELS", str(models))
    wav = _mk_wav(tmp_path / "in.wav")
    job = tsc._new_job("caption", "fake.mp4")
    segments, meta = wcpp.transcribe_step(str(wav), job, {"model": "medium"})
    assert meta["words"] == "tokens"
    assert [w["w"] for w in segments[0]["words"]] == ["halo", "dunia."]
    # ... and the shared cue builder turns them into word-timed captions.
    cues = tsc.build_cues(segments, {"segment_preset": "burst"}, "whispercpp")
    # The burst policy caps a cue at 2.5 s, and this segment runs 4 s, so it
    # comes out as two captions - cut exactly where the tokens say.
    assert [c["text"] for c in cues] == ["halo", "dunia."]
    assert [(c["start"], c["end"]) for c in cues] == [(0.0, 1.6), (1.6, 4.0)]
    assert [c["word_source"] for c in cues] == ["whispercpp", "whispercpp"]
    assert [w["w"] for w in cues[1]["words"]] == ["dunia."]


def test_a_build_without_token_output_still_produces_captions(tmp_path, monkeypatch):
    cli = _mk_cli(tmp_path, OLD_CLI)
    models = tmp_path / "models"
    models.mkdir()
    (models / "ggml-medium.bin").write_bytes(b"x")
    monkeypatch.setenv("VTS_WHISPER_CLI", str(cli))
    monkeypatch.setenv("VTS_WHISPER_MODELS", str(models))
    wav = _mk_wav(tmp_path / "in.wav")
    job = tsc._new_job("caption", "fake.mp4")
    segments, meta = wcpp.transcribe_step(str(wav), job, {"model": "medium"})
    # Retried without the flag rather than failing the job.
    assert meta["words"] == "none"
    assert [s["text"] for s in segments] == ["halo dunia"]
    assert not segments[0].get("words")
    cues = tsc.build_cues(segments, {"segment_preset": "burst"}, "whispercpp")
    assert cues[0]["text"] == "halo dunia"
    # No token timings: the cue gets an honest estimate instead of silence.
    assert cues[0]["word_source"] == "estimated"
    assert [w["w"] for w in cues[0]["words"]] == ["halo", "dunia"]


def test_cjk_tokens_become_one_word_each():
    """Japanese has no spaces: whisper.cpp emits a stream of per-character
    tokens, and each of those characters is a word a layout can cut at."""
    text = json.dumps({"transcription": [{
        "timestamps": {"from": "00:00:00,000", "to": "00:00:01,200"},
        "offsets": {"from": 0, "to": 1200},
        "text": "こんにちは世界。",
        "tokens": [{"text": t, "offsets": {"from": i * 150, "to": (i + 1) * 150}}
                   for i, t in enumerate("こんにちは世界。")],
    }]})
    segs = wcpp.parse_json_full(text)
    assert [w["w"] for w in segs[0]["words"]] == ["こ", "ん", "に", "ち", "は", "世", "界。"]
    assert segs[0]["words"][0]["s"] == 0.0 and segs[0]["words"][0]["e"] == 0.15
    assert segs[0]["words"][-1]["e"] == 1.2


def test_japanese_tokens_reach_burst_captions(monkeypatch):
    """The per-character fallback (no dictionary installed)."""
    from vts import morph
    monkeypatch.setattr(morph, "provider", lambda lang=None: None)
    toks = [{"text": t, "offsets": {"from": i * 150, "to": (i + 1) * 150}}
            for i, t in enumerate("こんにちは世界。")]
    segment = {"start": 0.0, "end": 1.2, "text": "こんにちは世界。",
               "words": wcpp.words_from_tokens(toks)}
    cues = tsc.build_cues([segment], {"segment_preset": "burst"}, "whispercpp")
    assert [c["text"] for c in cues] == ["こんに", "ちは世", "界。"]
    assert [c["word_source"] for c in cues] == ["whispercpp"] * 3
    assert cues[0]["words"][0]["w"] == "こ" and cues[-1]["words"][-1]["w"] == "界。"


def test_latin_tokens_still_merge_into_words():
    # The CJK rule must not break English: " world" continues nothing, "ing"
    # continues the word before it.
    toks = [{"text": " test", "offsets": {"from": 0, "to": 300}},
            {"text": "ing", "offsets": {"from": 300, "to": 500}},
            {"text": " one", "offsets": {"from": 500, "to": 800}}]
    assert [w["w"] for w in wcpp.words_from_tokens(toks)] == ["testing", "one"]


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
