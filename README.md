# Video Trim Studio

A small, local-first video editor built around the FFmpeg silence detection and subtitle workflow from the supplied scripts. It detects **silence** with FFmpeg and reads speech-caption timing from an **SRT or WebVTT file**. You review the labelled timeline, edit it like a simple video editor (cut, copy, paste, move, trim, undo), preview it, then export.

> **Your choice in this version:** captions can come from an existing `.srt` / `.vtt`, **or** be generated in-app from the video's audio with faster-whisper (the **Auto-caption** card, plus a matching `auto_caption.py` CLI). Silence detection is built in.

## What it does

- Local web UI with a video preview, a multi-row timeline (the video on V1 plus stacked caption lanes), filmstrip, waveform, clip list, search, and timeline playback.
- Detects silence with FFmpeg `silencedetect`; splits the timeline into `caption`, `silence`, and `other audio` sections.
- Imports `.srt` / `.vtt` by file path or upload and places the cues on the timeline, so they follow the cuts. Edit a caption on the timeline by double-clicking it, or edit a section's text in the clip list (the matching caption follows).
- **Auto-caption**: transcribes the open video with faster-whisper (99 languages, optional translation to English, optional word-level timestamps and burned-in copy) and feeds the result straight into detection. Optional dependency; the card shows the install command when it is missing. Results are fully **editable** in-app (text + timings, add/delete cues), and you can also start from a blank set or an existing `.srt`/`.vtt` without faster-whisper.
- Selects clips by click, Shift/Ctrl-click, rubber band, or the clip list checkboxes, and edits them with split, move, trim, cut, copy, paste, ripple delete, and undo/redo (see Typical workflow).
- Press **Space** to play/pause the video preview (except while typing or when a
  checkbox/control has keyboard focus).
- Exports with source-informed defaults: same container extension, resolution, frame rate when constant, pixel format, video codec family, target video bitrate, colour tags, audio codec where supported, audio bitrate, sample rate and channel count.
- **Frame-accurate re-encode** is the default. Stream copy stays fast for a single end-trim; cuts that need a seek or segment join automatically re-encode to prevent audio/video timestamp drift.
- GPU encoder is preferred if the local FFmpeg build exposes it; otherwise it uses a CPU encoder. If hardware decoding fails, it retries with CPU decoding; if the hardware encoder itself fails, it retries with a matching CPU encoder when available.
- No account, cloud API, or network service required. Your media stays on your PC when you run it locally.

## Requirements

### Windows (recommended for your PC)

- Windows 10/11, 64-bit.
- **Python 3.10 or later** (Python 3.11 recommended).
- **FFmpeg and FFprobe** installed and available on `PATH`.
- Around 1 GB of free disk space for Python packages, temporary work and output; more for the video itself.
- **8 GB RAM minimum; 16 GB is fine** for typical 1080p work. Keep additional free space for source, output and temporary data.

### Your hardware

Your **RX 6600 XT + i7-10700F + 16 GB RAM** is suitable for this app:

