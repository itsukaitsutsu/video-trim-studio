"""Unit tests for browser-preview classification and HTTP range parsing.

No ffmpeg needed: these only exercise the decision logic that decides whether
<video> can play a source directly or needs a transcode proxy.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server  # noqa: E402
from vts import preview  # noqa: E402


def info(ext, vcodec=None, acodec=None):
    return {
        "ext": ext,
        "video": {"codec": vcodec} if vcodec else None,
        "audio": {"codec": acodec} if acodec else None,
    }


# --- which sources need a proxy -------------------------------------------

@pytest.mark.parametrize("i", [
    info(".mp4", "h264", "aac"),
    info(".mp4", "h264", "mp3"),
    info(".mp4", "vp9", "opus"),
    info(".mov", "h264", "aac"),
    info(".webm", "vp8", "vorbis"),
    info(".m4v", "h264", "aac"),
])
def test_directly_playable_sources_need_no_proxy(i):
    mode, reason = preview.browser_support(i)
    assert mode == "direct", reason
    assert reason == ""


@pytest.mark.parametrize("i,why", [
    (info(".mkv", "h264", "aac"), "container"),
    (info(".avi", "mpeg4", "mp3"), "container"),
    (info(".ts", "h264", "aac"), "container"),
    (info(".wmv", "wmv3", "wmav2"), "container"),
    (info(".mp4", "mpeg4", "aac"), "video"),      # DivX/Xvid inside an MP4
    (info(".mp4", "h264", "ac3"), "audio"),       # AC3 audio
    (info(".mp4", "h264", "dts"), "audio"),
])
def test_unplayable_sources_require_a_proxy(i, why):
    mode, reason = preview.browser_support(i)
    assert mode == "proxy"
    assert why in reason


def test_hevc_is_uncertain_so_the_frontend_can_fall_back():
    mode, reason = preview.browser_support(info(".mp4", "hevc", "aac"))
    assert mode == "uncertain"
    assert "hevc" in reason


def test_video_without_audio_is_still_classified():
    assert preview.browser_support(info(".mp4", "h264"))[0] == "direct"
    assert preview.browser_support(info(".mkv", "h264"))[0] == "proxy"


# --- MIME types -----------------------------------------------------------

@pytest.mark.parametrize("name,want", [
    ("a.mp4", "video/mp4"), ("a.MP4", "video/mp4"),
    ("a.mkv", "video/x-matroska"), ("a.webm", "video/webm"),
    ("a.mov", "video/quicktime"), ("a.avi", "video/x-msvideo"),
    ("a.ts", "video/mp2t"), ("a.m2ts", "video/mp2t"),
    ("a.wmv", "video/x-ms-wmv"), ("a.3gp", "video/3gpp"),
    ("a.unknown", "application/octet-stream"),
])
def test_mime_for(name, want):
    assert preview.mime_for(name) == want


def test_mime_never_lies_about_the_container():
    """Regression: /api/media used to answer video/mp4 for every container."""
    assert preview.mime_for("clip.mkv") != "video/mp4"
    assert preview.mime_for("clip.webm") != "video/mp4"


def test_preview_encoder_prefers_available_hardware_then_cpu():
    assert preview.preview_encoder_candidates({"libx264", "h264_amf"}) == [
        "h264_amf", "libx264",
    ]
    assert preview.preview_encoder_candidates({"libx264", "h264_nvenc"}) == [
        "h264_nvenc", "libx264",
    ]


def test_preview_encoder_falls_back_to_software_when_no_hardware_exists():
    assert preview.preview_encoder_candidates({"libx264", "aac"}) == ["libx264"]
    assert preview.preview_encoder_candidates({"aac"}) == []


def test_preview_encoder_profiles_use_speed_or_preview_quality_settings():
    amf = preview.preview_encoder_args("h264_amf")
    assert "-quality" in amf and "speed" in amf
    assert "-rc" in amf and "cqp" in amf
    x264 = preview.preview_encoder_args("libx264")
    assert "ultrafast" in x264
    assert "-crf" in x264


# --- HTTP Range parsing ---------------------------------------------------

@pytest.mark.parametrize("header,size,want", [
    ("bytes=0-", 1000, (0, 999)),
    ("bytes=0-99", 1000, (0, 99)),
    ("bytes=900-", 1000, (900, 999)),
    ("bytes=0-99999", 1000, (0, 999)),          # end clamped to size-1
    ("bytes=-100", 1000, (900, 999)),           # suffix: last 100 bytes
    ("bytes=-5000", 1000, (0, 999)),            # suffix longer than the file
    ("Bytes=0-", 1000, (0, 999)),               # unit is case-insensitive
    ("BYTES=10-20", 1000, (10, 20)),
    ("bytes = 0 - 49 ", 1000, (0, 49)),         # optional whitespace
    ("bytes=0-1,2-3", 1000, (0, 1)),            # multi-range: first wins
    ("bytes=999-999", 1000, (999, 999)),
])
def test_parse_byte_range_accepts(header, size, want):
    assert server._parse_byte_range(header, size) == want


@pytest.mark.parametrize("header", [
    "bytes=1000-",      # start past the end -> unsatisfiable
    "bytes=1000-2000",
    "bytes=500-100",    # end before start
    "bytes=-0",         # suffix of zero bytes
    "bytes=abc-",
    "items=0-10",       # wrong range unit
    "nonsense",
    "",
])
def test_parse_byte_range_rejects(header):
    assert server._parse_byte_range(header, 1000) is None


def test_parse_byte_range_rejects_empty_files():
    assert server._parse_byte_range("bytes=0-", 0) is None
