"""Direct manipulation on the Program Monitor (static/gizmo.js).

The picture itself is the tool: click it to select, double-click to get handles,
then drag to move / resize / rotate / crop / mask. These tests drive it with the
real mouse against the real demo project, so they cover the hit-testing too.

Run:  python -m pytest tests/test_gizmo_ui.py -q
"""
import pytest

# Reuse the real server + browser fixtures (and the demo loader) from the
# timeline UI suite; importing the fixtures registers them for this module.
from test_timeline_ui import base_url, browser_page, open_demo  # noqa: F401


@pytest.fixture()
def gizmo_page(browser_page):
    page, errors = browser_page
    open_demo(page)
    page.wait_for_timeout(900)          # let the save round-trip settle
    return page, errors


def stage_rect(page):
    return page.evaluate("""(() => {
      const r = document.getElementById('previewStage').getBoundingClientRect();
      return {x: r.x, y: r.y, w: r.width, h: r.height};
    })()""")


def handle(page, name):
    return page.evaluate("""(n) => {
      const el = document.querySelector(`#gizSvg [data-giz="${n}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {x: r.x + r.width / 2, y: r.y + r.height / 2};
    }""", name)


def fx(page):
    return page.evaluate("JSON.parse(JSON.stringify(S.tl.clips[0].fx))")


def drag(page, start, dx, dy, steps=8):
    page.mouse.move(start["x"], start["y"])
    page.mouse.down()
    page.mouse.move(start["x"] + dx, start["y"] + dy, steps=steps)
    page.mouse.up()
    page.wait_for_timeout(120)


def test_double_click_puts_handles_on_the_picture(gizmo_page):
    page, errors = gizmo_page
    box = stage_rect(page)
    cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
    assert page.evaluate("GIZ.editing") is False

    page.mouse.dblclick(cx, cy)
    page.wait_for_timeout(200)
    assert page.evaluate("GIZ.editing") is True
    assert page.evaluate("GIZ.mode") == "transform"
    assert page.evaluate("S.sel.size") == 1
    assert page.evaluate("S.sel.has(S.tl.clips[0].id)") is True
    # 8 scale handles + the rotate knob + the body.
    assert page.evaluate("document.querySelectorAll('#gizSvg [data-giz]').length") == 10
    assert page.is_visible("#gizHud")

    # Escape leaves edit mode but keeps the clip selected.
    page.keyboard.press("Escape")
    page.wait_for_timeout(150)
    assert page.evaluate("GIZ.editing") is False
    assert page.evaluate("S.sel.size") == 1
    assert not errors, errors


def test_drag_moves_the_clip_and_undo_puts_it_back(gizmo_page):
    page, errors = gizmo_page
    box = stage_rect(page)
    cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
    page.mouse.dblclick(cx, cy)
    page.wait_for_timeout(150)
    before = fx(page)
    drag(page, {"x": cx, "y": cy}, 90, 45)
    after = fx(page)
    assert after["x"] > before["x"] + 5
    assert after["y"] > before["y"] + 3
    # The picture moved with it (the layer is translated by x/y %).
    tf = page.evaluate("getComputedStyle(document.querySelector('.fx-layer')).transform")
    assert tf != "none"
    page.keyboard.press("Control+z")
    page.wait_for_timeout(200)
    back = fx(page)
    assert abs(back["x"] - before["x"]) < 0.01 and abs(back["y"] - before["y"]) < 0.01
    assert not errors, errors


def test_corner_handle_scales_around_the_opposite_corner(gizmo_page):
    page, errors = gizmo_page
    box = stage_rect(page)
    cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
    page.mouse.dblclick(cx, cy)
    page.wait_for_timeout(150)
    se = handle(page, "se")
    nw_before = handle(page, "nw")
    drag(page, se, -110, -60)
    got = fx(page)
    assert got["scale"] < 95
    # The opposite corner stays put: the clip grew from the north-west corner.
    nw_after = handle(page, "nw")
    assert abs(nw_after["x"] - nw_before["x"]) < 2
    assert abs(nw_after["y"] - nw_before["y"]) < 2
    assert got["x"] < 0 and got["y"] < 0      # pushed up-left, not centred
    assert not errors, errors


def test_rotate_handle_turns_the_picture(gizmo_page):
    page, errors = gizmo_page
    box = stage_rect(page)
    cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
    page.mouse.dblclick(cx, cy)
    page.wait_for_timeout(150)
    rot = handle(page, "rot")
    drag(page, rot, 60, 40)
    assert abs(fx(page)["rot"]) > 5
    tf = page.evaluate("getComputedStyle(document.querySelector('.fx-box')).transform")
    assert "matrix" in tf and tf != "none"
    assert not errors, errors