- Silence analysis is a light FFmpeg audio pass; it does not need a powerful GPU.
- The RX 6600 XT can use FFmpeg's **AMD AMF** H.264/H.265 encoder on Windows, when the installed FFmpeg build and AMD driver expose `h264_amf` / `hevc_amf`. This helps exports run faster.
- The i7-10700F can use `libx264` if AMF is unavailable; CPU export works but will take longer.
- This build does **not** require CUDA or an NVIDIA GPU. Auto-captioning is an optional extra: it runs on CPU (`int8`) here and downloads the Whisper model you pick.
- Want GPU transcription? NVIDIA cards use faster-whisper with CUDA, AMD cards use whisper.cpp with Vulkan — step-by-step for both in [GPU transcription setup](#gpu-transcription-setup--nvidia-cuda-and-amd-vulkan).
- 16 GB is reasonable for normal 1080p footage. Very long, high-resolution/high-frame-rate projects may take longer and benefit from closing other applications.

To confirm AMF is available on the PC where you will run the app, open a new terminal after installing FFmpeg and run:

```bat
ffmpeg -hide_banner -encoders | findstr /i amf
```

If it lists `h264_amf` / `hevc_amf`, the app will offer them. If it does not, choose `libx264`; the editor still works.

## Install and run (Windows)

1. Install Python 3.11 from [python.org](https://www.python.org/downloads/windows/) and enable **Add Python to PATH**.
2. Install FFmpeg. In PowerShell or Command Prompt:

   ```bat
   winget install --id Gyan.FFmpeg
   ```

   Close that terminal and open a new one. Check `ffmpeg -version` and `ffprobe -version` both work.
3. Extract this project folder somewhere writable.
4. Double-click **`setup.bat`** once. It creates a project virtual environment and installs the Python packages.
5. Double-click **`run.bat`**. Leave the console window open and visit **<http://127.0.0.1:8765>**.
6. Click **Open demo** to try the included clip, or paste a video path / use **Browse** / **Upload** to open your own video.

The app binds to `127.0.0.1` by default, so it is only available on your PC. Do not change it to `0.0.0.0` unless you intentionally want other devices on your network to access it.

## Typical workflow

1. **Open a video.** Check the media details beside the path.
2. *(Optional)* Transcribe with **Auto-caption** (below), or load an `.srt` / `.vtt` in **Detect sections → Subtitle file**.
3. **Detect sections.** Silence and caption sections become clips on the **V1** row, and the captions go onto the caption lanes. Detection replaces the current timeline, and Ctrl+Z brings the old one back. The threshold and minimum-silence controls work as before.
4. **Edit the timeline.** All times are timeline seconds, and the preview plays the timeline.
   - **Select:** click a clip or caption. Shift/Ctrl-click adds or removes one. Drag on empty space to rubber-band select. Ctrl+A selects all, and Esc clears.
   - **Cut:** **Ctrl+K** (or **split**) splits the selection, or everything, at the playhead. Drag a clip edge to trim it. The edge stops at the neighbouring clips and at the start or end of the source.
   - **Move:** drag a clip or caption. A clip overwrites whatever it lands on, and a caption moves to a free lane if its lane is taken. Alt-drag copies instead.
   - **Remove:** **Delete** (or **delete**) leaves a gap. **Shift+Delete** (or **ripple delete**) closes the gap on every track, and the captions follow the picture.
   - **Copy / cut / paste:** Ctrl+C, Ctrl+X, and Ctrl+V paste at the playhead, overwriting. Ctrl+Shift+V inserts and pushes the later items along.
   - **Captions:** **+ caption** adds one at the playhead, and **+ lane** adds a caption lane to stack captions. Double-click a caption to edit its text. On the preview (burn mode), the caption box still drags and resizes as before.
   - **Undo / redo:** Ctrl+Z, Ctrl+Shift+Z, or Ctrl+Y. The edit list is saved while the app runs, so a page refresh keeps it.
   - **Playback:** Space plays the timeline. Left and Right step one frame, and Shift+arrows move one second. Gaps show black.
   - **Clip list:** it selects the same clips, with tick boxes, shift-click ranges, the filters, and **remove selected** (which closes the gaps).
5. **Export.** Set the output path and profile, then click **Export clean cut**. Clips are written in timeline order, gaps become black with silence, and captions use the timeline times. The source is never overwritten.
6. *(Optional)* In the export card, write the captions as an `.srt` next to the export, burn them into the picture, or both. Burning uses the caption box layout you set on the preview.

## Auto-caption (faster-whisper)

The **Auto-caption** card transcribes the open video's audio and writes three
files next to it (or into **Output folder** if you set one):

```text
video.srt   ready for YouTube / VLC / editing, and for this app's detection
video.vtt   for HTML5 <video> and web players
video.json  segments + word-level timestamps (karaoke / TikTok style)
video.captioned.mp4   only with "burn into a copy"
```

Install the optional engine once, **into the same Python that runs the app**:

```bash
python -m pip install -r requirements-caption.txt
# or, explicitly, using the interpreter the app reports:
#   .venv\Scripts\python.exe -m pip install faster-whisper      (Windows, run.bat)
#   .venv/bin/python -m pip install faster-whisper              (Linux/macOS)
```

The card stays visible without it and prints the exact command for the running
interpreter, so the mismatch that causes most "I installed it and it still says
missing" reports (a system-wide `pip install` while the app runs from `.venv`)
is easy to spot. After installing, press **Re-check** on the card — the package
is imported lazily, so no restart is needed; only restart if the command itself
failed.

The first transcription also downloads the chosen model (75 MB for `tiny`,
~1.5 GB for `medium`) into the HuggingFace cache; later runs reuse it.

**Slow connection? Download the model manually** — full link tables for both
engines are in [`MODEL-DOWNLOAD.md`](MODEL-DOWNLOAD.md). There are no
CUDA-specific files — the same four files serve both CUDA and CPU. Grab them from
`https://huggingface.co/Systran/faster-whisper-<model>` (or the same path on
the `hf-mirror.com` mirror): `model.bin`, `config.json`, `tokenizer.json`,
`vocabulary.txt`, and put all four into `work/fw-models/<model name>/` (e.g.
`work/fw-models/medium/`). The app then loads from that folder and skips the
automatic download entirely.

| Option | Notes |
| --- | --- |
| **Model** | `tiny`/`base` are fast, `medium` is the balanced default, `large-v3` is the most accurate and slow on CPU, `large-v3-turbo` is nearly as accurate and much faster (multilingual, incl. Indonesian). |
| **Language** | 99 codes plus *Auto-detect*. `id`, `ms`, `jw`, `en`, … |
| **Translate to English** | Any spoken language into English subtitles (Whisper's `translate` task). |
| **Device / compute type** | `auto` uses CUDA when CTranslate2 sees a GPU, otherwise CPU `int8`. An RX 6600 XT is CUDA-less, so it runs on CPU; low-VRAM CUDA setups can pick `int8_float16`. |
| **VAD** | Silero voice-activity filter; skips silence, reduces hallucinations, faster. |
| **Word timestamps** | Adds per-word timings to the JSON (about 10% slower). |
| **Temperature fallback** | Retries hard segments at higher temperature. Off by default: deterministic decoding was found more accurate on these videos. |
| **Normalize audio** | `loudnorm` pass for quiet or uneven recordings. Off by default, same reason. |
| **Hint / prompt** | Names or jargon the model should expect. Left empty, a generic per-language hint is used. |
| **Burn into a copy** | Renders `video.captioned.mp4` with hardsubs. The source file is never touched, and the copy keeps the source's orientation (rotation/flip is baked into the pixels, matching exports). |

While it runs, the card shows the stage, progress, `x` realtime speed, ETA and
the last transcript lines. **Cancel transcription** stops it at the next
segments boundary. **Use these captions → Detect sections** then runs the
normal detection with the generated captions, and the subtitle path is filled in
so a plain **Detect sections** works too.

### GPU transcription setup — NVIDIA (CUDA) and AMD (Vulkan)

Which engine you use depends on your graphics card:

| Your GPU | Engine | Acceleration |
| --- | --- | --- |
| NVIDIA (GTX/RTX) | faster-whisper | CUDA |
| AMD Radeon (RX 5000/6000/7000…) | whisper.cpp | Vulkan |
| No GPU / Intel iGPU | either | CPU (whisper.cpp is usually the faster of the two) |

faster-whisper runs on CTranslate2, whose pip builds only support **CPU and
NVIDIA CUDA** — an AMD card cannot be used by it. That is why the caption card
has an **Engine** switch, and why AMD users get their GPU speed through
whisper.cpp's Vulkan backend instead.

#### NVIDIA — CUDA with faster-whisper

1. Install the engine into the same Python that runs the app:
   `python -m pip install -r requirements-caption.txt`
2. Install the NVIDIA libraries CTranslate2 needs: **cuBLAS for CUDA 12** and
   **cuDNN 9 for CUDA 12**.
   - Easiest on Windows: one archive with both libraries from
     [Purfview's whisper-standalone-win releases ("libs")](https://github.com/Purfview/whisper-standalone-win/releases/tag/libs)
     — decompress it and put the folder on your `PATH`.
   - Official alternative: CUDA 12 toolkit + cuDNN 9 from nvidia.com.
3. Restart the app. The Auto-caption card's note should now say
   *N CUDA device(s) detected*; leave Device on `auto` (it picks CUDA with
   `float16`). If CUDA fails at run time, the job automatically falls back to
   CPU and says so.
4. Models download automatically on first run. If HuggingFace is slow for you,
   download the four files (`model.bin`, `config.json`, `tokenizer.json`,
   `vocabulary.txt`) from `https://huggingface.co/Systran/faster-whisper-<name>`
   (or the same path on `hf-mirror.com`) into `work/fw-models/<name>/` — the
   app prefers that folder and skips the automatic download. The files are
   identical for CUDA and CPU.
5. Version mismatch? Current CTranslate2 wants CUDA 12 + cuDNN 9. For
   CUDA 12 + cuDNN 8 pin `pip install ctranslate2==4.4.0`; for CUDA 11 use
   `ctranslate2==3.24.0` (see the faster-whisper README for details).

#### AMD — Vulkan with whisper.cpp

1. **Get a Vulkan-enabled `whisper-cli`** — pick one:
   - *Prebuilt (easiest on Windows, no compiler):* download
     [`whispercpp-v1.8.5-windows-x64.zip`](https://github.com/CryptoKey98/whispercpp-vulkan-runtime/releases)
     (built from official whisper.cpp sources; needs only your AMD driver —
     the Vulkan runtime ships with it — and the VC++ x64 redistributable).
   - *Build it yourself (Windows/Linux):* install CMake, a C++ compiler and
     the Vulkan SDK, then in a clone of
     [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp):
     `cmake -B build -DGGML_VULKAN=ON` then
     `cmake --build build --config Release`.
2. **Make it visible to the app:** put `whisper-cli` (plus the `.dll` files
   next to it) into `<app>/tools/`, or add it to PATH, or set `VTS_WHISPER_CLI`
   to its full path. The card's status line confirms when it's found.
3. **Get a GGML model:** use the card's Download button, or put
   `ggml-<name>.bin` into `work/whisper-models/` yourself (links in
   `MODEL-DOWNLOAD.md`). Recommended: `ggml-large-v3-turbo.bin` for daily use,
   `ggml-large-v3.bin` for max accuracy.
4. **Engine → whisper.cpp**, pick the model, transcribe. When the GPU is doing
   the work the job output mentions Vulkan and the app reports
   `backend: vulkan`; Task Manager's GPU meter should climb. A binary built
   without Vulkan still works — on CPU, which is often faster than
   faster-whisper on CPU.

#### Good to know (both engines)

- Everything downstream is shared: same outputs (`.srt/.vtt/.json`), editable
  cues, burn-in and section detection.
- The burned captions keep the preview's position/size/alignment, including
  for rotated (portrait phone) footage: the burn is computed in the displayed
  orientation, not the coded stream dimensions.
- Model files are **not interchangeable**: whisper.cpp reads one GGML `.bin`
  per model (`work/whisper-models/`), faster-whisper reads a four-file
  CTranslate2 folder (`work/fw-models/<name>/`). You only need the files for
  the engine you actually use — no need to download a model twice.
- The engine uses long-form CLI flags only, which are stable across
  whisper.cpp releases.

### Caption timeline (stacking, tracks, per-caption style)

The timeline draws the video clips on the V1 row, with the captions on caption
lanes below them (like CapCut / Kdenlive):

- **click** a block to select it, **drag** to move it in time, drag its
  **edges** to trim, drag **up/down** to put it on another lane (a free lane is
  used when the lane is taken). Overlapping blocks on different lanes = several
  captions on one frame.
- **+ caption** adds a 2 s caption at the playhead, **split** (Ctrl+K) cuts the
  selection at the playhead, **delete** (Delete) removes it and leaves a gap, and
  **ripple delete** (Shift+Delete) also closes the gap. **snap** sticks drags to
  the playhead and neighbouring edges.
- Every caption keeps its **own position/size/alignment**: select it and the
  drag/resize/align/font tools (and the draggable preview box) edit just that
  caption. The preview shows all captions on the current frame at once, in
  their own styles, and the export burns exactly that (one positioned ASS
  Dialogue per caption - overlaps included).
- The block, the preview boxes, the clip list and the burn all update together
  after each edit. Timeline edits are saved with the project, not written back
  to the subtitle file (see Captions).
- Ctrl+wheel zooms; drag on empty space to rubber-band select clips and captions.

### Editable captions

Whisper is not perfect, so every caption set is editable in the card:

- After a transcription finishes (or after opening/creating a set — below),
  the **Caption editor** lists every cue with its start/end times (seconds)
  and text. Fix the wording, nudge the timings, **+ Add cue**, or delete rows,
  then press **Save captions**: the `.srt`/`.vtt`/`.json` files are rewritten
  on disk, so detection and a later re-run see the corrected text.
- **New blank captions** — write subtitles by hand; needs no faster-whisper at
  all, so it also works for videos without an audio track.
- **Open .srt / .vtt…** — load an existing subtitle file into the editor (a
  file next to the video is offered automatically).
- **Use these captions → Detect sections** saves any pending edits first, so
  detection always works from the latest text.

Notes: saving sorts cues by start time and trims text; after an edit the
`.json` holds the edited cue list (word-level timestamps come from the
transcription and are replaced once you edit). The editor works on the source
timeline, like the transcription itself.

### Command line

`auto_caption.py` drives the same engine for batch or scripted use:

```bash
python auto_caption.py video.mp4 --language id --model large-v3
python auto_caption.py video.mp4 --language en --model large-v3-turbo
python auto_caption.py video.mp4 --language auto --model large-v3
python auto_caption.py video.mp4 --language id --translate-to-english
python auto_caption.py video.mp4 --language id --model medium --burn
```

Flags mirror the card: `--output-dir`, `--device`, `--compute-type`, `--no-vad`,
`--no-word-timestamps`, `--normalize`, `--no-temp-fallback`, `--beam-size`,
`--initial-prompt`, `--keep-audio`.

Notes:

- Transcription runs entirely on this machine; nothing is uploaded.
- A video without an audio track is rejected with a clear message.
- The `.srt` refers to the **source** timeline. After a trim, cue times no longer
  match the exported file unless you regenerate captions for it.

## Export: what “same as source” means

A clean edit changes timestamps and requires the kept sections to be joined. In the default **re-encode** mode, FFmpeg uses the source's container/extension, dimensions, constant frame rate (when detected), pixel format, source video codec family, measured video bitrate as the target, colour tags, and compatible audio parameters where available. You can override codec, bitrate/CRF, preset, pixel format, decoder, audio parameters and a few metadata/colour options.

This preserves the *format settings* as closely as possible; it cannot preserve the original encoded video bit-for-bit. The chosen bitrate is a target, so the output's measured average may differ. A short audio fade is added at cuts to avoid clicks.

**Stream copy** is lossless and quick only when the kept footage is one continuous range starting at the beginning and the source timestamps also start at zero (for example, trimming off the end). A start seek, non-zero source timestamps, joining multiple kept sections, or a source rotation/flip display tag can make a copy unsafe or impossible. Those cases automatically fall back to the selected re-encode profile; the job details explain when this happens. Re-encoding is slower and is not bit-for-bit lossless.

**Orientation.** Phone videos usually store the picture sideways and rely on a rotation/flip display tag, which plenty of players and editors ignore. Every export applies that transform to the pixels and writes no rotation tag, so the result looks exactly like the preview everywhere. A typical portrait clip therefore exports as a portrait file with swapped stored dimensions instead of a landscape file that depends on a tag. Because a stream copy cannot change pixels, a tagged source always re-encodes rather than being copied.

The source's original stream/container may contain features that need manual adjustment (for example unusual codecs or HDR metadata). Always play and inspect the exported file before deleting the original.

## Captions

Captions are items on the timeline. Each caption lane (T1, T2, …) holds one row of non-overlapping captions, so stacked lanes show overlapping captions. Captions follow the video when clips are removed with ripple delete.

- **Where they come from:** Detect sections with *Use captions* ticked, or **Use these captions → Detect sections**, places the cues on the timeline. A cue in removed time is dropped, and a cue that crosses a cut is split.
- **Where edits go:** timeline edits (text, timing, lanes, style) are saved with the project. They do **not** rewrite the subtitle file. The caption card's **Save captions** still rewrites the transcription's `.srt` / `.vtt` / `.json` files from its own cue list.
- **Export:** the `.srt` uses the exact timeline times of the exported video. Burning re-encodes, even in stream-copy mode.

## Browsing for a file

The **Browse…** dialog walks your filesystem, and on Windows it can reach every
drive — not just `C:`. Because Windows has no single root (`C:\` is its own
top), the dialog adds a virtual **This PC** level above the drive roots: from
`C:\` the Up row goes there, and `💽 D:`, `💽 E:`, USB sticks and mapped network
drives are also listed as a quick jump from *any* folder, so you never have to
walk up to switch drives.

Hidden entries and the Windows system folders at a drive root
(`$Recycle.Bin`, `System Volume Information`, …) are skipped, and an entry that
refuses to be read is passed over instead of blanking the whole listing.

## Preview playback

Browsers can only play a few container/codec combinations. AVI, MPEG-TS, WMV,
FLV, MPEG-PS, DivX/Xvid video and AC3/DTS audio all download correctly over
HTTP yet still render as a black box, because the *browser* refuses to demux or
decode them — nothing is wrong with the file or the server.

So when you open a file the browser cannot play, the server builds a small
H.264/AAC MP4 **preview proxy** (max 1280 px wide) in `work/preview/` and the
player uses that. It prefers a supported hardware H.264 encoder (AMD AMF,
NVIDIA NVENC, Intel QSV, or macOS VideoToolbox), falling back to the fast
`libx264` CPU preset if hardware encoding is missing or cannot initialize. The
progress message also reports encoder speed and a rough remaining-time estimate
when FFmpeg provides them. Waveform and filmstrip generation wait until a
required proxy is ready, avoiding several simultaneous full-file scans.

- The proxy is only for on-screen scrubbing. **Detection and export always use
  your original file**, so preview speed/quality settings do not affect export.
- It is cached per file (keyed by size and modification time), so reopening the
  same video is instant.
- HEVC/AV1 usually *can* play natively when your OS has a hardware decoder, so
  those are served directly first; if the browser still produces no frames the
  proxy is built automatically.
- A CPU-only build needs `libx264`; the Windows Gyan build and `apt install
  ffmpeg` normally include it. A hardware encoder also needs a compatible
  FFmpeg build and working driver. If it fails to initialize, the app tries
  `libx264` instead.

## Linux / macOS

Install Python 3.10+, FFmpeg and FFprobe using your package manager, then from the project directory:

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python server.py
```

Open <http://127.0.0.1:8765>. AMD AMF is primarily available with an appropriate FFmpeg/driver setup on Windows; on systems without a compatible hardware encoder, use `libx264`.

## Tests

```bash
python -m pip install -r requirements-dev.txt
python -m pytest tests/ -q                 # API, export, caption, and timeline tests
node --test tests/js/                      # timeline editing rules (Node 18+)
```

The browser test drives the editor with a real mouse and keyboard. It needs Playwright and Chromium:

```bash
python -m pip install playwright
python -m playwright install chromium      # on Linux also: python -m playwright install-deps chromium
python -m pytest tests/test_timeline_ui.py -q
```

The integration tests need FFmpeg and FFprobe on `PATH`. The timeline export tests check the real output: repeated and reordered clips, black gaps, stream copy, and burned captions.

## Project structure

```text
server.py                  FastAPI local server
auto_caption.py            CLI wrapper around the auto-caption engine
vts/                       FFprobe, detection, timeline validation (timeline.py),
                           timeline export (edl.py), FFmpeg export, preview proxy,
                           faster-whisper auto-caption
static/timeline-model.js   pure editing rules: split, move, trim, ripple, paste, undo data
static/timeline.js         timeline canvas, mouse and keyboard, playback, clip list,
                           detection and export glue
static/app.js              open and browse, caption card, caption box, export options
static/                    index.html and style.css (plain HTML/CSS/JS; no build step)
demo/                      18-second sample video + captions, and a short spoken clip
setup.bat, run.bat         Windows install/run helpers
requirements*.txt          Runtime and test Python packages
MODEL-DOWNLOAD.md          Manual model download links (faster-whisper + GGML)
tests/                     Unit, integration, API, browser, and timeline tests
tests/js/                  Node tests for the timeline editing rules
```

## Notes / limitations

- **One video per project.** There is no B-roll, no second video or audio file, and no picture-in-picture. Stacking applies to caption lanes; the picture is a single track.
- **Audio belongs to its video clip.** There are no separate audio tracks, per-clip volume, or keyframes. The only fade is the short one at each cut.
- **No transitions, titles** (beyond captions), or visual effects.
- **Gaps** between clips export as black picture and silence. Captions after the end of the last clip are dropped at export.
- **The edit list lives in the running server.** It is restored on a page refresh, but opening another video starts a new timeline and a server restart clears it, so export a finished cut before stopping the app.
- **The preview** plays the timeline with the browser's video player, so it can hitch at cuts and gaps. The exported file is the reference.
- Export still uses the primary video stream and the first audio stream.
