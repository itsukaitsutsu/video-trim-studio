"""Regression coverage for app fonts and single-silhouette shadow export."""
import shutil
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import server
from vts import captionmap
from vts.fonts import FontLibrary, MAX_FONT_BYTES


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


def test_shadow_spread_is_one_silhouette_not_offset_copies(tmp_path):
    path = tmp_path / 'cap.ass'
    captionmap.write_ass([dict(start=0, end=1, text='Hi')], path, 1920, 1080,
                        dict(shadow_opacity=50, shadow_size=20, shadow_blur=0))
    shadows = [s for s in path.read_text().splitlines() if s.startswith('Dialogue: 0')]
    assert len(shadows) == 1
    assert r'\bord20.00' in shadows[0]
    assert r'\1a&H80&'.lower() in shadows[0].lower()
    assert r'\3a&H80&'.lower() in shadows[0].lower()
    assert 'Cue0Shadow' in shadows[0]


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



def render_shadow(tmp_path, size=0, blur=0, distance=0, opacity=100):
    import numpy as np
    path = tmp_path / 'shadow.ass'
    captionmap.write_ass([dict(start=0, end=1, text='I')], path, 640, 360,
        dict(font='DejaVu Sans', bold=False, x=.5, y=.5, size_pct=16,
             fill_opacity=0, stroke_opacity=0, background_opacity=0,
             shadow='#ffffff', shadow_size=size, shadow_blur=blur,
             shadow_angle=0, shadow_distance=distance, shadow_opacity=opacity))
    from vts.export import escape_filter_path
    result = subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=black:s=640x360:d=1',
        '-vf',f'subtitles={escape_filter_path(str(path))}', '-frames:v','1',
        '-pix_fmt','gray','-f','rawvideo','-'], capture_output=True, check=True).stdout
    return np.frombuffer(result, dtype='uint8').reshape(360,640)


def bounds(image, threshold=20):
    import numpy as np
    y, x = np.where(image > threshold)
    assert len(x)
    return int(x.min()), int(y.min()), int(x.max()), int(y.max())


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='needs FFmpeg')
def test_real_shadow_spread_is_continuous_and_preserves_center(tmp_path):
    import numpy as np
    small = render_shadow(tmp_path, size=0)
    large = render_shadow(tmp_path, size=20)
    a, b = bounds(small), bounds(large)
    assert b[0] < a[0] - 4 and b[2] > a[2] + 4
    assert b[1] < a[1] - 4 and b[3] > a[3] + 4
    assert abs((a[0]+a[2]) - (b[0]+b[2])) <= 2
    # A vertical I dilates into ONE silhouette. The old offset ring made gaps.
    for row in large[b[1]+2:b[3]-1]:
        xs = np.flatnonzero(row > 20)
        if len(xs):
            assert np.all(row[xs[0]:xs[-1]+1] > 20)
    moved = bounds(render_shadow(tmp_path, size=20, distance=30))
    assert abs((moved[0] - b[0]) - 10) <= 1
    assert abs((moved[2] - b[2]) - 10) <= 1
    half = render_shadow(tmp_path, size=20, opacity=50)
    assert 110 <= int(half.max()) <= 145   # opacity is not accumulated per copy
    soft = render_shadow(tmp_path, size=20, blur=12)
    assert np.count_nonzero((soft > 5) & (soft < 245)) > np.count_nonzero((large > 5) & (large < 245))
