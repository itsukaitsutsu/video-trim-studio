"""Remap caption cues from the source timeline onto a trimmed export.

Captions describe the *source* video. When sections are cut out during export,
cue times no longer match the result. `remap_cues()` moves every cue through
the same cut list the exporter uses:

- a cue inside a kept range is shifted earlier by the total removed before it;
- a cue crossing a cut is split, one piece per kept fragment;
- pieces that end up back-to-back with the same text are merged again (a cut
  *inside* one sentence should not create two captions);
- a cue that lies entirely inside a removed range disappears.
"""

from __future__ import annotations

import math
import re

# Pieces shorter than this after clipping are dropped: they would flash on
# screen for less than a frame's worth of reading time.
MIN_PIECE_S = 0.05


def _clip_words(words, seg_start: float, seg_end: float,
                removed_before: float) -> list[dict]:
    """Words of a cue inside a kept range, moved onto the export timeline.

    A word straddling the cut is clipped (it is heard on both sides of the
    join); a word entirely inside a removed range disappears with the video.
    """
    out: list[dict] = []
    for w in words or []:
        try:
            ws, we = float(w["s"]), float(w["e"])
        except (KeyError, TypeError, ValueError):
            continue
        if we <= seg_start or ws >= seg_end:
            continue
        a, b = max(ws, seg_start), min(we, seg_end)
        if b - a < 1e-6:
            continue
        out.append({"w": str(w.get("w", "")),
                    "s": round(a - removed_before, 3),
                    "e": round(b - removed_before, 3)})
    return out


def remap_cues(cues: list[dict], kept_segments: list[tuple[float, float]],
               min_piece_s: float = MIN_PIECE_S) -> list[dict]:
    """Map [{start,end,text,words}] onto the export timeline of `kept_segments`."""
    pieces: list[dict] = []
    removed_before = 0.0          # total deleted time ahead of the cursor
    prev_kept_end = 0.0
    for seg_start, seg_end in kept_segments:
        removed_before += max(0.0, seg_start - prev_kept_end)
        prev_kept_end = seg_end
        for cue in cues:
            a = max(float(cue["start"]), seg_start)
            b = min(float(cue["end"]), seg_end)
            if b - a >= min_piece_s:
                piece = {
                    "start": round(a - removed_before, 3),
                    "end": round(b - removed_before, 3),
                    "text": (cue.get("text") or "").strip(),
                }
                for k in ("style", "id", "track"):
                    if k in cue:
                        piece[k] = cue[k]
                words = _clip_words(cue.get("words"), a, b, removed_before)
                if words:
                    piece["words"] = words
                    if cue.get("word_source"):
                        piece["word_source"] = cue["word_source"]
                pieces.append(piece)
    pieces.sort(key=lambda c: (c["start"], c["end"]))

    # Rejoin fragments of one sentence that a cut merely interrupted. The
    # words of both fragments follow the cue, minus a word that landed on the
    # join and would otherwise be listed twice.
    merged: list[dict] = []
    for piece in pieces:
        if (merged and merged[-1]["text"] == piece["text"]
                and abs(merged[-1]["end"] - piece["start"]) <= 1e-6):
            merged[-1]["end"] = piece["end"]
            if piece.get("words"):
                seen = {(w["w"], w["s"]) for w in merged[-1].get("words") or []}
                merged[-1].setdefault("words", [])
                merged[-1]["words"] += [w for w in piece["words"]
                                        if (w["w"], w["s"]) not in seen]
        else:
            merged.append(dict(piece))
    return merged


# ---------------------------------------------------------------------------
# Positioned burning: the preview lets the user drag the caption box, and the
# export burns exactly that layout by rendering an ASS file with \pos tags.
# ---------------------------------------------------------------------------

def _ass_colour(value: str) -> str:
    """CSS #RRGGBB to ASS &HBBGGRR&."""
    raw = str(value or "#ffffff").lstrip("#")
    if not re.fullmatch(r"[0-9a-fA-F]{6}", raw):
        raw = "ffffff"
    return "&H" + raw[4:6] + raw[2:4] + raw[0:2] + "&"


def _ass_alpha(opacity: float) -> str:
    alpha = round(255 * (100 - min(100, max(0, float(opacity)))) / 100)
    return f"&H{alpha:02X}&"


