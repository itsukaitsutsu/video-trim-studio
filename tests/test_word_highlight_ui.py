"""Word highlight in the preview (Inspector > Typography > Word highlight).

The karaoke highlight used to be one fixed colour. It is now configurable:
colour the word, paint a marker behind it, or both - and the program monitor
must show exactly what vts/captionmap.py burns.

Run:  python -m pytest tests/test_word_highlight_ui.py -q
"""
import pytest

from test_timeline_ui import base_url, browser_page, open_demo  # noqa: F401


def make_caption(page, words=None, start=1.0, step=0.4):
    """One caption with word timings, playing at `start`, preview burning."""
    words = words or ["satu", "dua", "tiga", "empat"]
    # The overlay only mounts when the export is set to burn captions; the
    # export panel itself can be collapsed, so set the value directly.
    page.evaluate("() => { document.getElementById('xCaptions').value = 'burn'; }")
    # The right column opens on Sections; the Inspector is a tab in the same
    # group, so click its header tab like an editor would.
    page.click('[data-wintab="clip"]')     # the "Inspector" tab
    page.wait_for_function("document.getElementById('tab-inspector').offsetWidth > 0")
    page.wait_for_timeout(200)
    page.evaluate(
        """({words, start, step}) => {
          setPlayhead(start + 0.15);
          inspSetScope("text");
          const cap = {
            id: 'wordhl-1', start, end: start + words.length * step,
            text: words.join(' '),
            style: {...CAPPOS, anim_words: "word"},
            word_source: "edited",
            words: words.map((w, i) => ({w, s: start + i * step,
                                         e: start + (i + 1) * step})),
          };
          S.tl.caps = [cap];
          S.capSel = cap.id;
          setTL(S.tl);
          setPlayhead(start + step * 2 + 0.05);
        }""",
        {"words": words, "start": start, "step": step})
    page.wait_for_function(
        "document.querySelectorAll('#capBoxText .cap-word').length === %d" % len(words))
    page.wait_for_timeout(200)


def style_of(page):
    return page.evaluate(
        "() => JSON.parse(JSON.stringify(capActiveCue().style))")


def test_marker_mode_draws_a_box_behind_the_spoken_word(browser_page):
    page, errors = browser_page
    open_demo(page)
    make_caption(page)
    page.select_option("#insHlMark", "bg")
    page.wait_for_timeout(300)
    assert style_of(page)["hl_mark"] == "bg"

    # The word being said carries a marker; the others do not.
    boxes = page.evaluate("""() => [...document.querySelectorAll('#capBoxText .cap-word')]
        .map((w) => ({word: w.textContent, bg: !!w.querySelector('.cap-word-bg'),
                      hl: w.classList.contains('hl')}))""")
    assert len(boxes) == 4, boxes
    assert [b["bg"] for b in boxes] == [False, False, True, False], boxes
    assert not any(b["hl"] for b in boxes)          # marker mode: no ink change
    # The mark is the box: no glow, no halo the burn would not draw.
    assert page.evaluate(
        "getComputedStyle(document.querySelector('#capBoxText .cap-word.now'))"
        ".textShadow") == "none"

    # Colour, opacity, padding and roundness come from the panel and land on
    # the preview's own custom properties (the CSS the box is drawn with).
    page.fill("#insHlBg", "#39ff88")
    page.dispatch_event("#insHlBg", "change")
    page.fill("#insHlBgOpacity", "60")
    page.dispatch_event("#insHlBgOpacity", "input")
    page.fill("#insHlPad", "25")
    page.dispatch_event("#insHlPad", "input")
    page.wait_for_timeout(300)
    css = page.evaluate("""() => {
      const box = document.querySelector('#capBoxText .cap-word-bg');
      const st = getComputedStyle(document.getElementById('capBoxText'));
      return {bg: getComputedStyle(box).backgroundColor,
              radius: getComputedStyle(box).borderRadius,
              pad: st.getPropertyValue('--cap-hl-pad').trim(),
                  radiusRaw: st.getPropertyValue('--cap-hl-radius').trim(),
                  fontSize: parseFloat(st.fontSize),
              stored: JSON.stringify([capActiveCue().style.hl_bg,
                                      capActiveCue().style.hl_bg_opacity,
                                      capActiveCue().style.hl_pad])};
    }""")
    assert css["bg"] == "rgba(57, 255, 136, 0.6)", css
    assert css["pad"] == "0.25em", css
    # Radius is a percentage of the font size, like the burn's; the browser
    # resolves it to px against the caption's own size.
    assert css["radiusRaw"] == "0.22em", css
    assert abs(float(css["radius"].rstrip("px")) -
               css["fontSize"] * 0.22) < 0.5, css
    assert css["stored"] == '["#39ff88",60,25]', css
    assert not errors, errors


def test_colour_mode_and_spoken_span_keep_the_old_behaviour(browser_page):
    page, errors = browser_page
    open_demo(page)
    make_caption(page)
    page.select_option("#insHlMark", "color")
    page.select_option("#insHlSpan", "word")
    page.wait_for_timeout(300)
    lit = page.evaluate("""() => [...document.querySelectorAll('#capBoxText .cap-word')]
        .map((w) => w.classList.contains('hl'))""")
    assert lit == [False, False, True, False], lit
    # Boxing is gone again.
    assert page.evaluate(
        "document.querySelectorAll('#capBoxText .cap-word-bg').length") == 0

    # "All spoken words": everything heard so far, like a read-along.
    page.select_option("#insHlSpan", "spoken")
    page.wait_for_timeout(300)
    lit = page.evaluate("""() => [...document.querySelectorAll('#capBoxText .cap-word')]
        .map((w) => w.classList.contains('hl'))""")
    assert lit == [True, True, True, False], lit
    # The accent colour is the one in the panel.
    assert page.evaluate(
        "getComputedStyle(document.getElementById('capBoxText'))"
        ".getPropertyValue('--cap-hl').trim()") == "#ffd400"
    assert not errors, errors


def test_both_marks_the_word_and_the_burn_agrees(browser_page):
    """The same style dict feeds the preview and the .ass writer."""
    page, errors = browser_page
    open_demo(page)
    make_caption(page)
    page.select_option("#insHlMark", "both")
    page.wait_for_timeout(300)
    state = page.evaluate("""() => {
      const cue = capActiveCue();
      const st = cue.style;
      return {mark: st.hl_mark, span: st.hl_span, bg: st.hl_bg,
              words: cue.words.length};
    }""")
    assert state["mark"] == "both" and state["words"] == 4
    # Preview: box + accent on the same word.
    both = page.evaluate("""() => [...document.querySelectorAll('#capBoxText .cap-word')]
        .map((w) => [w.classList.contains('hl'), !!w.querySelector('.cap-word-bg')])""")
    assert both == [[False, False], [False, False], [True, True], [False, False]], both
    assert not errors, errors
