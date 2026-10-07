"""Unit tests for the detection + export logic (no ffmpeg needed)."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from vts import detect, export
from vts.ffprobe import resolve_preset, source_match_profile

SRT = """1
00:00:01,000 --> 00:00:04,000
Halo semua, selamat datang.

2
00:00:06,500 --> 00:00:09,250
Hari ini kita bahas editing.

3
00:00:12,000 --> 00:00:14,000
Sampai jumpa.
"""

VTT = """WEBVTT

00:00:00.500 --> 00:00:02.000 line:90%
<b>Intro</b> line

00:00:03.000 --> 00:00:05.000
Second cue

00:05.000 --> 00:07.500
WebVTT without hour field
"""


def test_parse_srt():
    cues = detect.parse_subtitles(SRT)
    assert len(cues) == 3
    assert cues[0] == {"start": 1.0, "end": 4.0, "text": "Halo semua, selamat datang."}
    assert cues[1]["start"] == 6.5 and cues[1]["end"] == 9.25


def test_parse_vtt_strips_tags_and_settings():
    cues = detect.parse_subtitles(VTT)
    assert len(cues) == 3
    assert cues[0]["start"] == 0.5 and cues[0]["end"] == 2.0
    assert cues[0]["text"] == "Intro line"
    assert cues[2]["start"] == 5.0 and cues[2]["end"] == 7.5


def test_parse_subtitles_ignores_garbage():
    assert detect.parse_subtitles("not a subtitle file at all") == []


def test_build_sections_tiles_the_whole_timeline():
    secs = detect.build_sections(20.0, [(4.0, 6.5), (9.25, 12.0)],
                                 detect.parse_subtitles(SRT))
    assert secs[0].start == 0.0
    assert abs(secs[-1].end - 20.0) < 1e-6
    # no gaps, no overlaps
    for a, b in zip(secs, secs[1:]):
        assert abs(a.end - b.start) < 1e-6
    total = sum(s.end - s.start for s in secs)
    assert abs(total - 20.0) < 1e-6


def test_build_sections_labels():
    secs = detect.build_sections(20.0, [(4.0, 6.5), (9.25, 12.0)],
                                 detect.parse_subtitles(SRT))
    kinds = [(s.kind, round(s.start, 2), round(s.end, 2)) for s in secs]
    assert ("caption", 1.0, 4.0) in kinds
    assert ("silence", 4.0, 6.5) in kinds
    assert ("caption", 6.5, 9.25) in kinds
    assert ("other", 0.0, 1.0) in kinds      # before the first cue
    assert ("other", 14.0, 20.0) in kinds    # audible tail after the last cue
    cap = next(s for s in secs if s.kind == "caption")
    assert cap.text  # caption sections carry their cue text


def test_complement_and_kept_segments():
    kept = export.kept_segments(20.0, [(4.0, 6.5), (9.0, 12.0)])
    assert kept == [(0.0, 4.0), (6.5, 9.0), (12.0, 20.0)]
    assert export.removed_total([(4.0, 6.5), (9.0, 12.0)], 20.0) == 5.5


def test_stream_copy_is_limited_to_one_range_from_source_start():
    assert export.stream_copy_fallback_reason([(0.0, 8.0)]) is None
    assert "starts partway" in export.stream_copy_fallback_reason([(2.0, 10.0)])
    assert "must be joined" in export.stream_copy_fallback_reason(
        [(0.0, 2.0), (4.0, 10.0)])
    assert "non-zero stream start" in export.stream_copy_fallback_reason(
        [(0.0, 10.0)], {"start_time": 5.0})


def test_overlapping_deletions_merge():
    kept = export.kept_segments(10.0, [(1.0, 3.0), (2.0, 5.0)])
    assert kept == [(0.0, 1.0), (5.0, 10.0)]


def test_tiny_gaps_are_dropped():
    # a 20 ms leftover between two deletions is below min_segment and must not
    # survive as its own segment (it would produce a single-frame blip)
    kept = export.kept_segments(10.0, [(0.0, 4.0), (4.02, 8.0)])
    assert kept == [(8.0, 10.0)]
    # ...but a gap above the threshold is kept
    assert export.kept_segments(10.0, [(0.0, 4.0), (4.5, 8.0)]) == [(4.0, 4.5), (8.0, 10.0)]


def test_filter_complex_shape():
    graph = export.build_filter_complex([(0.0, 4.0), (6.5, 9.0)], 30, True)
    assert graph.count("]trim=") == 2   # "]trim" so "atrim" is not double counted
    assert graph.count("atrim=") == 2
    assert graph.count("afade=") == 4            # in + out per segment
    assert graph.endswith("concat=n=2:v=1:a=1[outv][outa]")
    assert "[v0][a0][v1][a1]" in graph


def test_filter_complex_without_audio():
    graph = export.build_filter_complex([(0.0, 4.0)], 30, False)
    assert "atrim" not in graph
    assert graph.endswith("concat=n=1:v=1:a=0[outv]")


def test_encoder_args_match_source_bitrate():
    info = {
        "duration": 60.0, "ext": ".mp4",
        "video": {"codec": "h264", "width": 1920, "height": 1080,
                  "pix_fmt": "yuv420p", "fps": 30.0, "is_cfr": True,
                  "bitrate_bps": 8_000_000, "color_space": "bt709",
                  "color_primaries": "bt709", "color_transfer": "bt709",
                  "color_range": "tv", "rotation": 0},
        "audio": {"codec": "aac", "sample_rate": 48000, "channels": 2,
                  "bitrate_bps": 192_000},
    }
    prof = source_match_profile(info)
    assert prof["video_bitrate_kbps"] == 8000
    assert prof["audio_codec"] == "aac"
    assert prof["pix_fmt"] == "yuv420p"
    assert prof["match_fps"] is True and prof["fps"] == 30.0

    prof["codec"] = "libx264"
    args = export.build_encoder_args(prof)
    assert "-b:v" in args and "8000k" in args
    assert args[args.index("-r") + 1] == "30.000000"
    assert "-colorspace" in args and "bt709" in args
    assert args[args.index("-c:a") + 1] == "aac"
    assert args[args.index("-ar") + 1] == "48000"
    assert args[args.index("-ac") + 1] == "2"


def test_crf_mode_has_no_bitrate():
    prof = source_match_profile({
        "duration": 10.0, "ext": ".mp4",
        "video": {"codec": "h264", "height": 1080, "pix_fmt": "yuv420p",
                  "fps": 25.0, "is_cfr": True, "bitrate_bps": 5_000_000,
                  "rotation": 0},
        "audio": {"codec": "aac", "sample_rate": 44100, "channels": 2,
                  "bitrate_bps": 128_000},
    })
    prof.update(codec="libx264", quality_mode="crf", crf=20)
    args = export.build_encoder_args(prof)
    assert "-b:v" not in args
    assert args[args.index("-crf") + 1] == "20"


def test_preset_translation_for_amf():
    assert resolve_preset("h264_amf", "ultrafast") == "speed"
    assert resolve_preset("h264_amf", "slow") == "quality"
    assert resolve_preset("h264_nvenc", "veryfast") == "p2"
    assert resolve_preset("libx264", "veryfast") == "veryfast"


def test_hwaccel_fallback_removes_the_option_and_value_together():
    cmd = ["ffmpeg", "-y", "-hwaccel", "d3d11va", "-i", "in.mp4",
           "-c:v", "h264_amf", "out.mp4"]
    retry = export._without_hwaccel(cmd)
    assert retry == ["ffmpeg", "-y", "-i", "in.mp4", "-c:v", "h264_amf", "out.mp4"]
    assert "d3d11va" not in retry and "-hwaccel" not in retry


def test_amf_uses_vbr_peak_rate_control():
    args = export.build_encoder_args({
        "codec": "h264_amf", "preset": "medium", "quality_mode": "bitrate",
        "video_bitrate_kbps": 12000, "maxrate_factor": 1.5,
        "pix_fmt": "yuv420p", "audio_codec": "none",
    })
    assert args[args.index("-rc") + 1] == "vbr_peak"
    assert "12000k" in args and "18000k" in args
    assert "-quality" in args and "balanced" in args


def test_amf_constant_quality_uses_cqp_not_x264_crf():
    args = export.build_encoder_args({
        "codec": "h264_amf", "preset": "medium", "quality_mode": "crf",
        "crf": 20, "video_bitrate_kbps": 12000,
        "pix_fmt": "yuv420p", "audio_codec": "none",
    })
    assert "-crf" not in args
    assert args[args.index("-rc") + 1] == "cqp"
    assert args[args.index("-qp_i") + 1] == "20"
    assert args[args.index("-qp_p") + 1] == "20"


def test_unknown_container_falls_back_to_mp4():
    prof = source_match_profile({
        "duration": 5.0, "ext": ".weird",
        "video": {"codec": "h264", "height": 720, "pix_fmt": "yuv420p",
                  "fps": 30.0, "is_cfr": True, "bitrate_bps": 4_000_000,
                  "rotation": 0},
        "audio": None,
    })
    assert prof["out_ext"] == ".mp4"
    assert prof["audio_codec"] == "none"


def test_summary_counts():
    secs = detect.build_sections(20.0, [(4.0, 6.5)], detect.parse_subtitles(SRT))
    s = detect.summary(secs)
    assert s["count"] == len(secs)
    assert set(s["seconds_by_kind"]) == {"caption", "silence", "other"}
    assert abs(sum(s["seconds_by_kind"].values()) - 20.0) < 0.01
