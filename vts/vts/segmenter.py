"""Word-level caption segmentation: how words become caption cues.

A transcription engine returns *words* with their own start/end times
(faster-whisper's `word_timestamps`, whisper.cpp's token timestamps). A caption
cue is only a *group* of those words that fits on screen long enough to read,
so the interesting knob is the grouping policy, not the ASR:

    words  ->  group_words(words, policy)  ->  [{start, end, text, words}]

Policies are plain dicts so they survive the JSON trip to the browser, can be
saved with a project and are cheap to test. `PRESETS` holds the named ones:

    engine  keep the engine's own segments (no re-grouping)
    line    readable subtitles: <= 7 words / 42 chars / 6 s, breaks on pauses
    burst   vertical short-form: <= 3 words / 18 chars / 2.5 s  (default)
    word    one word at a time
    custom  whatever the UI fields say

Every function here is pure: no I/O, no global state, no imports from the rest
of the app, so the transcription worker, the "Re-split captions" endpoint, the
tests and (through the API) the browser all share one implementation.

Words are plain dicts - short keys because a ten-minute video carries a few
thousand of them into the browser on every project load:

    {"w": "kabar", "s": 12.34, "e": 12.71}      # word, start, end (seconds)
"""

from __future__ import annotations

import re

from . import morph

# A cue never holds more words than this (a guard against a pathological run
# of one-word cues being merged by the UI).
MAX_WORDS = 200
# Shortest word we keep: below this a word is displayable but not editable.
MIN_WORD = 0.02
MIN_WORD_R = 0.03          # floor used when padding a zero-length word

# Sentence enders and clause separators, ASCII + the CJK/Thai punctuation a
# translated transcript can carry.
_SENTENCE_END = ".!?…。！？"
_CLAUSE_END = ",;:，、；：、"
# Trailing noise that should not stop a break decision (quotes, brackets).
_TRAILING = "\"'”’)]}»"

_UPPER_SAFE = re.compile(r"^[^\W\d_]+$", re.UNICODE)


def _r3(x: float) -> float:
    return round(x * 1000) / 1000


def _num(v, default=None):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if f != f or f in (float("inf"), float("-inf")):     # NaN / inf
        return default
    return f


def _flag(v, default: bool) -> bool:
    if v is None:
        return default
    if isinstance(v, str):
        return v.strip().lower() not in ("", "0", "false", "no", "off")
    return bool(v)


# ---------------------------------------------------------------------------
# Policy
# ---------------------------------------------------------------------------

# Field semantics (0 means "no limit" everywhere):
#   max_words      most words in one cue
#   max_chars      most characters in one cue's text
#   max_duration   longest cue, in seconds
#   min_duration   shorter cues are merged forward when the limits allow it
#   pause          a silence this long always starts a new cue
#   break_punct    end the cue after . ! ? (and after , ; : once the cue
#                  already holds two words)
#   uppercase      display the text in capitals (the short-form look)
#   strip_trailing drop a trailing . , ; : from the displayed text
#   keep_segments  do not group at all (use the engine's own segments)
DEFAULTS: dict = {
    "max_words": 3,
    "max_chars": 18,
    "max_duration": 2.5,
    "min_duration": 0.4,
    "pause": 0.35,
    "break_punct": True,
    "uppercase": False,
    "strip_trailing": False,
    "keep_segments": False,
}

PRESETS: dict[str, dict] = {
    "engine": {
        "label": "Engine segments (as transcribed)",
        "hint": "Whatever the recogniser produced - usually whole sentences. The "
            "recogniser is the only thing that knows where Japanese words end, "
            "so this is the layout to use when the cuts must be linguistically "
            "correct rather than small.",
        "policy": {"keep_segments": True},
    },
    "line": {
        "label": "Readable lines (subtitles)",
        "hint": "Up to 7 words, 42 characters or 6 s - the classic subtitle line.",
        "policy": {
            "max_words": 7, "max_chars": 42, "max_duration": 6.0,
            "min_duration": 0.8, "pause": 0.6, "break_punct": True,
        },
    },
    "burst": {
        "label": "Burst - 3 words (vertical video)",
        "hint": "Up to 3 words, 18 characters or 2.5 s - the short-form look. "
                "Japanese/Chinese/Korean count per character.",
        "policy": {
            "max_words": 3, "max_chars": 18, "max_duration": 2.5,
            "min_duration": 0.4, "pause": 0.35, "break_punct": True,
        },
    },
    "word": {
        "label": "One word at a time",
        "hint": "Every word gets its own cue - the karaoke / word-pop layout. "
                "One character per cue for Japanese/Chinese/Korean.",
        "policy": {
            "max_words": 1, "max_chars": 0, "max_duration": 0,
            "min_duration": 0, "pause": 0, "break_punct": False,
        },
    },
    "custom": {
        "label": "Custom",
        "hint": "Use the fields below.",
        "policy": {},
    },
}

