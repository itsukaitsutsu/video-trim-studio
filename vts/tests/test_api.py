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


def test_open_remembers_original_video_path_for_restart_restore(client, source):
    r = client.post("/api/open", json={"path": source})
    assert r.status_code == 200, r.text
    original_path = r.json()["info"]["path"]
    assert original_path == os.path.abspath(source)
    assert client.get("/api/last-project").json() == {"path": original_path}

    # A server restart clears the active in-memory project, but leaves the
    # original source path available to the browser's startup restore flow.
    server.PROJECT = None
    assert client.get("/api/project").status_code == 409
    assert client.get("/api/last-project").json() == {"path": original_path}


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


# ---------------------------------------------------------------------------
# /api/media: MIME type and HTTP Range handling
# ---------------------------------------------------------------------------

@pytest.fixture()
def mkv_source(tmp_path):
    """A tiny MKV - H.264/AAC inside a container browsers cannot demux."""
    path = str(tmp_path / "clip.mkv")
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=2",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k", path,
    ], check=True, capture_output=True)
    return path


@pytest.fixture()
def mov_source(tmp_path):
    """A tiny QuickTime file: played directly, but not an MP4 container."""
    path = str(tmp_path / "clip.mov")
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-an", path,
    ], check=True, capture_output=True)
    return path


def test_media_reports_the_real_container_mime(client, mov_source):
    """Regression: every container used to be answered as video/mp4, so the
    browser was handed non-MP4 bytes labelled MP4 and showed a black box."""
    client.post("/api/open", json={"path": mov_source})
    full = client.get("/api/media")
    assert full.headers["content-type"] == "video/quicktime"
    part = client.get("/api/media", headers={"Range": "bytes=0-1023"})
    assert part.headers["content-type"] == "video/quicktime"


def test_media_supports_suffix_ranges(client, source):
    client.post("/api/open", json={"path": source})
    total = len(client.get("/api/media", headers={"Range": "bytes=0-"}).content)

    last = client.get("/api/media", headers={"Range": "bytes=-256"})
    assert last.status_code == 206
    assert last.headers["Content-Range"] == f"bytes {total - 256}-{total - 1}/{total}"
    assert len(last.content) == 256


def test_media_range_unit_is_case_insensitive(client, source):
    client.post("/api/open", json={"path": source})
    assert client.get("/api/media", headers={"Range": "Bytes=0-1023"}).status_code == 206


def test_media_unsatisfiable_range_says_so(client, source):
    client.post("/api/open", json={"path": source})
    total = len(client.get("/api/media", headers={"Range": "bytes=0-"}).content)
    r = client.get("/api/media", headers={"Range": f"bytes={total + 100}-"})
    assert r.status_code == 416
    assert r.headers["Content-Range"] == f"bytes */{total}"


# ---------------------------------------------------------------------------
# Browser preview proxy
# ---------------------------------------------------------------------------

def test_playable_mp4_is_served_directly(client, source):
    data = client.post("/api/open", json={"path": source}).json()
    assert data["preview"]["mode"] == "direct"
    assert data["preview"]["serving_proxy"] is False


def test_unplayable_container_gets_a_browser_proxy(client, mkv_source):
    """End-to-end: MKV opens, a proxy is transcoded, and /api/media then serves
    an MP4 the browser can actually decode."""
    data = client.post("/api/open", json={"path": mkv_source}).json()
    assert data["preview"]["mode"] == "proxy"
    assert "mkv" in data["preview"]["reason"]

    assert server.PROJECT is not None
    assert server.PROJECT.proxy.wait(timeout=120), server.PROJECT.proxy.error

    status = client.get("/api/preview-status").json()
    assert status["ready"] is True
    assert status["serving_proxy"] is True

    r = client.get("/api/media")
    assert r.headers["content-type"] == "video/mp4"
    # The proxy is a real, playable MP4 - not the original Matroska bytes.
    assert r.content[4:8] == b"ftyp"


def test_preview_proxy_is_a_playable_mp4(client, mkv_source):
    client.post("/api/open", json={"path": mkv_source})
    r = client.post("/api/preview-proxy")
    assert r.status_code == 200
    assert server.PROJECT is not None
    assert server.PROJECT.proxy.wait(timeout=120)
    # Seeking still works against the proxy.
    part = client.get("/api/media", headers={"Range": "bytes=0-1023"})
    assert part.status_code == 206
    assert len(part.content) == 1024


# ---------------------------------------------------------------------------
# /api/browse: reaching other drives on Windows
# ---------------------------------------------------------------------------

def test_posix_reports_no_drives():
    if os.name == "nt":
        pytest.skip("POSIX-only assertion")
    assert server._windows_drives() == []


def test_browse_at_root_is_a_dead_end_on_posix(client):
    """On Linux/macOS '/' genuinely is the top, so parent stays null."""
    if os.name == "nt":
        pytest.skip("POSIX-only assertion")
    r = client.get("/api/browse", params={"path": "/"})
    assert r.status_code == 200
    body = r.json()
    assert body["parent"] is None
    assert body["drives"] == []


def test_browse_at_a_drive_root_offers_the_drive_list(client, monkeypatch):
    """Regression: at C:\\ the Up row vanished, trapping the user on C:.

    '/' is also a self-parent root, so on this platform it exercises exactly
    the branch Windows hits at C:\\.
    """
    monkeypatch.setattr(server, "_windows_drives", lambda: ["C:\\", "D:\\", "E:\\"])
    r = client.get("/api/browse", params={"path": "/"})
    assert r.status_code == 200
    body = r.json()
    assert body["parent"] == server.DRIVES_VIEW      # "up" now goes somewhere
    assert body["drives"] == ["C:\\", "D:\\", "E:\\"]


def test_browse_drive_list_view(client, monkeypatch):
    monkeypatch.setattr(server, "_windows_drives", lambda: ["C:\\", "D:\\"])
    r = client.get("/api/browse", params={"path": server.DRIVES_VIEW})
    assert r.status_code == 200
    body = r.json()
    assert body["cwd"] == "This PC"
    assert body["parent"] is None                    # nothing above This PC
    assert body["drives"] == ["C:\\", "D:\\"]


def test_browse_drive_list_view_rejected_without_drives(client):
    if os.name == "nt":
        pytest.skip("POSIX-only assertion")
    assert client.get("/api/browse", params={"path": server.DRIVES_VIEW}).status_code == 404


def test_browse_inside_a_folder_still_lists_drives(client, monkeypatch, tmp_path):
    """The drive quick-jump is available from any folder, not just the root."""
    monkeypatch.setattr(server, "_windows_drives", lambda: ["C:\\", "D:\\"])
    r = client.get("/api/browse", params={"path": str(tmp_path)})
    body = r.json()
    assert body["drives"] == ["C:\\", "D:\\"]
    assert body["parent"] == str(tmp_path.parent)    # normal Up behaviour intact


def test_browse_skips_unreadable_entries_instead_of_failing(client, tmp_path, monkeypatch):
    """A locked or broken entry must not blank the whole listing."""
    (tmp_path / "good.mp4").write_bytes(b"x")
    broken = tmp_path / "locked.mkv"
    broken.write_bytes(b"x")

    real_is_dir = server.Path.is_dir

    def flaky(self):
        if self.name == "locked.mkv":
            raise PermissionError("locked")
        return real_is_dir(self)

    monkeypatch.setattr(server.Path, "is_dir", flaky)
    body = client.get("/api/browse", params={"path": str(tmp_path)}).json()
    assert [f["name"] for f in body["files"]] == ["good.mp4"]
