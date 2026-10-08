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
from pathlib import Path

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


# ---------------------------------------------------------------------------
# Editable captions: validation, manual sets, saving back to disk
# ---------------------------------------------------------------------------

def test_validate_cues_normalises_and_sorts():
    cues = cap_mod.validate_cues([
        {"start": "2.5", "end": 4, "text": "  second  "},
        {"start": 0, "end": "1.99999", "text": "first"},
        {"start": 1, "end": 2, "text": None},          # no text -> empty cue
    ])
    assert [c["text"] for c in cues] == ["first", "", "second"]
    assert [c["start"] for c in cues] == [0.0, 1.0, 2.5]
    assert cues[1]["end"] == 2.0                        # rounded to ms
    assert cap_mod.validate_cues([]) == []              # empty is legal


@pytest.mark.parametrize("raw,match", [
    ("nope", "must be a list"),
    ([{"start": 1, "text": "x"}], "numbers"),           # missing end
    ([{"start": 2, "end": 1, "text": "x"}], "after start"),
    ([{"start": -1, "end": 1, "text": "x"}], "0 or later"),
    ([{"start": float("nan"), "end": 1, "text": "x"}], "not a valid number"),
    ([{"start": 0, "end": float("inf"), "text": "x"}], "not a valid number"),
    ([{"start": 0, "end": 1, "text": 5}], "must be a string"),
    ([42], "expected an object"),
    ([{"start": 0, "end": 99 * 3600, "text": "x"}], "24-hour"),
])
def test_validate_cues_rejects_bad_input(raw, match):
    with pytest.raises(cap_mod.CaptionError, match=match):
        cap_mod.validate_cues(raw)


def test_manual_set_starts_blank_without_the_optional_dependency(monkeypatch, tmp_path):
    """Editing captions must work on machines without faster-whisper."""
    monkeypatch.setattr(cap_mod, "dependency_status",
                        lambda: {"available": False, "install": "pip x"})
    video = tmp_path / "v.mp4"
    video.write_bytes(b"pretend video")
    job = cap_mod.start_manual_captions(str(video))
    state = cap_mod.get_job(job["id"])
    assert state["state"] == "manual"
    assert state["kind"] == "manual"
    assert state["cues"] == []
    assert state["outputs"]["srt"].endswith("v.srt")
    assert "Blank caption set" in state["note"]


def test_manual_set_loads_an_existing_sidecar(tmp_path):
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"x")
    srt = tmp_path / "clip.srt"
    srt.write_text("1\n00:00:01,000 --> 00:00:02,500\nHello there\n\n"
                   "2\n00:00:03,000 --> 00:00:04,000\nSecond line\n\n",
                   encoding="utf-8")
    job = cap_mod.start_manual_captions(str(video), sidecar=str(srt))
    assert job["cues"] == [
        {"start": 1.0, "end": 2.5, "text": "Hello there"},
        {"start": 3.0, "end": 4.0, "text": "Second line"},
    ]
    assert "2 cue(s)" in job["note"]


def test_manual_set_reports_an_unreadable_sidecar(tmp_path):
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"x")
    with pytest.raises(cap_mod.CaptionError, match="Cannot read"):
        cap_mod.start_manual_captions(str(video), sidecar=str(tmp_path / "gone.srt"))


def test_update_cues_rewrites_the_caption_files(tmp_path):
    video = tmp_path / "v.mp4"
    video.write_bytes(b"x")
    job = cap_mod.start_manual_captions(str(video), str(tmp_path))
    saved = cap_mod.update_cues(job["id"], [
        {"start": 2.0, "end": 3.5, "text": "edited second"},
        {"start": 0.5, "end": 1.25, "text": "edited first"},
    ])
    assert saved["edited"] is True
    assert saved["edited_at"]
    assert [c["text"] for c in saved["cues"]] == ["edited first", "edited second"]
    srt = Path(saved["outputs"]["srt"]).read_text(encoding="utf-8")
    assert "00:00:00,500 --> 00:00:01,250" in srt and "edited first" in srt
    assert srt.index("edited first") < srt.index("edited second")
    assert Path(saved["outputs"]["vtt"]).read_text(encoding="utf-8").startswith("WEBVTT")
    parsed = detect_mod.parse_subtitles(
        Path(saved["outputs"]["srt"]).read_text(encoding="utf-8"))
    assert len(parsed) == 2 and parsed[0]["text"] == "edited first"
    assert "edited second" in saved["cues_text"]
    meta = json.loads(Path(saved["outputs"]["json"]).read_text(encoding="utf-8"))
    assert meta["info"]["edited"] is True and meta["info"]["cue_count"] == 2


