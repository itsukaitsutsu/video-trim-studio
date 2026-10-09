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


def test_timeline_preview_and_list_follow_the_same_playhead(browser_page):
    page, page_errors = browser_page
    open_demo(page)
    page.wait_for_function("document.getElementById('player').readyState >= 1")

    def canvas_box():
        page.locator("#timeline").scroll_into_view_if_needed()
        return page.locator("#timeline").bounding_box()

    def x_of(t: float) -> float:
        return page.evaluate(
            "t => { const r = document.getElementById('timeline').getBoundingClientRect();"
            " return r.left + t2x(t); }", t)

    # Clicking a clip should select it, move the playhead, seek the preview,
    # and mark the matching section in the clip list.
    box = canvas_box()
    page.mouse.click(x_of(6.0), box["y"] + 48)
    page.wait_for_function("Math.abs(document.getElementById('player').currentTime - 6) < 0.25")
    clip_id = page.evaluate("S.tl.clips[0].id")
    assert abs(page.evaluate("S.T") - 6.0) < 0.1
    assert page.evaluate("id => S.sel.has(id)", clip_id)
    assert page.locator(f"#secTable tbody tr[data-id='{clip_id}']").evaluate(
        "row => row.classList.contains('at-playhead')")

    # Moving the clip changes which source frame belongs under the same
    # timeline time. The preview must follow the updated source mapping.
    page.evaluate("""() => {
      const id = S.tl.clips[0].id;
      S.tl = TLM.moveItems(S.tl, [id], 3, 0);
      refresh();
    }""")
    page.wait_for_function("Math.abs(document.getElementById('player').currentTime - 3) < 0.25")
    assert abs(page.evaluate("S.T") - 6.0) < 0.1
    assert page.locator(f"#secTable tbody tr[data-id='{clip_id}']").evaluate(
        "row => row.classList.contains('at-playhead')")

    # A row click seeks back through the moved clip's source in-point too.
    page.locator(f"#secTable tbody tr[data-id='{clip_id}'] td:nth-child(2)").click()
    page.wait_for_function("Math.abs(document.getElementById('player').currentTime - 0.01) < 0.2")
    assert abs(page.evaluate("S.T") - 3.01) < 0.1
    assert not page_errors, page_errors


