CAPTION WORD-LEVEL UPDATE (Sprint A + B) — "auto caption per words"
===================================================================

Word timings + caption segmentation. This is the first of the word-level
sprints: every word keeps its own start/end time from the recogniser all the
way to the export, and captions can be cut by word/pause/punctuation rules
instead of whatever long sentence Whisper happened to produce.

No new Python package, no ffmpeg change, no cloud call. Everything stays
offline and local. Nothing changes unless you ask for a layout: the default is
"engine" = the recogniser's own captions, exactly as before.

THE INTERFACE IS UNCHANGED except for ONE ADDED ROW in the caption editor
(see "WHERE IT IS IN THE UI" below) - nothing was moved, renamed or restyled,
and no panel was added to the Auto-caption card. static/timeline.js is the
file you already have, byte for byte. static/timeline-model.js (the timeline's
data model: no DOM, no CSS) is what keeps word timings attached to captions
when they are moved, trimmed, split or exported.


INSTALL
-------
1. Stop Video Trim Studio.
2. Back up same-named files in your project folder (or just keep this ZIP).
3. Extract this ZIP into the project root (the folder containing server.py),
   preserve the folder paths, and allow overwrite.
4. Hard-reload the page (Ctrl+F5). The CSS/JS URLs were cache-busted.

Two files are NEW, not replacements — they have to land as well:
    vts/segmenter.py           (segmentation policy: pure, no I/O)
    tests/test_segmenter.py    (51 unit tests for it)

Files this drop does NOT include (because they are unchanged):
    static/timeline.js
If you extracted an earlier build of this drop, re-extract this one over it -
the old panels are removed by the new app.js/index.html/style.css.

If you prefer git, apply the patch instead of copying: from the project root,

    git apply patches/caption-word-level.patch

The patch contains exactly the same edits as the files in this ZIP
(14 changed + 2 new), so use one or the other, not both.


FIXED SINCE THE FIRST BUILD OF THIS DROP
----------------------------------------
The first two builds changed the interface far too much (a segmentation panel
in the Auto-caption card, then a whole section inside the caption editor).
That is undone: the layout is now a single row with one dropdown and one
button inside the editor that already existed, and the transcribe form is
untouched. If you installed an earlier build of this drop, simply extract this
one over it - the old panel ids are gone and nothing is left behind.


VERIFY IN 30 SECONDS
--------------------
From the project root (the one with server.py):

    python -m pytest tests/ -q --ignore=tests/test_timeline_ui.py
    node --test tests/js/

Expected: 308 passed, 2 failed, 10 skipped — and 37/37 on the node side.
The two failures are NOT from this change: they also fail on the untouched
c194787 (test_broll_fonts.py::test_shadow_spread_does_not_multiply_opacity and
test_caption.py::test_caption_overlay_is_wired_between_html_and_js; the second
one expects a `data-tab="clip"` attribute your index.html does not have).
The 10 skips need faster-whisper / a GPU, which is fine. If you only have
time for two commands, run these:

    python -m pytest tests/test_segmenter.py tests/test_whispercpp.py -q
    python -m pytest tests/test_caption.py -q -k "words_survive or resplit"

The end-to-end caption test drives real ffmpeg (needs it on PATH as usual).


WHAT CHANGED
------------
New
  vts/segmenter.py              one pure module: policy + presets + word
                                cleaning + estimate + grouping + re-split +
                                the catalog the UI builds itself from
  tests/test_segmenter.py       51 unit tests (grouping rules, presets,
                                clamping, CJK joining, re-split invariants)

