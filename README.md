# Video Trim Studio

A small, local-first video editor built around the FFmpeg silence detection and subtitle workflow from the supplied scripts. It detects **silence** with FFmpeg and reads speech-caption timing from an **SRT or WebVTT file**. You review the labelled timeline, tick sections to remove, preview the cut, then export.

> **Your choice in this version:** captions can come from an existing `.srt` / `.vtt`, **or** be generated in-app from the video's audio with faster-whisper (the **Auto-caption** card, plus a matching `auto_caption.py` CLI). Silence detection is built in.

## What it does

- Local web UI with video preview, seekable timeline, filmstrip, waveform, section list, search, and cut-preview playback.
- Detects silence with FFmpeg `silencedetect`; splits the timeline into `caption`, `silence`, and `other audio` sections.
- Imports `.srt` / `.vtt` by file path or upload. Caption text and timestamps appear in the section list.
- **Auto-caption**: transcribes the open video with faster-whisper (99 languages, optional translation to English, optional word-level timestamps and burned-in copy) and feeds the result straight into detection. Optional dependency; the card shows the install command when it is missing.
- Selects sections by checkbox, click-and-drag down the checkbox column to paint
  a range, timeline click/drag, type, search, or bulk-select controls.
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

1. **Open a video**. Check the media details beside the path.
2. *(Optional)* In **Auto-caption**, press **Transcribe to captions** to generate `.srt`/`.vtt`/`.json` from the audio, then **Use these captions → Detect sections** to run detection with them. See [Auto-caption](#auto-caption-faster-whisper) for the options. New to it? Click **Speech demo** in the top bar — that clip contains a spoken sentence, whereas the main demo has only tones and silences.
3. In **Detect sections**, keep **Detect silence** enabled. Use the supplied script's `.srt`/`.vtt` in **Subtitle file**, or upload it. Click **Detect sections**.
   - `Threshold (dB)` controls the silence noise floor. `-45 dB` is a useful starting point. A *higher* value such as `-40 dB` detects more quiet audio as silence; a *lower* value such as `-50 dB` is stricter.
   - `Min silence` ignores short pauses. Start at 800 ms.
4. Review the section list/timeline. Red blocks are selected for deletion. Click or drag on the section row, tick checkboxes, filter by kind/search, or use bulk controls. **Selecting a caption section deletes its time range from the video**; it does not just hide the subtitle.
5. Turn on **Skip deleted parts while playing** to preview the cut.
6. Confirm the output path and export settings. Keep the output extension the same as the source (the app enforces this matching profile). Use **Re-encode (frame accurate)** for normal editing, then click **Export clean cut**.
7. The export is written to the chosen path. The source is never overwritten.

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

| Option | Notes |
| --- | --- |
| **Model** | `tiny`/`base` are fast, `medium` is the balanced default, `large-v3` is the most accurate and slow on CPU, `large-v3-turbo` is fast but weak outside English. |
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

Captions come from either an existing `.srt`/`.vtt` (select it in **Subtitle file**, or upload it) or from **Auto-caption**, which transcribes the audio with faster-whisper and writes the caption files for you. Word-level SRT cues can yield very small sections; the minimum-duration and minimum-section controls help keep the timeline manageable.

The generated `.srt` describes the **source** timeline. If you then cut parts out, the cue times no longer line up with the exported file - regenerate captions for the trimmed result, or keep the captions as a sidecar for the original.

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

The included tests cover SRT/VTT parsing, silence detection, timeline labels, export planning, source-profile arguments, real FFmpeg re-encoding/stream-copy, A/V timestamp and sync-safe fallback regressions, HTTP endpoints, media seeking, waveform and thumbnails, plus the auto-caption engine (writers, job lifecycle, burn-in, and a real speech-to-captions transcription when faster-whisper, a `flite`-capable ffmpeg and the model download are all available; otherwise that test skips itself).

```bash
python -m pip install -r requirements-dev.txt
python -m pytest tests/ -q
```

The tests require FFmpeg and FFprobe on `PATH` for the integration cases.

## Project structure

```text
server.py             FastAPI local server
auto_caption.py       CLI wrapper around the auto-caption engine
vts/                  FFprobe, detection, timeline assets, preview proxy, FFmpeg export,
                      faster-whisper auto-caption
static/               Browser UI (plain HTML/CSS/JS; no build step)
demo/                 18-second sample video + captions, and a short
                      spoken clip for the Auto-caption card
setup.bat, run.bat    Windows install/run helpers
requirements*.txt     Runtime and test Python packages
tests/                Unit, integration, and API tests
```

## Notes / limitations

- This is a focused cut editor, not a full nonlinear editor: no transitions, title cards, multitrack mixing, or visual effects.
- The waveform and filmstrip are generated locally when a video is opened; the first load takes a moment.
- The local app is designed for one user and one open project at a time.
- Export operates on the primary video stream and first audio stream. Extra audio tracks, embedded subtitle streams, and data streams are not currently carried into the clean output.
- The code is tested in a Linux FFmpeg environment using CPU H.264. AMF availability and performance depend on the FFmpeg build/AMD driver installed on your Windows PC.
