"""Caption timeline store: cues with id, track and per-cue style.

The timeline editor keeps one authoritative list of cues on the Project.
Each cue carries its own position/size/alignment (`style`) and a `track`
(the visual lane on the timeline), which is what lets several captions
share one frame - the burn writes one positioned ASS Dialogue per cue.

A cue also carries the *words* it displays, each with its own start/end
(`[{w,s,e}]`, absolute seconds), because that is what word-level layouts,
word editing and (later) word-pop rendering need. Words are optional: a cue
imported from an .srt has none, and anything that needs them falls back to
`vts.segmenter`. `word_source` records where they came from - "whisper",
"whispercpp", "estimated" (char-weighted) or "edited" - so the UI can be
honest about how trustworthy the timings are.

The plain subtitle file (.srt/.vtt) stays the exchange format: it is
rewritten from the store after every edit (sorted by start; overlapping
entries are fine for players and for our ASS burn), and it cannot carry word
timings - that is what the .json sidecar and the project state are for.
"""

import uuid

from .captionmap import DEFAULT_STYLE
from .segmenter import MIN_WORD, clean_word_source, clean_words

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
    """Validate/sort a client-submitted cue list into store form.

    Word-level cues are short by design (a fast talker's "a" can be 0.08 s), so
    the floor that keeps a cue visible is word-aware and, when a cue is padded
    to reach it, the padding stops at the next cue's start instead of piling
    cues onto extra lanes.
    """
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
        if duration and start >= duration:
            continue
        raw_end = max(start, end)
        words = clean_words(c.get("words"), start, raw_end)
        pad = MIN_WORD if words else MIN_LEN
        end = min(max(start + pad, raw_end), max(start + pad, duration))
        if end - start < pad / 2:
            continue
        cid = str(c.get("id") or "").strip()
        if not cid or cid in seen:
            cid = new_id()
        seen.add(cid)
        try:
            track = max(0, int(c.get("track", 0)))
        except (TypeError, ValueError):
            track = 0
        text = " ".join(str(c.get("text") or "").split()) or "Caption"
        out.append({
            "id": cid,
            "start": round(start, 3),
            "end": round(end, 3),
            "text": text,
            "track": min(track, 31),
            "style": clean_style(c.get("style")),
            "words": words,
            "_raw_end": round(raw_end, 3),
        })
        out[-1]["word_source"] = clean_word_source(c.get("word_source")) or (
            "edited" if words else None)
    out.sort(key=lambda c: (c["start"], c["end"], c["id"]))
    # Padding must never tread on the cue that follows: pull it back to the
    # next start (an original overlap the user made on purpose is kept).
    for i in range(len(out) - 1):
        cur, nxt = out[i], out[i + 1]
        if (cur["end"] > nxt["start"] + 1e-6
                and cur["_raw_end"] <= nxt["start"] + 1e-6):
            cur["end"] = nxt["start"]
    for c in out:
        c.pop("_raw_end", None)
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
    """Seed the store from parse_subtitles() output (import/generation).

    An .srt/.vtt parse has no word data, so cues that arrive with `words`
    (the transcription job's own cue list, or a project reload) keep them and
    a bare subtitle import gets a char-weighted estimate - enough for the
    burst/word layouts and for word-level editing to have something to work
    with, clearly labelled as an estimate.
    """
    from .morph import detect_lang_many
    from .segmenter import words_from_text
    lang = detect_lang_many([c.get("text") for c in cues or []
                             if isinstance(c, dict)])
    store = []
    for c in cues or []:
        try:
            start = round(float(c["start"]), 3)
            end = round(float(c["end"]), 3)
        except (KeyError, TypeError, ValueError):
            continue
        words = clean_words(c.get("words"))
        src = clean_word_source(c.get("word_source"))
        if not words:
            words = words_from_text(c.get("text", ""), start, end, lang)
            src = "estimated" if words else None
        store.append({
            "id": new_id(),
            "start": start,
            "end": end,
            "text": " ".join(str(c.get("text") or "").split()) or "Caption",
            "track": 0,
            "style": clean_style(c.get("style")),
            "words": words,
            "word_source": src,
        })
    return lane_pack(store)


def to_plain(cues: list[dict]) -> list[dict]:
    """Plain {start,end,text} view for section building / subtitle files."""
    return [{"start": c["start"], "end": c["end"], "text": c["text"]}
            for c in cues]
