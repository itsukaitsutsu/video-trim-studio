"""Browser test of the timeline editor: real mouse and keyboard on the page.

Starts the app on a free port and drives it with Playwright (Chromium). Skipped
when Playwright or its browser is not installed.
"""

import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sync_api = pytest.importorskip("playwright.sync_api")
pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg / ffprobe not installed",
)


def duration_of(path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True).stdout.strip()
    return float(out)


def open_demo(page):
    """Open the demo and wait until the NEW project is loaded (not the old state)."""
    page.click("#demoBtn")
    page.wait_for_function(
        "S.project && S.duration > 10 && S.tl.clips.length === 1 && S.tl.clips[0].kind === null"
        " && S.tl.caps.length === 0 && S.undo.length === 0")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def base_url():
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
            break
        except OSError:
            time.sleep(0.2)
    yield f"http://127.0.0.1:{port}"
    proc.terminate()
    proc.wait(timeout=15)


@pytest.fixture(scope="module")
def browser_page(base_url):
    try:
        playwright = sync_api.sync_playwright().start()
    except Exception as exc:  # pragma: no cover - environment dependent
        pytest.skip(f"Playwright unavailable: {exc}")
    try:
        browser = playwright.chromium.launch()
    except Exception as exc:  # pragma: no cover - browser not installed
        playwright.stop()
        pytest.skip(f"Chromium not installed for Playwright: {exc}")
    page = browser.new_page(viewport={"width": 1400, "height": 1000})
    page_errors: list[str] = []
    page.on("pageerror", lambda err: page_errors.append(str(err)))
    page.goto(base_url + "/")
    page.wait_for_function("typeof S !== 'undefined' && typeof t2x === 'function'")
    yield page, page_errors
    browser.close()
    playwright.stop()


def test_timeline_split_ripple_undo_paste_caption_export(browser_page, tmp_path):
    page, page_errors = browser_page

    open_demo(page)
    assert page.evaluate("S.tl.clips.length") == 1

    # Measure the canvas at every click: the layout can move while the page loads.
    def canvas_box():
        page.locator("#timeline").scroll_into_view_if_needed()
        return page.locator("#timeline").bounding_box()

    def ruler_y() -> float:
        return canvas_box()["y"] + 8          # ruler row

    def video_y() -> float:
        return canvas_box()["y"] + 48         # video row

    def x_of(t: float) -> float:
        return page.evaluate(
            "t => { const r = document.getElementById('timeline').getBoundingClientRect();"
            " return r.left + t2x(t); }", t)

    # Razor at 6 s (playhead from a ruler click, Ctrl+K splits).
    page.mouse.click(x_of(6.0), ruler_y())
    assert abs(page.evaluate("S.T") - 6.0) < 0.2
    page.keyboard.press("Control+k")
    assert page.evaluate("S.tl.clips.length") == 2

    # Select the second half and ripple-delete it (Shift+Delete closes the gap).
    page.mouse.click(x_of(12.0), video_y())
    assert page.evaluate("S.sel.size") == 1, "the click should select the clip"
    page.keyboard.press("Shift+Delete")
    assert page.evaluate("S.tl.clips.length") == 1
    assert abs(page.evaluate("S.tl.clips[0].end") - 6.0) < 0.05   # click precision ~1 px

    # Undo brings the second half back; redo removes it again.
    page.keyboard.press("Control+z")
    assert page.evaluate("S.tl.clips.length") == 2
    page.keyboard.press("Control+Shift+z")
    assert page.evaluate("S.tl.clips.length") == 1

    # Copy the first clip and paste it at 9 s: the gap 6-9 s stays empty.
    page.mouse.click(x_of(2.0), video_y())
    page.keyboard.press("Control+c")
    page.mouse.click(x_of(9.0), ruler_y())
    page.keyboard.press("Control+v")
    starts = page.evaluate("S.tl.clips.map(c => [c.start, c.end])")
    assert len(starts) == 2
    assert abs(starts[1][0] - 9.0) < 0.05 and abs(starts[1][1] - 15.0) < 0.05

    # A caption at the playhead lands on lane 0.
    page.click("#capAdd")
    assert page.evaluate("S.tl.caps.length") == 1
    assert abs(page.evaluate("S.tl.caps[0].start") - 9.0) < 0.05

    # Export: 6 s + 3 s of black gap + 6 s = 15 s. Wait for the job to finish.
    page.click("#exportBtn")
    page.wait_for_function("S.job && S.job.id", timeout=30000)
    job_id = page.evaluate("S.job.id")
    state = "running"
    deadline = time.time() + 180
    while time.time() < deadline and state == "running":
        time.sleep(0.5)
        state = page.evaluate(
            "id => fetch('/api/job/' + id).then(r => r.json()).then(j => j.state)", job_id)
    assert state == "done", page.evaluate(
        "id => fetch('/api/job/' + id).then(r => r.json())", job_id)

    job = page.evaluate("id => fetch('/api/job/' + id).then(r => r.json())", job_id)
    assert abs(duration_of(job["output"]) - 15.0) < 0.15, "gap must be kept as black time"
    assert not page_errors, page_errors