def test_update_cues_rejects_unknown_or_running_jobs(tmp_path):
    video = tmp_path / "v.mp4"
    video.write_bytes(b"x")
    assert cap_mod.update_cues("deadbeef0000", []) is None
    running = cap_mod._new_job("caption", str(video))     # still 'running'
    with pytest.raises(cap_mod.CaptionError, match="still running"):
        cap_mod.update_cues(running["id"], [{"start": 0, "end": 1, "text": "x"}])
    with pytest.raises(cap_mod.CaptionError, match="Cue 1"):
        manual = cap_mod.start_manual_captions(str(video))
        cap_mod.update_cues(manual["id"], [{"start": 5, "end": 2, "text": "x"}])


# ---------------------------------------------------------------------------
# Editable captions over HTTP
# ---------------------------------------------------------------------------

def test_caption_editor_roundtrip_over_http(client, tmp_path):
    """Blank set -> edit cues -> files on disk -> detection sees the edits."""
    video = tmp_path / "editable.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=gray:size=160x120:rate=10:duration=5",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        str(video),
    ], check=True, capture_output=True)
    assert client.post("/api/open", json={"path": str(video)}).status_code == 200

    res = client.post("/api/caption/manual", json={})
    assert res.status_code == 200, res.text
    job = res.json()
    assert job["state"] == "manual" and job["cues"] == []

    res = client.put(f"/api/caption/{job['id']}/cues", json={"cues": [
        {"start": 3.0, "end": 4.2, "text": "moved later"},
        {"start": 0.4, "end": 2.0, "text": "fixed text"},
    ]})
    assert res.status_code == 200, res.text
    saved = res.json()
    assert [c["text"] for c in saved["cues"]] == ["fixed text", "moved later"]
    assert Path(saved["outputs"]["srt"]).is_file()
    # GET returns the same editable copy.
    again = client.get(f"/api/caption/{job['id']}").json()
    assert again["cues"] == saved["cues"] and again["edited"] is True

    # Bad payloads are rejected with the cue-level message, not a traceback.
    bad = client.put(f"/api/caption/{job['id']}/cues",
                     json={"cues": [{"start": 4, "end": 1, "text": "x"}]})
    assert bad.status_code == 400 and "after start" in bad.json()["detail"]
    assert client.put("/api/caption/deadbeef/cues",
                      json={"cues": []}).status_code == 404

    # Detection reads the edited file and marks the caption sections.
    det = client.post("/api/detect", json={
        "detect_silence": False, "use_cues": True,
        "subtitles_path": saved["outputs"]["srt"], "min_section_ms": 100,
    })
    assert det.status_code == 200, det.text
    data = det.json()
    assert data["cue_count"] == 2
    texts = [s["text"] for s in data["sections"] if s["kind"] == "caption"]
    assert "fixed text" in texts and "moved later" in texts


def test_manual_caption_open_srt_over_http(client, tmp_path):
    video = tmp_path / "side.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=gray:size=160x120:rate=10:duration=3",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        str(video),
    ], check=True, capture_output=True)
    srt = tmp_path / "imported.srt"
    srt.write_text("1\n00:00:00,200 --> 00:00:01,800\nImported line\n\n",
                   encoding="utf-8")
    assert client.post("/api/open", json={"path": str(video)}).status_code == 200

    job = client.post("/api/caption/manual", json={"load": str(srt)}).json()
    assert job["cues"][0]["text"] == "Imported line"

    missing = client.post("/api/caption/manual", json={"load": str(tmp_path / "no.srt")})
    assert missing.status_code == 400 and "not found" in missing.json()["detail"]
    wrong = client.post("/api/caption/manual", json={"load": str(video)})
    assert wrong.status_code == 400


