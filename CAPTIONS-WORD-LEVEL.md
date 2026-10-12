# Word-level captions in Video Trim Studio

Feature guide for the caption word-level update (Sprint A + B). Companion to
`TEXT-AND-FONTS.md` and `BROLL-AND-FONTS.md`; install notes are in
`CAPTION-WORD-LEVEL-README.txt`.

---

## 1. What "word-level" means here

Three independent layers, and this update covers the first two:

| Layer | This update |
|---|---|
| **A. Word data** — each word has its own start/end time and travels with the caption it appears in | ✅ done, both engines |
| **B. Segmentation** — how many words share one caption, and where the cuts fall | ✅ done (presets + custom + re-split) |
| **C. Rendering** — the active word lighting up / popping, in the burn *and* the preview | later sprint |

The data model stays **one cue = several words**. "One word at a time" is a
*setting*, not a different file format: a 10-minute video would otherwise
become ~1500 separate captions on the timeline, in the SRT and in the editor.

---

## 2. Where words come from

| Source | Quality | Where the label shows |
|---|---|---|
| faster-whisper (`word_timestamps=True`) | real timing, ±50–150 ms | *faster-whisper words* |
| whisper.cpp (`--output-json-full` tokens) | real timing, tighter with `--dtw` | *whisper.cpp tokens* |
| `.srt` / `.vtt` import, hand-typed cues | character-weighted estimate across the cue | *word timing estimated* |
| you edited the text in the cue table | timing kept when the word count is unchanged | *words edited* |

The four labels are the `word_source` field on each caption. If a caption has
no words at all, the burst/one-word layouts still work — they use the
estimate — but nothing claims to know where the audio actually is.

**Why an estimate at all?** So that an imported subtitle file can still be
re-cut into short-form lines, and so that "One word" on a hand-typed caption
does something sensible. It is signposted, never silent.

---

## 3. Segmentation presets

