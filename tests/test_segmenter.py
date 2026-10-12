"""Unit tests for vts/segmenter.py - words in, caption cues out.

Pure functions, so these run everywhere (no ffmpeg, no model, no browser).
The policy is the contract the UI, the transcription worker and the
"Re-split captions" endpoint all share; anything that changes here changes
what the user sees on screen.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from vts import segmenter as seg          # noqa: E402


def words(*flat):
    """("Halo", 0.0, 0.4, "dunia", 0.5, 0.9) -> [{w,s,e}, ...]"""
    assert len(flat) % 3 == 0, "pass name/start/end triples"
    return [{"w": flat[i], "s": flat[i + 1], "e": flat[i + 2]}
            for i in range(0, len(flat), 3)]


SPOKEN = words(
    "Halo", 0.0, 0.4, "dunia", 0.45, 0.9, "apa", 1.5, 1.75, "kabar", 1.8, 2.2,
    "hari", 2.3, 2.6, "ini", 2.65, 2.9, "cerah", 2.95, 3.4,
)


# ---------------------------------------------------------------------------
# Catalog / presets
# ---------------------------------------------------------------------------

def test_catalog_offers_every_preset_in_a_fixed_order():
    cat = seg.catalog()
    assert cat["default"] == seg.DEFAULT_PRESET
    ids = [p["id"] for p in cat["presets"]]
    assert ids == list(seg.PRESET_ORDER)
    assert set(ids) == set(seg.PRESETS)
    # The UI builds its fields from this, so it must be complete.
    assert set(cat["fields"]) == {"max_words", "max_chars", "max_duration",
                                  "min_duration", "pause"}
    assert {f["id"] for f in cat["flags"]} == {"break_punct", "uppercase",
                                              "strip_trailing"}


def test_every_preset_policy_is_a_complete_policy():
    for pid in seg.PRESET_ORDER:
        pol = seg.normalize_policy(None, pid)
        assert set(pol) == set(seg.DEFAULTS), pid


def test_the_short_form_preset_is_the_default_and_word_is_one_at_a_time():
    assert seg.normalize_policy(None, "burst")["max_words"] == 3
    word = seg.normalize_policy(None, "word")
    assert word["max_words"] == 1 and word["max_duration"] == 0
    assert seg.normalize_policy(None, "line")["max_words"] == 7


# ---------------------------------------------------------------------------
# Policy normalisation
# ---------------------------------------------------------------------------

def test_an_unknown_preset_falls_back_to_the_defaults_plus_the_raw_dict():
    pol = seg.normalize_policy({"max_words": 5}, "nonsense")
    assert pol["max_words"] == 5
    assert pol["max_chars"] == seg.DEFAULTS["max_chars"]


@pytest.mark.parametrize("raw,key,expected", [
    ({"max_words": -4}, "max_words", 0),
    ({"max_words": 99999}, "max_words", seg.MAX_WORDS),
    ({"max_chars": -1}, "max_chars", 0),
    ({"max_duration": 1e9}, "max_duration", 600.0),
    ({"pause": -2}, "pause", 0.0),
])
def test_out_of_range_numbers_are_clamped_not_rejected(raw, key, expected):
    assert seg.normalize_policy(raw, "custom")[key] == expected


@pytest.mark.parametrize("value,expected", [
    ("false", False), ("off", False), ("no", False), ("", False),
    ("true", True), ("yes", True), (1, True), (0, False),
])
def test_flags_accept_strings_from_json(value, expected):
    assert seg.normalize_policy({"uppercase": value}, "custom")["uppercase"] is expected


def test_garbage_numbers_keep_the_default_instead_of_exploding():
    pol = seg.normalize_policy({"max_words": "three", "pause": None}, "custom")
    assert pol["max_words"] == seg.DEFAULTS["max_words"]
    assert pol["pause"] == seg.DEFAULTS["pause"]


def test_the_engine_preset_cannot_be_talked_out_of_itself():
    # "engine" means "leave the recogniser's segmentation alone"; a stray
    # segmentation dict must not silently re-cut it.
    pol = seg.normalize_policy({"keep_segments": False, "max_words": 2}, "engine")
    assert pol["keep_segments"] is True


def test_preset_of_reads_a_policy_back():
    assert seg.preset_of(seg.normalize_policy(None, "burst")) == "burst"
    assert seg.preset_of(seg.normalize_policy(None, "word")) == "word"
    assert seg.preset_of(seg.normalize_policy(None, "engine")) == "engine"
    assert seg.preset_of({"max_words": 4, "max_chars": 19}) == "custom"


# ---------------------------------------------------------------------------
# clean_words
# ---------------------------------------------------------------------------

def test_clean_words_accepts_both_spellings_and_sorts():
    raw = [{"word": "kabar", "start": 2.0, "end": 2.4},
           {"w": "Halo", "s": 1.0, "e": 1.4}]
    assert seg.clean_words(raw) == [{"w": "Halo", "s": 1.0, "e": 1.4},
                                    {"w": "kabar", "s": 2.0, "e": 2.4}]


def test_clean_words_clips_to_the_window_and_never_overlaps():
    ws = seg.clean_words(words("Halo", 0.0, 1.0, "dunia", 1.1, 2.0),
                         lo=0.5, hi=1.5)
    assert ws[0]["s"] == 0.5 and ws[0]["e"] == 1.0
    assert ws[1]["s"] == 1.1 and ws[1]["e"] == 1.5
    for a, b in zip(ws, ws[1:]):
        assert b["s"] >= a["e"]


def test_clean_words_drops_what_fell_outside_entirely():
    assert seg.clean_words(words("gone", 0.0, 0.4), lo=1.0, hi=2.0) == []
    assert seg.clean_words(words("late", 5.0, 5.4), lo=1.0, hi=2.0) == []


def test_a_punctuation_token_rides_with_the_word_before_it():
    # whisper.cpp emits "." as its own token, starting exactly where the
    # previous word ended; the caption must read "cerah." not "cerah .".
    ws = seg.clean_words(words("cerah", 2.0, 2.4, ".", 2.4, 2.5))
    assert len(ws) == 1
    assert ws[0]["w"] == "cerah." and ws[0]["e"] == 2.5


def test_clean_words_gives_a_zero_length_word_somethging_to_display():
    ws = seg.clean_words([{"w": "uh", "s": 1.0, "e": 1.0}])
    assert ws[0]["e"] > ws[0]["s"]


def test_clean_words_skips_junk_and_caps_the_list():
    raw = [None, "Halo", {"no": "time"}, {"w": "", "s": 0, "e": 1},
           {"w": "Halo", "s": "nope", "e": 1}] + \
          [{"w": f"w{i}", "s": i, "e": i + 0.5} for i in range(seg.MAX_WORDS + 40)]
    ws = seg.clean_words(raw)
    assert len(ws) == seg.MAX_WORDS
    assert ws[0]["w"].startswith("w")


def test_clean_words_is_stable_when_words_share_a_start():
    ws = seg.clean_words(words("a", 1.0, 1.2, "b", 1.0, 1.1, "c", 1.0, 1.3))
    assert [w["w"] for w in ws] == ["b", "a", "c"]
    # Same start for all three: each later word begins where the previous ended
    # (the earlier word keeps the end the engine gave it).
    assert [w["s"] for w in ws] == [1.0, 1.1, 1.2]
    for a, b in zip(ws, ws[1:]):
        assert b["s"] >= a["e"]


# ---------------------------------------------------------------------------
# Estimated words
# ---------------------------------------------------------------------------

def test_words_from_text_spans_the_cue_exactly():
    ws = seg.words_from_text("satu dua tiga", 10.0, 13.0)
    assert ws[0]["s"] == 10.0 and ws[-1]["e"] == 13.0
    assert [w["w"] for w in ws] == ["satu", "dua", "tiga"]
    # Time is shared by character count, so "dua" gets less than "satu".
    assert ws[1]["e"] - ws[1]["s"] < ws[0]["e"] - ws[0]["s"]
    assert ws[2]["e"] - ws[2]["s"] == pytest.approx(ws[0]["e"] - ws[0]["s"])
    assert seg.words_from_text("", 0, 1) == []
    assert seg.words_from_text("   ", 0, 1) == []


def test_with_estimated_words_only_touches_cues_without_words():
    cues = [
        {"start": 0, "end": 1, "text": "one two"},
        {"start": 1, "end": 2, "text": "three four", "words": words("three", 1.0, 1.4,
                                                                     "four", 1.5, 2.0),
         "word_source": "whisper"},
    ]
    out = seg.with_estimated_words(cues)
    assert out[0]["word_source"] == "estimated" and len(out[0]["words"]) == 2
    assert out[1]["word_source"] == "whisper"
    assert out[1]["words"] == cues[1]["words"]
    # The input is never mutated: the same cue list is reused by the caller.
    assert "words" not in cues[0]


def test_word_count_and_has_words():
    assert seg.has_words([]) is False
    assert seg.word_count([]) == 0
    cues = [{"words": words("a", 0, 1, "b", 1, 2)}, {}]
    assert seg.has_words(cues) is True
    assert seg.word_count(cues) == 2


def test_only_known_word_sources_survive():
    assert seg.clean_word_source("Whisper") == "whisper"
    assert seg.clean_word_source("estimated") == "estimated"
    assert seg.clean_word_source("someone-elses-guess") is None
    assert seg.clean_word_source(None) is None


def test_reword_for_text_keeps_timings_for_a_same_length_fix():
    ws = words("Halo", 0.2, 0.6, "dunia.", 0.7, 1.1)
    same, src = seg.reword_for_text(ws, "Halo dunia.", "whisper")
    assert [w["w"] for w in same] == ["Halo", "dunia."]
    assert src == "whisper"                     # nothing changed at all
    fixed, src = seg.reword_for_text(ws, "Halo duniaku.", "whisper")
    assert [w["w"] for w in fixed] == ["Halo", "duniaku."]
    assert [w["s"] for w in fixed] == [0.2, 0.7]
    assert src == "edited"
    dropped, src = seg.reword_for_text(ws, "Halo dunia semuanya", "whisper")
    assert dropped == [] and src is None
    assert seg.reword_for_text([], "anything") == ([], None)


# ---------------------------------------------------------------------------
# Text of a group
# ---------------------------------------------------------------------------

def test_join_words_uses_spaces_for_latin_and_none_for_cjk():
    assert seg.join_words(words("Halo", 0, 1, "dunia", 1, 2)) == "Halo dunia"
    assert seg.join_words(words("你好", 0, 1, "世界", 1, 2)) == "你好世界"


def test_tidy_pulls_punctuation_back_onto_its_word():
    assert seg.tidy("cerah .") == "cerah."
    assert seg.tidy("( halo )") == "(halo)"
    assert seg.tidy("  many   spaces  ") == "many spaces"


def test_sentence_and_clause_ends_look_through_quotes():
    assert seg.ends_sentence("cerah.") is True
    assert seg.ends_sentence('"cerah!"') is True
    assert seg.ends_sentence("cerah, ") is False
    assert seg.ends_clause("cerah,") is True
    assert seg.ends_clause("cerah") is False


# ---------------------------------------------------------------------------
# group_words
# ---------------------------------------------------------------------------

def test_burst_groups_three_words_at_a_time():
    cues = seg.group_words(SPOKEN, seg.normalize_policy(None, "burst"))
    # "Halo dunia" then a 0.6 s pause, then "apa kabar" ...
    assert cues[0]["text"] == "Halo dunia"
    assert cues[0]["start"] == 0.0 and cues[0]["end"] == 0.9
    # The third word of each cue is cut by the 3-word limit, except where the
    # 0.6 s pause after "dunia" got there first.
    assert [len(c["words"]) for c in cues] == [2, 3, 2]
    assert [c["text"] for c in cues][1] == "apa kabar hari"
    assert [c["text"] for c in cues][-1] == "ini cerah"


def test_a_pause_always_starts_a_new_cue():
    policy = {"max_words": 6, "max_chars": 0, "max_duration": 0,
              "min_duration": 0, "pause": 0.5, "break_punct": False}
    cues = seg.group_words(SPOKEN, policy)
    assert cues[0]["text"] == "Halo dunia"
    assert cues[1]["start"] == 1.5


def test_sentence_punctuation_ends_a_cue_early():
    policy = {"max_words": 8, "max_chars": 0, "max_duration": 0,
              "min_duration": 0, "pause": 0, "break_punct": True}
    ws = words("halo", 0.0, 0.3, "dunia", 0.35, 0.6, ".", 0.6, 0.7,
               "apa", 0.75, 1.0, "kabar", 1.05, 1.3)
    cues = seg.group_words(ws, policy)
    assert [c["text"] for c in cues] == ["halo dunia.", "apa kabar"]


def test_character_limit_keeps_a_cue_off_the_third_line():
    policy = {"max_words": 0, "max_chars": 12, "max_duration": 0,
              "min_duration": 0, "pause": 0, "break_punct": False}
    cues = seg.group_words(words("pneumonia", 0, 1, "extraordinarily", 1, 2,
                                 "ok", 2, 3), policy)
    # "pneumonia" alone already eats 9 of the 12 characters.
    assert cues[0]["text"] == "pneumonia"
    assert cues[1]["text"] == "extraordinarily"
    assert cues[2]["text"] == "ok"


def test_duration_limit_ends_a_cue():
    policy = {"max_words": 0, "max_chars": 0, "max_duration": 1.0,
              "min_duration": 0, "pause": 0, "break_punct": False}
    cues = seg.group_words(words("a", 0.0, 0.6, "b", 0.6, 1.2, "c", 1.2, 1.8), policy)
    assert [len(c["words"]) for c in cues] == [1, 1, 1]
    assert cues[0]["end"] == 0.6


def test_a_flash_of_text_is_merged_forward_when_the_limits_allow_it():
    policy = {"max_words": 4, "max_chars": 0, "max_duration": 0,
              "min_duration": 1.0, "pause": 0, "break_punct": False}
    cues = seg.group_words(words("ya", 0.0, 0.15, "baiklah", 0.2, 0.9), policy)
    assert len(cues) == 1
    assert cues[0]["text"] == "ya baiklah"


def test_uppercase_and_strip_trailing_are_display_only():
    policy = {"max_words": 3, "max_chars": 0, "max_duration": 0,
              "min_duration": 0, "pause": 0, "break_punct": False,
              "uppercase": True, "strip_trailing": True}
    cues = seg.group_words(words("halo", 0, 1, "dunia.", 1, 2), policy)
    assert cues[0]["text"] == "HALO DUNIA"


def test_group_words_with_no_words_is_an_empty_list():
    assert seg.group_words([], {"max_words": 3}) == []
    assert seg.group_words(SPOKEN, seg.normalize_policy(None, "engine")) == []


def test_cues_carry_the_words_they_were_built_from():
    cues = seg.group_words(SPOKEN, seg.normalize_policy(None, "burst"))
    first = cues[0]
    assert first["words"] == [{"w": "Halo", "s": 0.0, "e": 0.4},
                              {"w": "dunia", "s": 0.45, "e": 0.9}]
    assert first["start"] == first["words"][0]["s"]
    assert first["end"] == first["words"][-1]["e"]


# ---------------------------------------------------------------------------
# segment_cues - re-splitting without re-transcribing
# ---------------------------------------------------------------------------

def test_resplitting_a_word_preset_into_burst_keeps_every_word():
    one = seg.segment_cues(
        [{"start": 0.0, "end": 3.4, "text": seg.join_words(SPOKEN), "words": SPOKEN,
          "word_source": "whisper"}],
        seg.normalize_policy(None, "word"))
    assert [c["text"] for c in one] == [w["w"] for w in SPOKEN]
    assert all(c["word_source"] == "whisper" for c in one)

    burst = seg.segment_cues(one, seg.normalize_policy(None, "burst"))
    assert sum(len(c["words"]) for c in burst) == len(SPOKEN)
    assert burst[0]["text"] == "Halo dunia"
    assert all(c["word_source"] == "whisper" for c in burst)


def test_resplitting_a_cue_without_words_estimates_them():
    cues = seg.segment_cues(
        [{"start": 2.0, "end": 4.0, "text": "satu dua tiga empat"}],
        seg.normalize_policy(None, "burst"))
    assert [c["text"] for c in cues] == ["satu dua tiga", "empat"]
    assert all(c["word_source"] == "estimated" for c in cues)
    assert cues[0]["words"][0]["s"] == 2.0
    assert cues[-1]["words"][-1]["e"] == 4.0


def test_resplitting_keeps_the_engine_segmentation_when_asked_to():
    cues = [{"start": 0, "end": 2, "text": "Hello  there", "words": words("Hello", 0, 1,
                                                                          "there", 1, 2),
             "word_source": "whisper"},
            {"start": 2, "end": 3, "text": "again"}]
    out = seg.segment_cues(cues, seg.normalize_policy(None, "engine"))
    assert [c["text"] for c in out] == ["Hello there", "again"]
    assert out[0]["words"] == cues[0]["words"]
    assert out[0]["word_source"] == "whisper"
    assert out[1]["words"] == []          # typed text, nothing to guess from


def test_resplitting_ignores_junk_and_keeps_real_words_with_estimated_neighbours():
    cues = [
        "not a cue",
        {"start": 0.0, "end": 1.0, "text": "real words here",
         "words": words("real", 0.0, 0.3, "words", 0.35, 0.7, "here", 0.75, 1.0),
         "word_source": "whisper"},
        {"start": 1.0, "end": 2.0, "text": "guessed line"},
    ]
    out = seg.segment_cues(cues, seg.normalize_policy(None, "word"))
    assert [c["text"] for c in out] == ["real", "words", "here", "guessed", "line"]
    assert [c["word_source"] for c in out] == ["whisper"] * 3 + ["estimated"] * 2


def test_resplitting_nothing_is_an_empty_list():
    assert seg.segment_cues([], {"max_words": 3}) == []
    assert seg.segment_cues([{"start": 0, "end": 0, "text": ""}],
                            {"max_words": 3}) == []


def test_resplit_output_survives_a_json_round_trip():
    import json
    cues = seg.segment_cues(
        [{"start": 0, "end": 2, "text": "Halo dunia apa kabar",
          "words": words("Halo", 0.0, 0.4, "dunia", 0.45, 0.9,
                         "apa", 1.0, 1.3, "kabar", 1.35, 1.9),
          "word_source": "whispercpp"}],
        seg.normalize_policy(None, "burst"))
    again = json.loads(json.dumps(cues))
    assert seg.word_count(again) == 4
    assert seg.segment_cues(again, seg.normalize_policy(None, "burst")) == again


# ---------------------------------------------------------------------------
# describe
# ---------------------------------------------------------------------------

def test_describe_mentions_the_limits_that_are_actually_on():
    text = seg.describe(seg.normalize_policy(None, "burst"), "burst")
    assert "3 words" in text and "18 chars" in text and "2.5 s" in text
    assert "sentence ends" in text
    assert seg.describe({"max_words": 1, "max_chars": 0, "max_duration": 0,
                         "min_duration": 0, "pause": 0, "break_punct": False},
                        "word") == "1 word"


def test_describe_explains_the_engine_preset():
    assert seg.describe(seg.normalize_policy(None, "engine"), "engine") == \
        seg.PRESETS["engine"]["hint"]