def test_sidecar_is_reported_when_a_video_is_opened(client, tmp_path):
    video = tmp_path / "paired.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=gray:size=160x120:rate=10:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        str(video),
    ], check=True, capture_output=True)
    res = client.post("/api/open", json={"path": str(video)})
    assert res.status_code == 200
    assert res.json()["sidecar_subtitles"] is None       # nothing next to it yet
    srt = tmp_path / "paired.srt"
    srt.write_text("1\n00:00:00,000 --> 00:00:01,000\nhi\n\n", encoding="utf-8")
    res = client.post("/api/open", json={"path": str(video)})
    assert res.json()["sidecar_subtitles"] == str(srt)


def test_caption_editor_is_wired_between_html_and_js():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    js = open(os.path.join(root, "static", "app.js"), encoding="utf-8").read()
    html = open(os.path.join(root, "static", "index.html"), encoding="utf-8").read()
    for needle in ('capEditor', 'capSave', 'capAddCue', 'capRevert',
                   'capNewBtn', 'capOpenSrtBtn', 'capCueBody', '/cues'):
        assert needle in js, f"{needle} missing from app.js"
    for needle in ('capEditor', 'capSave', 'capAddCue', 'capRevert',
                   'capNewBtn', 'capOpenSrtBtn', 'capCueTable'):
        assert f'id="{needle}"' in html, f"id={needle} missing from index.html"


# ---------------------------------------------------------------------------
# Inline caption editing in the section list (double-click -> save to file)
# ---------------------------------------------------------------------------

SRT_THREE = ("1\n00:00:01,000 --> 00:00:02,500\nFirst line\n\n"
             "2\n00:00:02,500 --> 00:00:06,000\nA long line split by a pause\n\n"
             "3\n00:00:07,000 --> 00:00:08,000\nLast line\n\n")


def test_subtitle_edit_saves_back_to_srt(client, tmp_path):
    srt = tmp_path / "talk.srt"
    srt.write_text(SRT_THREE, encoding="utf-8")
    res = client.post("/api/subtitles/edit", json={
        "path": str(srt), "start": 1.0, "end": 2.5, "text": "Fixed first line"})
    assert res.status_code == 200, res.text
    assert res.json()["updated"] == 1
    cues = detect_mod.parse_subtitles(srt.read_text(encoding="utf-8"))
    assert [c["text"] for c in cues] == [
        "Fixed first line", "A long line split by a pause", "Last line"]
    assert len(cues) == 3                       # timings and count untouched


def test_subtitle_edit_updates_every_cue_under_a_split_row(client, tmp_path):
    """A pause inside one sentence shows as ONE row covering two cues."""
    srt = tmp_path / "split.srt"
    srt.write_text(
        "1\n00:00:02,000 --> 00:00:03,900\npart one\n\n"
        "2\n00:00:04,200 --> 00:00:05,000\npart two\n\n", encoding="utf-8")
    res = client.post("/api/subtitles/edit", json={
        "path": str(srt), "start": 2.0, "end": 5.0,
        "text": "one clean sentence"})
    assert res.json()["updated"] == 2
    cues = detect_mod.parse_subtitles(srt.read_text(encoding="utf-8"))
    assert all(c["text"] == "one clean sentence" for c in cues)


def test_subtitle_edit_keeps_vtt_format_and_flattens_newlines(client, tmp_path):
    vtt = tmp_path / "talk.vtt"
    vtt.write_text("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nold text\n\n",
                   encoding="utf-8")
    res = client.post("/api/subtitles/edit", json={
        "path": str(vtt), "start": 1.0, "end": 2.0,
        "text": "multi\nline\nbecomes one"})
    assert res.status_code == 200, res.text
    body = vtt.read_text(encoding="utf-8")
    assert body.startswith("WEBVTT")
    assert "multi line becomes one" in body and "old text" not in body


