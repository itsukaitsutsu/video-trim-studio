"""Regression coverage for uploaded overlays, app fonts and shadow export."""
import shutil
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import server
from vts import captionmap
from vts.fonts import FontLibrary, MAX_FONT_BYTES
from vts.timeline import TimelineError


def test_shadow_scaled_offsets_and_disabled(tmp_path):
    path = tmp_path / 'cap.ass'
    cue = {'start': 0, 'end': 1, 'text': 'Shadow'}
    style = dict(x=.5, y=.5, shadow_angle=0, shadow_distance=30,
                 shadow_size=0, shadow_blur=12, shadow_opacity=50)
    captionmap.write_ass([cue], path, 960, 540, style)
    text = path.read_text()
    shadow = next(line for line in text.splitlines() if line.startswith('Dialogue: 0'))
    foreground = next(line for line in text.splitlines() if line.startswith('Dialogue: 1'))
    assert r'\pos(495,270)' in shadow   # 30 design pixels -> 15 at 540p
    assert r'\blur6.00' in shadow
    assert r'\pos(480,270)' in foreground
    assert r'\blur0' in foreground
    captionmap.write_ass([cue], path, 960, 540, {**style, 'shadow_enabled': False})
    assert 'Dialogue: 0' not in path.read_text()


def test_shadow_spread_does_not_multiply_opacity(tmp_path):
    """Spread grows one silhouette; it must not stack copies that darken it."""
    path = tmp_path / 'cap.ass'
    captionmap.write_ass([dict(start=0, end=1, text='Hi')], path, 1920, 1080,
                        dict(shadow_opacity=50, shadow_size=6))
    shadows = [s for s in path.read_text().splitlines() if s.startswith('Dialogue: 0')]
    assert len(shadows) == 1
    # 50% opacity is written once, as alpha 0x80, on one pass.
    assert r'\1a&H80&' in shadows[0] and r'\3a&H80&' in shadows[0]
    # The spread widens the outline instead (design pixels at 1080p).
    assert r'\bord6.00' in shadows[0]


def installed_font():
    fonts = FontLibrary(Path('/nonexistent-font-test-dir')).scan()
    if not fonts:
        pytest.skip('No TTF/OTF system fonts')
    library = FontLibrary(Path('/nonexistent-font-test-dir'))
    library.scan()
    return Path(next(iter(library.records.values()))['path'])


def test_font_import_persistence_and_api(tmp_path, monkeypatch):
    lib = FontLibrary(tmp_path / 'fonts')
    monkeypatch.setattr(server, 'FONT_LIBRARY', lib)
    font = installed_font()
    data = font.read_bytes()
    with TestClient(server.app) as client:
        r = client.post('/api/fonts', files={'file': ('../../a' + font.suffix, data)})
        assert r.status_code == 200, r.text
        item = r.json()
        assert item['family'] and 'path' not in item
        assert client.get('/api/fonts/' + item['id']).content == data
        again = client.post('/api/fonts', files={'file': ('a' + font.suffix, data)}).json()
        assert again['id'] == item['id']
        assert client.post('/api/fonts', files={'file': ('bad.ttf', b'garbage')}).status_code == 400
        assert client.post('/api/fonts', files={'file': ('bad.exe', data)}).status_code == 400
        assert client.get('/api/fonts/not-a-font').status_code == 404
        assert client.post('/api/fonts', files={'file': ('big.ttf', b'x' * (MAX_FONT_BYTES + 1))}).status_code == 400
    imported = [f for f in FontLibrary(lib.directory).scan() if f['imported']]
    assert len(imported) == 1


def make_clip(path, color, duration, audio=False):
    cmd = ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
           f'color={color}:s=160x90:r=20:d={duration}']
    if audio:
        cmd += ['-f', 'lavfi', '-i', f'sine=frequency=440:duration={duration}', '-c:a', 'aac']
    cmd += ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(path)]
    subprocess.run(cmd, check=True, capture_output=True)


def pixel(path, t):
    data = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(t), '-i', str(path),
                           '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                          capture_output=True, check=True).stdout
    return tuple(data[:3])