def test_crop_mode_trims_an_edge(gizmo_page):
    page, errors = gizmo_page
    box = stage_rect(page)
    cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
    page.mouse.dblclick(cx, cy)
    page.wait_for_timeout(150)
    page.keyboard.press("c")                 # crop tool
    page.wait_for_timeout(150)
    assert page.evaluate("GIZ.mode") == "crop"
    bar = handle(page, "crop-l")
    drag(page, bar, 70, 0)
    got = fx(page)
    assert got["crop_l"] > 4
    assert got["crop_r"] == 0
    # The crop is applied to the picture: the media is blown up inside the box.
    style = page.evaluate("document.querySelector('.fx-media').style.width")
    assert float(style.rstrip("%")) > 101
    page.keyboard.press("v")
    page.wait_for_timeout(100)
    assert page.evaluate("GIZ.mode") == "transform"
    assert not errors, errors


def test_mask_mode_draws_and_moves_a_shape(gizmo_page):
    page, errors = gizmo_page
    box = stage_rect(page)
    cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
    page.mouse.dblclick(cx, cy)
    page.wait_for_timeout(150)
    page.keyboard.press("p")                 # mask tool turns a mask on
    page.wait_for_timeout(200)
    assert page.evaluate("GIZ.mode") == "mask"
    m0 = fx(page)["mask"]
    assert m0 and m0["on"] is True

    # Start outside the default 70% shape and drag a smaller one out of it.
    bw, bh = box["w"], box["h"]
    drag(page, {"x": cx - 0.47 * bw, "y": cy - 0.45 * bh}, 0.2 * bw, 0.2 * bh)
    m1 = fx(page)["mask"]
    assert m1["on"] is True
    assert m1["w"] < 60 and m1["h"] < 60          # drawn, not the default
    # The DOM box carries a real mask (SVG data URI) so the preview matches.
    mi = page.evaluate("document.querySelector('.fx-box').style.maskImage")
    assert mi.startswith("url(\"data:image/svg+xml")
    # Dragging the shape's body moves it.
    page.wait_for_timeout(120)
    x0 = m1["x"]
    body = page.evaluate("""(() => {
      const el = document.querySelector('#gizSvg [data-giz="m-move"]');
      const r = el.getBoundingClientRect();
      return {x: r.x + r.width / 2, y: r.y + r.height / 2};
    })()""")
    drag(page, body, 40, 0)
    assert fx(page)["mask"]["x"] > x0
    assert not errors, errors


def test_clicking_the_black_deselects(gizmo_page):
    page, errors = gizmo_page
    box = stage_rect(page)
    cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
    page.mouse.dblclick(cx, cy)
    page.wait_for_timeout(150)
    # Shrink it so there is black to click on.
    page.evaluate("""(() => {
      const c = S.tl.clips[0];
      c.fx = TLM.cleanFx(Object.assign({}, c.fx, {scale: 50}));
      commitTL(); refresh(); syncPreview(true);
    })()""")
    page.wait_for_timeout(200)
    page.mouse.click(box["x"] + 6, box["y"] + 6)
    page.wait_for_timeout(150)
    assert page.evaluate("S.sel.size") == 0
    assert page.evaluate("GIZ.editing") is False
    assert not errors, errors


def test_inspector_rotation_and_mask_controls_are_wired(gizmo_page):
    page, errors = gizmo_page
    page.evaluate("selectOnly(S.tl.clips[0].id)")
    page.click(".ws-tabs button:has-text('Inspector')")   # right column tab strip
    page.wait_for_timeout(200)
    assert page.is_visible("#txR")
    page.click("#toolBody details:has(summary:text('Mask')) > summary")
    page.wait_for_timeout(150)
    assert page.is_visible("#tmOn")
    page.fill("#txRn", "30")
    page.dispatch_event("#txRn", "change")
    page.wait_for_timeout(150)
    assert fx(page)["rot"] == 30
    page.check("#tmOn")
    page.wait_for_timeout(150)
    assert fx(page)["mask"]["on"] is True
    page.fill("#tmW", "40")
    page.dispatch_event("#tmW", "change")
    page.wait_for_timeout(150)
    assert fx(page)["mask"]["w"] == 40
    page.select_option("#tmShape", "ellipse")
    page.wait_for_timeout(150)
    assert fx(page)["mask"]["shape"] == "ellipse"
    assert page.evaluate("document.querySelector('.fx-box').style.maskImage") != ""
    page.click("#tmReset")
    page.wait_for_timeout(150)
    assert fx(page)["mask"] is None
    assert not errors, errors


