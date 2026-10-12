"""Section detection: silence (ffmpeg silencedetect) + captions (.srt/.vtt).

The result is a list of *sections* that tile the whole timeline. Each section
is one of:

    caption  - speech that an SRT/VTT cue covers (carries the cue text)
    silence  - below the noise floor for at least `min_silence_ms`
    other    - audible but not covered by any cue (music, laughter, room tone)

The UI lets the user tick any of these; the union of the ticks becomes the
deletion list handed to the exporter.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, asdict

from .ffprobe import run

SILENCE_START_RE = re.compile(r"silence_start:\s*(-?\d+(?:\.\d+)?)")
SILENCE_END_RE = re.compile(r"silence_end:\s*(-?\d+(?:\.\d+)?)")
SILENCE_DUR_RE = re.compile(r"silence_duration:\s*(-?\d+(?:\.\d+)?)")


# ---------------------------------------------------------------------------
# Subtitle parsing
# ---------------------------------------------------------------------------

_STAMP = r"(?:\d+:)?\d{2}:\d{2}[,.]\d{1,3}"
_TIME_RE = re.compile(rf"({_STAMP})\s*-->\s*({_STAMP})")


def _to_seconds(stamp: str) -> float:
    stamp = stamp.replace(",", ".")
    clock, millis = stamp.split(".", 1)
    parts = [int(p) for p in clock.split(":")]
    if len(parts) == 3:
        hours, minutes, seconds = parts
    else:  # WebVTT permits MM:SS.mmm when hours are zero.
        hours = 0
        minutes, seconds = parts
    return hours * 3600 + minutes * 60 + seconds + int(millis.ljust(3, "0")) / 1000.0


def parse_subtitles(text: str) -> list[dict]:
    """Parse SRT or WebVTT text into [{'start','end','text'}]."""
    cues: list[dict] = []
    # Strip BOM, normalise newlines, drop WEBVTT header / NOTE blocks / styling.
    text = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    blocks = re.split(r"\n\s*\n", text)
    for block in blocks:
        lines = [ln for ln in block.strip().split("\n") if ln.strip()]
        if not lines:
            continue
        time_idx = next(
            (i for i, ln in enumerate(lines) if _TIME_RE.search(ln)), None
        )
        if time_idx is None:
            continue
        m = _TIME_RE.search(lines[time_idx])
        if not m:
            continue
        start = _to_seconds(m.group(1))
        end = _to_seconds(m.group(2))
        body = lines[time_idx + 1:]
        # Drop VTT cue settings that leaked onto their own line, and tags.
        body = [re.sub(r"<[^>]+>", "", ln) for ln in body]
        body = [ln for ln in body if not ln.strip().startswith(("NOTE", "STYLE", "REGION"))]
        caption = " ".join(ln.strip() for ln in body).strip()
        if end <= start:
            continue
        cues.append({"start": round(start, 3), "end": round(end, 3), "text": caption})
    cues.sort(key=lambda c: c["start"])
    return cues


# ---------------------------------------------------------------------------
# Silence detection
# ---------------------------------------------------------------------------

def detect_silences(path: str, thresh_db: float, min_len_ms: int,
                    total_s: float) -> list[tuple[float, float]]:
    """[(start_s, end_s)] of every silent run, via ffmpeg's silencedetect."""
    cmd = [
        "ffmpeg", "-hide_banner", "-nostats", "-i", path,
        "-map", "0:a:0", "-vn",
        "-af", f"silencedetect=noise={thresh_db}dB:d={min_len_ms / 1000:.3f}",
        "-f", "null", "-",
    ]
    stderr = run(cmd).stderr

    silences: list[tuple[float, float]] = []
    start: float | None = None
    for line in stderr.splitlines():
        ms = SILENCE_START_RE.search(line)
        if ms:
            start = max(0.0, float(ms.group(1)))
            continue
        me = SILENCE_END_RE.search(line)
        if me and start is not None:
            silences.append((start, float(me.group(1))))
            start = None
    # A silence that runs to EOF never emits silence_end.
    if start is not None:
        silences.append((start, total_s))
    return silences


# ---------------------------------------------------------------------------
# Section building
# ---------------------------------------------------------------------------

