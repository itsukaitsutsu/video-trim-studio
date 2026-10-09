"""Caption timeline store: cues with id, track and per-cue style.

The timeline editor keeps one authoritative list of cues on the Project.
Each cue carries its own position/size/alignment (`style`) and a `track`
(the visual lane on the timeline), which is what lets several captions
share one frame - the burn writes one positioned ASS Dialogue per cue.

The plain subtitle file (.srt/.vtt) stays the exchange format: it is
rewritten from the store after every edit (sorted by start; overlapping
entries are fine for players and for our ASS burn), and parsing an
uploaded/generated file seeds the store."""

import uuid

from .captionmap import DEFAULT_STYLE

MIN_LEN = 0.1  # seconds; a cue shorter than this is useless to edit/burn


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def clean_style(st: dict | None) -> dict:
    """Coerce a style dict to safe values, filling defaults."""
    out = dict(DEFAULT_STYLE)
    st = st if isinstance(st, dict) else {}
    try:
        out["x"] = min(1.0, max(0.0, float(st.get("x", out["x"]))))
        out["y"] = min(1.0, max(0.0, float(st.get("y", out["y"]))))
        out["size_pct"] = min(25.0, max(1.0, float(st.get("size_pct", out["size_pct"]))))
        out["box_w"] = min(0.98, max(0.0, float(st.get("box_w", out["box_w"]))))
    except (TypeError, ValueError):
        pass
    align = str(st.get("align", out["align"]))
    out["align"] = align if align in ("left", "center", "right", "justify") else "center"
    return out


def normalize(cues: list[dict], duration: float) -> list[dict]:
    """Validate/sort a client-submitted cue list into store form."""
    out: list[dict] = []
    seen: set[str] = set()
    for c in cues or []:
        if not isinstance(c, dict):
            continue
        try:
            start = float(c.get("start", 0.0))
            end = float(c.get("end", 0.0))
        except (TypeError, ValueError):
            continue
        start = min(max(0.0, start), duration)
        end = min(max(start + MIN_LEN, end), max(start + MIN_LEN, duration))
        if end - start < MIN_LEN / 2 or duration and start >= duration:
            continue
        cid = str(c.get("id") or "").strip()
        if not cid or cid in seen:
            cid = new_id()
        seen.add(cid)
        try:
            track = max(0, int(c.get("track", 0)))
        except (TypeError, ValueError):
            track = 0
        out.append({
            "id": cid,
            "start": round(start, 3),
            "end": round(end, 3),
            "text": " ".join(str(c.get("text") or "").split()) or "Caption",
            "track": min(track, 31),
            "style": clean_style(c.get("style")),
        })
    out.sort(key=lambda c: (c["start"], c["end"], c["id"]))
    return out


def lane_pack(cues: list[dict]) -> list[dict]:
    """Assign `track` greedily so overlapping cues never share a lane."""
    last_end: list[float] = []
    packed = []
    for c in sorted(cues, key=lambda c: (c["start"], c["end"])):
        lane = next((i for i, e in enumerate(last_end) if e <= c["start"] + 1e-6), None)
        if lane is None:
            lane = len(last_end)
            last_end.append(c["end"])
        else:
            last_end[lane] = c["end"]
        c2 = dict(c)
        c2["track"] = lane
        packed.append(c2)
    return packed


def from_parsed(cues: list[dict]) -> list[dict]:
    """Seed the store from parse_subtitles() output (import/generation)."""
    store = []
    for c in cues or []:
        store.append({
            "id": new_id(),
            "start": round(float(c["start"]), 3),
            "end": round(float(c["end"]), 3),
            "text": " ".join(str(c.get("text") or "").split()) or "Caption",
            "track": 0,
            "style": clean_style(None),
        })
    return lane_pack(store)


def to_plain(cues: list[dict]) -> list[dict]:
    """Plain {start,end,text} view for section building / subtitle files."""
    return [{"start": c["start"], "end": c["end"], "text": c["text"]}
            for c in cues]
