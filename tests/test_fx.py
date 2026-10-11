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

# Every asset in these tests is a plain video with sound at /media/<id>.mp4.
ASSETS = {"overlay.mp4": ("video", True), "silent.mp4": ("video", False),
          "music.wav": ("audio", True)}


def _resolve(asset_id):
    path = f"/media/{asset_id}"
    kind, has_audio = ASSETS.get(asset_id, ("video", True))
    return (path, kind, has_audio)


def build(clips, total=5.0, burn=None, auds=None):
    """-> (filter graph, has_audio)."""
    inputs, by_asset = edl_mod.collect_inputs(clips, auds or [], _resolve, FPS)
    return edl_mod.build_filter(clips, auds or [], total, FPS, (W, H), "yuv420p",
                                48000, "stereo", 30, by_asset, burn_srt=burn)


def graph(clips, total=5.0, burn=None, auds=None):
    """The filter graph only (most assertions are about its shape)."""
    return build(clips, total=total, burn=burn, auds=auds)[0]


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


def test_plain_graph_overlays_one_clip_on_the_canvas():
    g, has_audio = build([{"start": 0, "end": 5, "in": 0, "track": 0,
                           "fx": fx_mod.clean_fx(None), "kf": []}])
    assert has_audio is True
    # One clip is composited onto the black canvas, not concatenated.
    assert g.count("overlay=") == 1
    assert "overlay=x=0:y=0" in g
    assert "color=c=black:s=1280x720" in g
    assert "concat" not in g
    assert "amix" not in g          # only one audible source
    assert "[outv]" in g and "[outa]" in g


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


def test_stacked_lanes_composite_instead_of_flattening():
    g = graph([
        {"start": 0, "end": 5, "in": 0, "track": 0,
         "fx": fx_mod.clean_fx(None), "kf": []},
        {"start": 1, "end": 3, "in": 10, "track": 1,
         "fx": fx_mod.clean_fx({"scale": 40, "x": 25}), "kf": []},
    ])
    # Two overlays: the base track, then the scaled-down V2 on top of it.
    assert g.count("overlay=") == 2
    assert "concat" not in g
    # V2 is 40% wide and pushed right, so it is placed, not padded over V1.
    assert "scale=512:288" in g
    assert "overlay=x=" in g
    # The enable windows are the clips' own timeline ranges.
    assert "enable='gte(t,1.000000)*lt(t,3.000000)'" in g
    assert "enable='gte(t,0.000000)*lt(t,5.000000)'" in g
    assert "[outv]" in g and "[outa]" in g


def test_lone_clip_on_upper_lane_renders():
    g = graph([{"start": 1, "end": 3, "in": 10, "track": 1,
                "fx": fx_mod.clean_fx({"scale": 50}), "kf": []}],
              total=5.0)
    assert g.count("overlay=") == 1
    assert "enable='gte(t,1.000000)*lt(t,3.000000)'" in g
    assert "scale=640:360" in g
    assert "[outv]" in g and "[outa]" in g


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
    # A video fade uses absolute timeline time (the layer is PTS-shifted).
    assert "fade=t=in:st=0.000000:d=0.500:alpha=1" in g
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
    assert g.count("scale=") >= 10  # 2 s of animation baked at 0.2 s steps
    assert g.count("overlay=") >= 10
    assert "[outv]" in g and "[outa]" in g


def test_fit_modes_change_only_the_box_filters():
    base = {"start": 0, "end": 2, "in": 0, "track": 0, "kf": []}
    plain = graph([dict(base, fx=fx_mod.clean_fx({"scale": 50, "fit": "fill"}))])
    assert "scale=640:360" in plain
    assert "pad=" not in plain
    letter = graph([dict(base, fx=fx_mod.clean_fx({"scale": 50, "fit": "contain"}))])
    assert "force_original_aspect_ratio=decrease" in letter
    assert "pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black@0.0" in letter
    assert "format=yuva420p" in letter     # letterbox bars must be transparent
    cover = graph([dict(base, fx=fx_mod.clean_fx({"scale": 50, "fit": "cover"}))])
    assert "force_original_aspect_ratio=increase" in cover
    assert "crop=640:360" in cover