def marker_path(w: float, h: float, radius: float) -> str:
    """An ASS drawing path for the word marker: a rounded rectangle.

    Coordinates are script pixels (a drawing is not scaled by \fs), so the
    rectangle is exactly the size asked for. `b` is a cubic bezier, which is
    how the corners round; a radius of 0 falls back to four straight sides.
    """
    w = max(1.0, float(w))
    h = max(1.0, float(h))
    r = max(0.0, min(float(radius), w / 2.0, h / 2.0))
    if r < 0.75:
        return (f"m 0 0 l {w:.1f} 0 l {w:.1f} {h:.1f} "
                f"l 0 {h:.1f} l 0 0")
    c = 0.5523 * r          # the control offset that makes a circle
    return (
        f"m {r:.1f} 0 "
        f"l {w - r:.1f} 0 "
        f"b {w - r + c:.1f} 0 {w:.1f} {r - c:.1f} {w:.1f} {r:.1f} "
        f"l {w:.1f} {h - r:.1f} "
        f"b {w:.1f} {h - r + c:.1f} {w - r + c:.1f} {h:.1f} {w - r:.1f} {h:.1f} "
        f"l {r:.1f} {h:.1f} "
        f"b {r - c:.1f} {h:.1f} 0 {h - r + c:.1f} 0 {h - r:.1f} "
        f"l 0 {r:.1f} "
        f"b 0 {r - c:.1f} {r - c:.1f} 0 {r:.1f} 0"
    )


def ass_time(seconds: float) -> str:
    """ASS timestamp: H:MM:SS.cc (centiseconds)."""
    seconds = max(0.0, float(seconds))
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:d}:{m:02d}:{s:05.2f}"


# Shared with static/app.js (wrapCaption / layoutCapOverlay): average glyph
# width and line height as fractions of the font size. Both sides wrap text
# with these, which is what makes the preview match the burn.
CHAR_FACTOR = 0.55
LINE_H_FACTOR = 1.25
# How far one glyph advances, as a fraction of the font size - the number the
# word marker's boxes are laid out with. A monospaced face (the default) has a
# fixed advance; a proportional one averages a little less. Only highlight
# geometry uses this; wrapping keeps CHAR_FACTOR so no line breaks move.
MONO_FONTS = ("lucida console", "consolas", "courier", "mono", "menlo",
              "monaco", "inconsolata", "fira code", "source code", "roboto mono",
              "jetbrains mono", "ibm plex mono", "space mono")
# Measured off the burn itself (libass, 0.588 of \fs for both the mono and
# the proportional fallback here). The marker's padding takes up the few
# percent a different face is off by, so the box still hugs the word.
ADVANCE_MONO = 0.588
ADVANCE_PROP = 0.588


def advance_factor(font: str) -> float:
    """The per-glyph advance of `font`, as a fraction of its size."""
    name = str(font or "").lower()
    return ADVANCE_MONO if any(m in name for m in MONO_FONTS) else ADVANCE_PROP


def wrap_lines(text: str, max_chars: int) -> list[str]:
    """Greedy word wrap; long words hard-break. Mirrors the JS wrap."""
    words = str(text).split()
    lines: list[str] = []
    cur = ""
    for w in words:
        cand = f"{cur} {w}" if cur else w
        if len(cand) <= max_chars:
            cur = cand
            continue
        if cur:
            lines.append(cur)
        while len(w) > max_chars:          # hard-break words wider than the box
            lines.append(w[:max_chars])
            w = w[max_chars:]
        cur = w
    if cur:
        lines.append(cur)
    return lines or [""]


# box_w 0 = "no fixed box" (no word wrap); the app's overlay always sends its
# own box_w (default 0.7), so this only affects style-less callers.
DEFAULT_STYLE = {"x": 0.5, "y": 0.92, "size_pct": 4.5,
                 "align": "center", "box_w": 0.88, "anchor": "bottom", "margin": 0.08,
                 "font": "Lucida Console", "tracking": 0, "leading": 1.25,
                 "bold": False, "italic": False, "underline": False, "strike": False,
                 "fill": "#ffffff", "fill_opacity": 100,
                 "stroke": "#000000", "stroke_width": 1, "stroke_opacity": 0,
                 "stroke_position": "outer", "background": "#000000", "background_opacity": 0,
                 "shadow": "#000000", "shadow_opacity": 100,
                 "shadow_angle": 135, "shadow_distance": 3, "shadow_size": 6,
                 "shadow_blur": 12, "box_h": 0,
                 # Text animation (Inspector > Text animation).
                 "anim_in": "none", "anim_ms": 400, "anim_words": "none",
                 "anim_stagger": 120, "anim_pop": 130, "highlight": "#ffd400",
                 # Word highlight (Inspector > Typography > Word highlight):
                 # what marks the spoken word and how. "color" is the plain
                 # accent the karaoke mode always had; "bg" paints a marker
                 # behind the word, "both" does the two together.
                 "hl_mark": "color", "hl_span": "word",
                 "hl_bg": "#101418", "hl_bg_opacity": 85,
                 "hl_pad": 12, "hl_radius": 22}


