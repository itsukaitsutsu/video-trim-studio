"""Dictionary word segmentation for captions in languages written without spaces.

Latin-script languages carry their word boundaries in the text itself: the
spaces. Japanese and Chinese do not, and Whisper (like every other recogniser)
returns them as a stream of per-character tokens - which is why a Japanese
caption used to be one indivisible unit whose only possible splits were
between characters. `こんにちは` is five tokens and one word, and only a
vocabulary can tell the difference.

Three optional, fully local dictionaries are wrapped here:

    sudachipy + sudachidict_core / _small   Japanese - recommended
    janome                                  Japanese - pure Python, no compiler
    jieba                                   Chinese

None of them is required. With nothing installed every function returns
`None` and the caller falls back to `segmenter.text_tokens()`, which cuts
text without spaces per character: usable for short-form captions, but not
linguistically correct. Nothing here touches the network.

What comes back are *caption units*, not dictionary words: a particle or an
auxiliary verb is glued to the unit in front of it -

    昨日の / 試合は / 本当に / 面白かった / です / ね。

- because that is how Japanese subtitling breaks lines. `面白かっ` and `た`
are two correct dictionary words and one terrible caption.
"""

from __future__ import annotations

import re
import threading

SUDACHI = "sudachi"
JANOME = "janome"
JIEBA = "jieba"

#: Which script each provider actually knows.
PROVIDER_LANG = {SUDACHI: "ja", JANOME: "ja", JIEBA: "zh"}
#: Providers to try for a language, best first.
LANG_PROVIDERS = {"ja": (SUDACHI, JANOME), "zh": (JIEBA,)}
#: One-line install command per language, shown as a hint (never a hard need).
INSTALL = {"ja": "python -m pip install sudachipy sudachidict_core",
           "zh": "python -m pip install jieba"}

# Script detection. It never has to be perfect - it only decides which
# dictionary (if any) to ask, and an unknown script simply falls through to
# the per-character fallback.
_KANA = re.compile(r"[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]")
_HANGUL = re.compile(r"[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]")
_HAN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_NO_SPACE_OTHER = re.compile(r"[\u0e00-\u0e7f\u0e80-\u0eff\u1000-\u109f"
                             r"\u1780-\u17ff\u0e81-\u0edf]")   # th / lo / my / km

#: Kinds of token that belong to the unit before them, by part of speech.
GLUE_POS = ("助詞", "助動詞", "接尾辞")          # particle, auxiliary, suffix
GLUE_PUNCT = ("記号", "補助記号", "空白")        # 。、！? and friends
GLUE_MARK = "非自立可能"                        # dependent verbs/nouns: てきた, こと
GLUE_MARK_POS = ("動詞", "名詞")                # ... but いい is 形容詞,非自立可能
                                                # and must start its own unit

_lock = threading.Lock()
_tokenizers: dict[str, object] = {}
_broken: set[str] = set()


def detect_lang(text) -> str | None:
    """The language a piece of text is written in, as far as script goes.

    Only the scripts that need a dictionary are named; Latin text (and
    anything unrecognised) returns None, which means "spaces are enough".
    """
    s = str(text or "")
    if _KANA.search(s):
        return "ja"
    if _HANGUL.search(s):
        return "ko"          # written with spaces: no dictionary needed
    if _HAN.search(s):
        return "zh"
    if _NO_SPACE_OTHER.search(s):
        return "th"          # no provider yet: falls back to per character
    return None


def detect_lang_many(texts) -> str | None:
    """One language for a whole cue list.

    A single kana anywhere settles the whole set as Japanese: a Japanese
    subtitle file can contain kanji-only lines (`東京駅`), and asking a
    Chinese dictionary about them would cut them wrongly.
    """
    seen: list[str | None] = [detect_lang(t) for t in texts or []]
    for lang in ("ja", "ko", "zh", "th"):
        if lang in seen:
            return lang
    return None


def provider(lang: str | None) -> str | None:
    """Which installed dictionary can handle `lang`, if any."""
    try:
        import importlib.util
    except Exception:                                  # pragma: no cover
        return None
    for name in LANG_PROVIDERS.get(str(lang or ""), ()):
        if name in _broken:
            continue
        if name == SUDACHI:
            if (importlib.util.find_spec("sudachipy")
                    and (importlib.util.find_spec("sudachidict_core")
                         or importlib.util.find_spec("sudachidict_small"))):
                return name
        elif importlib.util.find_spec(name):
            return name
    return None


def available(lang: str | None) -> str | None:
    """Installed provider for a language (None = per-character fallback)."""
    return provider(lang)


def install_hint(lang: str | None) -> str | None:
    """The command that would turn the fallback into real words, or None."""
    lang = str(lang or "")
    if lang in INSTALL and not provider(lang):
        return INSTALL[lang]
    return None


# --------------------------------------------------------------------------- #
# providers
# --------------------------------------------------------------------------- #

def _sudachi(text: str):
    from sudachipy import dictionary as sd, tokenizer as st
    tok = _tokenizers.get(SUDACHI)
    if tok is None:
        d = sd.Dictionary()
        tok = d.tokenizer() if hasattr(d, "tokenizer") else d.create()
        _tokenizers[SUDACHI] = tok
    mode = st.Tokenizer.SplitMode.A        # short units: caption-sized words
    return [(m.surface(), ",".join(m.part_of_speech())) for m in tok.tokenize(text, mode)]