@dataclass
class Section:
    id: int
    kind: str          # caption | silence | other
    start: float
    end: float
    text: str = ""
    selected: bool = False

    @property
    def dur(self) -> float:
        return round(self.end - self.start, 3)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["dur"] = self.dur
        return d


def _merge(ranges: list[tuple[float, float]], pad: float = 0.0) -> list[tuple[float, float]]:
    if not ranges:
        return []
    out: list[list[float]] = []
    for s, e in sorted(ranges):
        s, e = max(0.0, s - pad), e + pad
        if out and s <= out[-1][1] + 1e-6:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(s, e) for s, e in out]


def complement(ranges: list[tuple[float, float]], total: float,
               min_len: float = 0.05) -> list[tuple[float, float]]:
    """Everything in [0, total] that is NOT inside `ranges`."""
    kept: list[tuple[float, float]] = []
    pos = 0.0
    for s, e in _merge(ranges):
        s = max(0.0, min(s, total))
        e = max(0.0, min(e, total))
        if s - pos >= min_len:
            kept.append((pos, s))
        pos = max(pos, e)
    if total - pos >= min_len:
        kept.append((pos, total))
    return kept


def build_sections(duration: float,
                   silences: list[tuple[float, float]],
                   cues: list[dict],
                   min_section_ms: int = 120) -> list[Section]:
    """Tile [0, duration] into labelled sections.

    Boundaries come from both silence edges and cue edges, so a section is
    always homogeneous. Adjacent pieces with the same label+text are merged,
    and slivers shorter than `min_section_ms` are folded into their neighbour
    so the UI list stays readable.
    """
    bounds = {0.0, duration}
    for s, e in silences:
        bounds.update({max(0.0, min(s, duration)), max(0.0, min(e, duration))})
    for c in cues:
        bounds.update({max(0.0, min(c["start"], duration)),
                       max(0.0, min(c["end"], duration))})
    edges = sorted(b for b in bounds if 0.0 <= b <= duration)

    def in_any(ranges, t):
        return any(s - 1e-6 <= t <= e + 1e-6 for s, e in ranges)

    raw: list[tuple[str, float, float, str]] = []
    for a, b in zip(edges, edges[1:]):
        if b - a < 1e-4:
            continue
        mid = (a + b) / 2
        if in_any(silences, mid):
            raw.append(("silence", a, b, ""))
            continue
        cue = next((c for c in cues if c["start"] - 1e-6 <= mid <= c["end"] + 1e-6), None)
        if cue is not None:
            raw.append(("caption", a, b, cue["text"]))
        else:
            raw.append(("other", a, b, ""))

    # Merge neighbours that share kind + text.
    merged: list[list] = []
    for kind, a, b, text in raw:
        if merged and merged[-1][0] == kind and merged[-1][3] == text:
            merged[-1][2] = b
        else:
            merged.append([kind, a, b, text])

    # Fold slivers into the previous section (or the next, for the first one).
    min_len = min_section_ms / 1000.0
    folded: list[list] = []
    for item in merged:
        if folded and (item[2] - item[1]) < min_len:
            folded[-1][2] = item[2]
        else:
            folded.append(item)
    if len(folded) > 1 and (folded[0][2] - folded[0][1]) < min_len:
        folded[1][1] = folded[0][1]
        folded.pop(0)

    return [
        Section(id=i, kind=k, start=round(s, 3), end=round(e, 3), text=t)
        for i, (k, s, e, t) in enumerate(folded)
    ]


def sections_from_cues_only(duration: float, cues: list[dict],
                            min_section_ms: int = 120) -> list[Section]:
    """Caption layer without a silence pass: gaps between cues become 'other'."""
    return build_sections(duration, [], cues, min_section_ms)


def summary(sections: list[Section]) -> dict:
    by_kind = {"caption": 0.0, "silence": 0.0, "other": 0.0}
    counts = {"caption": 0, "silence": 0, "other": 0}
    for s in sections:
        by_kind[s.kind] = by_kind.get(s.kind, 0.0) + (s.end - s.start)
        counts[s.kind] = counts.get(s.kind, 0) + 1
    return {
        "total": round(sum(by_kind.values()), 3),
        "seconds_by_kind": {k: round(v, 3) for k, v in by_kind.items()},
        "count_by_kind": counts,
        "count": len(sections),
    }