def test_audio_items_mix_with_the_picture_sound():
    clips = [{"id": "c1", "src": "src", "start": 0, "end": 5, "in": 0, "track": 0,
              "fx": fx_mod.clean_fx(None), "kf": []}]
    auds = [{"id": "n1", "src": "music.wav", "start": 1.0, "end": 4.0, "in": 0,
             "atrack": 0, "fx": fx_mod.clean_fx({"volume": 60})}]
    g, has_audio = build(clips, total=5.0, auds=auds)
    assert has_audio is True
    assert "amix=inputs=2" in g
    assert "adelay=1000|1000" in g        # the item starts one second in
    assert "volume=0.6" in g


def test_muted_clip_stays_silent_but_keeps_the_audio_stream():
    clips = [{"id": "c1", "src": "src", "start": 0, "end": 2, "in": 0, "track": 0,
              "fx": fx_mod.clean_fx({"mute": True}), "kf": []}]
    g, has_audio = build(clips, total=2.0)
    # Muting silences the clip; it must not delete the exported audio track.
    assert has_audio is True
    assert "volume=0" in g


def test_source_without_sound_has_no_audio_stream():
    clips = [{"id": "c1", "src": "silent.mp4", "start": 0, "end": 2, "in": 0,
              "track": 0, "fx": fx_mod.clean_fx(None), "kf": []}]
    g, has_audio = build(clips, total=2.0)
    assert has_audio is False
    assert "[outa]" not in g


def test_unlinked_clip_audio_moves_to_the_audio_lane():
    clips = [{"id": "c1", "src": "src", "start": 0, "end": 3, "in": 0, "track": 0,
              "audio": False, "fx": fx_mod.clean_fx(None), "kf": []}]
    auds = [{"id": "n1", "src": "src", "start": 0.5, "end": 3.5, "in": 0.5,
             "atrack": 0, "fx": fx_mod.clean_fx(None)}]
    g, has_audio = build(clips, total=4.0, auds=auds)
    assert has_audio is True
    assert g.count(":a:0]atrim=") == 1   # only the A-lane item contributes
    assert "adelay=500|500" in g


def test_image_assets_get_a_looped_input_and_no_audio():
    inputs, by_asset = edl_mod.collect_inputs(
        [{"id": "c1", "src": "logo.png", "start": 0, "end": 2, "in": 0, "track": 0}],
        [], lambda a: (f"/media/{a}", "image", False), FPS)
    assert inputs[0].args == ["-loop", "1", "-framerate", "30.000000"]
    assert inputs[0].has_audio is False
    g, has_audio = edl_mod.build_filter(
        [{"id": "c1", "src": "logo.png", "start": 0, "end": 2, "in": 0, "track": 0,
          "fx": fx_mod.clean_fx(None), "kf": []}], [], 2.0, FPS, (W, H), "yuv420p",
        48000, "stereo", 30, by_asset)
    assert has_audio is False
    assert g.count("overlay=") == 1


def test_normalize_accepts_audio_items_and_grows_atracks():
    tl = tl_mod.normalize({
        "clips": [{"start": 0, "end": 5, "in": 0, "track": 0}],
        "auds": [{"start": 1, "end": 3, "in": 0, "atrack": 2, "src": "music.wav"}],
        "caps": [], "lanes": 1,
    }, 20.0)
    assert tl["vtracks"] == 1
    assert tl["atracks"] == 3
    assert tl["auds"][0]["src"] == "music.wav"
    assert tl_mod.timeline_length(tl) == 5.0

    with pytest.raises(tl_mod.TimelineError):
        tl_mod.normalize({"clips": [], "auds": [
            {"start": 0, "end": 5, "in": 0, "atrack": 0, "src": "music.wav"}]}, 2.0)
    with pytest.raises(tl_mod.TimelineError):
        tl_mod.normalize({"clips": [], "auds": [
            {"start": 0, "end": 0.01, "in": 0, "atrack": 0}]}, 20.0)


def test_normalize_checks_each_clip_against_its_own_source():
    media = {"src": {"duration": 10.0}, "clip.mp4": {"duration": 3.0}}
    ok = tl_mod.normalize({"clips": [
        {"start": 0, "end": 10, "in": 0, "src": "src"},
        {"start": 0, "end": 3, "in": 0, "src": "clip.mp4", "track": 1}]}, 10.0,
        media=media.get)
    assert len(ok["clips"]) == 2
    # 4 s from a 3 s asset is rejected, even though the main video is longer.
    with pytest.raises(tl_mod.TimelineError):
        tl_mod.normalize({"clips": [
            {"start": 0, "end": 4, "in": 0, "src": "clip.mp4"}]}, 10.0,
            media=media.get)


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
