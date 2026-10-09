"""Export a single-video timeline with FFmpeg.

The graph is built from the clips in timeline order. Clips may repeat or
reorder the source (copy/paste), and gaps between clips become black picture
and silence, so captions can keep the editor's timeline times. The encoder
settings, orientation handling, hardware fallback and job progress all come
from export.py, exactly like the legacy deletion-based export.
"""

from __future__ import annotations

import os
import tempfile
import threading

from . import export as ex
from .ffprobe import encoder_candidates
from .media import display_size

PIX_FORMATS = {"yuv420p", "yuv422p", "yuv444p",
               "yuv420p10le", "yuv422p10le", "yuv444p10le"}


def build_filter(clips: list[dict], total: float, fps: float,
                 size: tuple[int, int], pix_fmt: str, sample_rate: int,
                 layout: str, fade_ms: int, has_audio: bool,
                 burn_srt: str | None = None) -> str:
    """One filter_complex: a trimmed segment per clip, black gaps, one concat.

    Times are snapped to whole frames so video and audio segments stay the same
    length; every clip is trimmed from the same input, which FFmpeg splits for
    us, so repeated source ranges are fine."""
    w, h = size
    parts: list[str] = []
    labels: list[str] = []
    cursor = 0          # output position in frames
    seg = 0

    def add_gap(frames: int) -> None:
        nonlocal seg
        d = frames / fps
        parts.append(f"color=c=black:s={w}x{h}:r={fps:.6f}:d={d:.6f},"
                     f"format={pix_fmt},setsar=1[vs{seg}]")
        if has_audio:
            parts.append(f"anullsrc=r={sample_rate}:cl={layout}:d={d:.6f},"
                         f"aformat=sample_fmts=fltp:sample_rates={sample_rate}:"
                         f"channel_layouts={layout}[as{seg}]")
            labels.append(f"[vs{seg}][as{seg}]")
        else:
            labels.append(f"[vs{seg}]")
        seg += 1

    for clip in sorted(clips, key=lambda c: c["start"]):
        s_f = max(cursor, round(clip["start"] * fps))
        e_f = max(s_f + 1, round(clip["end"] * fps))
        if s_f > cursor:
            add_gap(s_f - cursor)
        d = (e_f - s_f) / fps
        src = float(clip["in"])
        parts.append(f"[0:v]trim=start={src:.6f}:duration={d:.6f},"
                     f"setpts=PTS-STARTPTS,fps={fps:.6f},format={pix_fmt},"
                     f"setsar=1[vs{seg}]")
        if has_audio:
            a = (f"[0:a]atrim=start={src:.6f}:duration={d:.6f},"
                 f"asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:"
                 f"sample_rates={sample_rate}:channel_layouts={layout}")
            fade = min(fade_ms / 1000.0, d / 2)
            if fade_ms > 0 and fade > 0:
                a += (f",afade=t=in:d={fade:.3f},"
                      f"afade=t=out:st={max(0.0, d - fade):.3f}:d={fade:.3f}")
            parts.append(a + f"[as{seg}]")
            labels.append(f"[vs{seg}][as{seg}]")
        else:
            labels.append(f"[vs{seg}]")
        seg += 1
        cursor = e_f

    total_f = round(total * fps)
    if cursor < total_f:
        add_gap(total_f - cursor)

    vout = "[concatv]" if burn_srt else "[outv]"
    aflag = 1 if has_audio else 0
    outs = f"{vout}[outa]" if has_audio else vout
    parts.append("".join(labels) + f"concat=n={seg}:v=1:a={aflag}{outs}")
    if burn_srt:
        parts.append(f"[concatv]subtitles={ex.escape_filter_path(burn_srt)}[outv]")
    return ";".join(parts)


