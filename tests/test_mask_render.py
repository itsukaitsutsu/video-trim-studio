"""Rotation and shape masks through a real ffmpeg run.

The filter strings are covered by test_fx.py; this file proves the graph the
exporter builds actually renders - a masked clip leaves the corners black, a
rotated one fills a bigger box, and ffmpeg accepts the geq/rotate syntax.
"""
import shutil
import subprocess

import pytest

from vts import edl as edl_mod
from vts import fx as fx_mod

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None,
                                reason="needs ffmpeg")

W, H = 320, 240
FPS = 10.0


def _clip(**fx):
    return {"id": "c1", "src": "overlay.mp4", "track": 0, "start": 0.0, "end": 1.0,
            "in": 0.0, "fx": fx_mod.clean_fx(fx), "kf": [], "audio": True}


def _render(fx, out_path):
    """Run one clip's layer chain over a red source onto a black canvas."""
    clip = _clip(**fx)
    parts = []
    label, px, py = edl_mod._layer_chain(
        edl_mod.Input(path="/src", kind="video", index=0, fps=FPS, has_audio=False),
        0.0, 1.0, 0.0, 1.0, clip["fx"], W, H, FPS, "yuv420p", "[c1]", parts)
    graph = (";".join(parts)
             + f";color=c=black:s={W}x{H}:d=1:r={FPS}[bg];"
             + f"[bg]{label}overlay=x={px}:y={py}:format=auto[v]")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
                    "-i", f"color=c=red:s={W}x{H}:d=1:r={FPS}",
                    "-filter_complex", graph, "-map", "[v]",
                    "-frames:v", "1", "-update", "1", str(out_path)], check=True)
    return out_path


def _pixels(path, points):
    out = {}
    for name, (x, y) in points.items():
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path),
                              "-vf", f"crop=1:1:{x}:{y},format=rgb24",
                              "-frames:v", "1", "-f", "rawvideo", "-"],
                             capture_output=True, check=True).stdout
        out[name] = list(raw[:3])
    return out


def test_rect_mask_leaves_the_corners_black(tmp_path):
    img = _render({"mask": {"on": True, "shape": "rect", "x": 50, "y": 50,
                            "w": 50, "h": 50, "feather": 0}}, tmp_path / "rect.png")
    px = _pixels(img, {"corner": (3, 3), "edge": (160, 8), "centre": (160, 120)})
    assert px["corner"] == [0, 0, 0]
    assert px["edge"] == [0, 0, 0]
    assert px["centre"][0] > 200 and px["centre"][1] < 40


def test_ellipse_mask_is_round(tmp_path):
    img = _render({"mask": {"on": True, "shape": "ellipse", "x": 50, "y": 50,
                            "w": 60, "h": 60, "feather": 0}}, tmp_path / "ell.png")
    px = _pixels(img, {"corner": (3, 3), "centre": (160, 120),
                       "inside_left": (130, 120), "corner_box": (100, 60)})
    assert px["corner"] == [0, 0, 0]
    assert px["centre"][0] > 200
    assert px["inside_left"][0] > 200       # still inside the ellipse
    assert px["corner_box"] == [0, 0, 0]    # but outside the curve


def test_inverted_mask_keeps_the_edges(tmp_path):
    img = _render({"mask": {"on": True, "shape": "rect", "x": 50, "y": 50,
                            "w": 50, "h": 50, "invert": True}}, tmp_path / "inv.png")
    px = _pixels(img, {"corner": (3, 3), "centre": (160, 120)})
    assert px["corner"][0] > 200
    assert px["centre"] == [0, 0, 0]


def test_rotation_turns_the_picture_and_keeps_the_centre(tmp_path):
    img = _render({"rot": 30}, tmp_path / "rot.png")
    px = _pixels(img, {"centre": (160, 120), "top_mid": (160, 6),
                       "left_mid": (6, 120), "corner": (3, 3),
                       "far_corner": (316, 236)})
    assert px["centre"][0] > 200
    # Turning the picture exposes the frame's own corners (it is a diamond now)
    assert px["corner"] == [0, 0, 0]
    assert px["far_corner"] == [0, 0, 0]
    # ...while the middle of each edge stays covered by the rotated body.
    assert px["top_mid"][0] > 200
    assert px["left_mid"][0] > 200
