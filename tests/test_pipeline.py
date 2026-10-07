"""End-to-end test: generate a video with real silences, detect, cut, verify.

Skipped automatically when ffmpeg is not installed.
"""

import os
import shutil
import subprocess
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from vts import detect, export
from vts.ffprobe import probe, source_match_profile

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg / ffprobe not installed",
)

DUR = 20.0
SILENCES = [(4.0, 6.5), (9.0, 12.0)]

SRT = """1
00:00:00,500 --> 00:00:03,800
Bagian pertama.

2
00:00:07,000 --> 00:00:08,800
Bagian kedua.

3
00:00:13,000 --> 00:00:19,000
Bagian ketiga.
"""


@pytest.fixture(scope="module")
def source(tmp_path_factory):
    path = str(tmp_path_factory.mktemp("media") / "source.mp4")
    af = ("volume=enable='between(t,4,6.5)':volume=0,"
          "volume=enable='between(t,9,12)':volume=0")
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"testsrc=size=320x240:rate=30:duration={DUR}",
        "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={DUR}",
        "-af", af,
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-b:v", "1500k", "-maxrate", "2250k",
        "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart", path,
    ], check=True, capture_output=True)
    return path


def test_probe_reads_source(source):
    info = probe(source)
    assert info["video"]["codec"] == "h264"
    assert (info["video"]["width"], info["video"]["height"]) == (320, 240)
    assert abs(info["video"]["fps"] - 30) < 0.1
    assert info["audio"]["codec"] == "aac"
    assert info["audio"]["sample_rate"] == 48000
    assert info["audio"]["channels"] == 2
    assert abs(info["duration"] - DUR) < 0.5


def test_silence_detection_finds_the_gaps(source):
    found = detect.detect_silences(source, -45.0, 800, DUR)
    assert len(found) >= 2
    for want_start, want_end in SILENCES:
        assert any(abs(s - want_start) < 0.35 and abs(e - want_end) < 0.35
                   for s, e in found), f"missed silence {want_start}-{want_end} in {found}"


def test_sections_carry_caption_text(source):
    info = probe(source)
    silences = detect.detect_silences(source, -45.0, 800, DUR)
    secs = detect.build_sections(info["duration"], silences, detect.parse_subtitles(SRT))
    texts = " ".join(s.text for s in secs if s.kind == "caption")
    assert "Bagian pertama" in texts
    assert "Bagian ketiga" in texts
    assert any(s.kind == "silence" for s in secs)


def test_export_matches_source_profile(source, tmp_path):
    info = probe(source)
    prof = source_match_profile(info)
    prof["codec"] = "libx264"          # CPU encoder: works everywhere
    prof["preset"] = "ultrafast"
    prof["hwaccel"] = "none"
    out = str(tmp_path / "clean.mp4")

    job = export.export(source, info, [list(s) for s in SILENCES], prof, out)
    assert job["kind"] == "reencode"

    deadline = time.time() + 180
    while time.time() < deadline:
        state = export.get_job(job["id"])
        if state["state"] in ("done", "error"):
            break
        time.sleep(0.3)
    state = export.get_job(job["id"])
    assert state["state"] == "done", f"export failed: {state.get('error')}"
    assert os.path.exists(out)

    result = probe(out)
    expected_dur = DUR - (6.5 - 4.0) - (12.0 - 9.0)   # 14.5 s

    # --- "same format" assertions -------------------------------------------
    assert result["video"]["codec"] == info["video"]["codec"]
    assert (result["video"]["width"], result["video"]["height"]) == (320, 240)
    assert abs(result["video"]["fps"] - info["video"]["fps"]) < 0.2
    assert result["video"]["pix_fmt"] == info["video"]["pix_fmt"]
    assert result["audio"]["codec"] == info["audio"]["codec"]
    assert result["audio"]["sample_rate"] == info["audio"]["sample_rate"]
    assert result["audio"]["channels"] == info["audio"]["channels"]
    assert result["container"] == info["container"]
    assert abs(result["duration"] - expected_dur) < 0.6

    # bitrate stays in the same ballpark as the source profile we asked for
    src_kbps = prof["video_bitrate_kbps"]
    out_kbps = result["video"]["bitrate_bps"] / 1000
    assert out_kbps > src_kbps * 0.25, f"video bitrate collapsed: {out_kbps} vs {src_kbps}"


def test_export_rejects_empty_and_total_selection(source, tmp_path):
    info = probe(source)
    prof = source_match_profile(info)
    with pytest.raises(export.JobError):
        export.export(source, info, [], prof, str(tmp_path / "x.mp4"))
    with pytest.raises(export.JobError):
        export.export(source, info, [[0.0, DUR]], prof, str(tmp_path / "x.mp4"))


def test_hardware_encoder_failure_falls_back_to_cpu(source, tmp_path):
    info = probe(source)
    prof = source_match_profile(info)
    prof.update(codec="not_real_amf", hwaccel="none", preset="ultrafast")
    out = str(tmp_path / "fallback.mp4")
    job = export.export(source, info, [list(SILENCES[0])], prof, out)
    deadline = time.time() + 180
    while time.time() < deadline:
        state = export.get_job(job["id"])
        if state["state"] in ("done", "error"):
            break
        time.sleep(0.25)
    state = export.get_job(job["id"])
    assert state["state"] == "done", f"CPU fallback failed: {state.get('error')}"
    assert "retrying with libx264" in state.get("note", "")
    assert probe(out)["video"]["codec"] == "h264"


def test_stream_copy_mode_produces_a_playable_file(source, tmp_path):
    info = probe(source)
    prof = source_match_profile(info)
    out = str(tmp_path / "copy.mp4")
    job = export.export(source, info, [list(SILENCES[0])], {**prof, "mode": "copy"}, out)
    deadline = time.time() + 120
    while time.time() < deadline:
        state = export.get_job(job["id"])
        if state["state"] in ("done", "error"):
            break
        time.sleep(0.2)
    state = export.get_job(job["id"])
    assert state["state"] == "done", f"copy failed: {state.get('error')}"
    result = probe(out)
    assert result["video"]["codec"] == info["video"]["codec"]
    # keyframe snapping means the cut is approximate, but it must be shorter
    assert result["duration"] < info["duration"]
