"""Tests for the auto-caption feature (faster-whisper integration).

Unit tests run anywhere. The end-to-end transcription test needs ffmpeg with
the `flite` filter (text-to-speech) plus the optional faster-whisper package,
and skips itself when either is missing.
"""

import builtins
import json
import os
import shutil
import subprocess
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from vts import detect as detect_mod            # noqa: E402
from vts import transcribe as cap_mod           # noqa: E402
from vts.ffprobe import probe                   # noqa: E402

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg / ffprobe not installed",
)


# ---------------------------------------------------------------------------
# Catalogs and dependency reporting
# ---------------------------------------------------------------------------

def test_language_catalog_covers_the_common_codes():
    langs = cap_mod.LANGUAGES
    assert len(langs) > 90
    assert langs["auto"].startswith("Auto")
    for code in ("id", "en", "ms", "jw", "zh", "ar", "es", "hi"):
        assert code in langs, f"missing language {code}"


def test_model_catalog_matches_the_cli_script():
    assert set(cap_mod.MODELS) >= {
        "tiny", "base", "small", "medium", "large-v3", "large-v3-turbo", "turbo"}
    for name, spec in cap_mod.MODELS.items():
        assert spec["size"] and spec["note"]


def test_ui_catalog_shape():
    ui = cap_mod.format_for_ui()
    assert {"languages", "models", "devices", "compute_types", "status"} <= set(ui)
    assert ui["devices"] == ["auto", "cuda", "cpu"]
    assert ui["status"]["available"] in (True, False)
    assert all({"code", "name"} == set(l) for l in ui["languages"])
    assert all({"name", "size", "note"} == set(m) for m in ui["models"])