def test_detection_fills_clips_and_captions_and_survives_reload(browser_page):
    page, page_errors = browser_page
    open_demo(page)
    page.click("#detectBtn")
    page.wait_for_function("S.tl.clips.length > 1", timeout=120000)
    clips = page.evaluate("S.tl.clips.length")
    kinds = page.evaluate("[...new Set(S.tl.clips.map(c => c.kind))]")
    assert set(kinds) & {"silence", "other", "caption"}, kinds
    assert page.evaluate("S.tl.caps.length") > 0, "demo captions should be on the timeline"

    # The edit list is saved on the server and comes back after a page reload.
    saved_clips = 0
    deadline = time.time() + 10
    while time.time() < deadline and saved_clips <= 1:
        time.sleep(0.2)
        saved_clips = page.evaluate(
            "fetch('/api/timeline').then(r => r.json())"
            ".then(j => (j.timeline ? j.timeline.clips.length : 0))")
    assert saved_clips == clips, "the server should hold the detected timeline"
    page.reload()
    page.wait_for_function("S.project && S.tl.clips.length > 1", timeout=30000)
    assert page.evaluate("S.tl.clips.length") == clips
    assert not page_errors, page_errors


def test_playback_caption_box_lanes_and_list(browser_page):
    page, page_errors = browser_page
    open_demo(page)
    page.click("#detectBtn")
    page.wait_for_function("S.tl.clips.length > 1", timeout=120000)

    # The caption box is shown (and draggable) when the export burns captions.
    page.select_option("#xCaptions", "burn")
    first = page.evaluate("S.tl.caps[0]")
    page.evaluate("t => setPlayhead(t + 0.3)", first["start"])
    shown = page.evaluate("document.getElementById('capBoxText').textContent")
    assert first["text"].split()[0] in shown, shown

    # Play for a moment: the playhead moves on and the player keeps up.
    page.click("#playBtn")
    page.wait_for_timeout(1500)
    page.click("#playBtn")
    assert page.evaluate("S.T") > first["start"] + 0.8

    # Stack another caption lane.
    lanes = page.evaluate("S.tl.lanes")
    page.click("#tlLane")
    assert page.evaluate("S.tl.lanes") == lanes + 1

    # Type a new text into the list: the section and its caption both change.
    cell = page.locator("#secTable tbody td.txt", has_text=first["text"]).first
    cell.click()
    page.keyboard.press("Control+a")
    page.keyboard.type("Changed in the list")
    page.keyboard.press("Enter")
    assert page.evaluate("S.tl.clips.some(c => c.text === 'Changed in the list')")
    assert page.evaluate("S.tl.caps.some(c => c.text === 'Changed in the list')")

    # Tick one clip in the list and remove it with ripple.
    n = page.evaluate("S.tl.clips.length")
    page.click("#secTable tbody tr:nth-child(2) input[type=checkbox]")
    assert page.evaluate("S.sel.size") == 1
    page.click("#selRemove")
    assert page.evaluate("S.tl.clips.length") == n - 1
    assert not page_errors, page_errors