def test_subtitle_edit_rejects_bad_targets(client, tmp_path):
    missing = client.post("/api/subtitles/edit", json={
        "path": str(tmp_path / "nope.srt"), "start": 0, "end": 1, "text": "x"})
    assert missing.status_code == 404
    video = tmp_path / "movie.mp4"
    video.write_bytes(b"x")
    wrong = client.post("/api/subtitles/edit", json={
        "path": str(video), "start": 0, "end": 1, "text": "x"})
    assert wrong.status_code == 400
    srt = tmp_path / "t.srt"
    srt.write_text(SRT_THREE, encoding="utf-8")
    backwards = client.post("/api/subtitles/edit", json={
        "path": str(srt), "start": 5, "end": 2, "text": "x"})
    assert backwards.status_code == 400
    # A range that matches nothing changes nothing but is not an error.
    untouched = client.post("/api/subtitles/edit", json={
        "path": str(srt), "start": 100, "end": 101, "text": "x"})
    assert untouched.json()["updated"] == 0


def test_inline_edit_is_wired_between_html_and_js():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    js = open(os.path.join(root, "static", "app.js"), encoding="utf-8").read()
    html = open(os.path.join(root, "static", "index.html"), encoding="utf-8").read()
    for needle in ('/api/subtitles/edit', 'startCaptionEdit', 'commitCaptionEdit',
                   'dblclick', 'txt-edit'):
        assert needle in js, f"{needle} missing from app.js"
    assert "click a caption text to edit it" in html
    # Focusing the player on row click yanked the page up to the video, which
    # is what made inline editing unusable; keep it gone.
    assert "player.focus" not in js
    # Clicking a caption must bring that cue on screen: the seek lands INSIDE
    # the cue (seekIntoCue), never before it - seeking to/before the start
    # shows the previous frame and the caption is not visible.
    assert "seekIntoCue" in js
    assert "start - 0.1" not in js
    # The list editor live-syncs the preview box while typing.
    assert "syncPreview" in js and 'dataset.raw = input.value' in js
    # The preview box itself is editable: dblclick opens an on-video editor
    # that commits through the same path as the list editor.
    for needle in ("startOverlayCaptionEdit", "CAP_EDITING", "cap-edit"):
        assert needle in js, f"{needle} missing from app.js"
    assert "double-click to edit" in html
    # whisper.cpp engine (AMD/Vulkan) is wired end to end
    for needle in ('id="cEngine"', 'id="wcppPanel"', 'id="wModel"', 'id="wDlBtn"'):
        assert needle in html, f"{needle} missing from index.html"
    for needle in ("engineIsWcpp", "renderWcppPanel", "downloadWcppModel",
                   "/api/whispercpp/download"):
        assert needle in js, f"{needle} missing from app.js"
    srv = open(os.path.join(root, "server.py"), encoding="utf-8").read()
    assert "/api/whispercpp/status" in srv and "/api/whispercpp/download" in srv
    css = open(os.path.join(root, "static", "style.css"), encoding="utf-8").read()
    # the editor must opt back into text selection (capBox disables it for
    # dragging) or the textarea cannot be typed into
    assert "user-select: text" in css
    # transient focus flickers after the dblclick must not tear the editor
    # down; the dblclick default is suppressed at the source
    assert "document.activeElement !== ta" in js
    assert "ev.preventDefault();                       // no word-select/focus side effects" in js
    # Cache-busting query strings stop replaced files from serving stale JS.
    assert "app.js?v=" in html and "style.css?v=" in html


# ---------------------------------------------------------------------------
# Export with captions synced to the trimmed result
# ---------------------------------------------------------------------------

from vts import captionmap as cmap_mod      # noqa: E402


def test_remap_cues_shifts_splits_drops_and_merges():
    kept = [(0.0, 2.0), (4.0, 6.0)]          # cut 2-4 out of 6 s
    cues = [
        {"start": 0.5, "end": 1.5, "text": "a"},
        {"start": 1.5, "end": 4.5, "text": "b"},     # spans the cut
        {"start": 2.2, "end": 3.8, "text": "gone"},  # entirely removed
        {"start": 5.0, "end": 5.8, "text": "c"},
    ]
    out = cmap_mod.remap_cues(cues, kept)
    assert out == [
        {"start": 0.5, "end": 1.5, "text": "a"},
        {"start": 1.5, "end": 2.5, "text": "b"},     # merged back together
        {"start": 3.0, "end": 3.8, "text": "c"},     # shifted 2 s earlier
    ]