PRESET_ORDER = ("engine", "line", "burst", "word", "custom")
#: The layout a *new* caption set gets: the recogniser's own segments. Nothing
#: is re-split unless the user asks for it by picking another layout - the
#: transcription button must never silently re-cut the transcript (it used to
#: default to Burst, which also hid any segment the engine gave no word times
#: for). "burst" stays one click away.
DEFAULT_PRESET = "engine"


def normalize_policy(raw: dict | None = None, preset: str | None = None) -> dict:
    """Validate a policy dict / preset name into a complete policy.

    `preset` (when it names a real preset) wins over `raw`; "custom" or an
    unknown/absent name means "use `raw` on top of the defaults".
    """
    name = str(preset or "").strip().lower()
    pol = dict(DEFAULTS)
    if name in PRESETS and name != "custom":
        pol.update(PRESETS[name]["policy"])
    src = raw if isinstance(raw, dict) else {}
    # Never let a raw dict un-keep the engine segments of an explicit preset.
    if name == "engine":
        return pol
    det = {
        "max_words": (0, MAX_WORDS),
        "max_chars": (0, 500),
        "max_duration": (0.0, 600.0),
        "min_duration": (0.0, 60.0),
        "pause": (0.0, 10.0),
    }
    for key, (lo, hi) in det.items():
        if key in src and src[key] is not None:
            v = _num(src[key])
            if v is not None:
                pol[key] = min(hi, max(lo, int(v) if key == "max_words" else v))
    for key in ("break_punct", "uppercase", "strip_trailing", "keep_segments"):
        if key in src and src[key] is not None:
            pol[key] = _flag(src[key], pol[key])
    if name == "engine":
        pol["keep_segments"] = True
    return pol


def preset_of(policy: dict | None) -> str:
    """The preset a policy matches, for showing it back in the UI."""
    pol = normalize_policy(policy)
    for name in PRESET_ORDER:
        if name in ("custom", "engine"):
            continue
        if normalize_policy(None, name) == pol:
            return name
    return "engine" if pol.get("keep_segments") else "custom"


# ---------------------------------------------------------------------------
# Words
# ---------------------------------------------------------------------------

def clean_words(raw, lo: float | None = None, hi: float | None = None) -> list[dict]:
    """Coerce anything JSON-ish into sorted `[{w,s,e}]` inside [lo, hi].

    Accepts the app's `{w,s,e}` and the engines' `{word,start,end}` spelling.
    Words fully outside the window are dropped, straddling ones are clipped;
    a word is never allowed to overlap its neighbour. A punctuation-only token
    ("." from whisper.cpp's token timestamps) is glued onto the word before it,
    so the display text reads "cerah." and not "cerah .".
    """
    out: list[dict] = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        w = str(item.get("w", item.get("word", "")) or "").strip()
        if not w:
            continue
        s = _num(item.get("s", item.get("start")))
        e = _num(item.get("e", item.get("end")))
        if s is None:
            continue
        if e is None or e <= s:
            e = s + MIN_WORD_R
        punct_only = not any(ch.isalnum() for ch in w)
        if punct_only and out:
            # Punctuation rides with the word before it, even when it lands a
            # hair outside the window (whisper.cpp emits "." as its own token,
            # starting exactly where the previous word ends).
            out[-1]["w"] = out[-1]["w"] + w
            out[-1]["e"] = _r3(max(out[-1]["e"], min(e, hi) if hi is not None else e))
            continue
        if hi is not None and s >= hi - 1e-6:
            continue
        if lo is not None and e <= lo + 1e-6:
            continue
        if lo is not None:
            s = max(s, lo)
        if hi is not None:
            e = min(e, hi)
        if e - s < MIN_WORD:
            e = s + MIN_WORD
        out.append({"w": w, "s": _r3(s), "e": _r3(e)})
    out.sort(key=lambda x: (x["s"], x["e"]))
    # Two words may not share the same slice of the timeline: the later one
    # starts where the earlier one ended. Everything downstream (the ASS
    # writer, the karaoke timing, the word editor) assumes this.
    for i in range(1, len(out)):
        prev, cur = out[i - 1], out[i]
        if cur["s"] < prev["e"]:
            cur["s"] = _r3(prev["e"])
            if cur["e"] <= cur["s"]:
                cur["e"] = _r3(cur["s"] + MIN_WORD_R)
    return out[:MAX_WORDS]


