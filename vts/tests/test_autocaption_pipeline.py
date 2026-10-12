"""Regression tests for the auto-caption -> captions pipeline.

The rule these lock in: **transcribing must not silently re-split, and must
never silently drop a segment.** Both were real bugs - the layout dropdown
defaulted to Burst (so every transcription came out re-split, and there was no
way to get the recogniser's own segments without noticing the dropdown), and a
segment the engine could not time lost its text the moment a layout other than
"engine" was in play.
"""

import os

from vts import segmenter, transcribe
from vts import whispercpp as wcpp


def _seg(text, start, end, words=None):
    seg = {"start": start, "end": end, "text": text}
    if words is not None:
        seg["words"] = words
    return seg


def _w(word, start, end):
    return {"w": word, "s": start, "e": end}


TWO_SEGMENTS = [
    _seg("Hello there everyone.", 0.0, 2.0,
         [_w("Hello", 0.0, 0.6), _w("there", 0.6, 1.2), _w("everyone", 1.2, 2.0)]),
    _seg("This one has no word timings.", 2.5, 5.0),      # engine gave none
    _seg("Goodbye.", 5.5, 7.0, [_w("Goodbye", 5.5, 7.0)]),
]


# ---------------------------------------------------------------------------
# nothing is dropped
# ---------------------------------------------------------------------------

def test_a_segment_without_word_timings_keeps_its_caption():
    """The bug: a segment with no words disappeared from every re-split layout.

    The text must survive - as an estimate when nothing better exists - because
    a caption that is not there is worse than a caption with guessed timing.
    """
    for preset in ("burst", "word", "line", "engine"):
        cues = transcribe.build_cues(TWO_SEGMENTS, {"segment_preset": preset},
                                     "whisper")
        text = " ".join(c["text"] for c in cues)
        # (The words I hand in carry no punctuation; the point here is that the
        # segment's *words* survive, not that the text matches verbatim.)
        assert "This one has no word timings" in text, preset
        assert "Goodbye" in text, preset
        assert "Hello" in text, preset


def test_the_estimated_segment_says_so_and_the_others_do_not():
    cues = transcribe.build_cues(TWO_SEGMENTS, {"segment_preset": "burst"},
                                 "whisper")
    src = {c["text"]: c.get("word_source") for c in cues}
    assert src["Hello there"] == "whisper"
    assert src["This one has"] == "estimated"
    assert src["no word timings."] == "estimated"


def test_a_transcript_with_no_word_data_at_all_still_gets_the_chosen_layout():
    cues = transcribe.build_cues([_seg("one two three four five six", 0, 3)],
                                 {"segment_preset": "burst"}, "whisper")
    assert [c["text"] for c in cues] == ["one two three", "four five six"]
    assert [c.get("word_source") for c in cues] == ["estimated", "estimated"]


def test_engine_mode_keeps_boundaries_and_still_estimates_words():
    cues = transcribe.build_cues(TWO_SEGMENTS, {"segment_preset": "engine"},
                                 "whisper")
    assert [c["text"] for c in cues] == ["Hello there everyone.",
                                         "This one has no word timings.",
                                         "Goodbye."]
    assert [c["start"] for c in cues] == [0.0, 2.5, 5.5]
    assert cues[1]["word_source"] == "estimated"
    assert len(cues[1]["words"]) == 6      # This / one / has / no / word / timings.


def test_whispercpp_untimed_trailing_token_keeps_its_text():
    """whisper.cpp omits a timestamp when the model cannot align a token; its
    text used to be discarded, taking the rest of the segment with it."""
    toks = [{"text": " Hello", "offsets": {"from": 0, "to": 500}},
            {"text": " there", "offsets": {"from": 500, "to": 900}},
            {"text": " untimed"}]                      # no offsets at all
    words = wcpp.words_from_tokens(toks)
    assert [w["w"] for w in words] == ["Hello", "there untimed"]
    assert words[-1]["e"] == 0.9                       # the timed part's end
    # If the whole segment is untimed there is nothing to attach to; the text
    # still reaches the captions through the segment text.
    assert wcpp.words_from_tokens([{"text": "only"}]) == []


# ---------------------------------------------------------------------------
# the defaults
# ---------------------------------------------------------------------------

def test_transcribing_defaults_to_the_engines_own_segments():
    """Transcribe must not re-split unless the user picks a layout.

    The default lives in three places; they have to agree.
    """
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    assert segmenter.DEFAULT_PRESET == "engine"
    assert segmenter.catalog()["default"] == "engine"
    js = open(os.path.join(root, "static", "app.js"), encoding="utf-8").read()
    assert 'const SEG_DEFAULT = "engine"' in js
    py = open(os.path.join(root, "server.py"), encoding="utf-8").read()
    assert 'segment_preset: str = "engine"' in py


def test_the_layout_choices_are_still_there_and_work():
    """Default = engine must not cost the user the other layouts."""
    ids = [p["id"] for p in segmenter.catalog()["presets"]]
    # "custom" is in the API (CLI/JSON) but hidden from the UI dropdown.
    assert ids == ["engine", "line", "burst", "word", "custom"]
    pr = segmenter.PRESETS
    assert pr["engine"]["policy"]["keep_segments"] is True
    cues = transcribe.build_cues(TWO_SEGMENTS, {"segment_preset": "burst"},
                                 "whisper")
    assert len(cues) > 3, "burst still re-splits when asked for"
