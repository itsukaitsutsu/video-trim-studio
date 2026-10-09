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
DEFAULT_STYLE = {"x": 0.5, "y": 0.88, "size_pct": 5.5,
                 "align": "center", "box_w": 0.0}


def _cue_events(cue: dict, st: dict, width: int, height: int) -> list[str]:
    """One positioned Dialogue per wrapped line for a single cue."""
    x = min(1.0, max(0.0, float(st.get("x", 0.5))))
    y = min(1.0, max(0.0, float(st.get("y", 0.88))))
    size_pct = min(25.0, max(1.0, float(st.get("size_pct", 5.5))))
    align = st.get("align", "center")
    align = align if align in ("left", "center", "right", "justify") else "center"
    font_size = max(8, round(size_pct / 100.0 * height))
    line_h = round(font_size * LINE_H_FACTOR)
    char_w = font_size * CHAR_FACTOR

    cx = x * width
    cy = y * height
    box_w = float(st.get("box_w", 0.0) or 0.0)
    box_px = (min(1.0, max(0.05, box_w)) * width) if box_w else None
    max_chars = max(4, int(box_px // (font_size * CHAR_FACTOR))) if box_px else None

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
                tag = "{%s\\an4\\pos(%d,%d)}" % (fs, round(xc), round(ly))
                events.append(
                    f"Dialogue: 0,{start},{end},Default,,0,0,0,,{tag}{word}")
                xc += wd + gap
            continue
        if align == "left" and box_px:
            tag = "{%s\\an4\\pos(%d,%d)}" % (fs, round(left_x), round(ly))
        elif align == "right" and box_px:
            tag = "{%s\\an6\\pos(%d,%d)}" % (fs, round(right_x), round(ly))
        elif align == "justify" and box_px:
            tag = "{%s\\an4\\pos(%d,%d)}" % (fs, round(left_x), round(ly))
        else:  # center
            tag = "{%s\\an5\\pos(%d,%d)}" % (fs, round(cx), round(ly))
        events.append(f"Dialogue: 0,{start},{end},Default,,0,0,0,,{tag}{line}")
    return events


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
        f"Style: Default,Arial,12,&H00FFFFFF,&H000000FF,&H00000000,"
        "&H80000000,0,0,0,0,100,100,0,0,1,2,0,5,10,10,10,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
        "Effect, Text",
    ]
    events: list[str] = []
    for cue in cues:
        events += _cue_events(cue, dict(base, **(cue.get("style") or {})),
                              width, height)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(header + events) + "\n")
