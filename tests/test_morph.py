"""Dictionary word segmentation for languages written without spaces.

Two layers are tested here:

  * the pure parts (`detect_lang`, `glue_units`, `recut`) - no dictionary and
    no engine needed, so they run everywhere;
  * the wiring - that a segmenter/engine word list really does get re-cut onto
    dictionary units. Those use a stub first (always run) and the installed
    SudachiPy after that (skipped when it is not there).
"""

import json

import pytest

from vts import morph, segmenter, transcribe
from vts import whispercpp as wcpp

JA = "こんにちは、今日はいい天気ですね。"


@pytest.fixture()
def stub_units(monkeypatch):
    """A dictionary that always answers with fixed units."""
    units = ["今日は", "いい", "天気ですね。"]
    monkeypatch.setattr(morph, "split_words", lambda text, lang=None: list(units))
    return units


# ---------------------------------------------------------------------------
# script detection
# ---------------------------------------------------------------------------

def test_detect_lang_by_script():
    assert morph.detect_lang("こんにちは") == "ja"          # kana
    assert morph.detect_lang("東京駅") == "zh"              # Han, no kana
    assert morph.detect_lang("你好世界") == "zh"
    assert morph.detect_lang("안녕하세요") == "ko"          # Korean uses spaces
    assert morph.detect_lang("สวัสดี") == "th"
    assert morph.detect_lang("hello world") is None
    assert morph.detect_lang("") is None


def test_kana_anywhere_makes_the_whole_set_japanese():
    # A Japanese subtitle file is full of kanji-only lines; asking a Chinese
    # dictionary about them would cut them wrongly.
    texts = ["東京駅", "まで歩く"]           # second line has kana
    assert morph.detect_lang_many(texts) == "ja"
    assert morph.detect_lang_many(["東京駅"]) == "zh"
    assert morph.detect_lang_many(["hello", "world"]) is None


def test_install_hint_only_when_nothing_is_installed(monkeypatch):
    monkeypatch.setattr(morph, "provider", lambda lang=None: None)
    assert "sudachipy" in morph.install_hint("ja")
    assert "jieba" in morph.install_hint("zh")
    assert morph.install_hint("en") is None
    monkeypatch.setattr(morph, "provider", lambda lang=None: "sudachi")
    assert morph.install_hint("ja") is None


# ---------------------------------------------------------------------------
# caption units (pure)
# ---------------------------------------------------------------------------

def test_glue_units_attaches_particles_but_not_content_words():
    got = morph.glue_units([
        ("昨日", "名詞,普通名詞,副詞可能,*,*,*"),
        ("の", "助詞,格助詞,*,*,*,*"),
        ("試合", "名詞,普通名詞,サ変可能,*,*,*"),
        ("は", "助詞,係助詞,*,*,*,*"),
        ("面白かっ", "形容詞,一般,*,*,形容詞,連用形-促音便"),
        ("た", "助動詞,*,*,*,助動詞-タ,終止形-一般"),
        ("です", "助動詞,*,*,*,助動詞-デス,終止形-一般"),
        ("。", "補助記号,句点,*,*,*,*"),
    ])
    assert got == ["昨日の", "試合は", "面白かったです。"]


def test_glue_units_keeps_dependent_verbs_and_standalone_adjectives():
    # 登っ / て / き / た is one caption unit ("climbed and came")...
    assert morph.glue_units([
        ("登っ", "動詞,一般,*,*,五段-ラ行,連用形-促音便"),
        ("て", "助詞,接続助詞,*,*,*,*"),
        ("き", "動詞,非自立可能,*,*,カ行変格,連用形-一般"),
        ("た", "助動詞,*,*,*,助動詞-タ,終止形-一般"),
        ("よ", "助詞,終助詞,*,*,*,*"),
        ("！", "補助記号,句点,*,*,*,*"),
    ]) == ["登ってきたよ！"]
    # ... but "いい" is tagged 形容詞,非自立可能 and must stay its own word.
    assert morph.glue_units([("今日", "名詞,普通名詞,副詞可能,*,*,*"),
                             ("は", "助詞,係助詞,*,*,*,*"),
                             ("いい", "形容詞,非自立可能,*,*,形容詞,連体形-一般")]) \
        == ["今日は", "いい"]
    # A conjunction starts a new unit instead of gluing to the previous one.
    assert morph.glue_units([("雨", "名詞,普通名詞,一般,*,*,*"),
                             ("でも", "接続詞,*,*,*,*,*")]) == ["雨", "でも"]


