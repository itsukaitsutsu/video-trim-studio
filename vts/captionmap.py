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


def remap_cues(cues: list[dict], kept_segments: list[tuple[float, float]],
               min_piece_s: float = MIN_PIECE_S) -> list[dict]:
    """Map [{start,end,text}] onto the export timeline of `kept_segments`."""
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
                pieces.append(piece)
    pieces.sort(key=lambda c: (c["start"], c["end"]))

    # Rejoin fragments of one sentence that a cut merely interrupted.
    merged: list[dict] = []
    for piece in pieces:
        if (merged and merged[-1]["text"] == piece["text"]
                and abs(merged[-1]["end"] - piece["start"]) <= 1e-6):
            merged[-1]["end"] = piece["end"]
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
                 "shadow_blur": 12, "box_h": 0}


def _cue_events(cue: dict, st: dict, width: int, height: int,
                style_name: str = "Default") -> list[str]:
    """One positioned Dialogue per wrapped line for a single cue."""
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
    shadow_alpha = _ass_alpha(st.get("shadow_opacity", 75))
    shadow_angle = math.radians(float(st.get("shadow_angle", 45) or 0))
    shadow_distance = max(0.0, float(st.get("shadow_distance", 2) or 0))
    shadow_x = math.cos(shadow_angle) * shadow_distance
    shadow_y = math.sin(shadow_angle) * shadow_distance
    shadow_blur = max(0.0, float(st.get("shadow_blur", 2) or 0))
    underline = "\\u1" if st.get("underline", False) else "\\u0"
    strike = "\\s1" if st.get("strike", False) else "\\s0"
    shadow_size = max(0.0, float(st.get("shadow_size", 0) or 0))
    common_tags = (f"\\fn{font}{fs}{bold}{italic}{underline}{strike}{tracking_tag}"
                   f"\\c{fill}\\alpha{fill_alpha}"
                   f"\\3c{outline}\\3a{outline_alpha}"
                   f"\\bord{max(0.0, float(st.get('stroke_width', 2) or 0)):.2f}")
    px_scale = height / 1080.0
    shadow_distance *= px_scale
    shadow_size *= px_scale
    shadow_blur *= px_scale
    shadow_alpha_value = min(100.0, max(0.0, float(st.get("shadow_opacity", 100))))

    def emit_line(text: str, an: int, px: float, py: float) -> list[str]:
        out: list[str] = []
        if shadow_alpha_value > 0:
            # ASS/libass has blur and offset, but no independent shadow-spread
            # parameter. Approximate spread with a ring of offset glyph passes;
            # blur remains a separate softness control.
            spread_offsets = [(0.0, 0.0)]
            if shadow_size > 0:
                spread_offsets += [(math.cos(math.radians(a)) * shadow_size,
                                    math.sin(math.radians(a)) * shadow_size)
                                   for a in range(0, 360, 45)]
            for ox, oy in spread_offsets:
                shadow_tags = (f"\\fn{font}{fs}{bold}{italic}{tracking_tag}"
                               f"\\c{shadow_colour}\\alpha{_ass_alpha(shadow_alpha_value)}"
                               f"\\3a&HFF&\\bord0\\blur{shadow_blur:.2f}"
                               f"\\an{an}\\pos({round(px + shadow_x + ox)},{round(py + shadow_y + oy)})")
                out.append(f"Dialogue: 0,{start},{end},{style_name},,0,0,0,,{{{shadow_tags}}}{text}")
        main_tags = f"{common_tags}\\an{an}\\pos({round(px)},{round(py)})"
        out.append(f"Dialogue: 0,{start},{end},{style_name},,0,0,0,,{{{main_tags}}}{text}")
        return out

    events: list[str] = []
    for i, line in enumerate(lines):
        ly = top + i * line_h
        if align == "justify" and box_px and i < n - 1 and len(line.split()) > 1:
            # True justify: both edges flush with the box. ASS cannot justify,
            # so each word gets its own \pos - first word on the left edge,
            # last word ending on the right edge, remainder distributed.
            # (Like CSS, the final line stays left-aligned, handled below.)
            words = line.split(" ")
            widths = [len(w) * char_w for w in words]
            gap = (box_px - sum(widths)) / max(1, len(words) - 1)
            xc = left_x
            for word, wd in zip(words, widths):
                events.extend(emit_line(word, 4, xc, ly))
                xc += wd + gap
            continue
        if align == "left" and box_px:
            events.extend(emit_line(line, 4, left_x, ly))
        elif align == "right" and box_px:
            events.extend(emit_line(line, 6, right_x, ly))
        elif align == "justify" and box_px:
            events.extend(emit_line(line, 4, left_x, ly))
        else:  # center
            events.extend(emit_line(line, 5, cx, ly))
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
    outline_width = max(0.0, float(st.get("stroke_width", 2) or 0))
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
    for i, cue in enumerate(cues):
        cue_style = dict(base, **(cue.get("style") or {}))
        style_name = f"Cue{i}"
        style_lines.append(_ass_style_line(style_name, cue_style, height))
        events += _cue_events(cue, cue_style, width, height, style_name)
    # Place each per-cue ASS style before [Events].
    events_at = header.index("[Events]")
    header[events_at:events_at] = style_lines + ([""] if style_lines else [])
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(header + events) + "\n")