def test_status_points_at_the_install_command_when_missing(monkeypatch):
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name.split(".")[0] == "faster_whisper":
            raise ImportError("No module named 'faster_whisper'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    status = cap_mod.dependency_status()
    assert status["available"] is False
    assert "faster-whisper" in status["install"]
    assert status["default_device"] == "cpu"
    # The hint must name the interpreter that actually runs the app: installing
    # into a different Python is the usual reason this warning never clears.
    assert sys.executable in status["install"]
    assert status["executable"] == sys.executable
    assert status["requirements"] == "requirements-caption.txt"


def test_available_status_reports_its_interpreter():
    status = cap_mod.dependency_status()
    if not status["available"]:
        pytest.skip("faster-whisper is not installed here")
    assert status["executable"] == sys.executable
    assert status["version"]


def test_pick_device_and_compute_resolves_auto(monkeypatch):
    monkeypatch.setattr(cap_mod, "dependency_status",
                        lambda: {"cuda_devices": 0})
    assert cap_mod.pick_device_and_compute("auto", "auto") == ("cpu", "int8")
    monkeypatch.setattr(cap_mod, "dependency_status",
                        lambda: {"cuda_devices": 2})
    assert cap_mod.pick_device_and_compute("auto", "auto") == ("cuda", "float16")
    # Explicit choices are never second-guessed.
    assert cap_mod.pick_device_and_compute("cpu", "float32") == ("cpu", "float32")
    assert cap_mod.pick_device_and_compute("cuda", "int8_float16") == ("cuda", "int8_float16")


# ---------------------------------------------------------------------------
# Start-up validation
# ---------------------------------------------------------------------------

@pytest.fixture()
def whisper_present(monkeypatch):
    """Pretend the optional dependency is installed, so validation runs."""
    monkeypatch.setattr(cap_mod, "dependency_status",
                        lambda: {"available": True, "cuda_devices": 0,
                                 "version": "test", "default_device": "cpu"})


def test_start_needs_the_optional_dependency(monkeypatch, tmp_path):
    monkeypatch.setattr(cap_mod, "dependency_status",
                        lambda: {"available": False, "install": "pip install faster-whisper"})
    video = tmp_path / "v.mp4"
    video.write_bytes(b"not really a video")
    with pytest.raises(cap_mod.CaptionError, match="faster-whisper"):
        cap_mod.start_caption(str(video), {})


@pytest.mark.parametrize("opts,message", [
    ({"model": "not-a-model"}, "Unknown model"),
    ({"language": "xx"}, "Unknown language"),
    ({"beam_size": 99}, "beam_size"),
    ({"device": "tpu"}, "device must be"),
    ({"compute_type": "quantum"}, "compute_type must be"),
])
def test_start_rejects_bad_options(whisper_present, tmp_path, opts, message):
    video = tmp_path / "v.mp4"
    video.write_bytes(b"x")
    with pytest.raises(cap_mod.CaptionError, match=message):
        cap_mod.start_caption(str(video), opts)


def test_start_reports_a_missing_video(whisper_present, tmp_path):
    with pytest.raises(cap_mod.CaptionError, match="not found"):
        cap_mod.start_caption(str(tmp_path / "nope.mp4"), {})


# ---------------------------------------------------------------------------
# Jobs: snapshots, cancellation, pruning
# ---------------------------------------------------------------------------

def test_job_snapshot_is_json_safe_and_masks_internals():
    job = cap_mod._new_job("caption", "/tmp/x.mp4")
    job["tail"].append({"t": "00:00:01,000", "text": "hi"})
    job["segments"] = [{"start": 0.0, "end": 1.0, "text": "hi", "words": []}]
    snap = cap_mod.get_job(job["id"])
    json.dumps(snap)                                    # must not raise
    assert "_cancel" not in snap and "segments" not in snap
    assert snap["segment_count"] == 1
    assert snap["tail"] == [{"t": "00:00:01,000", "text": "hi"}]
    assert snap["state"] == "running"


def test_cancel_sets_the_flag_and_is_reflected_in_the_note():
    job = cap_mod._new_job("caption", "/tmp/x.mp4")
    state = cap_mod.cancel_job(job["id"])
    assert cap_mod.JOBS[job["id"]]["_cancel"].is_set()
    assert state["note"].startswith("cancelling")
    assert cap_mod.cancel_job("missing-job") is None

    # A job that already finished is never resurrected into a cancelling state.
    finished = cap_mod._new_job("caption", "/tmp/y.mp4")
    cap_mod.JOBS[finished["id"]]["state"] = "done"
    cap_mod.JOBS[finished["id"]]["note"] = "10 segments"
    assert cap_mod.cancel_job(finished["id"])["state"] == "done"
    assert not cap_mod.JOBS[finished["id"]]["_cancel"].is_set()


def test_job_registry_prunes_finished_jobs_but_never_running_ones():
    cap_mod.JOBS.clear()
    ids = [cap_mod._new_job("caption", "/tmp/x.mp4")["id"]
           for _ in range(cap_mod.MAX_JOBS)]
    # Running jobs are kept: a user must be able to poll a long transcription.
    running = cap_mod._new_job("caption", "/tmp/x.mp4")["id"]
    assert cap_mod.get_job(ids[0]) is not None
    assert cap_mod.get_job(running) is not None

    for job_id in ids:
        cap_mod.JOBS[job_id]["state"] = "done"
    cap_mod._new_job("caption", "/tmp/x.mp4")
    assert cap_mod.JOBS.get(ids[0]) is None            # oldest finished evicted
    assert cap_mod.get_job(running) is not None


# ---------------------------------------------------------------------------
# Timestamps and caption files
# ---------------------------------------------------------------------------

def test_timestamp_formatters():
    assert cap_mod.to_srt_time(3661.5) == "01:01:01,500"
    assert cap_mod.to_vtt_time(3661.5) == "01:01:01.500"
    assert cap_mod.to_srt_time(-4) == "00:00:00,000"
    assert cap_mod.fmt_clock(75) == "01:15"
    assert cap_mod.fmt_clock(3675) == "1:01:15"


SEGMENTS = [
    {"start": 0.5, "end": 2.25, "text": "Bagian pertama.",
     "avg_logprob": -0.2, "no_speech_prob": 0.01,
     "words": [{"word": " Bagian", "start": 0.5, "end": 1.2, "probability": 0.9}]},
    {"start": 3.0, "end": 4.75, "text": "Kedua.",
     "avg_logprob": -0.3, "no_speech_prob": 0.02, "words": None},
]


def test_written_captions_parse_back_with_the_apps_own_parser(tmp_path):
    srt = tmp_path / "a.srt"
    vtt = tmp_path / "a.vtt"
    js = tmp_path / "a.json"
    cap_mod.write_srt(SEGMENTS, srt)
    cap_mod.write_vtt(SEGMENTS, vtt)
    cap_mod.write_json(SEGMENTS, {"model": "tiny", "language": "id"}, js)

    for path in (srt, vtt):
        cues = detect_mod.parse_subtitles(path.read_text(encoding="utf-8"))
        assert len(cues) == len(SEGMENTS)
        assert [c["text"] for c in cues] == [s["text"] for s in SEGMENTS]
        assert abs(cues[0]["start"] - 0.5) < 1e-6
        assert abs(cues[1]["end"] - 4.75) < 1e-6

    data = json.loads(js.read_text(encoding="utf-8"))
    assert data["info"]["model"] == "tiny"
    assert len(data["segments"]) == 2
    assert data["segments"][0]["words"][0]["probability"] == 0.9


def test_cues_text_matches_the_srt_body(tmp_path):
    srt = tmp_path / "b.srt"
    cap_mod.write_srt(SEGMENTS, srt)
    assert cap_mod.srt_to_cues_text(SEGMENTS) == srt.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Burn-in: orientation, audio, and visible pixels
# ---------------------------------------------------------------------------

def _dark_video(path, rotation=None):
    """Dark 320x240 clip with a tone, so burned-in text is easy to detect."""
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    if rotation is not None:
        cmd += ["-display_rotation", str(rotation)]
    flat = str(path) + ".flat.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=#101418:size=320x240:rate=15:duration=4",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=4",
        "-shortest", "-c:v", "libx264", "-preset", "ultrafast",
        "-pix_fmt", "yuv420p", "-c:a", "aac", flat,
    ], check=True, capture_output=True)
    if rotation is None:
        os.replace(flat, path)
        return str(path)
    subprocess.run(cmd + ["-i", flat, "-map", "0", "-c", "copy", str(path)],
                   check=True, capture_output=True)
    return str(path)


