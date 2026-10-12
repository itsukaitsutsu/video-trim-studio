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

Files this drop does NOT include (because it is unchanged):
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


INCLUDED: the preview "blink" when the clip changes
---------------------------------------------------
A pre-existing bug, fixed here because this drop makes it obvious: cutting a
video at every caption section means a cut every second or two, and every cut
made the program monitor flash blank for a frame.

Why it happened (static/stage.js): the monitor keeps one <video> per *clip*.
At a cut, the outgoing clip's element is released to a pool - and stageRelease
cleared its .src - so the incoming clip had to load the file again. Until the
first frame was decoded there was nothing to paint: one blank frame, per cut,
and the same thing when you click another clip (any jump between clips swaps
the element the same way). Consecutive clips almost always come from the same
file, so that reload was pure waste.

The fix, two edits:

  stageAcquire()  prefer an idle layer that already holds the asset this clip
                  needs (it is decoded and buffered, so a clip change costs a
                  seek at worst)
  stageRelease()  keep rec.src when the layer goes back into the pool, so the
                  next clip does not re-assign .src and trigger a reload

Measured in this build, browser driving the bundled demo (18 s, 15 clips after
Detect sections), sampling the layer's own decoded frame on every animation
frame:

  clicking through clips        stock stage.js        with this drop
    switches sampled                   10                   10
    instants with no picture      9 of 10 switches      0 of 10
    frameless frames overall          3.7%                0.0%
  playing through the cuts
    <video> reloads                    9                    0
    blank frames in 12 s           32/743 (4.3%)         1/746 (0.1%)

static/index.html also bumps stage.js?v=1 -> ?v=2, so a browser cannot keep
the old cached script after you update.

If you apply the caption patch instead of copying files, this is included as
part of patches/caption-word-level.patch (it touches static/stage.js only,
nothing else).

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


TRANSCRIBING NO LONGER RE-SPLITS - AND NO SEGMENT IS EVER DROPPED
-----------------------------------------------------------------
Two bugs, both reported from a real 3:41 transcription. Both are fixed here.

1. "it defaults to re-split even when I don't want it"
   The caption layout defaulted to **Burst** in three places (the dropdown, the
   API model, the segmenter), so every transcription came out re-cut and a
   segment the recogniser gave no word timings for disappeared with it. The
   default is now **Engine segments (as transcribed)** everywhere:

       vts/segmenter.py   DEFAULT_PRESET = "engine"
       server.py          segment_preset = "engine"
       static/app.js      SEG_DEFAULT = "engine"

   Transcribe now gives you exactly what the model said, cue for cue. Burst /
   Line / One word at a time are one click away in the same dropdown - pick one
   and press Re-split (or pick one before transcribing). The dropdown is the
   whole story: whatever it shows is what a transcription produces.