def is_cjk_word(ch: str) -> bool:
    """True for a CJK character that carries meaning (a letter), as opposed to
    CJK punctuation (。、「」), which belongs to the token before it."""
    return bool(ch) and _is_cjk(ch) and ch.isalnum()


def has_cjk(text: str) -> bool:
    """True when the text contains a character from a script written without
    spaces (Japanese, Chinese, Korean, Thai, Khmer, Lao, Myanmar). Those
    languages cannot be split on whitespace - a caption layout has to cut them
    per character instead, which is what `text_tokens` does."""
    return any(_is_cjk(ch) for ch in str(text or ""))


def text_tokens(text: str) -> list[str]:
    """Split caption text into the units a layout can cut at.

    Latin words split on whitespace. CJK splits **per character**, because
    those languages are written without spaces and Whisper returns them as
    per-character tokens; a Japanese cue of 20 characters is 20 cut points,
    not one. Punctuation stays glued to the token it follows, so the displayed
    text reads "世界。" rather than "世界 ." - the same rule `clean_words`
    applies to real word data.
    """
    out: list[str] = []
    gap = True                                 # start of text = start of a unit
    for ch in str(text or ""):
        if ch.isspace():
            gap = True                         # a space always ends a unit
            continue
        if _is_cjk(ch):
            if is_cjk_word(ch):
                out.append(ch)
            elif out:
                out[-1] += ch              # 。 and 、 belong to the word before
            else:
                out.append(ch)
            gap = False
            continue
        if ch.isalnum():
            tail = out[-1][-1] if (out and out[-1]) else ""
            if not gap and tail and not _is_cjk(tail) and tail.isalnum():
                out[-1] += ch                  # keep a Latin/digit run together
            else:
                out.append(ch)
            gap = False
            continue
        if out:
            out[-1] += ch                      # punctuation rides with its word
        else:
            out.append(ch)
        gap = False
    return out


def text_units(text: str, lang: str | None = None) -> list[str]:
    """The points a caption layout may cut this text at.

    With a dictionary installed (see `vts.morph`) those are real words, which
    is the only way to cut Japanese or Chinese correctly. Without one the
    script heuristic is used: spaces for Latin, one character per unit for
    languages that are written without them.
    """
    units = morph.split_words(text, lang)
    return units if units else text_tokens(text)


def words_from_text(text: str, start: float, end: float,
                    lang: str | None = None) -> list[dict]:
    """Char-weighted word timings for a cue that has no word data.

    Used for .srt/.vtt imports and hand-typed cues so the burst/word layouts
    still work; the result is always labelled `estimated`.
    """
    parts = text_units(text, lang)
    if not parts:
        return []
    a = _num(start, 0.0) or 0.0
    b = _num(end, a + 0.1)
    span = max(0.05, b - a)
    weights = [len(p) + 1 for p in parts]
    total = sum(weights) or 1
    out: list[dict] = []
    t = a
    for p, wt in zip(parts, weights):
        dur = span * wt / total
        out.append({"w": p, "s": _r3(t), "e": _r3(t + dur)})
        t += dur
    return out