def kf(page):
    return page.evaluate("JSON.parse(JSON.stringify(S.tl.clips[0].kf))")


def test_moving_an_animated_clip_writes_a_keyframe_at_the_playhead(gizmo_page):
    """Premiere/CapCut behaviour: once a clip has one ◆, dragging the picture
    records a keyframe at the playhead instead of silently writing a clip-wide
    value that evalFxAt() would ignore."""
    page, errors = gizmo_page
    select = "selectOnly(S.tl.clips[0].id); refresh();"
    page.evaluate(select)
    page.evaluate("S.T = 1; refresh();")
    page.wait_for_timeout(150)
    page.evaluate("clipAddKeyframe()")
    page.wait_for_timeout(200)
    assert [k["t"] for k in kf(page)] == [1.0]

    box = stage_rect(page)
    cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
    page.evaluate("S.T = 6; refresh();")
    page.wait_for_timeout(200)
    page.mouse.dblclick(cx, cy)
    page.wait_for_timeout(200)
    drag(page, {"x": cx, "y": cy}, 70, 35)

    keys = kf(page)
    assert [k["t"] for k in keys] == [1.0, 6.0], keys          # a second ◆ appeared
    # The clip block shows a diamond per keyframe, so it is visible on the timeline.
    assert page.evaluate("document.querySelectorAll('#lanes .clip .kfdot').length") == 2
    assert keys[1]["x"] > 5 and keys[1]["y"] > 2, keys         # it holds the move
    # The clip-wide value was left alone; the keyframe track is what animates.
    assert fx(page)["x"] == 0

    # Scrubbing between the two keyframes interpolates.
    mid = page.evaluate("TLM.evalFxAt(S.tl.clips[0], 3.5).x")
    assert 0 < mid < keys[1]["x"]

    # Dragging again at the same time updates that keyframe instead of adding one.
    drag(page, {"x": cx + 70, "y": cy + 35}, 20, 0)
    again = kf(page)
    assert [k["t"] for k in again] == [1.0, 6.0], again
    assert again[1]["x"] > keys[1]["x"]

    # The Inspector sliders edit the same track and read back what is on screen.
    page.click(".ws-tabs button:has-text('Inspector')")
    page.wait_for_timeout(200)
    page.evaluate("S.T = 3; refresh();")
    page.wait_for_timeout(200)
    page.fill("#txXn", "30")
    page.dispatch_event("#txXn", "change")
    page.wait_for_timeout(200)
    assert [k["t"] for k in kf(page)] == [1.0, 3.0, 6.0], kf(page)
    assert next(k for k in kf(page) if k["t"] == 3.0)["x"] == 30
    page.evaluate("document.activeElement.blur(); S.T = 6; refresh();")
    page.wait_for_timeout(200)
    assert float(page.input_value("#txXn")) == again[1]["x"]
    assert not errors, errors


def test_rotation_is_animatable_and_old_keyframes_keep_the_clip_rotation(gizmo_page):
    page, errors = gizmo_page
    page.evaluate("selectOnly(S.tl.clips[0].id); refresh();")
    # A keyframe written before rotation was animatable has no "rot" key.
    page.evaluate("""(() => {
      const c = S.tl.clips[0];
      c.fx = TLM.cleanFx({ rot: 25 });
      c.kf = [{ t: 0, x: 0, y: 0, scale: 100, opacity: 100 },
              { t: 4, x: 20, y: 0, scale: 100, opacity: 100 }];
      refresh();
    })()""")
    page.wait_for_timeout(150)
    assert page.evaluate("TLM.evalFxAt(S.tl.clips[0], 2).rot") == 25
    # New keyframes interpolate the rotation too.
    page.evaluate("""(() => {
      const c = S.tl.clips[0];
      c.kf = [{ t: 0, x: 0, y: 0, scale: 100, opacity: 100, rot: 0 },
              { t: 4, x: 0, y: 0, scale: 100, opacity: 100, rot: 90 }];
      refresh();
    })()""")
    page.wait_for_timeout(150)
    assert page.evaluate("TLM.evalFxAt(S.tl.clips[0], 2).rot") == 45
    assert not errors, errors