def test_glue_units_survives_an_empty_or_odd_answer():
    assert morph.glue_units([]) == []
    assert morph.glue_units([(" ", "空白,*,*,*,*,*")]) == []
    assert morph.glue_units([("。", "")]) == ["。"]     # nothing to glue onto


# ---------------------------------------------------------------------------
# timing (pure)
# ---------------------------------------------------------------------------

def test_recut_merges_spans_and_splits_one_proportionally():
    # "こんにちは世界" arrives as three engine tokens; the dictionary says
    # こんにちは + 世界, so the first two spans merge and the third is cut.
    spans = [("こんに", 0.0, 0.6), ("ちは", 0.6, 1.2), ("世界", 1.2, 2.0)]
    got = morph.recut(spans, ["こんにちは", "世界"])
    assert [w["w"] for w in got] == ["こんにちは", "世界"]
    assert got[0]["s"] == 0.0 and got[0]["e"] == 1.2
    assert got[1]["s"] == 1.2 and got[1]["e"] == 2.0
    # One engine word covering two dictionary words: split proportionally.
    got = morph.recut([("あいうえ", 0.0, 2.0)], ["あい", "うえ"])
    assert [w["w"] for w in got] == ["あい", "うえ"]
    assert got[0] == {"w": "あい", "s": 0.0, "e": 1.0}
    assert got[1] == {"w": "うえ", "s": 1.0, "e": 2.0}


def test_recut_never_loses_the_tail_or_the_edges():
    # The units ran out before the text did: the rest rides the last word.
    got = morph.recut([("こんにちは世界", 0.0, 2.0)], ["こんにちは"])
    assert got == [{"w": "こんにちは世界", "s": 0.0, "e": 2.0}]
    # Nothing to cut: no words, no spans, garbage in.
    assert morph.recut([], ["こんにちは"]) == []
    assert morph.recut([("こんにちは", 0.0, 1.0)], []) == []
    assert morph.recut([("x", 1.0, 1.0), (None, 0, 1)], ["x"]) == []


def test_word_spans_ignores_broken_entries():
    assert morph.word_spans([{"w": "a", "s": 0, "e": 1}, {"w": "b"}, None]) == [("a", 0.0, 1.0)]


# ---------------------------------------------------------------------------
# wiring: engine words -> dictionary units
# ---------------------------------------------------------------------------

def test_segmenter_recuts_engine_words_onto_dictionary_units(stub_units):
    text = "今日はいい天気ですね。"
    chars = [{"w": c, "s": i * 0.25, "e": (i + 1) * 0.25} for i, c in enumerate(text)]
    out = segmenter.segment_cues(
        [{"start": 0.0, "end": len(text) * 0.25, "text": text,
          "words": chars, "word_source": "whispercpp"}],
        segmenter.normalize_policy(None, "word"))
    assert [c["text"] for c in out] == stub_units
    # The engine's timings are kept, not invented: 今日は ends where its last
    # character ended.
    assert out[0]["start"] == 0.0 and out[0]["end"] == 0.75
    assert out[1]["start"] == 0.75 and out[1]["end"] == 1.25
    assert [c["word_source"] for c in out] == ["whispercpp"] * 3


def test_engine_preset_keeps_cue_boundaries_but_recuts_the_words(stub_units):
    text = "今日はいい天気ですね。"
    chars = [{"w": c, "s": i * 0.25, "e": (i + 1) * 0.25} for i, c in enumerate(text)]
    out = segmenter.segment_cues(
        [{"start": 0.0, "end": 2.5, "text": text, "words": chars,
          "word_source": "whispercpp"}],
        segmenter.normalize_policy(None, "engine"))
    assert [c["text"] for c in out] == [text]          # one cue, as the engine drew it
    assert out[0]["start"] == 0.0 and out[0]["end"] == 2.5
    assert [w["w"] for w in out[0]["words"]] == stub_units
    assert out[0]["word_source"] == "whispercpp"


def test_a_japanese_cue_without_words_is_estimated_from_units(stub_units):
    out = segmenter.segment_cues(
        [{"start": 0.0, "end": 3.0, "text": "今日はいい天気ですね。"}],
        segmenter.normalize_policy(None, "burst"))
    assert [c["text"] for c in out] == ["今日はいい", "天気ですね。"]
    assert all(c["word_source"] == "estimated" for c in out)
    assert all(w["w"] in stub_units for c in out for w in c["words"])