def reword_for_text(words, text, source=None):
    """Re-point word timings at edited text.

    A caption whose text was fixed ("dunia" -> "duniaku") still describes the
    same speech, so when the word count is unchanged the timings are kept and
    only their labels change; the result is marked `edited` to say so. A text
    with a different number of words has no timing to map, so the words are
    dropped (the cue falls back to an estimate at render time).

    Returns `(words, word_source)`.
    """
    ws = clean_words(words)
    parts = str(text or "").split()
    if not ws:
        return [], None
    if len(parts) != len(ws):
        # Text without spaces (Japanese, Chinese) has one "part" per sentence,
        # so counting words cannot work. A dictionary can: re-cut the *new*
        # text and map it onto the old timings, which still describe the same
        # speech. Without a dictionary the words are dropped, as before.
        units = morph.split_words(text)
        recut = morph.recut(morph.word_spans(ws), units) if units else None
        if recut:
            return recut, "edited"
        return [], None
    if [w["w"] for w in ws] == parts:
        return ws, clean_word_source(source)
    return ([{"w": part, "s": w["s"], "e": w["e"]} for part, w in zip(parts, ws)],
            "edited")


WORD_SOURCES = (None, "whisper", "whispercpp", "estimated", "edited")


def clean_word_source(src) -> str | None:
    """Only the sources we know about survive; anything else becomes None."""
    s = str(src or "").strip().lower()
    return s if s in WORD_SOURCES else None


def has_words(cues) -> bool:
    return any(c.get("words") for c in (cues or []))


def word_count(cues) -> int:
    return sum(len(c.get("words") or []) for c in (cues or []))


def with_estimated_words(cues, lang: str | None = None) -> list[dict]:
    """Fill in `words` for cues that have none (marked `estimated`).

    Keeping an estimate on hand means Burst/Word layouts and word-level edits
    work on an imported .srt too - it is a starting point, not a claim about
    the audio, which is exactly what `word_source` says.
    """
    out = []
    for c in cues or []:
        c2 = dict(c)
        if not c2.get("words"):
            est = words_from_text(c2.get("text", ""), c2.get("start", 0.0),
                                  c2.get("end", 0.0), lang)
            if est:
                c2["words"] = est
                c2["word_source"] = "estimated"
        out.append(c2)
    return out


# ---------------------------------------------------------------------------
# Text of a group of words
# ---------------------------------------------------------------------------

# Languages written without spaces between words: joining with " " would put a
# space inside every sentence.
_CJK_RANGES = (
    (0x1100, 0x11FF), (0x2E80, 0x303F), (0x3040, 0x30FF), (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF), (0xAC00, 0xD7AF), (0xF900, 0xFAFF), (0x0E00, 0x0E7F),
    (0x0E80, 0x0EFF), (0x1000, 0x109F), (0x1780, 0x17FF),
)


def _is_cjk(ch: str) -> bool:
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in _CJK_RANGES)


def joiner(words) -> str:
    body = "".join(str(w.get("w", "")) for w in words or [])
    letters = [ch for ch in body if not ch.isspace()]
    if letters and all(_is_cjk(ch) for ch in letters):
        return ""
    return " "


def tidy(text: str) -> str:
    """Collapse whitespace and pull punctuation back onto its word."""
    t = " ".join(str(text or "").split())
    t = re.sub(r"\s+([,.;:!?…，。、；：！？)\]}»])", r"\1", t)
    t = re.sub(r"([(\[{«])\s+", r"\1", t)
    return t


def join_words(words) -> str:
    """The displayed text of a group of words.

    A space goes between units - except between two CJK characters, which are
    written together: "日本" + "語" is "日本語", while "日本語" + "OK" is
    "日本語 OK". (Deciding per boundary instead of per group is what keeps a
    mixed Japanese/English caption readable.)
    """
    out = ""
    for w in words or []:
        part = str(w.get("w", ""))
        if not part:
            continue
        if not out:
            out = part
        elif _is_cjk(out[-1]) and _is_cjk(part[0]):
            out += part
        else:
            out += " " + part
    return tidy(out)


# ---------------------------------------------------------------------------
# Grouping
# ---------------------------------------------------------------------------

def _last_index(word: str) -> str:
    s = str(word or "").rstrip()
    while s and s[-1] in _TRAILING:
        s = s[:-1].rstrip()
    return s[-1] if s else ""


def ends_sentence(word: str) -> bool:
    return _last_index(word) in _SENTENCE_END


def ends_clause(word: str) -> bool:
    return _last_index(word) in _CLAUSE_END


def _group_text(group, pol: dict) -> str:
    text = join_words(group)
    if pol.get("strip_trailing"):
        stripped = re.sub(r"[.,;:]+$", "", text).strip()
        if stripped:
            text = stripped
    if pol.get("uppercase"):
        text = text.upper()
    return text


