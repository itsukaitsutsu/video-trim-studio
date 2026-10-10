#!/usr/bin/env python3
"""Auto-Caption Video with faster-whisper - command line.

Turn any video into .srt / .vtt / .json captions, with optional burned-in
(hardsub) output. Works for 99 languages including Indonesian, Malay, Javanese
and English.

This is a thin CLI over `vts/transcribe.py`, the same engine the web UI's
"Auto-caption" card uses, so both produce identical files.

Install:
    python -m pip install -r requirements-caption.txt      # faster-whisper
    # ffmpeg is required as well (the app's setup already checks for it)

Examples:
    # Indonesian video -> Indonesian subtitles
    python auto_caption.py video.mp4 --language id --model large-v3

    # English video -> English subtitles
    python auto_caption.py video.mp4 --language en --model large-v3-turbo

    # Auto-detect the language
    python auto_caption.py video.mp4 --language auto --model large-v3

    # Indonesian audio -> English subtitles (translation)
    python auto_caption.py video.mp4 --language id --translate-to-english

    # Also burn the subtitles into a new video file
    python auto_caption.py video.mp4 --language id --model medium --burn
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from vts import transcribe as cap                      # noqa: E402

# Defaults, matching the original script's quick config.
DEFAULT_LANGUAGE = "id"
DEFAULT_MODEL = "medium"
DEFAULT_DEVICE = "cpu"
DEFAULT_BEAM_SIZE = 1
USE_VAD = True
WORD_TIMESTAMPS = True
TEMPERATURE_FALLBACK = False
NORMALIZE_AUDIO = False
TRANSLATE_TO_ENGLISH = False
BURN_SUBTITLES = False
KEEP_AUDIO = False


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Auto-caption a video with faster-whisper (99 languages). "
                    "Writes .srt, .vtt and .json next to the video by default.")
    p.add_argument("video", type=Path, help="Input video file")
    p.add_argument("--language", default=DEFAULT_LANGUAGE,
                   help=f"Audio language code: id, en, ms, jw, auto, ... (default: {DEFAULT_LANGUAGE})")
    p.add_argument("--model", default=DEFAULT_MODEL,
                   help="tiny / base / small / medium / large-v3 / large-v3-turbo "
                        f"(default: {DEFAULT_MODEL}; turbo is transcription-only)")
    p.add_argument("--translate-to-english", action="store_true",
                   default=TRANSLATE_TO_ENGLISH,
                   help="Translate any language to English subtitles")
    p.add_argument("--output-dir", type=Path, default=None,
                   help="Where to write .srt/.vtt/.json (default: next to the video)")
    p.add_argument("--burn", action="store_true", default=BURN_SUBTITLES,
                   help="Also render a .captioned.mp4 with burned-in subtitles")
    p.add_argument("--device", default=DEFAULT_DEVICE, choices=["auto", "cuda", "cpu"],
                   help=f"cuda / cpu / auto (default: {DEFAULT_DEVICE})")
    p.add_argument("--compute-type", default="auto",
                   help="CTranslate2 compute type: auto, int8, int8_float16, float16, float32")
    p.add_argument("--no-vad", action="store_true",
                   help="Disable Silero VAD preprocessing (VAD is on by default)")
    p.add_argument("--no-word-timestamps", action="store_true",
                   help="Disable word-level timestamps (faster, but no karaoke data)")
    p.add_argument("--no-normalize", action="store_true",
                   help="Disable loudness normalization for the transcription pass")
    p.add_argument("--normalize", action="store_true", default=NORMALIZE_AUDIO,
                   help="Enable loudness normalization (helps quiet recordings)")
    p.add_argument("--no-temp-fallback", action="store_true",
                   help="Disable temperature fallback; use deterministic temp=0 only")
    p.add_argument("--beam-size", type=int, default=DEFAULT_BEAM_SIZE,
                   help=f"Beam size 1-10 (default: {DEFAULT_BEAM_SIZE}; 1 = fastest)")
    p.add_argument("--initial-prompt", default=None,
                   help="Optional hint for names/jargon. Default is a generic "
                        "per-language hint.")
    p.add_argument("--keep-audio", action="store_true", default=KEEP_AUDIO,
                   help="Keep the extracted 16 kHz WAV next to the outputs")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    if not args.video.is_file():
        print(f"ERROR: input not found: {args.video}", file=sys.stderr)
        sys.exit(1)

    status = cap.dependency_status()
    if not status["available"]:
        print("ERROR: faster-whisper is not installed.", file=sys.stderr)
        print(f"Run:  {status['install']}", file=sys.stderr)
        sys.exit(1)
    try:
        cap.check_ffmpeg()
    except cap.CaptionError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    if (args.translate_to_english
            and args.model.casefold() in cap.TRANSLATION_UNSUPPORTED_MODELS):
        print(f"ERROR: {cap.translation_model_error(args.model)}", file=sys.stderr)
        sys.exit(2)
    if args.model == "large-v3-turbo" and args.language not in ("en", "auto"):
        print("NOTE: large-v3-turbo is weaker on non-English; consider "
              "--model large-v3 for Indonesian.", file=sys.stderr)

    opts = {
        "language": args.language,
        "model": args.model,
        "translate_to_english": args.translate_to_english,
        "device": args.device,
        "compute_type": args.compute_type,
        "vad": USE_VAD and not args.no_vad,
        "word_timestamps": WORD_TIMESTAMPS and not args.no_word_timestamps,
        "temperature_fallback": TEMPERATURE_FALLBACK and not args.no_temp_fallback,
        "normalize_audio": args.normalize and not args.no_normalize,
        "beam_size": args.beam_size,
        "initial_prompt": args.initial_prompt,
        "keep_audio": args.keep_audio,
        "burn": args.burn,
        "output_dir": str(args.output_dir) if args.output_dir else None,
    }
    device, compute = cap.pick_device_and_compute(opts["device"], opts["compute_type"])
    opts["device"], opts["compute_type"] = device, compute

    print(f"Input : {args.video.resolve()}")
    print(f"Output: {Path(opts['output_dir'] or cap.default_output_dir(str(args.video))).resolve()}/")
    print(f"        model={args.model} device={device} compute={compute} "
          f"language={args.language} task={'translate' if args.translate_to_english else 'transcribe'}")

    job = cap.start_caption(str(args.video), opts)
    job_id = job["id"]
    last_line = None
    shown = 0
    while True:
        state = cap.get_job(job_id)
        if state is None:
            print("ERROR: job disappeared.", file=sys.stderr)
            sys.exit(1)
        # Report each stage change (and any new note), not just the stage name:
        # several stages share the "loading model" note.
        line = (state["stage"], state.get("note") or "")
        if line != last_line:
            last_line = line
            if line[1]:
                print(f"  [{line[0]}] {line[1]}")
        # Print transcript lines as they arrive, like the original script.
        tail = state["tail"]
        while shown < len(tail):
            entry = tail[shown]
            pct = state["progress"]
            eta = f" ETA {cap.fmt_clock(state['eta'])}" if state.get("eta") else ""
            print(f"        [{pct:5.1f}%{eta}] [{entry['t']}] {entry['text'][:80]}")
            shown += 1
        if state["state"] != "running":
            break
        time.sleep(0.5)

    if state["state"] == "cancelled":
        print("Cancelled.", file=sys.stderr)
        sys.exit(130)
    if state["state"] == "error":
        print(f"ERROR: {state['error']}", file=sys.stderr)
        if state.get("traceback"):
            print(state["traceback"], file=sys.stderr)
        sys.exit(1)

    meta = state["meta"]
    outputs = state["outputs"]
    print(f"\n  {meta['segments']} segments · language {meta['language']} "
          f"({meta['language_probability']:.0%}) · {cap.fmt_clock(meta['transcribe_seconds'])} "
          f"on {meta['device']}")
    print("  Wrote:")
    for key in ("srt", "vtt", "json", "audio", "video"):
        if outputs.get(key):
            print(f"    {outputs[key]}")

    srt = outputs.get("srt", "")
    print("\nDone. Preview tips:")
    print(f"  VLC / MPV : open {args.video.name} + load {Path(srt).name}")
    print(f"  YouTube   : upload {Path(srt).name} as subtitles")
    if outputs.get("vtt"):
        print(f'  Web       : <track src="{Path(outputs["vtt"]).name}" kind="subtitles" '
              f'srclang="{meta["language"]}">')
    if not args.burn:
        print("  (rerun with --burn to render a .captioned.mp4)")


if __name__ == "__main__":
    main()
