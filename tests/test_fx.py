"""Clip effects, stacked video lanes and the flattened export graph.

Pure-Python tests: no ffmpeg, no faster-whisper, no server needed.
Run with:  python -m pytest tests/test_fx.py -q
"""
import pytest

from vts import edl as edl_mod
from vts import fx as fx_mod
from vts import timeline as tl_mod

W, H = 1280, 720
FPS = 30.0


def graph(clips, total=5.0, burn=None, audio=True):
    return edl_mod.build_filter(clips, total, FPS, (W, H), "yuv420p",
                                48000, "stereo", 30, audio, burn_srt=burn)


def test_clean_fx_clamps_ranges():
    fx = fx_mod.clean_fx({"x": 999, "scale": 0, "crop_l": 80, "crop_r": 80,
                          "volume": -5, "mute": 1, "fade_in": -2})
    assert fx["x"] == 100.0
    assert fx["scale"] == 1.0
    assert fx["crop_l"] + fx["crop_r"] < 90.0
    assert fx["volume"] == 0.0
    assert fx["mute"] is True
    assert fx["fade_in"] == 0.0
    assert fx_mod.fx_is_default(None)
    assert fx_mod.fx_is_default(fx_mod.clean_fx(None))
    assert not fx_mod.fx_is_default(fx)


def test_keyframes_clean_sort_and_dedupe():
    kf = fx_mod.clean_keyframes([
        {"t": 2, "scale": 50}, {"t": 0, "x": -10}, {"t": 2, "scale": 60},
        {"t": 99, "x": 5}, "junk",
    ], 4.0)
    assert [k["t"] for k in kf] == [0.0, 2.0, 4.0]
    assert kf[1]["scale"] == 60.0  # later duplicate wins


def test_eval_fx_interpolates_and_holds():
    fx = fx_mod.clean_fx(None)
    kf = [{"t": 0.0, "x": -100.0, "y": 0.0, "scale": 50.0, "opacity": 0.0},
          {"t": 4.0, "x": 100.0, "y": 0.0, "scale": 100.0, "opacity": 100.0}]
    mid = fx_mod.eval_fx_at(fx, kf, 4.0, 2.0)
    assert mid["x"] == 0.0
    assert mid["scale"] == 75.0
    assert fx_mod.eval_fx_at(fx, kf, 4.0, -5.0)["x"] == -100.0
    assert fx_mod.eval_fx_at(fx, kf, 4.0, 99.0)["x"] == 100.0
    assert fx_mod.eval_fx_at(fx, [], 4.0, 2.0)["scale"] == 100.0


def test_slice_spans_single_without_keyframes():
    spans = fx_mod.slice_spans(fx_mod.clean_fx(None), [], 10.0)
    assert len(spans) == 1
    assert spans[0][:2] == (0.0, 10.0)


def test_slice_spans_cover_animated_clip():
    kf = [{"t": 0.0, "x": 0.0, "y": 0.0, "scale": 100.0, "opacity": 100.0},
          {"t": 4.0, "x": 0.0, "y": 0.0, "scale": 50.0, "opacity": 100.0}]
    spans = fx_mod.slice_spans(fx_mod.clean_fx(None), kf, 4.0)
    assert len(spans) > 1
    assert spans[0][0] == 0.0
    assert spans[-1][1] == 4.0
    for (a0, a1, _), (b0, b1, _) in zip(spans, spans[1:]):
        assert a1 == pytest.approx(b0)
    assert spans[0][2]["scale"] > spans[-1][2]["scale"]


def test_normalize_accepts_tracks_fx_and_keyframes():
    tl = tl_mod.normalize({
        "clips": [
            {"start": 0, "end": 5, "in": 0, "track": 0},
            {"start": 1, "end": 3, "in": 10, "track": 1,
             "fx": {"scale": 40, "x": 25},
             "kf": [{"t": 0, "scale": 20}, {"t": 2, "scale": 40}]},
        ],
        "caps": [], "lanes": 1,
    }, 20.0)
    assert tl["vtracks"] == 2
    assert tl["clips"][1]["fx"]["scale"] == 40.0
    assert len(tl["clips"][1]["kf"]) == 2
    assert tl_mod.video_length(tl) == 5.0


def test_normalize_rejects_same_track_overlap_but_allows_stacking():
    with pytest.raises(tl_mod.TimelineError):
        tl_mod.normalize({"clips": [{"start": 0, "end": 5, "in": 0},
                                    {"start": 3, "end": 6, "in": 3}]}, 20.0)
    ok = tl_mod.normalize({"clips": [{"start": 0, "end": 5, "in": 0, "track": 0},
                                     {"start": 3, "end": 6, "in": 3, "track": 2}]}, 20.0)
    assert ok["vtracks"] == 3


def test_normalize_rejects_bad_track():
    with pytest.raises(tl_mod.TimelineError):
        tl_mod.normalize({"clips": [{"start": 0, "end": 2, "in": 0, "track": 99}]}, 20.0)