def test_editing_japanese_text_keeps_its_timings(stub_units):
    words = [{"w": "今日は", "s": 0.0, "e": 1.0},
             {"w": "いい", "s": 1.0, "e": 1.5},
             {"w": "天気ですね。", "s": 1.5, "e": 3.0}]
    got, src = segmenter.reword_for_text(words, "今日はいい天気ですね")
    assert src == "edited"
    assert [w["w"] for w in got] == stub_units
    assert got[0]["s"] == 0.0 and got[-1]["e"] == 3.0


def test_build_cues_recuts_engine_tokens(stub_units):
    """The whisper.cpp path: per-character tokens in, real words out."""
    toks = [{"text": c, "offsets": {"from": i * 250, "to": (i + 1) * 250}}
            for i, c in enumerate("今日はいい天気ですね。")]
    segments = [{"start": 0.0, "end": 2.5, "text": "今日はいい天気ですね。",
                 "words": wcpp.words_from_tokens(toks)}]
    cues = transcribe.build_cues(segments, {"segment_preset": "word",
                                            "language": "ja"}, "whispercpp")
    assert [c["text"] for c in cues] == stub_units
    assert cues[0]["word_source"] == "whispercpp"


def test_build_cues_leaves_latin_alone():
    """No dictionary claims English, so its words pass through untouched."""
    assert morph.split_words("hello world") is None
    segments = [{"start": 0.0, "end": 1.0, "text": "hello world",
                 "words": [{"w": "hello", "s": 0.0, "e": 0.5},
                           {"w": "world", "s": 0.5, "e": 1.0}]}]
    cues = transcribe.build_cues(segments, {"segment_preset": "word",
                                            "language": "en"}, "whisper")
    assert [c["text"] for c in cues] == ["hello", "world"]
    assert cues[0]["word_source"] == "whisper"


# ---------------------------------------------------------------------------
# with the real dictionary (skipped when it is not installed)
# ---------------------------------------------------------------------------

@pytest.mark.skipif(morph.provider("ja") is None,
                    reason="no Japanese dictionary installed")
def test_sudachi_gives_real_caption_words():
    assert morph.split_words(JA) == ["こんにちは、", "今日は", "いい", "天気ですね。"]
    assert morph.split_words("昨日の試合は本当に面白かったです。") \
        == ["昨日の", "試合は", "本当に", "面白かったです。"]
    # Caption units, not dictionary words: no unit is a bare particle, and the
    # count is nothing like the per-character fallback.
    for units in (morph.split_words(JA),):
        assert not any(u in ("は", "の", "に", "を", "て", "た") for u in units)
        assert len(units) < len(JA) / 3


@pytest.mark.skipif(morph.provider("ja") is None,
                    reason="no Japanese dictionary installed")
def test_sudachi_path_end_to_end_through_a_whispercpp_token_stream():
    toks = [{"text": c, "offsets": {"from": i * 250, "to": (i + 1) * 250}}
            for i, c in enumerate(JA)]
    segments = [{"start": 0.0, "end": len(JA) * 0.25, "text": JA,
                 "words": wcpp.words_from_tokens(toks)}]
    cues = transcribe.build_cues(segments, {"segment_preset": "word",
                                            "language": "ja"}, "whispercpp")
    assert [c["text"] for c in cues] == ["こんにちは、", "今日は", "いい", "天気ですね。"]
    assert cues[0]["start"] == 0.0
    assert cues[-1]["end"] == pytest.approx(len(JA) * 0.25, abs=0.05)
    # Timings tile the segment: each cue starts where the last one ended.
    for a, b in zip(cues, cues[1:]):
        assert a["end"] == b["start"]


@pytest.mark.skipif(morph.provider("ja") is None,
                    reason="no Japanese dictionary installed")
def test_sudachi_burst_layout_reads_like_captions():
    out = segmenter.segment_cues(
        [{"start": 0.0, "end": 4.0, "text": "こんにちは、今日はいい天気ですね。"}],
        segmenter.normalize_policy(None, "burst"))
    # Burst is <= 3 words / 18 chars / 2.5 s, and the 2.5 s limit is what
    # splits this line (the words are estimates spread over the cue).
    assert [c["text"] for c in out] == ["こんにちは、今日は", "いい天気ですね。"]
    assert all(len(c["text"]) <= 18 for c in out)
    assert all(len(c["words"]) <= 3 for c in out)


@pytest.mark.skipif(morph.provider("zh") is None, reason="jieba is not installed")
def test_jieba_handles_chinese_without_a_provider_for_japanese():
    units = morph.split_words("你好世界，今天天气很好。")
    assert units and "".join(units) == "你好世界，今天天气很好。"
    # 你好 / 世界， / 今天天气 / 很 / 好。 - full stops ride with the word before
    assert units == ["你好", "世界，", "今天天气", "很", "好。"]