def _cue(group, pol: dict, src=None) -> dict:
    return {
        "start": _r3(group[0]["s"]),
        "end": _r3(group[-1]["e"]),
        "text": _group_text(group, pol),
        "words": [{"w": w["w"], "s": _r3(w["s"]), "e": _r3(w["e"])} for w in group],
        **({"word_source": src} if src else {}),
    }


def _fits(cur: list[dict], w: dict, pol: dict) -> bool:
    gap = w["s"] - cur[-1]["e"]
    if pol["pause"] and gap > pol["pause"]:
        return False
    if pol["max_words"] and len(cur) + 1 > pol["max_words"]:
        return False
    if pol["max_duration"] and (w["e"] - cur[0]["s"]) > pol["max_duration"] + 1e-9:
        return False
    last = cur[-1]["w"]
    if pol["break_punct"]:
        if ends_sentence(last):
            return False
        if len(cur) >= 2 and ends_clause(last):
            return False
    if pol["max_chars"]:
        if len(_group_text(cur + [w], pol)) > pol["max_chars"]:
            return False
    return True


def _can_merge(a: list[dict], b: list[dict], pol: dict) -> bool:
    if pol["max_words"] and len(a) + len(b) > pol["max_words"]:
        return False
    if pol["max_duration"] and (b[-1]["e"] - a[0]["s"]) > pol["max_duration"] + 1e-9:
        return False
    if pol["max_chars"] and len(_group_text(a + b, pol)) > pol["max_chars"]:
        return False
    gap_limit = (pol["pause"] or 0.5) + 0.3
    return (b[0]["s"] - a[-1]["e"]) <= gap_limit


def _merge_short(groups: list[list[dict]], pol: dict) -> list[list[dict]]:
    """Merge cues shorter than `min_duration` forward, when limits allow.

    A one-second flash of text is a reading problem, not a timing problem; the
    merge is what makes 0.2 s of speech visible at all.
    """
    out: list[list[dict]] = []
    for g in groups:
        prev = out[-1] if out else None
        dur = (prev[-1]["e"] - prev[0]["s"]) if prev else 0.0
        if (prev is not None and dur + 1e-9 < pol["min_duration"]
                and _can_merge(prev, g, pol)):
            out[-1] = prev + list(g)
        else:
            out.append(list(g))
    return out


def _group_lists(words: list[dict], pol: dict) -> list[list[dict]]:
    """The grouping itself: word dicts in, groups of word dicts out."""
    if not words or pol["keep_segments"]:
        return []
    groups: list[list[dict]] = [[words[0]]]
    for w in words[1:]:
        if _fits(groups[-1], w, pol):
            groups[-1].append(w)
        else:
            groups.append([w])
    if pol["min_duration"] > 0:
        groups = _merge_short(groups, pol)
    return groups


def group_words(words, policy: dict | None = None) -> list[dict]:
    """Group words into cues following `policy`. Empty list for keep_segments."""
    pol = normalize_policy(policy)
    return [_cue(g, pol) for g in _group_lists(clean_words(words), pol)]