def _janome(text: str):
    from janome.tokenizer import Tokenizer
    tok = _tokenizers.get(JANOME)
    if tok is None:
        tok = Tokenizer()
        _tokenizers[JANOME] = tok
    return [(t.surface, str(t.part_of_speech)) for t in tok.tokenize(text)]


def _jieba(text: str):
    """Chinese, with jieba's part-of-speech flags.

    jieba's flags are mapped onto the two kinds of token the glue rule knows:
    `x` (punctuation/symbols) and `u*` (particles such as 了 / 的, which behave
    like Japanese suffixes and belong to the word in front of them).
    """
    import jieba.posseg as pseg
    out = []
    for word, flag in pseg.cut(text):
        pos = "補助記号" if flag == "x" else ("助詞" if flag.startswith("u") else flag)
        out.append((word, pos))
    return out


_PROVIDERS = {SUDACHI: _sudachi, JANOME: _janome, JIEBA: _jieba}


def _pairs(text: str, lang: str | None):
    name = provider(lang)
    if not name:
        return None
    fn = _PROVIDERS[name]
    with _lock:                       # the analyzers are not thread-safe
        try:
            return fn(text)
        except Exception:             # a half-installed dictionary must not
            _broken.add(name)         # take the caption feature down with it
            return None


# --------------------------------------------------------------------------- #
# caption units
# --------------------------------------------------------------------------- #

def glue_units(pairs) -> list[str]:
    """Dictionary tokens -> caption units (particles glued to the word before).

    Pure: `pairs` is [(surface, part-of-speech)] and the result is a list of
    strings, so the rule can be tested without any dictionary installed.
    """
    out: list[str] = []
    for surface, pos in pairs or []:
        w = str(surface or "")
        if not w.strip():
            continue
        fields = str(pos or "").split(",")
        head = fields[0] if fields and fields[0] else ""
        glues = (head in GLUE_POS or head in GLUE_PUNCT
                 or (head in GLUE_MARK_POS
                     and any(GLUE_MARK in f for f in fields)))
        if out and glues:
            out[-1] += w
        else:
            out.append(w)
    return out


def split_words(text: str, lang: str | None = None) -> list[str] | None:
    """Cut text into caption units using a dictionary.

    Returns None when no dictionary is installed (or the language does not
    need one), which is the caller's signal to use the per-character fallback.
    """
    s = str(text or "")
    if not s.strip():
        return None
    lang = lang or detect_lang(s)
    pairs = _pairs(s, lang)
    if not pairs:
        return None
    units = glue_units(pairs)
    return units or None


# --------------------------------------------------------------------------- #
# timing
# --------------------------------------------------------------------------- #

def _r3(x: float) -> float:
    return round(float(x), 3)


def recut(spans, units) -> list[dict]:
    """Give each caption unit a real time span, taken from the engine's timing.

    `spans` are what the recogniser actually timed - whisper.cpp tokens,
    faster-whisper words - as `(text, start, end)`. Characters are consumed in
    order, so a unit that covers several spans gets the whole stretch, and one
    that ends in the middle of a span splits that span proportionally. The
    words tile the engine's timeline exactly: no timing is invented and none
    is lost.

    Pure, so it can be tested with no dictionary and no engine at all.
    """
    chars: list[tuple[str, float, float]] = []
    for item in spans or []:
        try:
            if not isinstance(item[0], str):
                continue
            text, a, b = item[0], float(item[1]), float(item[2])
        except (TypeError, IndexError, ValueError):
            continue
        cs = [ch for ch in text if not ch.isspace()]
        if not cs or b <= a:
            continue
        step = (b - a) / len(cs)
        for i, ch in enumerate(cs):
            chars.append((ch, a + i * step, a + (i + 1) * step))
    if not chars or not units:
        return []
    out: list[dict] = []
    i = 0
    for unit in units:
        want = len([c for c in str(unit) if not c.isspace()])
        if want <= 0:
            continue
        chunk = chars[i:i + want]
        if not chunk:
            break
        out.append({"w": str(unit), "s": _r3(chunk[0][1]), "e": _r3(chunk[-1][2])})
        i += len(chunk)
    if not out:
        return []
    if i < len(chars):                # the units ran out before the text did
        out[-1]["w"] += "".join(c[0] for c in chars[i:])
        out[-1]["e"] = _r3(chars[-1][2])
    return out


def word_spans(words) -> list[tuple]:
    """`[{w,s,e}]` -> `[(text, start, end)]`, the input `recut` expects."""
    out = []
    for w in words or []:
        try:
            out.append((str(w["w"]), float(w["s"]), float(w["e"])))
        except (KeyError, TypeError, ValueError):
            continue
    return out


def recut_spans(words, lang: str | None = None) -> list[dict] | None:
    """Re-cut engine words onto dictionary units, keeping their timings.

    Returns None when there is nothing to do (no dictionary, or Latin text).
    """
    spans = word_spans(words)
    if not spans:
        return None
    text = "".join(t for t, _, _ in spans)
    units = split_words(text, lang)
    if not units:
        return None
    out = recut(spans, units)
    return out or None


def describe() -> dict:
    """What is installed - exposed through /api/env so the app can say so."""
    return {lang: {"provider": provider(lang), "install": install_hint(lang)}
            for lang in sorted(LANG_PROVIDERS)}
