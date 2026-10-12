"""End-to-end test: generate a video with real silences, detect, cut, verify.

Skipped automatically when ffmpeg is not installed.
"""

import json
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
        "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p",
        "-g", "250", "-keyint_min", "250", "-sc_threshold", "0",
        "-b:v", "1500k", "-maxrate", "2250k",
        "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart", path,
    ], check=True, capture_output=True)
    return path


def _stream_timing(path):
    data = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries",
        "stream=codec_type,start_time,duration", "-of", "json", path,
    ], text=True))
    return {
        stream["codec_type"]: {
            "start": float(stream.get("start_time", 0.0)),
            "duration": float(stream.get("duration", 0.0)),
        }
        for stream in data["streams"]
    }


def _packet_dts(path, selector):
    data = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", selector,
        "-show_packets", "-show_entries", "packet=dts_time", "-of", "json", path,
    ], text=True))
    return [float(packet["dts_time"]) for packet in data["packets"]
            if packet.get("dts_time") not in (None, "N/A")]


def test_probe_reads_source(source):
    info = probe(source)
    assert info["video"]["codec"] == "h264"
    assert (info["video"]["width"], info["video"]["height"]) == (320, 240)
    assert abs(info["video"]["fps"] - 30) < 0.1
    assert info["audio"]["codec"] == "aac"
    assert info["audio"]["sample_rate"] == 48000
    assert info["audio"]["channels"] == 2
    assert abs(info["duration"] - DUR) < 0.5
    assert abs(info["video"]["start_time"]) < 0.05
    assert abs(info["audio"]["start_time"]) < 0.05


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


def test_stream_copy_multicut_falls_back_and_preserves_av_sync(source, tmp_path):
    """Multi-range concat can overlap DTS; copy mode must re-encode instead."""
    info = probe(source)
    prof = source_match_profile(info)
    prof.update(codec="libx264", preset="ultrafast", hwaccel="none")
    out = str(tmp_path / "copy-request-multicut.mp4")

    job = export.export(
        source, info, [list(SILENCES[0])], {**prof, "mode": "copy"}, out)
    assert job["kind"] == "reencode"
    assert "desynchronize" in job.get("note", "")

    deadline = time.time() + 180
    while time.time() < deadline:
        state = export.get_job(job["id"])
        if state["state"] in ("done", "error"):
            break
        time.sleep(0.2)
    state = export.get_job(job["id"])
    assert state["state"] == "done", f"sync-safe fallback failed: {state.get('error')}"

    result = probe(out)
    assert result["video"]["codec"] == info["video"]["codec"]
    assert result["duration"] < info["duration"]
    timing = _stream_timing(out)
    assert "video" in timing and "audio" in timing
    assert abs(timing["video"]["start"] - timing["audio"]["start"]) < 0.05
    assert abs(timing["video"]["duration"] - timing["audio"]["duration"]) < 0.12

    # The original failure included timestamp overlap across segments. A good
    # synchronized result must have monotonic DTS in both output streams.
    for selector in ("v:0", "a:0"):
        dts = _packet_dts(out, selector)
        assert dts
        assert all(current >= previous for previous, current in zip(dts, dts[1:]))


# ---------------------------------------------------------------------------
# Orientation: exports bake the source rotation/flip and write no tag
# ---------------------------------------------------------------------------

def _wait_for(job, timeout=180):
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = export.get_job(job["id"])
        if state["state"] in ("done", "error"):
            return state
        time.sleep(0.2)
    return export.get_job(job["id"])


def _requires_display_rotation():
    help_text = subprocess.run(
        ["ffmpeg", "-hide_banner", "-h", "full"], capture_output=True,
        text=True, check=False,
    )
    if "-display_rotation" not in (help_text.stdout + help_text.stderr):
        pytest.skip("installed FFmpeg cannot write a display rotation")


