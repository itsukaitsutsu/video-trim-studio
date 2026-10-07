"""API-level test: drives the FastAPI app the same way the browser does.

Skipped when ffmpeg is missing.
"""

import os
import shutil
import subprocess
import sys
import time

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server  # noqa: E402

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg / ffprobe not installed",
)

DUR = 16.0
SRT = """1
00:00:00,500 --> 00:00:03,500
Kalimat satu.

2
00:00:07,000 --> 00:00:15,000
Kalimat dua.
"""


@pytest.fixture(scope="module")
def source(tmp_path_factory):
    path = str(tmp_path_factory.mktemp("api") / "clip.mp4")
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"testsrc=size=640x360:rate=25:duration={DUR}",
        "-f", "lavfi", "-i", f"sine=frequency=330:sample_rate=44100:duration={DUR}",
        "-af", "volume=enable='between(t,4,6)':volume=0",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-b:v", "2000k", "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2",
        path,
    ], check=True, capture_output=True)
    return path


@pytest.fixture()
def client():
    # The app intentionally keeps one active project in memory; reset it so
    # API tests stay isolated from one another.
    server.PROJECT = None
    with TestClient(server.app) as c:
        yield c
    server.PROJECT = None


def test_bundled_demo_opens_and_finds_its_srt(client):
    r = client.post("/api/demo", json={})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["info"]["name"] == "sample.mp4"
    assert os.path.isfile(data["demo_subtitles"])
    det = client.post("/api/detect", json={
        "detect_silence": True, "use_cues": True,
        "subtitles_path": data["demo_subtitles"],
    })
    assert det.status_code == 200, det.text
    assert det.json()["cue_count"] == 4
    assert det.json()["silence_count"] >= 2


def test_env_reports_ffmpeg(client):
    r = client.get("/api/env")
    assert r.status_code == 200
    body = r.json()
    assert body["ffmpeg_ok"] is True
    assert "libx264" in body["encoders"]


def test_project_required_before_open(client):
    assert client.get("/api/project").status_code == 409


def test_open_rejects_missing_file(client):
    r = client.post("/api/open", json={"path": "/nope/does-not-exist.mp4"})
    assert r.status_code == 404


def test_full_flow(client, source, tmp_path):
    # 1. open
    r = client.post("/api/open", json={"path": source})
    assert r.status_code == 200, r.text
    proj = r.json()
    assert proj["info"]["video"]["width"] == 640
    assert proj["profile"]["video_bitrate_kbps"] > 0
    assert "libx264" in proj["profile"]["encoder_choices"]

    # 2. detect with captions + silence
    r = client.post("/api/detect", json={
        "silence_thresh_db": -45, "min_silence_ms": 800, "min_section_ms": 120,
        "detect_silence": True, "use_cues": True, "subtitles_text": SRT,
    })
    assert r.status_code == 200, r.text
    det = r.json()
    assert det["cue_count"] == 2
    assert det["silence_count"] >= 1
    sections = det["sections"]
    assert any(s["kind"] == "caption" and "Kalimat satu" in s["text"] for s in sections)

    # 3. pick the silence section(s) and dry-run the plan
    silences = [[s["start"], s["end"]] for s in sections if s["kind"] == "silence"]
    assert silences
    r = client.post("/api/preview-plan", json={"deletions": silences})
    assert r.status_code == 200
    plan = r.json()
    assert 0 < plan["removed"] < DUR
    assert plan["kept_segments"] >= 1

    # 4. export with a CPU encoder (AMD/NVIDIA encoders are not in every build)
    out = str(tmp_path / "clean.mp4")
    r = client.post("/api/export", json={
        "deletions": silences,
        "output": out,
        "opts": {"mode": "reencode", "codec": "libx264", "preset": "ultrafast",
                 "hwaccel": "none", "quality_mode": "bitrate"},
    })
    assert r.status_code == 200, r.text
    job_id = r.json()["id"]

    state = None
    deadline = time.time() + 180
    while time.time() < deadline:
        state = client.get(f"/api/job/{job_id}").json()
        if state["state"] in ("done", "error"):
            break
        time.sleep(0.25)
    assert state["state"] == "done", f"job failed: {state}"
    assert state["progress"] == 100.0
    assert os.path.exists(out)

    # 5. the result is shorter, same format
    from vts.ffprobe import probe
    res = probe(out)
    assert res["duration"] < DUR - 1.0
    assert (res["video"]["width"], res["video"]["height"]) == (640, 360)
    assert res["audio"]["sample_rate"] == 44100