| Preset | Limit | Breaks on | Use for |
|---|---|---|---|
| **Engine segments** | none | nothing (keeps the recogniser's own cuts) | the previous behaviour, long readable lines |
| **Readable lines** | 7 words / 42 chars / 6 s | pauses ≥ 0.6 s, sentence + clause punctuation, cues under 0.8 s merged forward | classic subtitles, YouTube |
| **Burst** *(default)* | 3 words / 18 chars / 2.5 s | pauses ≥ 0.35 s, sentence punctuation, cues under 0.4 s merged forward | Reels / Shorts / TikTok |
| **One word** | 1 word | nothing | word-pop layout, karaoke timing |
| **Custom** | your numbers | your flags | everything else |

The policy fields, all of which accept `0` = *no limit*:

| Field | Meaning |
|---|---|
| `max_words` | most words in one caption |
| `max_chars` | most characters (spaces included) |
| `max_duration` | longest caption, seconds |
| `min_duration` | shorter captions are merged **forward** when the limits allow — a 0.15 s flash of text is a reading problem, not a timing problem |
| `pause` | a gap this long always starts a new caption |
| `break_punct` | end the caption after `. ! ?` (and after `, ; :` once it already holds two words) |
| `uppercase` | display in capitals (display only — the words keep their real spelling for editing) |
| `strip_trailing` | drop a trailing `. , ; :` from the displayed text |

Both `uppercase` and `strip_trailing` change the *text* of the caption; the
word list keeps the recogniser's spelling, so a later re-split at a different
preset still reads correctly.

---

## 4. Choosing a layout, and re-cutting without re-transcribing

The web interface gains **one row** in the caption editor (which only appears
once there is a caption set to edit) — a layout dropdown and **Re-split** —
and nothing else. The same layouts are reachable without the browser:

```bash
# fresh transcription, 3 words per caption
python auto_caption.py video.mp4 --language id --layout burst

# one word per caption
python auto_caption.py video.mp4 --language id --layout word

# your own numbers
python auto_caption.py video.mp4 --layout custom --max-words 4 --max-chars 24 \
    --break-pause 0.5 --uppercase
```

or over the API, which is what the browser would send if it had a control:

```
POST /api/caption                     {"segment_preset": "burst"}
POST /api/caption/{job_id}/resegment  {"preset": "line"}
```

`resegment` re-cuts a **finished** caption set from the words it already has:
no second pass over the audio. It works for transcribed captions (real word
timings) and for imported or hand-typed ones (an estimate is used, and each
caption says `word_source: "estimated"`). `GET /api/env` lists the presets and
their defaults under `caption.segmentation`.

Because a layout is a *policy*, not a data change, re-cutting is lossless:
every word keeps its own timing, so line → burst → word → line returns the
captions you started from. The server
re-groups the caption set from the words it already has (`POST
/api/caption/{job_id}/resegment`), rewrites the `.srt`/`.vtt`/`.json` outputs
and keeps going. Notes:

* Re-split works from the **current** cues, not the original transcript — a
  cue you moved, fixed or deleted stays that way.
* Real word timing survives; a caption with only an estimate stays labelled
  `estimated`.
* Your hand-typed text with no timing gets an estimate rather than being
  dropped.
* The new layout also updates the `segmentation` saved with the job, so a
  later re-open remembers how the cues were cut.

Saving the cue table (`Save captions`) also protects words: a row whose text
did not change keeps its timings; a row whose text gained or lost words keeps
the timings only when the word count matches (a spelling fix), and is marked
*words edited*.

---

## 5. Rules that hold everywhere (so preview == export)

1. **Word times are absolute source seconds** in the caption store, and are
   shifted or sliced by the same maths as the caption itself when the timeline
   moves, trims, razor-cuts, ripples or copy-pastes it.
2. Words are clipped to their caption: a word that falls outside the caption's
   `[start, end]` is clipped, and one that falls entirely outside disappears.
3. Words never overlap: the later word starts where the earlier one ended.
   Everything word-level downstream (ASS events, karaoke timing, the editor)
   assumes this.
4. Punctuation is glued to the word it follows, so a caption reads
   "cerah." and the word list says `cerah.` — never `cerah` + `.`.
5. At export, `export_cues()` re-clips each caption's words to the exported
   `[start, end]`, so the burn uses exactly the timings the editor shows.
6. CJK text is joined without spaces (`你好世界`), Latin text with them
   (`halo dunia`).

---

## 6. Test map

| Suite | Covers |
|---|---|
| `tests/test_segmenter.py` (new) | presets and their defaults, policy clamping, flag parsing, `clean_words` (clipping, punctuation glue, de-overlapping, junk), estimates, grouping rules, re-split invariants, JSON round-trip, `describe()` |
| `auto_caption.py --layout …` | manual check: `--layout burst` on a clip vs `--layout engine` gives the same words in shorter captions (with `--no-word-timestamps` the captions still come out, marked estimated) |
| `tests/test_whispercpp.py` | token JSON parsing, sub-word merging, `--output-json-full` / `--dtw` flags, DTW preset per model, the retry on a build that rejects the flag, words → burst cues |
| `tests/test_caption.py` | words survive the cue editor, a spelling fix keeps timings, a word-count change drops them, re-split to burst/one-word, bad preset / unknown job, word count in the `.json` sidecar |
| `tests/js/timeline-model.test.js` | move shifts words, trim slices them, razor splits at the cut, seeding from cues keeps source times and `word_source`, text edits re-word |

Run everything: `python -m pytest tests/ -q --ignore=tests/test_timeline_ui.py`
and `node --test tests/js/`.

---

## 7. Coming next (already planned)

* **Sprint C** — active-word emphasis in the burn *and* the preview
  (highlight / pop / karaoke sweep, chosen with a word-mode dropdown), sharing
  the same rounding and the same style dict so the preview keeps its promise
  of showing the export.
* **Sprint D** — word-level editing at scale: virtualised caption list, word
  chips per cue, split/merge at a word, find & replace, per-project glossary.
* **Sprint E** — style preset library, keyword auto-highlight, filler-word
  removal, translation / bilingual captions on a second caption lane.