def test_caption_cards_cover_every_lane_and_follow_timeline_selection(browser_page):
    page, page_errors = browser_page
    open_demo(page)
    page.wait_for_function("document.getElementById('player').readyState >= 1")
    page.evaluate("""() => {
      S.tl = {
        clips: [{ id: 'video-1', start: 0, end: S.duration, in: 0, kind: null, text: '' }],
        caps: [
          { id: 'caption-t1', lane: 0, start: 1, end: 2, text: 'Lane one', style: null },
          { id: 'caption-t2', lane: 1, start: 1.2, end: 2.2, text: 'Lane two', style: null },
          { id: 'caption-t3', lane: 2, start: 2.5, end: 3.5, text: 'Lane three', style: null },
          ...Array.from({ length: 24 }, (_, i) => ({
            id: `filler-${i}`, lane: i % 3, start: 4 + i * 0.4,
            end: 4 + i * 0.4 + 0.3, text: `Filler ${i}`, style: null,
          })),
        ],
        lanes: 3,
      };
      S.sel = new Set();
      S.T = 0;
      S.lastJSON = JSON.stringify(S.tl);
      refresh(true);
    }""")

    for cue_id, lane in [("caption-t1", "T1"), ("caption-t2", "T2"), ("caption-t3", "T3")]:
        assert page.locator(f"#secTable tbody tr[data-id='{cue_id}'] td.track").inner_text() == lane

    # Start scrolled well away from the early caption rows. Clicking a timeline
    # item should bring its matching card back into the list viewport.
    bottom_scroll = page.locator(".list-scroll").evaluate(
        "el => { el.scrollTop = el.scrollHeight; return el.scrollTop; }")
    assert bottom_scroll > 0
    page.locator("#timeline").scroll_into_view_if_needed()

    # Clicking the T2 block selects the matching T2 card and places the
    # playhead/preview at the same time, even while T1 overlaps it.
    point = page.evaluate("""t => {
      const r = document.getElementById('timeline').getBoundingClientRect();
      return { x: r.left + t2x(t), y: r.top + laneY(1) + 10 };
    }""", 1.6)
    page.mouse.click(point["x"], point["y"])
    page.wait_for_function("Math.abs(document.getElementById('player').currentTime - 1.6) < 0.25")
    assert abs(page.evaluate("S.T") - 1.6) < 0.1
    assert page.evaluate("S.capSel") == "caption-t2"
    t2row = page.locator("#secTable tbody tr[data-id='caption-t2']")
    assert t2row.evaluate("row => row.classList.contains('sel')")
    assert t2row.evaluate("row => row.classList.contains('at-playhead')")
    assert page.locator(".list-scroll").evaluate("el => el.scrollTop") < bottom_scroll
    assert page.evaluate("""() => {
      const list = document.querySelector('.list-scroll');
      const row = document.querySelector("#secTable tbody tr[data-id='caption-t2']");
      const headHeight = list.querySelector('thead').getBoundingClientRect().height;
      const box = row.getBoundingClientRect();
      const viewport = list.getBoundingClientRect();
      return box.top >= viewport.top + headHeight - 1 && box.bottom <= viewport.bottom + 1;
    }""")
    assert page.locator("#secTable tbody tr[data-id='caption-t1']").evaluate(
        "row => row.classList.contains('at-playhead')")

    # Clicking the T3 card selects its exact lane item and seeks the timeline.
    page.locator("#secTable tbody tr[data-id='caption-t3'] td.track").click()
    page.wait_for_function("Math.abs(document.getElementById('player').currentTime - 2.51) < 0.25")
    assert abs(page.evaluate("S.T") - 2.51) < 0.1
    assert page.evaluate("S.capSel") == "caption-t3"
    assert page.locator("#secTable tbody tr[data-id='caption-t3']").evaluate(
        "row => row.classList.contains('at-playhead') && row.classList.contains('sel')")
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
    cell = page.locator("#secTable tbody tr[data-type='clip'] td.txt", has_text=first["text"]).first
    cell.click()
    page.keyboard.press("Control+a")
    page.keyboard.type("Changed in the list")
    page.keyboard.press("Enter")
    assert page.evaluate("S.tl.clips.some(c => c.text === 'Changed in the list')")
    assert page.evaluate("S.tl.caps.some(c => c.text === 'Changed in the list')")

    # Check one clip, then hold and drag across another checkbox to paint a
    # multi-selection instead of clicking every section individually.
    n = page.evaluate("S.tl.clips.length")
    first = page.locator("#secTable tbody tr:nth-child(1) input[type=checkbox]")
    second = page.locator("#secTable tbody tr:nth-child(2) input[type=checkbox]")
    first.scroll_into_view_if_needed()
    first_box, second_box = first.bounding_box(), second.bounding_box()
    first_id = page.locator("#secTable tbody tr:nth-child(1)").get_attribute("data-id")
    second_id = page.locator("#secTable tbody tr:nth-child(2)").get_attribute("data-id")
    selected_clip_count = page.evaluate(
        "ids => S.tl.clips.filter(clip => ids.includes(clip.id)).length",
        [first_id, second_id])
    page.mouse.click(first_box["x"] + first_box["width"] / 2,
                     first_box["y"] + first_box["height"] / 2)
    assert page.evaluate("S.sel.size") == 1

    page.mouse.move(second_box["x"] + second_box["width"] / 2,
                    second_box["y"] + second_box["height"] / 2)
    page.mouse.down()
    page.mouse.move(first_box["x"] + first_box["width"] / 2,
                    first_box["y"] + first_box["height"] / 2, steps=4)
    page.mouse.up()
    assert page.evaluate("ids => ids.every(id => S.sel.has(id))", [first_id, second_id])
    assert page.evaluate("S.sel.size") == 2

    page.click("#selRemove")
    assert page.evaluate("S.tl.clips.length") == n - selected_clip_count
    assert not page_errors, page_errors


def test_track_labels_stay_pinned_left_during_horizontal_pan(browser_page):
    page, page_errors = browser_page
    open_demo(page)
    page.click("#tlLane")
    page.evaluate("""() => {
      S.view = { start: 0, span: S.duration / 2 };
      draw();
    }""")

    rail = page.locator("#trackLabels")
    assert rail.locator(".track-name").all_inner_texts() == ["V1", "T1", "T2"]
    before = rail.bounding_box()
    start_before = page.evaluate("S.view.start")
    page.locator("#timeline").evaluate("""canvas => canvas.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaX: 400, deltaY: 0,
      clientX: canvas.clientWidth / 2,
    }))""")

    assert page.evaluate("S.view.start") > start_before, "the time view should pan horizontally"
    after = rail.bounding_box()
    assert abs(after["x"] - before["x"]) < 1
    assert abs(after["width"] - before["width"]) < 1
    assert abs(page.locator("#timeline").bounding_box()["x"] - after["x"] - after["width"]) < 1
    assert not page_errors, page_errors


def test_startup_reopens_saved_video_when_project_is_missing(browser_page):
    page, page_errors = browser_page
    open_demo(page)
    saved_path = page.locator("#pathInput").input_value()
    saved_name = page.evaluate("S.project.info.name")

    # Mimic the empty in-memory project seen after a server restart. Startup
    # should ask for the saved original path and reopen it automatically.
    page.route("**/api/project", lambda route: route.fulfill(
        status=409, content_type="application/json",
        body='{"detail":"No video is open yet."}',
    ))
    page.reload()
    page.wait_for_function(
        "name => S.project && S.project.info.name === name", arg=saved_name, timeout=30000)
    assert page.locator("#pathInput").input_value() == saved_path
    assert not page_errors, page_errors