def _displayed_size(info):
    """Size a player shows: a 90/270 degree matrix is applied, a 180 is not."""
    v = info["video"]
    if abs(v["rotation"]) % 180 == 90:
        return v["height"], v["width"]
    return v["width"], v["height"]


def _shown_corners(path):
    """Colour name of each corner of the frame as a player displays it."""
    png = f"{path}.frame.png"
    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", path,
         "-frames:v", "1", png], check=True, capture_output=True)
    raw = subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", png, "-f", "rawvideo",
        "-pix_fmt", "rgb24", "-"])
    frame = probe(png)
    w, h = frame["video"]["width"], frame["video"]["height"]

    def name_at(x, y):
        i = 3 * (y * w + x)
        r, g, b = raw[i], raw[i + 1], raw[i + 2]
        if min(r, g, b) > 150:
            return "white"
        if r > 150 and g < 110 and b < 110:
            return "red"
        if g > 110 and r < 110 and b < 110:
            return "green"
        if b > 150 and r < 110 and g < 110:
            return "blue"
        return f"rgb({r},{g},{b})"

    return tuple(name_at(x, y) for x, y in (
        (w // 8, h // 8), (w - w // 8, h // 8),
        (w // 8, h - h // 8), (w - w // 8, h - h // 8)))


@pytest.fixture(scope="module")
def quadrant(tmp_path_factory):
    """Four distinctly coloured corners, so orientation is checkable per pixel."""
    path = str(tmp_path_factory.mktemp("orientation") / "quadrant.mp4")
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=black:size=320x240:rate=30:duration=4",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4",
        "-shortest",
        "-vf", ("drawbox=x=0:y=0:w=160:h=120:c=red:t=fill,"
                "drawbox=x=160:y=0:w=160:h=120:c=green:t=fill,"
                "drawbox=x=0:y=120:w=160:h=120:c=blue:t=fill,"
                "drawbox=x=160:y=120:w=160:h=120:c=white:t=fill"),
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", path,
    ], check=True, capture_output=True)
    return path


def _tagged(src, path, rotation):
    """A phone-style clip: pixels stored sideways, rotation tag on the stream."""
    _requires_display_rotation()
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-display_rotation", str(rotation), "-i", src, "-map", "0", "-c", "copy",
        path,
    ], check=True, capture_output=True)
    return path


@pytest.mark.parametrize("rotation", [90, 180, 270])
def test_export_bakes_orientation_and_writes_no_rotation_tag(
        quadrant, tmp_path, rotation):
    """A tagged source exports as upright pixels, with no display matrix.

    Regression: the re-encode path kept the source rotation tag instead of
    applying it, and the stream-copy fallback dropped it. Both left the visible
    orientation to the player, so clips came out sideways.
    """
    rotated = _tagged(quadrant, str(tmp_path / f"rotated-{rotation}.mp4"), rotation)
    info = probe(rotated)
    assert info["video"]["has_display_matrix"]
    assert info["video"]["rotation"] != 0

    prof = source_match_profile(info)
    prof.update(codec="libx264", preset="ultrafast", hwaccel="none")
    out = str(tmp_path / f"baked-{rotation}.mp4")
    state = _wait_for(export.export(rotated, info, [[3.0, 4.0]], prof, out))
    assert state["state"] == "done", f"export failed: {state.get('error')}"
    assert "baked into the picture" in state.get("note", "")

    result = probe(out)
    assert result["video"]["rotation"] == 0
    assert not result["video"]["has_display_matrix"]
    assert (result["video"]["width"], result["video"]["height"]) == _displayed_size(info)
    assert _shown_corners(out) == _shown_corners(rotated)