def test_plain_graph_has_no_overlay_or_mix():
    g = graph([{"start": 0, "end": 5, "in": 0, "track": 0,
                "fx": fx_mod.clean_fx(None), "kf": []}])
    assert "overlay" not in g
    assert "amix" not in g
    assert "concat=n=1" in g
    assert g.rstrip().endswith("[outv][outa]")


def test_flatten_clips_highest_lane_wins_and_merges_runs():
    flat = edl_mod.flatten_clips([
        {"id": "a", "start": 0, "end": 6, "in": 0, "track": 0,
         "fx": fx_mod.clean_fx(None), "kf": []},
        {"id": "b", "start": 2, "end": 4, "in": 10, "track": 1,
         "fx": fx_mod.clean_fx({"volume": 50}),
         "kf": [{"t": 0, "x": 0, "y": 0, "scale": 20, "opacity": 100},
                {"t": 2, "x": 0, "y": 0, "scale": 40, "opacity": 100}]},
    ])
    assert [(p["from"], p["start"], p["end"]) for p in flat] == [
        ("a", 0.0, 2.0), ("b", 2.0, 4.0), ("a", 4.0, 6.0)]
    assert flat[1]["in"] == 10.0
    assert flat[2]["in"] == 4.0  # source offset follows the timeline cut
    assert flat[1]["fx"]["volume"] == 50.0
    assert [k["t"] for k in flat[1]["kf"]] == [0.0, 2.0]


def test_stacked_lanes_flatten_without_mixing():
    g = graph([
        {"start": 0, "end": 5, "in": 0, "track": 0,
         "fx": fx_mod.clean_fx(None), "kf": []},
        {"start": 1, "end": 3, "in": 10, "track": 1,
         "fx": fx_mod.clean_fx({"scale": 40, "x": 25, "volume": 50}), "kf": []},
    ])
    assert "overlay=x=" not in g
    assert "amix=" not in g
    assert "adelay=" not in g
    assert "concat=n=3" in g  # a[0,1] b[1,3] a[3,5]
    assert "volume=0.5" in g  # the winning lane's audio
    assert "scale=" in g
    assert g.rstrip().endswith("[outv][outa]")


def test_lone_clip_on_upper_lane_renders():
    g = graph([{"start": 1, "end": 3, "in": 10, "track": 1,
                "fx": fx_mod.clean_fx({"scale": 50}), "kf": []}],
              total=5.0)
    assert "amix=" not in g
    assert "scale=" in g
    assert g.rstrip().endswith("[outv][outa]")


def test_volume_mute_and_fades_land_in_audio_chain():
    g = graph([{"start": 0, "end": 6, "in": 0, "track": 0,
                "fx": fx_mod.clean_fx({"volume": 50, "fade_in": 1.0,
                                        "fade_out": 0.5}), "kf": []}])
    assert "volume=0.5" in g
    assert "afade=t=in:st=0:d=1.000" in g
    assert "afade=t=out" in g
    muted = graph([{"start": 0, "end": 2, "in": 0, "track": 0,
                    "fx": fx_mod.clean_fx({"mute": True}), "kf": []}])
    assert "volume=0" in muted


def test_video_fades_and_crop_and_opacity():
    g = graph([{"start": 0, "end": 6, "in": 0, "track": 0,
                "fx": fx_mod.clean_fx({"vfade_in": 0.5, "crop_l": 10,
                                        "crop_r": 10, "opacity": 50}), "kf": []}])
    assert "fade=t=in:st=0:d=0.500" in g
    assert "crop=" in g
    assert "colorchannelmixer=aa=0.5000" in g


def test_keyframed_top_clip_bakes_multiple_spans():
    g = graph([
        {"start": 0, "end": 5, "in": 0, "track": 0,
         "fx": fx_mod.clean_fx(None), "kf": []},
        {"start": 1, "end": 3, "in": 10, "track": 1,
         "fx": fx_mod.clean_fx({"scale": 40}), "kf": [
             {"t": 0, "x": 0, "y": 0, "scale": 20, "opacity": 100},
             {"t": 2, "x": 0, "y": 0, "scale": 40, "opacity": 100}]},
    ])
    assert "amix=" not in g
    assert "adelay=" not in g
    assert g.count("scale=") >= 10  # 2 s of animation baked at 0.2 s steps
    assert g.rstrip().endswith("[outv][outa]")


def test_burn_graph_still_terminates_at_outv():
    clips = [
        {"start": 0, "end": 5, "in": 0, "track": 0,
         "fx": fx_mod.clean_fx(None), "kf": []},
        {"start": 1, "end": 3, "in": 10, "track": 1,
         "fx": fx_mod.clean_fx({"scale": 40}), "kf": []},
    ]
    g = graph(clips, burn="caps.ass")
    assert "subtitles=" in g
    assert g.rstrip().endswith("[outv]")
