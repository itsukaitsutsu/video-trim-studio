"""Media bin, multi-track compositing and audio-lane export coverage."""
import math
from array import array
import subprocess
import time

import pytest
from fastapi.testclient import TestClient

import server
from vts.medialib import MAIN_ID

pytestmark = pytest.mark.skipif(
    not subprocess.run(['bash', '-lc', 'command -v ffmpeg'],
                       capture_output=True).returncode == 0,
    reason='needs FFmpeg')


def make_clip(path, color, duration, audio=False, freq=440, size='160x90'):
    cmd = ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
           f'color={color}:s={size}:r=20:d={duration}']
    if audio:
        cmd += ['-f', 'lavfi', '-i', f'sine=frequency={freq}:duration={duration}',
                '-c:a', 'aac', '-shortest']
    cmd += ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(path)]
    subprocess.run(cmd, check=True, capture_output=True)


def tone_levels(path, start, end, freqs, rate=8000):
    """Goertzel magnitude of each frequency in a window of the exported mix."""
    raw = subprocess.run(
        ['ffmpeg', '-v', 'error', '-ss', str(start), '-t', str(end - start),
         '-i', str(path), '-ac', '1', '-ar', str(rate), '-f', 's16le', '-'],
        capture_output=True, check=True).stdout
    pcm = array('h')
    pcm.frombytes(raw[:len(raw) // 2 * 2])
    out = {}
    for freq in freqs:
        coeff = 2 * math.cos(2 * math.pi * freq / rate)
        s1 = s2 = 0.0
        for sample in pcm:
            s0 = sample / 32768.0 + coeff * s1 - s2
            s2, s1 = s1, s0
        out[freq] = math.sqrt(max(0.0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / max(1, len(pcm))
    return out


def pixel_box(path, t, x, y):
    """Average an 8x8 box so a single compressed pixel cannot skew the result."""
    out = subprocess.run(
        ['ffmpeg', '-v', 'error', '-ss', str(t), '-i', str(path), '-frames:v', '1',
         '-vf', f'crop=8:8:{x}:{y},scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
        capture_output=True, check=True).stdout
    return tuple(out[:3])


def run_export(client, output, opts=None):
    r = client.post('/api/export/timeline', json={
        'output': str(output),
        'opts': opts or {'mode': 'copy', 'codec': 'libx264', 'preset': 'ultrafast',
                         'hwaccel': 'none'}})
    assert r.status_code == 200, r.text
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        job = client.get('/api/job/' + r.json()['id']).json()
        if job['state'] in ('done', 'error'):
            break
        time.sleep(.05)
    assert job['state'] == 'done', job
    return job


def test_open_project_registers_the_main_asset(tmp_path, monkeypatch):
    monkeypatch.setattr(server, 'WORK_DIR', tmp_path)
    monkeypatch.setattr(server, 'LAST_PROJECT_FILE', tmp_path / 'last.txt')
    main = tmp_path / 'main.mp4'
    make_clip(main, 'red', 3, True)
    with TestClient(server.app) as client:
        assert client.post('/api/open', json={'path': str(main)}).status_code == 200
        assets = client.get('/api/bin').json()['assets']
        by_id = {a['id']: a for a in assets}
        assert MAIN_ID in by_id
        assert by_id[MAIN_ID]['main'] is True
        assert by_id[MAIN_ID]['kind'] == 'video'
        assert by_id[MAIN_ID]['duration'] == pytest.approx(3, abs=.1)
        # The bin must not duplicate the project's own preview transcode.
        assert by_id[MAIN_ID]['preview']['state'] == 'none'


def test_bin_upload_import_and_remove(tmp_path, monkeypatch):
    monkeypatch.setattr(server, 'WORK_DIR', tmp_path)
    monkeypatch.setattr(server, 'LAST_PROJECT_FILE', tmp_path / 'last.txt')
    main = tmp_path / 'main.mp4'
    blue = tmp_path / 'blue.mp4'
    make_clip(main, 'red', 3, True)
    make_clip(blue, 'blue', 1)
    with TestClient(server.app) as client:
        assert client.post('/api/open', json={'path': str(main)}).status_code == 200
        r = client.post('/api/bin/import', json={'paths': [str(blue)]})
        assert r.status_code == 200, r.text
        body = r.json()
        assert len(body['added']) == 1
        asset = next(a for a in body['assets'] if a['id'] == body['added'][0])
        assert asset['kind'] == 'video'
        assert asset['name'] == 'blue.mp4'
        assert asset['has_audio'] is False          # blue was rendered silent
        assert asset['preview']['state'] == 'none'  # mp4 is already browser-playable
        assert client.get('/api/bin').json()['assets'][1]['id'] == asset['id']
        # A second import must reuse the same asset instead of duplicating it.
        again = client.post('/api/bin/import', json={'paths': [str(blue)]}).json()
        assert again['added'] == [asset['id']]
        assert len(client.get('/api/bin').json()['assets']) == 2
        assert client.delete('/api/bin/' + asset['id']).status_code == 200
        assert [a['id'] for a in client.get('/api/bin').json()['assets']] == [MAIN_ID]
        # The main asset is the project itself and cannot be dropped.
        assert client.delete('/api/bin/' + MAIN_ID).status_code == 400


def test_upload_rejects_junk_and_honours_the_asset_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(server, 'WORK_DIR', tmp_path)
    monkeypatch.setattr(server, 'LAST_PROJECT_FILE', tmp_path / 'last.txt')
    main = tmp_path / 'main.mp4'
    make_clip(main, 'red', 3, True)
    with TestClient(server.app) as client:
        assert client.post('/api/open', json={'path': str(main)}).status_code == 200
        r = client.post('/api/bin/upload', files={'file': ('bad.mp4', b'not a video')})
        assert r.status_code == 400
        for i in range(63):   # 63 uploads + the main asset = the 64-asset cap
            clip = tmp_path / f'c{i}.mp4'
            make_clip(clip, 'blue', 1)
            r = client.post('/api/bin/upload',
                            files={'file': (f'c{i}.mp4', clip.read_bytes())})
            assert r.status_code == 200, r.text
            clip.unlink()
        assert client.post('/api/bin/upload', files={'file': (
            'x.mp4', (tmp_path / 'x.mp4').write_bytes(b'') or b'y')}).status_code == 400


def test_missing_import_path_is_reported(tmp_path, monkeypatch):
    monkeypatch.setattr(server, 'WORK_DIR', tmp_path)
    monkeypatch.setattr(server, 'LAST_PROJECT_FILE', tmp_path / 'last.txt')
    main = tmp_path / 'main.mp4'
    make_clip(main, 'red', 3, True)
    with TestClient(server.app) as client:
        assert client.post('/api/open', json={'path': str(main)}).status_code == 200
        good = tmp_path / 'ok.mp4'
        make_clip(good, 'blue', 1)
        r = client.post('/api/bin/import',
                        json={'paths': [str(good), str(tmp_path / 'gone.mp4')]})
        assert r.status_code == 200
        assert r.json()['added']
        assert r.json()['errors']
        # Failing alone is a hard error so the UI can show why.
        assert client.post('/api/bin/import', json={'paths': [
            str(tmp_path / 'gone.mp4')]}).status_code == 400


def test_upper_lane_video_composites_over_the_main_track(tmp_path, monkeypatch):
    monkeypatch.setattr(server, 'WORK_DIR', tmp_path)
    monkeypatch.setattr(server, 'LAST_PROJECT_FILE', tmp_path / 'last.txt')
    main, overlay = tmp_path / 'main.mp4', tmp_path / 'blue.mp4'
    make_clip(main, 'red', 3, True)
    make_clip(overlay, 'blue', 1)
    output = tmp_path / 'out.mp4'
    with TestClient(server.app) as client:
        assert client.post('/api/open', json={'path': str(main)}).status_code == 200
        asset = client.post('/api/bin/import',
                            json={'paths': [str(overlay)]}).json()['assets'][-1]
        timeline = dict(
            lanes=2, atracks=2,
            clips=[dict(id='c1', src=MAIN_ID, track=0, start=0, end=3, **{'in': 0}),
                   dict(id='c2', src=asset['id'], track=1, start=1, end=2, **{'in': 0},
                        fx=dict(scale=40))],
            auds=[], caps=[])
        r = client.put('/api/timeline', json=timeline)
        assert r.status_code == 200, r.text
        saved = client.get('/api/timeline').json()['timeline']
        assert saved['clips'][1]['track'] == 1          # not auto-restacked onto V1
        run_export(client, output)
        before, during, after = (pixel_box(output, .5, 76, 41),
                                 pixel_box(output, 1.5, 76, 41),
                                 pixel_box(output, 2.5, 76, 41))
        assert before[0] > 200 and before[2] < 40          # red
        assert during[2] > 200 and during[0] < 40          # blue overlay on top
        assert after[0] > 200 and after[2] < 40            # overlay ends cleanly
        # The corner stays red: the overlay is a picture-in-picture, not a wipe.
        corner = pixel_box(output, 1.5, 4, 4)
        assert corner[0] > 200 and corner[2] < 40
        assert server.probe(str(output))['audio']


def test_audio_lane_item_mixes_with_the_main_sound(tmp_path, monkeypatch):
    monkeypatch.setattr(server, 'WORK_DIR', tmp_path)
    monkeypatch.setattr(server, 'LAST_PROJECT_FILE', tmp_path / 'last.txt')
    main, music = tmp_path / 'main.mp4', tmp_path / 'music.wav'
    make_clip(main, 'red', 3, True, freq=440)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                    'sine=frequency=220:duration=1', str(music)],
                   check=True, capture_output=True)
    output = tmp_path / 'out.mp4'
    with TestClient(server.app) as client:
        assert client.post('/api/open', json={'path': str(main)}).status_code == 200
        asset = client.post('/api/bin/import',
                            json={'paths': [str(music)]}).json()['assets'][-1]
        assert asset['kind'] == 'audio'
        assert asset['has_video'] is False
        assert asset['preview']['state'] in ('none', 'ready', 'building', 'error')
        timeline = dict(
            lanes=1, atracks=1,
            clips=[dict(id='c1', src=MAIN_ID, track=0, start=0, end=3, **{'in': 0})],
            auds=[dict(id='a1', src=asset['id'], atrack=0, start=2.0, end=3.0,
                       **{'in': 0})],
            caps=[])
        assert client.put('/api/timeline', json=timeline).status_code == 200
        run_export(client, output)
        assert server.probe(str(output))['audio']
        before = tone_levels(output, .2, 1.8, (220, 440))
        during = tone_levels(output, 2.2, 2.8, (220, 440))
        # 440 Hz is the whole way through; 220 Hz only where the A1 item sits.
        assert before[440] > 20 * before[220]
        assert during[220] > .2 * during[440]
        assert during[440] > .2 * before[440]      # the main track is not ducked


def test_unlinked_clip_audio_keeps_playing_from_the_a_lane(tmp_path, monkeypatch):
    monkeypatch.setattr(server, 'WORK_DIR', tmp_path)
    monkeypatch.setattr(server, 'LAST_PROJECT_FILE', tmp_path / 'last.txt')
    main = tmp_path / 'main.mp4'
    make_clip(main, 'red', 3, True)
    output = tmp_path / 'out.mp4'
    with TestClient(server.app) as client:
        assert client.post('/api/open', json={'path': str(main)}).status_code == 200
        timeline = dict(
            lanes=1, atracks=1,
            clips=[dict(id='c1', src=MAIN_ID, track=0, start=0, end=3, **{'in': 0},
                        audio=False)],
            auds=[dict(id='a1', src=MAIN_ID, atrack=0, start=0, end=3, **{'in': 0})],
            caps=[])
        r = client.put('/api/timeline', json=timeline)
        assert r.status_code == 200, r.text
        saved = client.get('/api/timeline').json()['timeline']
        assert saved['clips'][0]['audio'] is False
        assert saved['auds'][0]['src'] == MAIN_ID
        run_export(client, output)
        assert server.probe(str(output))['audio']
        assert server.probe(str(output))['duration'] == pytest.approx(3, abs=.2)


def test_image_asset_gets_a_default_duration(tmp_path, monkeypatch):
    monkeypatch.setattr(server, 'WORK_DIR', tmp_path)
    monkeypatch.setattr(server, 'LAST_PROJECT_FILE', tmp_path / 'last.txt')
    main, png = tmp_path / 'main.mp4', tmp_path / 'logo.png'
    make_clip(main, 'red', 3, True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                    'color=green:s=80x45:d=1', '-frames:v', '1', str(png)],
                   check=True, capture_output=True)
    with TestClient(server.app) as client:
        assert client.post('/api/open', json={'path': str(main)}).status_code == 200
        asset = client.post('/api/bin/import',
                            json={'paths': [str(png)]}).json()['assets'][-1]
        assert asset['kind'] == 'image'
        assert asset['duration'] == pytest.approx(5.0, abs=.01)
        assert asset['width'] == 80 and asset['height'] == 45


def test_png_is_served_as_an_image_not_a_proxy(tmp_path, monkeypatch):
    """A still must reach the <img> as image/png - no transcode, no octet-stream."""
    monkeypatch.setattr(server, 'WORK_DIR', tmp_path)
    monkeypatch.setattr(server, 'LAST_PROJECT_FILE', tmp_path / 'last.txt')
    main, png = tmp_path / 'main.mp4', tmp_path / 'still.png'
    make_clip(main, 'red', 3, True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                    'color=green:s=64x36:d=1', '-frames:v', '1', str(png)],
                   check=True, capture_output=True)
    with TestClient(server.app) as client:
        assert client.post('/api/open', json={'path': str(main)}).status_code == 200
        asset = client.post('/api/bin/import', json={'paths': [str(png)]}).json()['assets'][-1]
        assert asset['kind'] == 'image'
        # Direct: the browser paints the file itself, so no proxy is started.
        assert asset['preview'] == {'state': 'none', 'ready': False, 'progress': 0}
        served = client.get(f"/api/bin/{asset['id']}/stream")
        assert served.status_code == 200
        assert served.headers['content-type'].split(';')[0] == 'image/png'
        assert served.content[:8] == b'\x89PNG\r\n\x1a\n'
        # No proxy file was written for it either.
        assert not list(tmp_path.rglob('*.proxy.mp4'))


def test_convert_only_image_gets_a_png_preview_copy(tmp_path, monkeypatch):
    """TIFF: kept as the source of truth, previewed through a PNG sidecar."""
    monkeypatch.setattr(server, 'WORK_DIR', tmp_path)
    monkeypatch.setattr(server, 'LAST_PROJECT_FILE', tmp_path / 'last.txt')
    main, tif = tmp_path / 'main.mp4', tmp_path / 'scan.tiff'
    make_clip(main, 'blue', 3, True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                    'color=yellow:s=48x32:d=1', '-frames:v', '1', str(tif)],
                   check=True, capture_output=True)
    with TestClient(server.app) as client:
        assert client.post('/api/open', json={'path': str(main)}).status_code == 200
        asset = client.post('/api/bin/import', json={'paths': [str(tif)]}).json()['assets'][-1]
        assert asset['kind'] == 'image'
        assert asset['preview']['state'] == 'none'
        served = client.get(f"/api/bin/{asset['id']}/stream")
        assert served.headers['content-type'].split(';')[0] == 'image/png'
        assert served.content[:4] == b'\x89PNG'
        # Removing the asset removes the sidecar as well.
        assert client.delete(f"/api/bin/{asset['id']}").status_code == 200
        assert not list((tmp_path / 'binstills').glob('*.png'))