def export_timeline(source: str, info: dict, clips: list[dict],
                    opts: dict, output: str) -> dict:
    """Start the export of `clips` (dicts with start, end, in); returns the job."""
    if not clips:
        raise ex.JobError("The timeline has no video clips left to export.")
    clips = sorted(clips, key=lambda c: c["start"])
    total = max(c["end"] for c in clips)
    if total < 0.05:
        raise ex.JobError("The timeline is too short to export.")
    os.makedirs(os.path.dirname(os.path.abspath(output)) or ".", exist_ok=True)

    vinfo = info.get("video") or {}
    ainfo = info.get("audio") or {}
    has_audio = bool(ainfo)
    fps = float(vinfo.get("fps") or 0) or 30.0
    if not 1.0 <= fps <= 240.0:
        fps = 30.0

    # Stream copy only when the result is one untouched range from the start.
    single = clips[0] if len(clips) == 1 else None
    if (opts.get("mode") == "copy" and single is not None
            and single["start"] < 1e-3 and single["in"] < 1e-3
            and not opts.get("burn_srt") and not ex.has_display_transform(info)):
        dur = single["end"] - single["start"]
        fd, list_path = tempfile.mkstemp(suffix=".txt", prefix="vts_concat_")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            quoted = source.replace("'", "'\\''")
            f.write(f"file '{quoted}'\n")
            f.write(f"outpoint {dur:.3f}\n")
        job = ex._new_job("copy", output, dur)
        job["concat_list"] = list_path
        cmd = ex.build_copy_command(source, list_path, output, opts)
        threading.Thread(target=ex._watch, args=(job, cmd, dur, False), daemon=True).start()
        snap = ex.get_job(job["id"])
        snap["segments"] = 1
        return snap

    if opts.get("mode") == "copy" and not opts.get("_mode_note"):
        opts = {**opts, "_mode_note": "Stream copy needs one clip that starts at 0 with no "
                                      "burned captions, so this export was re-encoded."}
    pix = opts.get("pix_fmt") or vinfo.get("pix_fmt") or "yuv420p"
    if pix not in PIX_FORMATS:
        pix = "yuv420p"
    sample_rate = int(ainfo.get("sample_rate") or 48000) if has_audio else 48000
    layout = "mono" if has_audio and int(ainfo.get("channels") or 2) == 1 else "stereo"
    w, h = display_size(vinfo)
    graph = build_filter(clips, total, fps, (w, h), pix, sample_rate, layout,
                         int(opts.get("fade_ms", 30)), has_audio,
                         burn_srt=opts.get("burn_srt"))

    fd, script_path = tempfile.mkstemp(suffix=".txt", prefix="vts_filter_")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(graph)

    job = ex._new_job("reencode", output, total)
    if opts.get("_burn_ass_cleanup"):
        job["burn_ass"] = opts["_burn_ass_cleanup"]
    if opts.get("_mode_note"):
        job["note"] = opts["_mode_note"]
    elif ex.has_display_transform(info):
        job["note"] = ("Rotation/flip is baked into the picture; the export "
                       "carries no rotation tag.")
    job["filter_script"] = script_path
    hwaccel = opts.get("hwaccel") or "auto"
    cmd = ex.build_command(source, output, [], opts, script_path, has_audio, hwaccel)

    fallback_cmd = None
    fallback_codec = None
    codec = opts.get("codec", "")
    if codec.endswith(("_amf", "_nvenc", "_qsv", "_videotoolbox")):
        fallback_codec = next(
            (c["name"] for c in encoder_candidates(vinfo.get("codec"))
             if not c["hw"] and c["name"] != codec), None)
        if fallback_codec:
            fallback_opts = {**opts, "codec": fallback_codec, "hwaccel": "none"}
            fallback_cmd = ex.build_command(source, output, [], fallback_opts,
                                            script_path, has_audio, "none")

    threading.Thread(
        target=ex._watch_and_cleanup,
        args=(job, cmd, total, hwaccel in ("auto", "d3d11va", "cuda", "dxva2", "vaapi"),
              script_path, fallback_cmd, fallback_codec),
        daemon=True,
    ).start()
    snap = ex.get_job(job["id"])
    snap["segments"] = len(clips)
    return snap