def test_remap_cues_no_cuts_is_identity():
    cues = [{"start": 1.0, "end": 2.0, "text": "x"}]
    assert cmap_mod.remap_cues(cues, [(0.0, 10.0)]) == cues


def _make_clip(path, duration=6):
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"color=c=gray:size=160x120:rate=10:duration={duration}",
        "-f", "lavfi", "-i", f"sine=frequency=330:duration={duration}",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", str(path),
    ], check=True, capture_output=True)


def _wait_job(client, job_id, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/api/job/{job_id}").json()
        if job["state"] != "running":
            return job
        time.sleep(0.5)
    raise AssertionError(f"export job {job_id} did not finish in time")


def test_export_writes_remapped_srt(client, tmp_path):
    video = tmp_path / "podcast.mp4"
    _make_clip(video, 6)
    srt = tmp_path / "podcast.srt"
    srt.write_text(
        "1\n00:00:00,500 --> 00:00:01,500\nbefore the cut\n\n"
        "2\n00:00:01,500 --> 00:00:04,500\nspans the cut\n\n"
        "3\n00:00:05,000 --> 00:00:05,800\nafter the cut\n\n", encoding="utf-8")
    out = tmp_path / "podcast.clean.mp4"
    assert client.post("/api/open", json={"path": str(video)}).status_code == 200

    res = client.post("/api/export", json={
        "deletions": [[2, 4]], "output": str(out),
        "opts": {"mode": "reencode", "codec": "libx264"},
        "subtitles_path": str(srt), "caption_mode": "srt",
    })
    assert res.status_code == 200, res.text
    job = res.json()
    assert job["captions"]["cues_in"] == 3 and job["captions"]["cues_out"] == 3
    done = _wait_job(client, job["id"])
    assert done["state"] == "done", done.get("error")
    assert out.is_file()
    remapped = Path(job["captions"]["srt"])
    assert remapped.is_file() and remapped.with_suffix("").name == out.stem
    cues = detect_mod.parse_subtitles(remapped.read_text(encoding="utf-8"))
    assert [(c["start"], c["end"], c["text"]) for c in cues] == [
        (0.5, 1.5, "before the cut"),
        (1.5, 2.5, "spans the cut"),       # split pieces merged, shifted
        (3.0, 3.8, "after the cut"),       # 2 s earlier than the source
    ]


def test_export_burns_captions_and_upgrades_copy_mode(client, tmp_path):
    video = tmp_path / "burn.mp4"
    _make_clip(video, 6)
    srt = tmp_path / "burn.srt"
    srt.write_text("1\n00:00:00,200 --> 00:00:01,800\nburned line\n\n",
                   encoding="utf-8")
    out = tmp_path / "burn.clean.mp4"
    assert client.post("/api/open", json={"path": str(video)}).status_code == 200

    # stream copy + burn must transparently upgrade to re-encode
    res = client.post("/api/export", json={
        "deletions": [[2, 4]], "output": str(out), "opts": {"mode": "copy"},
        "subtitles_path": str(srt), "caption_mode": "burn",
    })
    assert res.status_code == 200, res.text
    job = res.json()
    assert job["kind"] == "reencode"
    assert "burn" in job["note"].lower() or "re-encod" in job["note"].lower()
    done = _wait_job(client, job["id"])
    assert done["state"] == "done", done.get("error")
    assert out.is_file()
    info = probe(str(out))
    assert abs(float(info["duration"]) - 4.0) < 0.5     # 6 s minus the 2 s cut
    # the remapped srt used for burning is left next to the export
    assert job["captions"]["srt"].endswith("burn.clean.srt")
    assert Path(job["captions"]["srt"]).is_file()


def test_export_caption_validation(client, tmp_path):
    video = tmp_path / "v.mp4"
    _make_clip(video, 3)
    assert client.post("/api/open", json={"path": str(video)}).status_code == 200
    base = {"deletions": [[1, 2]], "opts": {"mode": "reencode"}}
    res = client.post("/api/export", json={**base, "caption_mode": "srt"})
    assert res.status_code == 400 and "subtitle file" in res.json()["detail"].lower()
    res = client.post("/api/export", json={
        **base, "caption_mode": "srt", "subtitles_path": str(tmp_path / "no.srt")})
    assert res.status_code == 404
    res = client.post("/api/export", json={
        **base, "caption_mode": "wrong", "subtitles_path": str(video)})
    assert res.status_code == 400


def test_export_caption_controls_are_wired():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    js = open(os.path.join(root, "static", "app.js"), encoding="utf-8").read()
    html = open(os.path.join(root, "static", "index.html"), encoding="utf-8").read()
    for needle in ("xCaptions", "caption_mode", "subtitles_path",
                   "updateCaptionExportInfo", "job.captions"):
        assert needle in js, f"{needle} missing from app.js"
    assert 'id="xCaptions"' in html and 'id="xCapInfo"' in html
    assert "app.js?v=14" in html


# ---------------------------------------------------------------------------
# CapCut-style caption positioning: overlay position burned via ASS
# ---------------------------------------------------------------------------

def test_write_ass_places_every_cue_at_the_chosen_point(tmp_path):
    out = tmp_path / "cap.ass"
    cmap_mod.write_ass(
        [{"start": 0.5, "end": 2.25, "text": "hello world"},
         {"start": 3.0, "end": 4.0, "text": ""}],        # empty cue skipped
        out, width=1280, height=720, x=0.5, y=0.5, size_pct=10.0)
    body = out.read_text(encoding="utf-8")
    assert "PlayResX: 1280" in body and "PlayResY: 720" in body
    assert "{\\an5\\pos(640,360)}hello world" in body
    assert "Fontsize" not in body or ",Arial,72," in body   # size lives in the style
    assert body.count("Dialogue:") == 1                   # empty cue dropped
    assert "0:00:00.50,0:00:02.25," in body               # ASS centisecond stamps


def test_write_ass_clamps_and_sanitises(tmp_path):
    out = tmp_path / "cap.ass"
    cmap_mod.write_ass([{"start": -1, "end": 1, "text": "a {tag} b"}],
                       out, 320, 240, x=5, y=-3, size_pct=99)
    body = out.read_text(encoding="utf-8")
    assert "\\pos(320,0)" in body                         # clamped to the frame
    assert "{tag}" not in body and "a (tag) b" in body    # tags neutralised
    assert "0:00:00.00,0:00:01.00," in body


def test_export_burns_at_the_preview_position(client, tmp_path):
    video = tmp_path / "pos.mp4"
    _make_clip(video, 5)
    srt = tmp_path / "pos.srt"
    srt.write_text("1\n00:00:00,300 --> 00:00:03,000\ndragged caption\n\n",
                   encoding="utf-8")
    out = tmp_path / "pos.clean.mp4"
    assert client.post("/api/open", json={"path": str(video)}).status_code == 200
    res = client.post("/api/export", json={
        "deletions": [[3.5, 4.5]], "output": str(out),
        "opts": {"mode": "reencode", "codec": "libx264"},
        "subtitles_path": str(srt), "caption_mode": "burn",
        "caption_style": {"x": 0.5, "y": 0.33, "size_pct": 8},
    })
    assert res.status_code == 200, res.text
    job = res.json()
    assert job["captions"]["positioned"] is True
    done = _wait_job(client, job["id"])
    assert done["state"] == "done", done.get("error")
    assert out.is_file()
    info = probe(str(out))
    assert abs(float(info["duration"]) - 4.0) < 0.5
    # the temp ASS is cleaned up after the job
    time.sleep(0.3)
    assert not Path(job["id"]).exists()  # sanity: id is not a path
    import glob
    assert not glob.glob(str(tmp_path / "*.ass"))


def test_export_burn_without_style_keeps_plain_srt(client, tmp_path):
    video = tmp_path / "nostyle.mp4"
    _make_clip(video, 4)
    srt = tmp_path / "nostyle.srt"
    srt.write_text("1\n00:00:00,200 --> 00:00:01,000\nplain\n\n", encoding="utf-8")
    out = tmp_path / "nostyle.clean.mp4"
    assert client.post("/api/open", json={"path": str(video)}).status_code == 200
    res = client.post("/api/export", json={
        "deletions": [[2, 3]], "output": str(out),
        "opts": {"mode": "reencode", "codec": "libx264"},
        "subtitles_path": str(srt), "caption_mode": "burn",
        "caption_style": {},
    })
    assert res.json()["captions"]["positioned"] is False
    done = _wait_job(client, res.json()["id"])
    assert done["state"] == "done", done.get("error")


def test_caption_overlay_is_wired_between_html_and_js():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    js = open(os.path.join(root, "static", "app.js"), encoding="utf-8").read()
    html = open(os.path.join(root, "static", "index.html"), encoding="utf-8").read()
    for needle in ("CAPPOS", "capOverlay", "capBox", "bindCaptionOverlay",
                   "caption_style", "videoContentRect", "guideV", "SNAP_X"):
        assert needle in js, f"{needle} missing from app.js"
    for needle in ("capOverlay", "capBox", "capBoxText", "guideV", "guideH",
                   "capStyleRow", "capFontSize", "capPosReset", "capPosInfo"):
        assert f'id="{needle}"' in html, f"id={needle} missing from index.html"
    assert "app.js?v=14" in html


# ---------------------------------------------------------------------------
# Imported (uploaded) captions must be editable, not read-only
# ---------------------------------------------------------------------------

def test_uploaded_subtitles_are_persisted_and_editable(client, tmp_path):
    video = tmp_path / "imp.mp4"
    _make_clip(video, 4)
    assert client.post("/api/open", json={"path": str(video)}).status_code == 200

    srt_bytes = ("1\n00:00:00,300 --> 00:00:01,900\nimported line\n\n"
                 "2\n00:00:02,200 --> 00:00:03,400\nsecond line\n\n").encode()
    res = client.post("/api/parse-subtitles",
                      files={"file": ("mysubs.srt", srt_bytes, "text/plain")})
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["count"] == 2
    saved = data.get("saved_path")
    assert saved and Path(saved).is_file()
    assert saved.endswith(".srt") and "mysubs" in Path(saved).name
    assert Path(saved).read_bytes() == srt_bytes

    # Detection reads the saved file, then an inline edit writes back to it.
    det = client.post("/api/detect", json={
        "detect_silence": False, "use_cues": True,
        "subtitles_path": saved, "min_section_ms": 100})
    assert det.json()["cue_count"] == 2
    edit = client.post("/api/subtitles/edit", json={
        "path": saved, "start": 0.3, "end": 1.9, "text": "imported line (fixed)"})
    assert edit.json()["updated"] == 1
    assert "imported line (fixed)" in Path(saved).read_text(encoding="utf-8")


def test_uploaded_subtitles_without_extension_get_srt(client):
    res = client.post("/api/parse-subtitles",
                      files={"file": ("noext", b"1\n00:00:00,000 --> 00:00:01,000\nhi\n\n",
                                       "application/octet-stream")})
    assert res.status_code == 200, res.text
    assert res.json()["saved_path"].endswith(".srt")


def test_upload_handler_points_the_path_at_the_saved_file():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    js = open(os.path.join(root, "static", "app.js"), encoding="utf-8").read()
    assert 'data.saved_path' in js                    # path filled from the upload
    assert '$("dSubPath").value = "";' not in js.split("dSubFile", 1)[1].split("};", 1)[0]
    assert "app.js?v=14" in open(os.path.join(root, "static", "index.html"),
                                 encoding="utf-8").read()


# ---------------------------------------------------------------------------
# Alignment modes + resizable box (wrap, justify, per-line placement)
# ---------------------------------------------------------------------------

def test_wrap_lines_greedy_with_hard_break():
    lines = cmap_mod.wrap_lines("aa bb cc dd", 5)
    assert lines == ["aa bb", "cc dd"]
    long = cmap_mod.wrap_lines("abcdefghij k", 4)
    assert long[0] == "abcd" and long[1] == "efgh"      # hard-broken word
    assert cmap_mod.wrap_lines("", 10) == [""]


def test_write_ass_alignment_and_box_width(tmp_path):
    text = "this caption is long enough to wrap into two lines"
    cues = [{"start": 1.0, "end": 2.0, "text": text}]
    out = tmp_path / "align.ass"
    cmap_mod.write_ass(cues, out, 1000, 1000, x=0.5, y=0.5, size_pct=10.0,
                       align="left", box_w=0.5)
    body = out.read_text(encoding="utf-8")
    assert body.count("Dialogue:") >= 2                  # wrapped to >= 2 lines
    assert "{\\an4\\pos(250," in body                    # left edge of the box
    assert "{\\an5\\pos(" not in body and "{\\an6\\pos(" not in body

    cmap_mod.write_ass(cues, out, 1000, 1000, x=0.5, y=0.5, size_pct=10.0,
                       align="right", box_w=0.5)
    body = out.read_text(encoding="utf-8")
    assert "{\\an6\\pos(750," in body                    # right edge



def test_export_burn_accepts_alignment_and_box_width(client, tmp_path):
    video = tmp_path / "al.mp4"
    _make_clip(video, 4)
    srt = tmp_path / "al.srt"
    srt.write_text(
        "1\n00:00:00,200 --> 00:00:03,000\njudul panjang yang pasti dibungkus dua baris\n\n",
        encoding="utf-8")
    out = tmp_path / "al.clean.mp4"
    assert client.post("/api/open", json={"path": str(video)}).status_code == 200
    res = client.post("/api/export", json={
        "deletions": [[3, 3.5]], "output": str(out),
        "opts": {"mode": "reencode", "codec": "libx264"},
        "subtitles_path": str(srt), "caption_mode": "burn",
        "caption_style": {"x": 0.5, "y": 0.2, "size_pct": 7,
                          "align": "right", "box_w": 0.6},
    })
    assert res.status_code == 200, res.text
    done = _wait_job(client, res.json()["id"])
    assert done["state"] == "done", done.get("error")
    assert out.is_file()


def test_alignment_and_resize_controls_are_wired():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    js = open(os.path.join(root, "static", "app.js"), encoding="utf-8").read()
    html = open(os.path.join(root, "static", "index.html"), encoding="utf-8").read()
    for needle in ("wrapText", "CHAR_FACTOR", "box_w", "capAlign", "syncAlignButtons",
                   "bindCaptionResize", "justify", "renderCaptionLines"):
        assert needle in js, f"{needle} missing from app.js"
    assert "justify_char" not in js and "justify_char" not in html  # JC mode removed
    for needle in ("capAlign", "cap-handle", ">J<"):
        assert needle in html, f"{needle} missing from index.html"
    assert "app.js?v=14" in html


def test_write_ass_justify_flushes_both_edges(tmp_path):
    """Justify = every line but the last spans the full box width: first word
    on the left edge, last word ending on the right edge (each word gets its
    own \pos, because libass itself cannot justify)."""
    text = "this caption is long enough to wrap into two lines"
    cues = [{"start": 1.0, "end": 2.0, "text": text}]
    out = tmp_path / "justify.ass"
    # fs = 40 px, char 22 px, box 800 px (100..900), 36 chars/line
    cmap_mod.write_ass(cues, out, 1000, 1000, x=0.5, y=0.5, size_pct=4.0,
                       align="justify", box_w=0.8)
    events = [l for l in out.read_text(encoding="utf-8").splitlines()
              if l.startswith("Dialogue:")]
    assert len(events) == 8          # 7 words placed + 1 left-aligned last line
    first = events[0].split(",,")[-1]
    assert first.startswith("{\\an4\\pos(100,") and first.endswith("}this")
    seventh = events[6].split(",,")[-1]   # "wrap" (88 px) ends at the right edge
    assert seventh.startswith("{\\an4\\pos(812,") and seventh.endswith("}wrap")
    last = events[7].split(",,")[-1]      # final line left-aligned, not centred
    assert last.startswith("{\\an4\\pos(100,") and last.endswith("}into two lines")

def test_resolve_fw_model_prefers_local_folder(tmp_path, monkeypatch):
    import vts.transcribe as t
    monkeypatch.setenv("VTS_FW_MODELS", str(tmp_path))
    assert t.resolve_fw_model("medium") == "medium"      # nothing local yet
    mdir = tmp_path / "medium"
    mdir.mkdir()
    (mdir / "model.bin").write_bytes(b"x")
    assert t.resolve_fw_model("medium") == str(mdir)     # local folder wins