def test_export_refuses_to_overwrite_source(client, source):
    client.post("/api/open", json={"path": source})
    r = client.post("/api/detect", json={"detect_silence": True, "use_cues": False})
    sil = [[s["start"], s["end"]] for s in r.json()["sections"] if s["kind"] == "silence"]
    r = client.post("/api/export", json={"deletions": sil, "output": source})
    assert r.status_code == 400
    assert "different file" in r.json()["detail"]


def test_export_rejects_bad_container(client, source, tmp_path):
    client.post("/api/open", json={"path": source})
    r = client.post("/api/export", json={
        "deletions": [[1.0, 2.0]], "output": str(tmp_path / "out.xyz"),
    })
    assert r.status_code == 400


def test_export_requires_same_source_extension(client, source, tmp_path):
    client.post("/api/open", json={"path": source})
    r = client.post("/api/export", json={
        "deletions": [[1.0, 2.0]], "output": str(tmp_path / "out.mkv"),
    })
    assert r.status_code == 400
    assert "match the source" in r.json()["detail"]


def test_export_rejects_unavailable_encoder(client, source, tmp_path):
    client.post("/api/open", json={"path": source})
    r = client.post("/api/export", json={
        "deletions": [[1.0, 2.0]], "output": str(tmp_path / "out.mp4"),
        "opts": {"codec": "h264_imaginary"},
    })
    assert r.status_code == 400
    assert "not available" in r.json()["detail"]


def test_media_endpoint_supports_range(client, source):
    client.post("/api/open", json={"path": source})
    full = client.get("/api/media")
    assert full.status_code == 200
    total = len(full.content)

    part = client.get("/api/media", headers={"Range": "bytes=0-1023"})
    assert part.status_code == 206
    assert len(part.content) == 1024
    assert part.headers["Content-Range"] == f"bytes 0-1023/{total}"
    assert part.headers["Accept-Ranges"] == "bytes"


def test_browse_lists_directories(client, tmp_path):
    (tmp_path / "a.mp4").write_bytes(b"x")
    (tmp_path / "notes.txt").write_text("hi")
    r = client.get(f"/api/browse?path={tmp_path}")
    assert r.status_code == 200
    names = [f["name"] for f in r.json()["files"]]
    assert "a.mp4" in names and "notes.txt" in names


def test_parse_subtitles_endpoint(client):
    files = {"file": ("cues.srt", SRT.encode(), "text/plain")}
    r = client.post("/api/parse-subtitles", files=files)
    assert r.status_code == 200
    assert r.json()["count"] == 2


def test_waveform_and_thumbnails(client, source):
    client.post("/api/open", json={"path": source})
    w = client.post("/api/waveform?buckets=200").json()
    assert w["count"] > 0
    assert max(w["peaks"]) == 1000          # normalised so the loudest peak is full scale

    t = client.post("/api/thumbnails?count=4").json()
    assert t["count"] >= 1
    img = client.get("/api/thumbnail/thumb_0001.jpg")
    assert img.status_code == 200
    assert img.content[:3] == b"\xff\xd8\xff"   # JPEG magic


def test_thumbnail_name_is_validated(client):
    # Anything reaching the handler must match thumb_NNNN.jpg exactly.
    assert client.get("/api/thumbnail/passwd").status_code == 400
    assert client.get("/api/thumbnail/thumb_0001.jpg%00.png").status_code == 400
    # Path traversal is stopped by the router before the handler; either way it
    # must never serve file contents.
    for url in ("/api/thumbnail/../../etc/passwd",
                "/api/thumbnail/..%2F..%2Fetc%2Fpasswd"):
        r = client.get(url)
        assert r.status_code in (400, 404)
        assert b"root:" not in r.content


def test_detect_without_audio_explains_itself(client, tmp_path):
    silent = str(tmp_path / "noaudio.mp4")
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"testsrc=size=320x240:rate=25:duration=4",
        "-an", "-c:v", "libx264", "-preset", "ultrafast", silent,
    ], check=True, capture_output=True)
    client.post("/api/open", json={"path": silent})
    r = client.post("/api/detect", json={"detect_silence": True})
    assert r.status_code == 400
    assert "no audio track" in r.json()["detail"]
    # captions-only detection still works
    r = client.post("/api/detect", json={"detect_silence": False, "use_cues": True,
                                         "subtitles_text": SRT})
    assert r.status_code == 200