def _bright_pixels(path, t=1.0):
    raw = subprocess.run([
        "ffmpeg", "-v", "error", "-ss", str(t), "-i", path, "-frames:v", "1",
        "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ], capture_output=True, check=True).stdout
    return sum(1 for b in raw if b > 180)


def test_burn_subtitles_renders_text_and_keeps_orientation(tmp_path):
    src = _dark_video(tmp_path / "src.mp4", rotation=270)
    info = probe(src)
    assert info["video"]["has_display_matrix"]

    srt = tmp_path / "src.srt"
    srt.write_text("1\n00:00:00,500 --> 00:00:03,500\nBurned caption line\n\n",
                   encoding="utf-8")
    out = tmp_path / "src.captioned.mp4"
    before = _bright_pixels(src, t=1.0)
    assert before == 0                          # nothing bright in a dark clip
    cap_mod.burn_subtitles(src, str(srt), str(out))

    result = probe(str(out))
    # Same picture as the source shows: portrait pixels, no rotation tag.
    assert (result["video"]["width"], result["video"]["height"]) == (240, 320)
    assert result["video"]["rotation"] == 0
    assert not result["video"]["has_display_matrix"]
    # Audio is copied through and the captions are actually on the frame.
    assert result["audio"] is not None
    assert _bright_pixels(out, t=1.0) > before + 200


# ---------------------------------------------------------------------------
# End-to-end: speech -> captions
# ---------------------------------------------------------------------------

def _faster_whisper_ready() -> bool:
    try:
        import faster_whisper                            # noqa: F401
        return True
    except Exception:                                    # noqa: BLE001
        return False


def _has_flite() -> bool:
    try:
        probe_out = subprocess.run(["ffmpeg", "-hide_banner", "-filters"],
                                   capture_output=True, text=True, check=False)
    except OSError:
        return False
    return " flite " in (probe_out.stdout or "")


def test_transcribes_real_speech_end_to_end(tmp_path):
    """ffmpeg's flite voice -> faster-whisper -> .srt/.vtt/.json."""
    if not _faster_whisper_ready():
        pytest.skip("faster-whisper is not installed")
    if not _has_flite():
        pytest.skip("this ffmpeg build has no flite (text-to-speech) filter")

    video = tmp_path / "speech.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=navy:size=320x240:rate=15:duration=9",
        "-f", "lavfi", "-i", "flite=text='Hello world. This is an automatic "
                            "caption test.':voice=slt",
        "-shortest", "-c:v", "libx264", "-preset", "ultrafast",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "16000", "-ac", "1",
        str(video),
    ], check=True, capture_output=True)

    try:
        job = cap_mod.start_caption(str(video), {
            "model": "tiny", "language": "en", "device": "cpu",
            "compute_type": "int8", "output_dir": str(tmp_path),
            "word_timestamps": True,
        })
    except cap_mod.CaptionError as exc:                  # pragma: no cover
        pytest.skip(f"cannot start transcription here: {exc}")

    deadline = time.time() + 900
    state = cap_mod.get_job(job["id"])
    while time.time() < deadline and state["state"] == "running":
        time.sleep(1)
        state = cap_mod.get_job(job["id"])

    if state["state"] == "error":
        error = state.get("error") or ""
        if any(word in error.lower() for word in
               ("connection", "download", "resolve", "huggingface", "certificate")):
            pytest.skip(f"model download unavailable: {error[:200]}")
        pytest.fail(f"transcription failed: {error}\n{state.get('traceback', '')}")

    assert state["state"] == "done", state
    assert state["progress"] == 100.0
    assert state["stage"] == "writing"
    assert state["tail"], "live transcript tail was never filled"
    assert state["cues_text"], "UI needs the ready-to-parse cue text"

    outputs = state["outputs"]
    for key in ("srt", "vtt", "json"):
        assert os.path.isfile(outputs[key]), f"missing {key}"

    meta = state["meta"]
    assert meta["model"] == "tiny"
    assert meta["language"] == "en"
    assert meta["segments"] >= 1
    assert 1.5 < meta["duration"] < 15.0

    cues = detect_mod.parse_subtitles(open(outputs["srt"], encoding="utf-8").read())
    assert cues, "no cues written"
    words = " ".join(c["text"].lower() for c in cues)
    # Sentence-level check; tiny is not expected to be perfect word-for-word.
    assert any(w in words for w in ("hello", "world", "caption", "test", "automatic"))
    # Timings stay inside the clip.
    assert cues[0]["start"] >= 0 and cues[-1]["end"] <= meta["duration"] + 1.0

    # Word timestamps make it into the JSON for karaoke-style use.
    data = json.loads(open(outputs["json"], encoding="utf-8").read())
    assert data["segments"][0]["words"], "word timestamps missing from JSON"