def test_still_cannot_be_opened_as_the_project_source(tmp_path, monkeypatch):
    monkeypatch.setattr(server, 'WORK_DIR', tmp_path)
    monkeypatch.setattr(server, 'LAST_PROJECT_FILE', tmp_path / 'last.txt')
    png = tmp_path / 'lonely.png'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                    'color=white:s=40x24:d=1', '-frames:v', '1', str(png)],
                   check=True, capture_output=True)
    with TestClient(server.app) as client:
        res = client.post('/api/open', json={'path': str(png)})
        assert res.status_code == 400
        assert 'still image' in res.json()['detail']
        assert 'Media bin' in res.json()['detail']


def test_svg_becomes_a_still_through_the_png_copy(tmp_path, monkeypatch):
    """SVG is a still, not a video: rasterised once, served as image/png."""
    monkeypatch.setattr(server, 'WORK_DIR', tmp_path)
    monkeypatch.setattr(server, 'LAST_PROJECT_FILE', tmp_path / 'last.txt')
    main, svg = tmp_path / 'main.mp4', tmp_path / 'logo.svg'
    make_clip(main, 'red', 3, True)
    svg.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="36">'
                   '<rect width="64" height="36" fill="#0af"/></svg>')
    with TestClient(server.app) as client:
        assert client.post('/api/open', json={'path': str(main)}).status_code == 200
        res = client.post('/api/bin/import', json={'paths': [str(svg)]})
        assert res.status_code == 200, res.text
        asset = res.json()['assets'][-1]
        assert asset['kind'] == 'image'
        assert asset['preview']['state'] == 'none'
        served = client.get(f"/api/bin/{asset['id']}/stream")
        assert served.headers['content-type'].split(';')[0] == 'image/png'


