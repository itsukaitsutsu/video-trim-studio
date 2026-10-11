"""Regression coverage for uploaded overlays, app fonts and shadow export."""
import shutil
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import server
from vts import broll, captionmap
from vts.fonts import FontLibrary, MAX_FONT_BYTES
from vts.timeline import TimelineError


def test_broll_validation():
    assets = {'a': {'duration': 5}}
    clip = dict(id='b1', asset_id='a', start=1, end=3, **{'in': 1}, fit='cover')
    assert broll.normalize([clip], assets, 10) == [clip]
    for patch in ({'start': -1}, {'in': -1}, {'end': 12}, {'in': 4},
                  {'start': float('nan')}, {'asset_id': '../../file'}, {'fit': 'bogus'}):
        with pytest.raises(TimelineError):
            broll.normalize([{**clip, **patch}], assets, 10)
    with pytest.raises(TimelineError, match='overlap'):
        broll.normalize([clip, {**clip, 'id': 'b2'}], assets, 10)


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
    path = tmp_path / 'cap.ass'
    captionmap.write_ass([dict(start=0, end=1, text='Hi')], path, 1920, 1080,
                        dict(shadow_opacity=50, shadow_size=6))
    shadows = [s for s in path.read_text().splitlines() if s.startswith('Dialogue: 0')]
    assert len(shadows) == 9
    # Per-pass alpha is ~236, not 128 on each of nine overlapping passes.
    assert all(r'\alpha&HEC&'.lower() in s.lower() for s in shadows)


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


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='needs FFmpeg')
def test_broll_upload_save_and_real_export(tmp_path, monkeypatch):
    monkeypatch.setattr(server, 'WORK_DIR', tmp_path)
    monkeypatch.setattr(server, 'LAST_PROJECT_FILE', tmp_path / 'last.txt')
    main, overlay = tmp_path / 'main.mp4', tmp_path / 'blue.mp4'
    make_clip(main, 'red', 3, True)
    make_clip(overlay, 'blue', 1)
    with TestClient(server.app) as client:
        assert client.post('/api/open', json={'path': str(main)}).status_code == 200
        assert client.post('/api/broll', files={'file': ('invalid.mp4', b'no video')}).status_code == 400
        asset = client.post('/api/broll', files={'file': ('blue.mp4', overlay.read_bytes())}).json()
        second = client.post('/api/broll', files={'file': ('blue.mp4', overlay.read_bytes())}).json()
        assert asset['id'] != second['id']
        assert client.get(asset['url'], headers={'Range': 'bytes=0-9'}).status_code == 206
        timeline = dict(clips=[dict(id='c1', start=0, end=3, **{'in': 0})], caps=[], lanes=1,
                        broll=[dict(id='b1', asset_id=asset['id'], start=1, end=2, **{'in': 0}, fit='cover')])
        r = client.put('/api/timeline', json=timeline)
        assert r.status_code == 200, r.text
        assert client.get('/api/timeline').json()['timeline']['broll'][0]['asset_id'] == asset['id']
        output = tmp_path / 'result.mp4'
        r = client.post('/api/export/timeline', json={'output': str(output), 'opts': {
            'mode': 'copy', 'codec': 'libx264', 'preset': 'ultrafast', 'hwaccel': 'none'}})
        assert r.status_code == 200, r.text
        assert r.json()['kind'] == 'reencode'
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            job = client.get('/api/job/' + r.json()['id']).json()
            if job['state'] in ('done', 'error'):
                break
            time.sleep(.05)
        assert job['state'] == 'done', job
        before, during, after = pixel(output, .5), pixel(output, 1.5), pixel(output, 2.5)
        assert before[0] > 200 and before[2] < 30
        assert during[2] > 200 and during[0] < 30
        assert after[0] > 200 and after[2] < 30  # overlay must NOT freeze after end
        assert server.probe(str(output))['audio']
        # Burn text AFTER the overlay, using an imported family and global style.
        library = FontLibrary(tmp_path / "fonts imported")
        monkeypatch.setattr(server, 'FONT_LIBRARY', library)
        font_path = installed_font()
        imported = library.import_font(font_path.read_bytes(), font_path.name)
        timeline['caps'] = [dict(id='t1', lane=0, start=1, end=2, text='HI')]
        timeline['broll'][0]['fit'] = 'contain'
        captioned = tmp_path / 'captioned.mp4'
        r = client.post('/api/export/timeline', json={
            'output': str(captioned), 'timeline': timeline, 'caption_mode': 'burn',
            'caption_style': {'font': imported['family'], 'size_pct': 25, 'x': .5, 'y': .5,
                              'shadow_opacity': 50, 'shadow_angle': 0, 'shadow_distance': 10},
            'opts': {'codec': 'libx264', 'preset': 'ultrafast', 'hwaccel': 'none'}})
        assert r.status_code == 200, r.text
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            job = client.get('/api/job/' + r.json()['id']).json()
            if job['state'] in ('done', 'error'):
                break
            time.sleep(.05)
        assert job['state'] == 'done', job
        frame = subprocess.run(['ffmpeg', '-v', 'error', '-ss', '1.5', '-i', str(captioned),
                                '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                               capture_output=True, check=True).stdout
        white_pixels = sum(all(channel > 180 for channel in frame[i:i+3])
                           for i in range(0, len(frame), 3))
        assert white_pixels > 20  # captions remain visible on top of the blue overlay
        timeline['broll'][0]['asset_id'] = 'missing'
        assert client.put('/api/timeline', json=timeline).status_code == 400
        # A new main video starts a new asset collection.
        client.post('/api/open', json={'path': str(main)})
        assert client.get('/api/broll').json()['assets'] == []