def _cue_events(cue: dict, st: dict, width: int, height: int,
                style_name: str = "Default",
                shadow_name: str | None = None) -> list[str]:
    """One positioned Dialogue per wrapped line for a single cue.

    `shadow_name` is the style the shadow Dialogues reference. It is normally
    `<style_name>Shadow`, but the writer may have collapsed two cues onto one
    shared style, so the name it actually declared is passed in.
    """
    if shadow_name is None:
        shadow_name = style_name + "Shadow"
    x = min(1.0, max(0.0, float(st.get("x", 0.5))))
    y = min(1.0, max(0.0, float(st.get("y", 0.88))))
    size_pct = min(25.0, max(1.0, float(st.get("size_pct", 5.5))))
    align = st.get("align", "center")
    align = align if align in ("left", "center", "right", "justify") else "center"
    font_size = max(8, round(size_pct / 100.0 * height))
    leading = min(3.0, max(0.7, float(st.get("leading", LINE_H_FACTOR))))
    line_h = round(font_size * leading)
    tracking = min(1.0, max(-0.2, float(st.get("tracking", 0) or 0)))
    char_w = font_size * (CHAR_FACTOR + tracking)

    cx = x * width
    cy = y * height
    box_w = float(st.get("box_w", 0.0) or 0.0)
    box_px = (min(1.0, max(0.05, box_w)) * width) if box_w else None
    max_chars = max(4, int(box_px // max(1, font_size * (CHAR_FACTOR + tracking)))) if box_px else None

    text = (cue.get("text") or "").strip()
    if not text:
        return []
    text = text.replace("{", "(").replace("}", ")")
    lines = wrap_lines(text, max_chars) if max_chars else [text]
    n = len(lines)
    top = cy - (n - 1) * line_h / 2.0
    start, end = ass_time(cue["start"]), ass_time(cue["end"])
    left_x = cx - box_px / 2 if box_px else cx
    right_x = cx + box_px / 2 if box_px else cx
    fs = "\\fs%d" % font_size
    font = re.sub(r"[{}\\]", "", str(st.get("font", "Arial")))[:64] or "Arial"
    bold = "\\b1" if st.get("bold", True) else "\\b0"
    italic = "\\i1" if st.get("italic", False) else "\\i0"
    tracking_tag = "\\fsp%.2f" % (font_size * tracking)
    fill = _ass_colour(st.get("fill", "#ffffff"))
    fill_alpha = _ass_alpha(st.get("fill_opacity", 100))
    outline = _ass_colour(st.get("stroke", "#000000"))
    outline_alpha = _ass_alpha(st.get("stroke_opacity", 100))
    shadow_colour = _ass_colour(st.get("shadow", "#000000"))
    shadow_angle = math.radians(float(st.get("shadow_angle", 45) or 0))
    shadow_distance = max(0.0, float(st.get("shadow_distance", 2) or 0))
    shadow_blur = max(0.0, float(st.get("shadow_blur", 2) or 0))
    underline = "\\u1" if st.get("underline", False) else "\\u0"
    strike = "\\s1" if st.get("strike", False) else "\\s0"
    shadow_size = max(0.0, float(st.get("shadow_size", 0) or 0))
    common_tags = (f"\\fn{font}{fs}{bold}{italic}{underline}{strike}{tracking_tag}"
                   f"\\c{fill}\\alpha{fill_alpha}"
                   f"\\3c{outline}\\3a{outline_alpha}"
                   f"\\bord{max(0.0, float(st.get('stroke_width', 2) or 0) * height / 1080):.2f}")
    px_scale = height / 1080.0
    shadow_distance *= px_scale
    shadow_x = math.cos(shadow_angle) * shadow_distance
    shadow_y = math.sin(shadow_angle) * shadow_distance
    shadow_size *= px_scale
    shadow_blur *= px_scale
    shadow_alpha_value = min(100.0, max(0.0, float(st.get("shadow_opacity", 100))))

    if st.get("shadow_enabled") is False:
        shadow_alpha_value = 0

    # ---- text animation (Inspector > Text animation) --------------------
    # Entry animations ride on tags the ASS renderer already supports; karaoke
    # uses ASS's own \k clock, word reveal emits progressive prefixes and
    # typewriter reveals one character at a time. "none" (the default) leaves
    # every Dialogue exactly as it was before this feature existed.
    anim_in = str(st.get("anim_in") or "none")
    anim_words = str(st.get("anim_words") or "none")
    if anim_words == "karaoke":     # the name before it became configurable
        anim_words = "word"
    try:
        anim_ms = max(0, min(4000, int(float(st.get("anim_ms") or 0))))
    except (TypeError, ValueError):
        anim_ms = 400
    try:
        pop_pct = max(100.0, min(220.0, float(st.get("anim_pop") or 130)))
    except (TypeError, ValueError):
        pop_pct = 130.0
    try:
        stagger = max(0.0, min(4.0, float(st.get("anim_stagger") or 0))) / 1000.0
    except (TypeError, ValueError):
        stagger = 0.12
    highlight_hex = str(st.get("highlight") or "#ffd400")
    highlight = _ass_colour(highlight_hex)
    # Word highlight (Inspector > Typography): what marks the spoken word.
    hl_mark = str(st.get("hl_mark") or "color")
    if hl_mark not in ("color", "bg", "both"):
        hl_mark = "color"
    hl_span = str(st.get("hl_span") or "word")
    if hl_span not in ("word", "spoken"):
        hl_span = "word"
    hl_bg = _ass_colour(st.get("hl_bg") or "#101418")
    try:
        hl_bg_opacity = min(100.0, max(0.0, float(st.get("hl_bg_opacity", 85) or 0)))
    except (TypeError, ValueError):
        hl_bg_opacity = 85.0
    try:
        hl_pad_pct = min(40.0, max(0.0, float(st.get("hl_pad", 12) or 0)))
    except (TypeError, ValueError):
        hl_pad_pct = 12.0
    try:
        hl_radius_pct = min(50.0, max(0.0, float(st.get("hl_radius", 22) or 0)))
    except (TypeError, ValueError):
        hl_radius_pct = 22.0
    # The marker is laid out with the font's own advance (see advance_factor),
    # not the wrapping estimate, so its boxes sit under the glyphs.
    mark_w = font_size * (advance_factor(font) + tracking)
    cue_start = float(cue["start"])
    cue_end = float(cue["end"])
    start, end = ass_time(cue_start), ass_time(cue_end)

    def pos_tag(an: int, px: float, py: float) -> str:
        if anim_in == "slide" and anim_ms > 0:
            lift = height * 0.06
            return (f"\\an{an}\\move({round(px)},{round(py + lift)},"
                    f"{round(px)},{round(py)},0,{anim_ms})")
        return f"\\an{an}\\pos({round(px)},{round(py)})"

    def entry_tags(an: int, px: float, py: float) -> str:
        tags = ""
        if anim_ms > 0:
            if anim_in == "fade":
                tags += f"\\fad({anim_ms},0)"
            elif anim_in in ("pop", "bounce"):
                tags += f"\\fscx{pop_pct:.1f}\\fscy{pop_pct:.1f}"
                if anim_in == "bounce":
                    mid = max(1, int(anim_ms * 0.62))
                    over = min(220.0, pop_pct * 1.08)
                    tags += (f"\\t(0,{mid},\\fscx{over:.1f}\\fscy{over:.1f})"
                             f"\\t({mid},{anim_ms},\\fscx100\\fscy100)")
                else:
                    tags += f"\\t(0,{anim_ms},\\fscx100\\fscy100)"
        return tags + pos_tag(an, px, py)

    def emit_line(text: str, an: int, px: float, py: float,
                  t0: str | None = None, t1: str | None = None,
                  extra: str = "", shadow_text: str | None = None,
                  entry: bool = True) -> list[str]:
        out: list[str] = []
        a = start if t0 is None else t0
        b = end if t1 is None else t1
        if shadow_alpha_value > 0:
            # A single filled/outlined glyph silhouette: size grows its contour.
            # Same fill/outline colour and alpha, one offset, no ring of copies.
            alpha = _ass_alpha(shadow_alpha_value)
            shadow_tags = (f"\\fn{font}{fs}{bold}{italic}{underline}{strike}{tracking_tag}"
                           f"\\1c{shadow_colour}\\3c{shadow_colour}"
                           f"\\1a{alpha}\\3a{alpha}\\4a&HFF&\\shad0"
                           f"\\bord{shadow_size:.2f}\\blur{shadow_blur:.2f}"
                           f"{pos_tag(an, px + shadow_x, py + shadow_y)}")
            out.append(f"Dialogue: 0,{a},{b},{shadow_name},,0,0,0,,"
                       f"{{{shadow_tags}}}{text if shadow_text is None else shadow_text}")
        tags = entry_tags(an, px, py) if entry else pos_tag(an, px, py)
        main_tags = f"{common_tags}\\shad0\\blur0{tags}{extra}"
        out.append(f"Dialogue: 1,{a},{b},{style_name},,0,0,0,,{{{main_tags}}}{text}")
        return out

    # Where each wrapped line sits. Shared by every animation mode so a
    # half-revealed caption never jumps between lines.
    placed = []
    for i, line in enumerate(lines):
        ly = top + i * line_h
        if align == "left" and box_px:
            placed.append((line, 4, left_x, ly))
        elif align == "right" and box_px:
            placed.append((line, 6, right_x, ly))
        elif align == "justify" and box_px:
            placed.append((line, 4, left_x, ly))
        else:  # centre
            placed.append((line, 5, cx, ly))

    tokens = text.split()
    # Per-word timings: the cue's own word data when it lines up with the text,
    # otherwise an even spread across the cue (same estimate the preview uses).
    times: list[tuple[float, float]] = []
    raw_words = cue.get("words") or []
    if isinstance(raw_words, list) and len(raw_words) == len(tokens) and tokens:
        for w in raw_words:
            try:
                times.append((float(w.get("s", cue_start)), float(w.get("e", cue_end))))
            except (AttributeError, TypeError, ValueError):
                times = []
                break
    if not times and tokens:
        slot = max(0.001, (cue_end - cue_start) / max(1, len(tokens)))
        times = [(cue_start + i * slot, cue_start + (i + 1) * slot)
                 for i in range(len(tokens))]
    if stagger and tokens and not raw_words:
        times = [(cue_start + i * stagger, cue_start + (i + 1) * stagger)
                 for i in range(len(tokens))]

    events: list[str] = []

    if anim_words == "reveal" and tokens:
        # One Dialogue per new word: the caption grows the way it does in the
        # preview, then holds the full line until the cue ends.
        for k in range(len(tokens)):
            t0 = times[k][0]
            t1 = times[k + 1][0] if k + 1 < len(times) else cue_end
            if t1 <= t0:
                t1 = min(cue_end, t0 + 0.02)
            if t1 <= t0:
                continue
            shown = tokens[:k + 1]
            # Re-wrap the same slots: line j shows the words that fit it.
            pos = 0
            for line, an, px, py in placed:
                count = len(line.split())
                part = shown[pos:pos + count]
                pos += count
                if not part:
                    continue
                events.extend(emit_line(" ".join(part), an, px, py,
                                        ass_time(t0), ass_time(t1)))
        return events

    if anim_in == "typewriter" and anim_ms > 0 and any(len(l) for l in lines):
        total = sum(len(line) for line in lines)
        steps = max(1, min(70, total))
        for k in range(1, steps + 1):
            remain = round(total * k / steps)
            t0 = cue_start + (anim_ms / 1000.0) * (k - 1) / steps
            t1 = cue_end if k == steps else cue_start + (anim_ms / 1000.0) * k / steps
            if t1 <= t0:
                continue
            for line, an, px, py in placed:
                part = line[:max(0, min(len(line), remain))]
                remain -= len(line)
                if not part:
                    continue
                events.extend(emit_line(part, an, px, py, ass_time(t0), ass_time(t1)))
        return events

    if anim_words == "word" and tokens:
        # One picture per word window, the way the program monitor paints
        # it: the caption's own lines with the marked words in the accent
        # and/or over a marker box, plus a rounded rectangle behind each
        # marked word. A \k clock cannot do this - it only ever swaps the
        # text's two colours - so the windows are emitted explicitly.
        anim_end = cue_start + (anim_ms / 1000.0 if anim_in != "none" else 0.0)
        anim_end = min(cue_end, max(cue_start, anim_end))
        pad_px = font_size * hl_pad_pct / 100.0
        radius_px = font_size * hl_radius_pct / 100.0
        box_h_px = font_size * 1.16 + 2 * pad_px
        want_bg = hl_mark in ("bg", "both") and hl_bg_opacity > 0
        want_ink = hl_mark in ("color", "both")
        bg_alpha = _ass_alpha(hl_bg_opacity)

        def word_rows() -> list[tuple[list[str], list[float], float, int]]:
            """(words, each word's centre x, line baseline, index of the
            row's first word) for every wrapped line.

            A marked word is drawn on its own, at the centre given here, so
            the text and its marker box cannot drift apart: both use this
            one number. The advance is the font's own (advance_factor), not
            the wrapping estimate, which is why the boxes land under the
            glyphs. Justify spreads the row to the box, as it does in the
            static path.
            """
            rows = []
            first = 0
            for line, an, px, py in placed:
                parts = line.split()
                if not parts:
                    continue
                if align == "justify" and box_px and len(parts) > 1:
                    widths = [len(w) * mark_w for w in parts]
                    gap = (box_px - sum(widths)) / max(1, len(parts) - 1)
                    xs, xc = [], left_x
                    for wd in widths:
                        xs.append(xc + wd / 2.0)
                        xc += wd + gap
                else:
                    total = len(line) * mark_w
                    x0 = px if an == 4 else (px - total if an == 6 else px - total / 2.0)
                    xs, off = [], 0
                    for w in parts:
                        xs.append(x0 + (off + len(w) / 2.0) * mark_w)
                        off += len(w) + 1
                rows.append((parts, xs, py, first))
                first += len(parts)
            return rows

        rows = word_rows()
        events = []
        # The entrance plays unmarked first: the caption arrives, then the
        # words begin lighting up under it.
        if anim_end > cue_start + 1e-4:
            for line, an, px, py in placed:
                events.extend(emit_line(line, an, px, py,
                                        ass_time(cue_start), ass_time(anim_end)))
        for k in range(len(times)):
            t0 = max(times[k][0], anim_end)
            t1 = min(cue_end, times[k + 1][0] if k + 1 < len(times) else cue_end)
            if t1 <= t0 + 1e-4:
                continue
            marked = set(range(k + 1)) if hl_span == "spoken" else {k}
            a, b = ass_time(t0), ass_time(t1)
            for parts, xs, py, first in rows:
                for j, word in enumerate(parts):
                    if (first + j) not in marked:
                        continue
                    if want_bg:
                        wpx = len(word) * mark_w + 2 * pad_px
                        path = marker_path(wpx, box_h_px, radius_px)
                        bx = xs[j] - wpx / 2.0
                        by = py - box_h_px / 2.0
                        tags = (f"\\an7\\pos({bx:.1f},{by:.1f})\\p1\\bord0"
                                f"\\shad0\\blur0\\1c{hl_bg}\\1a{bg_alpha}")
                        events.append(f"Dialogue: 0,{a},{b},{style_name},,0,0,0,,"
                                      f"{{{tags}}}{path}{{\\p0}}")
                    ink = (f"{{\\1c{highlight}}}{word}{{\\1c{fill}}}"
                           if want_ink else word)
                    events.extend(emit_line(ink, 5, xs[j], py, a, b,
                                            shadow_text=word, entry=False))
            # Words nobody marked still have to stay on screen while this
            # window plays: draw them, without the accent, over the marker.
            for parts, xs, py, first in rows:
                for j, word in enumerate(parts):
                    if (first + j) in marked:
                        continue
                    events.extend(emit_line(word, 5, xs[j], py, a, b,
                                            shadow_text=word, entry=False))
        if events:
            return events

        # Nothing could be timed (no words, or every window collapsed) -
        # fall through to the static path, which draws the whole line.

    # ---- static layout (the default) ------------------------------------
    for li, (line, an, px, py) in enumerate(placed):
        if align == "justify" and box_px and li < len(placed) - 1 and len(line.split()) > 1:
            # True justify: both edges flush with the box. ASS cannot justify,
            # so each word gets its own \pos - first word on the left edge,
            # last word ending on the right edge, remainder distributed.
            # (Like CSS, the final line stays left-aligned, handled below.)
            words = line.split(" ")
            widths = [len(w) * char_w for w in words]
            gap = (box_px - sum(widths)) / max(1, len(words) - 1)
            xc = left_x
            for word, wd in zip(words, widths):
                events.extend(emit_line(word, 4, xc, py))
                xc += wd + gap
            continue
        events.extend(emit_line(line, an, px, py))
    return events


def _ass_rgba(colour: str, opacity: float) -> str:
    return _ass_alpha(opacity)[:-1] + _ass_colour(colour)[2:]


def _ass_style_line(name: str, st: dict, height: int) -> str:
    font = re.sub(r"[{},\\]", "", str(st.get("font", "Arial")))[:64] or "Arial"
    size = max(8, round(float(st.get("size_pct", 4.5)) / 100 * height))
    fill = _ass_rgba(st.get("fill", "#ffffff"), st.get("fill_opacity", 100))
    stroke = _ass_rgba(st.get("stroke", "#000000"), st.get("stroke_opacity", 100))
    bg = _ass_rgba(st.get("background", "#000000"), st.get("background_opacity", 0))
    bold = -1 if st.get("bold", True) else 0
    italic = -1 if st.get("italic", False) else 0
    border_style = 3 if float(st.get("background_opacity", 0) or 0) > 0 else 1
    tracking = min(1.0, max(-0.2, float(st.get("tracking", 0) or 0)))
    outline_width = max(0.0, float(st.get("stroke_width", 2) or 0)) * height / 1080
    return (f"Style: {name},{font},{size},{fill},{fill},{stroke},{bg},"
            f"{bold},{italic},0,0,100,100,{size * tracking:.2f},0,{border_style},"
            f"{outline_width:.2f},0,5,10,10,10,1")


def write_ass(cues: list[dict], path, width: int, height: int,
              style: dict | None = None) -> None:
    """Write cues as ASS reproducing the preview overlay's layout.

    x/y are normalised (0..1) and describe the caption box's centre - the
    point the preview drags. `box_w` (normalised frame width) and `align`
    (left/center/right/justify) come from the overlay too. Text is word-
    wrapped to the box width and emitted one positioned line per Dialogue,
    so the burned result matches what the preview showed.

    Every cue may carry its own `style` dict (the timeline gives each caption
    one); it overrides `style` (the document default). Overlapping cues stay
    separate Dialogues, so several captions can share one frame.

    The wrap uses the same greedy algorithm + character-width factor as the
    frontend (CHAR_FACTOR / LINE_H_FACTOR), which keeps both sides in sync."""
    width = max(2, int(width))
    height = max(2, int(height))
    base = dict(DEFAULT_STYLE, **(style or {}))

    header = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        _ass_style_line("Default", base, height),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
        "Effect, Text",
    ]
    events: list[str] = []
    style_lines: list[str] = []
    # Word-granular captions mean hundreds of cues, and a style line per cue
    # (plus its shadow) turns into thousands of styles that libass has to look
    # up by name for every event. Identical styles collapse onto one name -
    # the first cue that needed it keeps it, so nothing else changes.
    style_cache: dict[str, str] = {}

    def name_for(cue_style: dict, shadow: bool, idx: int) -> str:
        st2 = {**cue_style, "background_opacity": 0} if shadow else cue_style
        # The prefix keeps a shadow from collapsing onto a main style that
        # happens to be identical (a cue with no box background), so the
        # Cue<n> / Cue<n>Shadow pairing stays what it always was. A cue whose
        # style no earlier cue used keeps its own number - which is why the
        # styles of a normal project are named exactly as before.
        key = ("S|" if shadow else "P|") + _ass_style_line("X", st2, height)
        hit = style_cache.get(key)
        if hit:
            return hit
        name = f"Cue{idx}" + ("Shadow" if shadow else "")
        style_cache[key] = name
        style_lines.append(_ass_style_line(name, st2, height))
        return name

    for i, cue in enumerate(cues):
        cue_style = dict(base, **(cue.get("style") or {}))
        style_name = name_for(cue_style, False, i)
        shadow_name = name_for(cue_style, True, i)
        events += _cue_events(cue, cue_style, width, height, style_name, shadow_name)
    # Place each per-cue ASS style before [Events].
    events_at = header.index("[Events]")
    header[events_at:events_at] = style_lines + ([""] if style_lines else [])
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(header + events) + "\n")