def test_unreadable_image_is_refused_with_a_reason(tmp_path, monkeypatch):
    monkeypatch.setattr(server, 'WORK_DIR', tmp_path)
    monkeypatch.setattr(server, 'LAST_PROJECT_FILE', tmp_path / 'last.txt')
    main, bad = tmp_path / 'main.mp4', tmp_path / 'broken.tiff'
    make_clip(main, 'red', 3, True)
    bad.write_bytes(b'not actually a tiff')
    with TestClient(server.app) as client:
        assert client.post('/api/open', json={'path': str(main)}).status_code == 200
        res = client.post('/api/bin/import', json={'paths': [str(bad)]})
        assert res.status_code == 400
        assert 'broken.tiff' in res.json()['detail']


def test_audio_only_files_are_not_transcoded(tmp_path, monkeypatch):
    """MP3/WAV play in an <audio> tag, so the bin must not build a proxy."""
    monkeypatch.setattr(server, 'WORK_DIR', tmp_path)
    monkeypatch.setattr(server, 'LAST_PROJECT_FILE', tmp_path / 'last.txt')
    main, mp3, wav = tmp_path / 'main.mp4', tmp_path / 'tone.mp3', tmp_path / 'tone.wav'
    make_clip(main, 'red', 2, True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                    'sine=frequency=440:duration=1', str(mp3)], check=True, capture_output=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                    'sine=frequency=660:duration=1', str(wav)], check=True, capture_output=True)
    with TestClient(server.app) as client:
        assert client.post('/api/open', json={'path': str(main)}).status_code == 200
        assets = client.post('/api/bin/import',
                             json={'paths': [str(mp3), str(wav)]}).json()['assets']
        for asset in [a for a in assets if a['name'].startswith('tone')]:
            assert asset['kind'] == 'audio'
            assert asset['preview']['state'] == 'none', asset['name']
            served = client.get(f"/api/bin/{asset['id']}/stream")
            assert served.headers['content-type'].startswith('audio/'), asset['name']