# ---------------------------------------------------------------------------
# HTTP endpoints
# ---------------------------------------------------------------------------

@pytest.fixture()
def client(tmp_path, monkeypatch):
    import server
    from fastapi.testclient import TestClient
    monkeypatch.setattr(server, "PROJECT", None)
    return TestClient(server.app)


def test_env_exposes_the_caption_catalog(client):
    data = client.get("/api/env").json()
    caption = data["caption"]
    assert caption["status"]["available"] in (True, False)
    assert len(caption["languages"]) > 90
    assert any(m["name"] == "large-v3" for m in caption["models"])


def test_caption_endpoints_need_an_open_project(client, tmp_path):
    assert client.get("/api/caption").status_code == 200          # catalog is public
    assert client.post("/api/caption", json={}).status_code == 409
    assert client.get("/api/caption/deadbeef").status_code == 404
    assert client.post("/api/caption/deadbeef/cancel").status_code == 404


def test_caption_rejects_a_video_without_audio(client, tmp_path):
    silent = tmp_path / "silent.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=black:size=160x120:rate=10:duration=1",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        str(silent),
    ], check=True, capture_output=True)
    assert client.post("/api/open", json={"path": str(silent)}).status_code == 200
    res = client.post("/api/caption", json={})
    assert res.status_code == 400
    assert "audio" in res.json()["detail"].lower()


# ---------------------------------------------------------------------------
# Frontend wiring: the caption card must match between HTML and JS
# ---------------------------------------------------------------------------

def test_caption_dom_ids_exist_in_the_html():
    """Every element id the frontend looks up must exist in index.html."""
    import re
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    js = open(os.path.join(root, "static", "app.js"), encoding="utf-8").read()
    html = open(os.path.join(root, "static", "index.html"), encoding="utf-8").read()
    html_ids = set(re.findall(r'id="([^"]+)"', html))
    js_ids = set(re.findall(r'\$\("([A-Za-z0-9_]+)"\)', js))
    missing = sorted(js_ids - html_ids)
    assert not missing, f"app.js references ids that index.html does not define: {missing}"


def test_caption_card_is_wired_end_to_end():
    """The UI entry points for the feature are present in both files."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    js = open(os.path.join(root, "static", "app.js"), encoding="utf-8").read()
    html = open(os.path.join(root, "static", "index.html"), encoding="utf-8").read()
    for needle in ('/api/caption', 'capBtn', 'capUse', 'capCancel', 'fillCaptionCard'):
        assert needle in js, f"{needle} missing from app.js"
    assert "Auto-caption" in html
    assert 'id="cUse"' not in html            # no stale ids from other drafts


def test_speech_demo_endpoint_opens_the_spoken_clip(client):
    """The speech demo is the sample that can actually be auto-captioned."""
    res = client.post("/api/demo/speech")
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["info"]["name"] == "sample-speech.mp4"
    assert data["info"]["audio"] is not None          # it must have speech to transcribe
