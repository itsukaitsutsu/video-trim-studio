"""Single-video timeline: validation, EDL export through real FFmpeg, and the API.

Clips may repeat, reorder or leave gaps; gaps must render as black silence and
captions must keep the timeline times. Skipped when ffmpeg is missing.
"""

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from vts import edl as edl_mod  # noqa: E402
from vts import export as ex  # noqa: E402
from vts import timeline as tl_mod  # noqa: E402
from vts.ffprobe import probe, source_match_profile  # noqa: E402

DEMO = ROOT / "demo" / "sample.mp4"          # 18 s clip with video and audio

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg / ffprobe not installed",
)


def wait_job(job_id: str, timeout: float = 180.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = ex.get_job(job_id)
        if job and job["state"] != "running":
            return job
        time.sleep(0.2)
    raise AssertionError("export did not finish in time")


def duration_of(path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True).stdout.strip()
    return float(out)


def mean_luma_at(path, t: float) -> float:
    """Mean brightness (0-255) of one frame, to tell black from picture."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", str(path),
         "-frames:v", "1", "-vf", "scale=32:18", "-f", "rawvideo",
         "-pix_fmt", "gray", "-"],
        capture_output=True, check=True).stdout
    return sum(raw) / max(1, len(raw))


def export(clips, output, mode="reencode"):
    info = probe(str(DEMO))
    opts = {**source_match_profile(info), "mode": mode}
    job = edl_mod.export_timeline(str(DEMO), info, clips, opts, str(output))
    done = wait_job(job["id"])
    assert done["state"] == "done", done.get("error")
    return done


# --------------------------------------------------------------------- model


def test_normalize_sorts_and_keeps_ids():
    tl = tl_mod.normalize({
        "clips": [{"id": "b", "start": 4, "end": 6, "in": 10},
                  {"id": "a", "start": 0, "end": 2, "in": 0}],
        "caps": [{"id": "x", "lane": 1, "start": 0.5, "end": 1.5, "text": "hi"}],
        "lanes": 1,
    }, 18.0)
    assert [c["id"] for c in tl["clips"]] == ["a", "b"]
    assert tl["lanes"] == 2                       # lane 1 used -> two lanes
    assert tl["caps"][0]["text"] == "hi"


@pytest.mark.parametrize("bad", [
    {"clips": [{"start": 0, "end": 5, "in": 0}, {"start": 3, "end": 6, "in": 3}]},   # overlap
    {"clips": [{"start": 0, "end": 2, "in": 17}]},                                  # past end
    {"clips": [{"start": 2, "end": 2, "in": 0}]},                                   # empty
    {"clips": [{"start": 0, "end": 2, "in": -1}]},                                  # before 0
    {"caps": [{"lane": 0, "start": 0, "end": 2, "text": "a"},
              {"lane": 0, "start": 1, "end": 3, "text": "b"}]},                     # lane clash
    {"clips": [{"start": "x", "end": 2, "in": 0}]},                                 # not a number
])
def test_normalize_rejects_inconsistent_timelines(bad):
    with pytest.raises(tl_mod.TimelineError):
        tl_mod.normalize(bad, 18.0)


def test_export_cues_keep_timeline_times_and_drop_empty_text():
    tl = tl_mod.normalize({
        "clips": [{"start": 0, "end": 10, "in": 0}],
        "caps": [{"lane": 0, "start": 7.0, "end": 12.0, "text": "late"},
                 {"lane": 0, "start": 1.0, "end": 2.0, "text": "  "},
                 {"lane": 1, "start": 2.0, "end": 3.0, "text": "one"}],
    }, 18.0)
    cues = tl_mod.export_cues(tl, tl_mod.video_length(tl))
    assert [(c["start"], c["end"], c["text"]) for c in cues] == [
        (2.0, 3.0, "one"), (7.0, 10.0, "late")]


# --------------------------------------------------------------- ffmpeg export


def test_reordered_and_repeated_clips_export_the_right_length(tmp_path):
    clips = [
        {"start": 0.0, "end": 2.0, "in": 0.0},
        {"start": 2.0, "end": 4.0, "in": 5.0},    # source 5-7 s, out of order
        {"start": 4.0, "end": 6.0, "in": 0.0},    # repeats the first range
    ]
    out = tmp_path / "reorder.mp4"
    export(clips, out)
    assert abs(duration_of(out) - 6.0) < 0.15


def test_gap_between_clips_renders_black_and_keeps_length(tmp_path):
    clips = [
        {"start": 0.0, "end": 2.0, "in": 0.0},
        {"start": 3.0, "end": 5.0, "in": 5.0},   # one second of gap at 2-3 s
    ]
    out = tmp_path / "gap.mp4"
    export(clips, out)
    assert abs(duration_of(out) - 5.0) < 0.15
    assert mean_luma_at(out, 2.5) < 40          # black gap
    assert mean_luma_at(out, 4.0) > mean_luma_at(out, 2.5) + 5   # picture after it


def test_single_clip_from_start_can_stream_copy(tmp_path):
    out = tmp_path / "copy.mp4"
    done = export([{"start": 0.0, "end": 6.0, "in": 0.0}], out, mode="copy")
    assert done["kind"] == "copy"
    assert abs(duration_of(out) - 6.0) < 0.15


def test_burned_captions_export_runs(tmp_path):
    clips = [{"start": 0.0, "end": 4.0, "in": 0.0}]
    srt = tmp_path / "burn.srt"
    srt.write_text("1\n00:00:00,500 --> 00:00:02,000\nhalo\n\n", encoding="utf-8")
    info = probe(str(DEMO))
    opts = {**source_match_profile(info), "mode": "reencode", "burn_srt": str(srt)}
    job = edl_mod.export_timeline(str(DEMO), info, clips, opts, str(tmp_path / "burn.mp4"))
    assert wait_job(job["id"])["state"] == "done"


# ------------------------------------------------------------------------ API


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    import server  # noqa: E402
    return TestClient(server.app)


def test_timeline_api_roundtrip_and_export(client, tmp_path):
    r = client.post("/api/open", json={"path": str(DEMO)})
    assert r.status_code == 200, r.text

    body = {
        "clips": [{"id": "a", "start": 0, "end": 3, "in": 0},
                  {"id": "b", "start": 3, "end": 6, "in": 9}],
        "caps": [{"id": "cap1", "lane": 0, "start": 0.5, "end": 2.0, "text": "Halo"}],
        "lanes": 1,
    }
    r = client.put("/api/timeline", json=body)
    assert r.status_code == 200, r.text
    saved = client.get("/api/timeline").json()["timeline"]
    assert [c["id"] for c in saved["clips"]] == ["a", "b"]
    assert saved["caps"][0]["text"] == "Halo"

    overlap = {"clips": [{"start": 0, "end": 3, "in": 0}, {"start": 2, "end": 4, "in": 2}]}
    assert client.put("/api/timeline", json=overlap).status_code == 400

    out = tmp_path / "api.mp4"
    r = client.post("/api/export/timeline",
                    json={"output": str(out), "caption_mode": "srt"})
    assert r.status_code == 200, r.text
    job = r.json()
    assert job["captions"]["cues"] == 1
    assert wait_job(job["id"])["state"] == "done"
    assert abs(duration_of(out) - 6.0) < 0.15
    srt_text = (tmp_path / "api.srt").read_text(encoding="utf-8")
    assert "00:00:00,500 --> 00:00:02,000" in srt_text and "Halo" in srt_text


def test_export_refuses_an_empty_timeline(client, tmp_path):
    client.post("/api/open", json={"path": str(DEMO)})
    r = client.post("/api/export/timeline",
                    json={"output": str(tmp_path / "x.mp4"),
                          "timeline": {"clips": [], "caps": [], "lanes": 1}})
    assert r.status_code == 400


def test_copy_request_that_cannot_stream_copy_says_why(tmp_path):
    clips = [{"start": 0.0, "end": 2.0, "in": 0.0}, {"start": 2.0, "end": 4.0, "in": 5.0}]
    done = export(clips, tmp_path / "note.mp4", mode="copy")
    assert done["kind"] == "reencode"
    assert "re-encoded" in (done.get("note") or "")