def segment_cues(cues, policy: dict | None = None,
                 lang: str | None = None) -> list[dict]:
    """Re-split an existing cue list into new cues without re-transcribing.

    Words are taken from `words` when a cue has them, otherwise char-weighted
    per word. The returned cues carry `word_source`: "estimated" when a cue is
    built only from estimated words, otherwise the source the input declared.

    When a dictionary is installed, the cue's words are first re-cut onto real
    word units (`vts.morph`) - a Japanese cue whose engine words are
    per-character tokens becomes a list of actual words, with the engine's
    timings kept by splitting the token spans proportionally. This is what
    makes Re-split work in languages that have no spaces.
    """
    pol = normalize_policy(policy)
    if lang is None:
        lang = morph.detect_lang_many([c.get("text") for c in cues or []
                                       if isinstance(c, dict)])
    src = []
    for c in cues or []:
        if not isinstance(c, dict):
            continue
        have = clean_words(c.get("words"))
        est = not have
        if have:
            units = morph.split_words(c.get("text", ""), lang)
            words = (morph.recut(morph.word_spans(have), units) if units else None) or have
        else:
            words = words_from_text(
                c.get("text", ""), _num(c.get("start"), 0.0) or 0.0,
                _num(c.get("end"), 0.0) or 0.0, lang)
        for w in words:
            w["_est"] = est
            w["_src"] = c.get("word_source") or ("estimated" if est else None)
        src.extend(words)
    if pol["keep_segments"]:
        out = []
        for c in cues or []:
            if not isinstance(c, dict):
                continue
            # The cue *boundaries* stay exactly as the engine drew them - that
            # is what this preset promises. The words inside a cue are still
            # re-cut onto dictionary units when one is installed, so word
            # editing and (later) word-pop rendering have real words to work
            # with instead of per-character tokens.
            have = clean_words(c.get("words"))
            units = morph.split_words(c.get("text", ""), lang)
            words = (morph.recut(morph.word_spans(have), units)
                     if (have and units) else None) or have
            out.append({
                "start": _r3(_num(c.get("start"), 0.0) or 0.0),
                "end": _r3(_num(c.get("end"), 0.0) or 0.0),
                "text": tidy(c.get("text", "")),
                "words": words,
                **({"word_source": c["word_source"]} if c.get("word_source") else {}),
            })
        # Keep the engine's cue boundaries, but a cue the engine gave no word
        # timings for still gets editable words (clearly marked `estimated`).
        return with_estimated_words(out, lang)
    if not src:
        return []
    src.sort(key=lambda x: (x["s"], x["e"]))
    out = []
    for group in _group_lists(src, pol):
        # A cue is "estimated" only when every word in it is estimated;
        # otherwise it keeps the best real source its words came from.
        if all(w.get("_est") for w in group):
            word_src = "estimated"
        else:
            word_src = next((w.get("_src") for w in group if not w.get("_est")), None)
        out.append(_cue(group, pol, word_src))
    return out


def describe(policy: dict | None, preset: str | None = None) -> str:
    """One-line human summary of a policy, for the UI hint."""
    name = str(preset or "").strip().lower()
    if name == "engine":
        return PRESETS["engine"]["hint"]
    pol = normalize_policy(policy, None if name in ("", "custom") else name)
    if pol["keep_segments"]:
        return PRESETS["engine"]["hint"]
    bits = []
    if pol["max_words"]:
        bits.append(f"{pol['max_words']} word" + ("s" if pol["max_words"] > 1 else ""))
    if pol["max_chars"]:
        bits.append(f"{pol['max_chars']:g} chars")
    if pol["max_duration"]:
        bits.append(f"{pol['max_duration']:g} s")
    head = " / ".join(bits) if bits else "no length limit"
    tail = []
    if pol["pause"]:
        tail.append(f"pauses >= {pol['pause']:g} s")
    if pol["break_punct"]:
        tail.append("sentence ends")
    if pol["min_duration"]:
        tail.append(f"merged under {pol['min_duration']:g} s")
    if pol["uppercase"]:
        tail.append("UPPERCASE")
    return head + (" · breaks on " + ", ".join(tail) if tail else "")


def catalog() -> dict:
    """Presets + field metadata, so the UI builds itself from the API."""
    return {
        "default": DEFAULT_PRESET,
        "presets": [
            {"id": pid, "label": PRESETS[pid]["label"],
             "hint": PRESETS[pid]["hint"],
             "policy": {**DEFAULTS, **PRESETS[pid]["policy"]}}
            for pid in PRESET_ORDER
        ],
        "fields": {
            "max_words": {"label": "Max words", "min": 0, "max": 40, "step": 1,
                          "note": "0 = no limit"},
            "max_chars": {"label": "Max characters", "min": 0, "max": 200, "step": 1,
                          "note": "0 = no limit"},
            "max_duration": {"label": "Max seconds", "min": 0, "max": 30, "step": 0.1,
                             "note": "0 = no limit"},
            "min_duration": {"label": "Merge under (s)", "min": 0, "max": 5, "step": 0.05,
                             "note": "0 = keep short cues"},
            "pause": {"label": "Break on pause (s)", "min": 0, "max": 5, "step": 0.05,
                      "note": "0 = ignore pauses"},
        },
        "flags": [
            {"id": "break_punct", "label": "Break after . ! ?"},
            {"id": "uppercase", "label": "UPPERCASE"},
            {"id": "strip_trailing", "label": "Drop trailing punctuation"},
        ],
    }