Changed
  vts/transcribe.py             build_cues() (segments -> policy -> cues),
                                inherit_words() protects word data when the
                                cue editor saves, resegment_job(), notes
                                "412 cue(s), 1180 word(s)", env payload
  vts/whispercpp.py             --output-json-full token parsing -> real word
                                timings, --dtw option, automatic retry without
                                the flag on builds that predate it (1.7)
  vts/captions.py               the cue store keeps words/word_source
  vts/captionmap.py             export clips words with the cue at each cut;
                                identical ASS styles collapse to one style
                                line while keeping the Cue<i>/Cue<i>Shadow
                                pairing (needed before word mode multiplies
                                cue counts)
  vts/timeline.py               the timeline store keeps words per caption
                                and re-clips them to the exported [start,end]
  server.py                     POST /api/caption/{id}/resegment, DTW and
                                segmentation fields on the caption request,
                                /api/detect accepts the editor's cue list
  static/*.js,index.html,style.css
                                "Caption segmentation" block + "Re-split"
                                button + word-aware caption model (move, trim,
                                razor, ripple, copy/paste all shift or slice
                                words)


WHERE IT IS IN THE UI (the only screen that changed)
---------------------------------------------------
The caption editor does not exist until there is something to edit - it stays
hidden until you transcribe, or press "Open .srt / .vtt..." / "New blank
captions". Once it appears (Auto-caption card, under the file list), it now
has ONE extra row, directly under the existing "Caption editor / + Add cue /
Undo changes / Save captions" line:

    [ Layout: Burst - 3 words (vertical video) v ]  [ Re-split ]

  * Layout    engine (as transcribed) / line / burst / word. Also used for the
              next transcription, so a fresh run can come out in bursts
              straight away. Custom limits are not in this dropdown - they
              stay available on the command line / API.
  * Re-split  re-cuts the captions in the editor with that layout, using the
              words they already carry. Works for transcribed captions (real
              word timings) and for imported or typed ones (an estimate,
              marked "estimated"). No new pass over the audio.

Everything else in the editor - the table, the buttons, the status line - is
exactly where it was.


HOW TO USE IT
-------------
A. From the UI (the row described above)
   1. Auto-caption card -> "Open .srt / .vtt..." (or transcribe as usual).
   2. Pick a layout, press "Re-split". Repeat with another layout any time.
   3. "Use these captions -> Detect sections" puts them on the timeline.

B. Command line (auto_caption.py)
     python auto_caption.py video.mp4 --language id --layout burst
     python auto_caption.py video.mp4 --language id --layout word
     python auto_caption.py video.mp4 --language id --layout line
     python auto_caption.py video.mp4 --layout custom --max-words 4 --max-chars 24

   --layout is one of: engine (default = unchanged), line, burst, word, custom
   With --layout custom you also get --max-words, --max-chars, --max-seconds,
   --merge-under, --break-pause, --uppercase, --strip-trailing-punct.

C. API (what the browser row sends)
   The caption request accepts two extra fields:

     POST /api/caption        {"segment_preset": "burst"}      # or line/word/custom
                              {"segmentation": {"max_words": 4, "max_chars": 24}}
     POST /api/caption/{id}/resegment   {"preset": "burst"}

   `POST /api/caption/{id}/resegment` re-cuts a finished caption set from the
   words it already has - no second transcription. It works for transcribed
   captions (real word timing) and for imported/hand-typed ones (an estimate
   is used, marked "estimated"). `GET /api/env` still returns the catalog of
   presets and their defaults under caption.segmentation.

   The bundled app keeps working exactly as before: with no fields sent, the
   preset is "engine", i.e. the recogniser's own captions.

The layouts:
     engine   what the recogniser produced (the old behaviour, and the default)
     line     <= 7 words / 42 chars / 6 s - classic subtitles
     burst    3 words / 18 chars / 2.5 s per caption - short-form
     word     one caption per word - the word-pop layout
     custom   your own numbers, from the flags/fields above

AMD/Vulkan users: the whisper.cpp engine now emits real word timings too (it
needs a build with --output-json-full, i.e. any release since 1.7; older ones
fall back to SRT + an honest estimate). Pass "dtw": true (API) to trade speed
for tighter word alignment; the right DTW preset is picked from your model
automatically. The old checkbox never existed in your UI, and still does not.

Everything word-related is OPT-IN: without --layout (or a preset in the API
call) the captions behave exactly as before.


NOTES / LIMITS (worth reading once)
-----------------------------------
* An .srt/.vtt cannot carry word timing, so a sidecar import (or hand-typed
  captions) gets a char-weighted estimate marked "estimated". It is a
  starting point for Burst/One-word layouts, not a claim about the audio.
* Whisper word timings are an inference-time trick, not a trained output:
  expect +-50-150 ms, worst around pauses and music. No per-syllable effect
  will ever be frame-accurate on that data; that is what DTW improves.
* "One word" on a 10-minute video means ~1500 captions. The timeline canvas
  and the caption table were not built for that many rows yet (that is
  Sprint D: word-level editing + virtualisation). Use Burst for long videos
  for now.
* Editing a caption's text in the cue table: same word count -> the timings
  are kept and the words are relabelled "edited"; different word count ->
  the words are dropped (the cue falls back to an estimate) rather than
  leaving timings that no longer describe what you hear.
* The words shown in the editor are what the export uses - preview and burn
  disagreeing is the thing this sprint exists to prevent.
* Not in this drop: the active-word highlight / pop / karaoke sweep in the
  burned video and the preview (Sprint C), word-level editing UX (Sprint D),
  style preset library / filler-word removal / translation (Sprint E).
* Re-split lives in the caption editor. Captions that reached the timeline
  through the plain "Use captions (srt/vtt)" detection path carry estimated
  words but have no re-split button of their own yet - open the caption card
  and use the editor for that.


CHANGELOG SNIPPET (paste into CHANGE-NOTES.txt if you keep one)
---------------------------------------------------------------
Caption word-level update - words + segmentation (no UI changes)
  New       vts/segmenter.py, tests/test_segmenter.py
  Changed   auto_caption.py (--layout and friends), server.py,
            vts/{transcribe,whispercpp,captions,captionmap,timeline}.py,
            static/timeline-model.js, tests/{test_caption,test_whispercpp}.py,
            tests/js/timeline-model.test.js
  Feature   word timings end-to-end (both engines), caption layouts
            (line/burst/word/custom) chosen on the command line or the API,
            POST /api/caption/{id}/resegment to re-cut without transcribing
  Interface: one added row in the caption editor (layout dropdown +
            Re-split); nothing moved or renamed, static/timeline.js untouched

Read CAPTIONS-WORD-LEVEL.md in this ZIP for the longer feature guide
(same style as TEXT-AND-FONTS.md / BROLL-AND-FONTS.md). That file is only
documentation - delete it if you don't want it in the project.