def test_copy_fallback_applies_rotation_instead_of_losing_it(quadrant, tmp_path):
    """Copy mode must not re-orient a tagged clip when it falls back.

    Regression: the sync-safe fallback zeroed the display matrix without baking
    it, so a mid-cut export of a phone clip came out rotated (90/270 degrees)
    compared with the source shown in the preview.
    """
    rotated = _tagged(quadrant, str(tmp_path / "rotated-copy.mp4"), 270)
    info = probe(rotated)
    assert info["video"]["has_display_matrix"] and info["video"]["rotation"] != 0

    prof = source_match_profile(info)
    prof.update(codec="libx264", preset="ultrafast", hwaccel="none")
    out = str(tmp_path / "rotated-copy-fallback.mp4")
    job = export.export(
        rotated, info, [[0.5, 1.0]], {**prof, "mode": "copy"}, out)
    assert job["kind"] == "reencode"
    assert "rotation/flip display tag" in job.get("note", "")

    state = _wait_for(job)
    assert state["state"] == "done", f"copy fallback failed: {state.get('error')}"
    result = probe(out)
    assert result["video"]["rotation"] == 0
    assert not result["video"]["has_display_matrix"]
    assert (result["video"]["width"], result["video"]["height"]) == _displayed_size(info)
    assert _shown_corners(out) == _shown_corners(rotated)

    # The original sync reason must still be reported alongside the rotation.
    sync_only = _wait_for(export.export(
        rotated, info, [[0.5, 1.0]], {**prof, "mode": "copy"},
        str(tmp_path / "rotated-sync.mp4")))
    assert sync_only["state"] == "done"
    assert "must be joined" in sync_only.get("note", "")


def test_untagged_source_is_not_blocked_by_the_rotation_guard(source):
    """The rotation guard must not disable honest stream copies."""
    info = probe(source)
    assert not info["video"]["has_display_matrix"]
    assert not info["video"]["rotation"]
    assert export.stream_copy_fallback_reason([(0.0, 5.0)], info) is None


def test_stream_copy_tail_trim_remains_fast(source, tmp_path):
    """A range from t=0 has no concat join or seek, so it can stay bit-copy."""
    info = probe(source)
    prof = source_match_profile(info)
    out = str(tmp_path / "copy-tail-trim.mp4")
    job = export.export(
        source, info, [[DUR - 3.0, DUR]], {**prof, "mode": "copy"}, out)
    assert job["kind"] == "copy"

    deadline = time.time() + 120
    while time.time() < deadline:
        state = export.get_job(job["id"])
        if state["state"] in ("done", "error"):
            break
        time.sleep(0.2)
    state = export.get_job(job["id"])
    assert state["state"] == "done", f"safe stream copy failed: {state.get('error')}"
    result = probe(out)
    assert result["video"]["codec"] == info["video"]["codec"]
    assert result["duration"] < info["duration"]


def test_stream_copy_nonzero_start_falls_back_and_keeps_timing(source, tmp_path):
    offset = str(tmp_path / "offset-source.mp4")
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-itsoffset", "5", "-i", source, "-map", "0", "-c", "copy", offset,
    ], check=True, capture_output=True)
    info = probe(offset)
    assert info["start_time"] > 4.9

    prof = source_match_profile(info)
    prof.update(codec="libx264", preset="ultrafast", hwaccel="none")
    out = str(tmp_path / "offset-sync-safe.mp4")
    job = export.export(
        offset, info, [[info["duration"] - 3.0, info["duration"]]],
        {**prof, "mode": "copy"}, out)
    assert job["kind"] == "reencode"
    assert "non-zero stream start" in job.get("note", "")

    deadline = time.time() + 180
    while time.time() < deadline:
        state = export.get_job(job["id"])
        if state["state"] in ("done", "error"):
            break
        time.sleep(0.2)
    state = export.get_job(job["id"])
    assert state["state"] == "done", f"offset fallback failed: {state.get('error')}"
    result = probe(out)
    assert abs(result["duration"] - (info["duration"] - 3.0)) < 0.3
    timing = _stream_timing(out)
    assert abs(timing["video"]["start"] - timing["audio"]["start"]) < 0.05