2. "the next caption is missing" (a segment that had no word timings)
   A caption layout can only build captions out of *words*. When the engine
   returned a segment without word timings (faster-whisper drops them for some
   segments; whisper.cpp omits a token's timing when the model cannot align it),
   that segment was left out of the word list - and with Burst or One-word as
   the default, its text was silently deleted from the captions:

       segments in : [has words] [NO word timings] [has words]
       burst out   : Hello there / everyone /            / Goodbye      <- lost

   Fixed in two layers:
     * `vts/transcribe.py` - build_cues() now hands the segments to
       `segmenter.segment_cues()`, the one place that estimates words for a cue
       that has none. A segment without word timings keeps its text and its
       place, marked `estimated` (word_source), and the rest of the transcript
       keeps the engine's real timings.
     * `vts/whispercpp.py` - an untimed token's text now rides on the next word
       (or the previous one, if the segment ends there) instead of being
       discarded.

   Measured through the API with a cue list shaped exactly like a bad run:

       burst   7 cue(s): First caption has | words | The engine gave |
                          no word timings | here | Last caption has | words
       word   15 cue(s): ... The | engine | gave | no | word | timings | here ...

   The middle caption used to be gone in both.

Re-check your 3:41 video: transcribe it again and the editor should list one
cue per recogniser segment. If a caption is still missing at 3:10, send the
.json sidecar the run wrote (or the two cue times around the gap) - that has
the engine's own segments in it, and it will say whether the caption was never
produced or produced and then moved.

JAPANESE / CHINESE / KOREAN: words need a dictionary (read this)
-----------------------------------------------------------------
Japanese and Chinese are written without spaces, and Whisper + whisper.cpp
return them as a stream of per-character tokens. Latin languages carry their
word boundaries in the text (the spaces); those two do not, so "words" there
can only come from a vocabulary. There is no way around that - guessing word
boundaries between characters is how you get "面白かっ / た".

So this drop now uses a dictionary when there is one, and stays honest when
there is not:

  * **with a dictionary** (optional, offline, one pip command):
        python -m pip install sudachipy sudachidict_core      # Japanese
        python -m pip install jieba                           # Chinese
    Re-split cuts Japanese at real word boundaries, particles glued to the
    word in front of them (that is how Japanese subtitling breaks lines).

  * **without one**: nothing changes, nothing breaks - text without spaces is
    cut per character. Usable for short-form captions, just not correct words.
    The caption card says so in its status line, with the install command.

Nothing is downloaded behind your back and no network call is made: the
dictionary is a local file, exactly like the Whisper model.

Measured on a 3-line Japanese .srt (49 characters) through the web UI:

                                    Re-split -> "Burst - 3 words" / "One word"
    no dictionary                   17 captions of 3 characters   / 43 of 1
    Sudachi (sudachipy + dict)       6 real captions              / 11 real words

    no dictionary  burst   こんに / ちは世 / 界。 / 今日は / いい天 / 気です ...
    no dictionary  word    こ / ん / に / ち / は / 世 / 界。 ...
    Sudachi        burst   こんにちは世界。 / 今日はいい天気ですね。 / 東京は晴れです。 ...
    Sudachi        word    こんにちは / 世界。 / 今日は / いい / 天気ですね。 ...

The same dictionary is used on every path that carries words, so it does not
matter where your captions came from:

  * `.srt` / `.vtt` import and typed cues  -> words are re-cut from the text
  * whisper.cpp (`-ojf` tokens)            -> tokens recut onto words, and the
                                              engine's own timings are kept
  * faster-whisper                         -> same, per segment
  * editing a Japanese caption's text      -> timings survive (before, an edit
                                              threw the word timings away)
  * "Engine segments" preset               -> cue boundaries stay exactly as
                                              the recogniser drew them, but the
                                              words inside them are real words

Details: 文節-style units - a particle, an auxiliary verb or a suffix is glued
to the word before it (昨日の / 試合は / 面白かったです。), because "面白かっ"
and "た" are two correct dictionary words and one terrible caption. Conjunctions
(でも, しかし) stay their own unit. For Japanese the analyzer runs in its
"short unit" mode; ``いい`` is *not* glued even though its tag says it could be.

Provider order (first installed wins): sudachipy+sudachidict_core (recommended:
0.1 s to load, ~50 MB, memory-mapped), then janome (pure Python, no compiler),
and jieba for Chinese. Which one is in use is visible at ``/api/env`` under
``words``.

Tip for whisper.cpp users: ``--dtw`` on the CLI (or ``"dtw": true`` in the API)
switches word alignment from the default heuristic to DTW, which is noticeably
better for Japanese word *timings*. Needs a whisper.cpp build with --dtw.

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
  New       vts/segmenter.py, vts/morph.py (dictionary word segmentation),
            tests/test_segmenter.py, tests/test_morph.py
  Fixed     Transcribing applied "Burst" by default (now "Engine segments" -
            see above); a segment without word timings was silently dropped by
            every re-split layout; whisper.cpp untimed tokens lost their text.
  Fixed     Japanese/Chinese/Korean captions could not be re-split: real words
            with a dictionary installed (vts/morph.py), per-character without
            one. Also fixed: editing a Japanese caption used to drop its word
            timings.
  Changed   auto_caption.py (--layout and friends), server.py,
            vts/{transcribe,whispercpp,captions,captionmap,timeline}.py,
            static/{timeline-model.js,stage.js,app.js,index.html,style.css},
            tests/{test_caption,test_whispercpp}.py,
            tests/js/timeline-model.test.js
  Fixed     program monitor flashing blank at every cut / clip change
            (stage.js: reuse the pooled layer instead of reloading the file)
  Feature   word timings end-to-end (both engines), caption layouts
            (line/burst/word/custom) chosen on the command line or the API,
            POST /api/caption/{id}/resegment to re-cut without transcribing
  Interface: one added row in the caption editor (layout dropdown +
            Re-split); nothing moved or renamed, static/timeline.js untouched

Read CAPTIONS-WORD-LEVEL.md in this ZIP for the longer feature guide
(same style as TEXT-AND-FONTS.md / BROLL-AND-FONTS.md). That file is only
documentation - delete it if you don't want it in the project.
