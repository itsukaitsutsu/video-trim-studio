"""Export a single-video timeline with FFmpeg.

Video lanes work exactly like caption lanes: clips may overlap in time and
are auto-stacked onto free lanes, and the highest lane wins the picture.
`flatten_clips()` resolves the stack into one virtual track (trim/concat,
black gaps); gaps become black picture and silence, so captions keep the
editor's timeline times. Per-clip effects (transform, crop, opacity, volume,
fades) and keyframes (baked into short spans) come from vts/fx.py. The
encoder settings, orientation handling, hardware fallback and job progress
all come from export.py, exactly like the legacy deletion-based export.
"""

from __future__ import annotations

import os
import tempfile
import threading

from . import export as ex
from . import fx as fx_mod
from .ffprobe import encoder_candidates
from .media import display_size

PIX_FORMATS = {"yuv420p", "yuv422p", "yuv444p",
               "yuv420p10le", "yuv422p10le", "yuv444p10le"}


def _clip_track(clip: dict) -> int:
    try:
        return max(0, int(clip.get("track", 0)))
    except (TypeError, ValueError):
        return 0


def _base_video_chain(seg: int, src: float, d: float, eff: dict,
                      w: int, h: int, fps: float, pix_fmt: str,
                      parts: list[str]) -> str:
    """Append a V1 segment; return its output label."""
    chain = [f"[0:v]trim=start={src:.6f}:duration={d:.6f}", "setpts=PTS-STARTPTS"]
    crop_txt, cw, ch = fx_mod.crop_filter(eff, w, h)
    if crop_txt:
        chain.append(crop_txt)
    scale_txt, sw, sh = fx_mod.scale_filter(eff, cw, ch)
    if scale_txt:
        chain.append(scale_txt)
    needs_compose = bool(crop_txt or scale_txt or eff["x"] or eff["y"])
    if needs_compose:
        compose, _ = fx_mod.compose_to_frame(
            sw, sh, w, h, w * eff["x"] / 100.0, h * eff["y"] / 100.0)
        if compose:
            chain.append(compose)
    faded = fx_mod.video_fade_chain(eff, d, alpha=False)
    if faded:
        chain.append(faded)
    chain.append(f"fps={fps:.6f}")
    if eff["opacity"] < 100.0 - 1e-9:
        # Static transparency on the base track: flatten over black.
        chain.append("format=yuva420p")
        chain.append(f"colorchannelmixer=aa={eff['opacity'] / 100.0:.4f}")
        parts.append(",".join(chain) + f"[vs{seg}t]")
        parts.append(f"color=c=black:s={w}x{h}:r={fps:.6f}:d={d:.6f},"
                     f"format={pix_fmt}[vsbg{seg}]")
        parts.append(f"[vsbg{seg}][vs{seg}t]overlay=0:0:format=auto,"
                     f"format={pix_fmt},setsar=1[vs{seg}]")
    else:
        chain.append(f"format={pix_fmt}")
        chain.append("setsar=1")
        parts.append(",".join(chain) + f"[vs{seg}]")
    return f"[vs{seg}]"


def _micro_fade(d: float, fade_ms: int, at_in: bool, at_out: bool,
                user_in: float, user_out: float) -> str:
    """Short anti-click fade, skipped inside slices and under user fades."""
    out: list[str] = []
    span = min(fade_ms / 1000.0, d / 2.0)
    if fade_ms > 0 and span > 0:
        if at_in and user_in < 0.05:
            out.append(f"afade=t=in:d={span:.3f}")
        if at_out and user_out < 0.05:
            out.append(f"afade=t=out:st={max(0.0, d - span):.3f}:d={span:.3f}")
    return ",".join(out)


def _base_audio_chain(seg: int, src: float, d: float, eff: dict,
                      sample_rate: int, layout: str, fade_ms: int,
                      at_in: bool, at_out: bool, parts: list[str]) -> str:
    chain = [f"[0:a]atrim=start={src:.6f}:duration={d:.6f}",
             "asetpts=PTS-STARTPTS",
             f"aformat=sample_fmts=fltp:sample_rates={sample_rate}:"
             f"channel_layouts={layout}"]
    user = fx_mod.audio_chain(eff, d)
    if user:
        chain.append(user)
    micro = _micro_fade(d, fade_ms, at_in, at_out, eff["fade_in"], eff["fade_out"])
    if micro:
        chain.append(micro)
    parts.append(",".join(chain) + f"[as{seg}]")
    return f"[as{seg}]"


def flatten_clips(clips: list[dict]) -> list[dict]:
    """Resolve overlapping lanes into one virtual track (highest lane wins).

    Returns pieces sorted by start: {start, end, in, fx, kf, from}, with
    keyframes shifted to piece time. Adjacent pieces from the same clip are
    merged back together. Gaps are left out (the segment builder fills them
    with black picture and silence).
    """
    if not clips:
        return []
    bounds = sorted({round(float(c["start"]), 3) for c in clips}
                    | {round(float(c["end"]), 3) for c in clips})
    wins: list[tuple[float, float, dict]] = []
    for s, e in zip(bounds, bounds[1:]):
        if e - s < 1e-3:
            continue
        covering = [c for c in clips
                    if float(c["start"]) <= s + 1e-6 and float(c["end"]) >= e - 1e-6]
        if not covering:
            continue
        win = max(covering, key=lambda c: (_clip_track(c), float(c["start"])))
        wins.append((s, e, win))
    merged: list[tuple[float, float, dict]] = []
    for s, e, win in wins:
        prev = merged[-1][2] if merged else None
        same = (prev is not None and
                (prev is win or (win.get("id") is not None and
                                 prev.get("id") == win.get("id"))))
        if merged and same and abs(merged[-1][1] - s) < 1e-6:
            merged[-1] = (merged[-1][0], e, win)
        else:
            merged.append((s, e, win))
    out: list[dict] = []
    for s, e, win in merged:
        clip_start = float(win["start"])
        clip_len = float(win["end"]) - clip_start
        fx = fx_mod.clean_fx(win.get("fx"))
        kf = fx_mod.kf_for_piece(
            fx_mod.clean_keyframes(win.get("kf"), clip_len),
            s - clip_start, e - s)
        out.append({"start": s, "end": e,
                    "in": round(float(win["in"]) + (s - clip_start), 3),
                    "fx": fx, "kf": kf, "from": win.get("id")})
    return out


def build_filter(clips: list[dict], total: float, fps: float,
                 size: tuple[int, int], pix_fmt: str, sample_rate: int,
                 layout: str, fade_ms: int, has_audio: bool,
                 burn_srt: str | None = None) -> str:
    """One filter_complex: flattened lanes (trim/concat/gaps) + caption burn.

    Times are snapped to whole frames so video and audio segments stay the same
    length; every clip is trimmed from the same input, which FFmpeg splits for
    us, so repeated source ranges are fine. Animated clips (keyframes) are
    baked into short spans by vts/fx.slice_spans.
    """
    w, h = size
    total = max(float(total or 0.0),
                max((float(c["end"]) for c in clips), default=0.0))
    flat = flatten_clips(clips)
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

    for clip in flat:
        clip_len = float(clip["end"]) - float(clip["start"])
        fx = fx_mod.clean_fx(clip.get("fx"))
        kf = fx_mod.clean_keyframes(clip.get("kf"), clip_len)
        spans = fx_mod.slice_spans(fx, kf, clip_len)
        for i, (rel0, rel1, eff) in enumerate(spans):
            s_f = max(cursor, round((float(clip["start"]) + rel0) * fps))
            e_f = max(s_f + 1, round((float(clip["start"]) + rel1) * fps))
            if s_f > cursor:
                add_gap(s_f - cursor)
            d = (e_f - s_f) / fps
            src = float(clip["in"]) + rel0
            vlabel = _base_video_chain(seg, src, d, eff, w, h, fps, pix_fmt, parts)
            if has_audio:
                alabel = _base_audio_chain(seg, src, d, eff, sample_rate, layout,
                                           fade_ms, i == 0, i == len(spans) - 1,
                                           parts)
                labels.append(f"{vlabel}{alabel}")
            else:
                labels.append(vlabel)
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
    clips = sorted(clips, key=lambda c: (_clip_track(c), c["start"]))
    total = max(float(c["end"]) for c in clips)
    if total < 0.05:
        raise ex.JobError("The timeline is too short to export.")
    os.makedirs(os.path.dirname(os.path.abspath(output)) or ".", exist_ok=True)

    vinfo = info.get("video") or {}
    ainfo = info.get("audio") or {}
    has_audio = bool(ainfo)
    fps = float(vinfo.get("fps") or 0) or 30.0
    if not 1.0 <= fps <= 240.0:
        fps = 30.0

    # Stream copy only when the result is one untouched V1 range from the
    # start: stacked lanes and any clip effect force the frame-accurate path.
    pieces = flatten_clips(clips)
    single = pieces[0] if len(pieces) == 1 else None
    single_plain = (single is not None
                    and fx_mod.fx_is_default(single.get("fx"))
                    and not single.get("kf"))
    if (opts.get("mode") == "copy" and single_plain
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
        stacked = len(pieces) != 1 or len(clips) != 1
        fxed = any(not fx_mod.fx_is_default(c.get("fx")) or c.get("kf") for c in clips)
        reason = ("stacked lanes" if stacked else
                  ("clip effects / keyframes" if fxed else
                   "this edit list")) + " need frame-accurate rendering"
        opts = {**opts, "_mode_note": "Stream copy needs one plain clip that starts at 0 "
                                      "with no burned captions; " + reason +
                                      ", so this export was re-encoded."}
    pix = opts.get("pix_fmt") or vinfo.get("pix_fmt") or "yuv420p"
    if pix not in PIX_FORMATS:
        pix = "yuv420p"
    sample_rate = int(ainfo.get("sample_rate") or 48000) if has_audio else 48000
    layout = "mono" if has_audio and int(ainfo.get("channels") or 2) == 1 else "stereo"
    w, h = display_size(vinfo)
    graph = build_filter(clips, total, fps, (w, h), pix, sample_rate, layout,
                         int(opts.get("fade_ms", 30)), has_audio,
                         burn_srt=None)
    burn = opts.get("burn_srt")
    if burn:
        graph = graph.replace("[outv]", "[basev]")
        fonts = (":fontsdir=" + ex.escape_filter_path(opts["fonts_dir"])) if opts.get("fonts_dir") else ""
        graph += f";[basev]subtitles={ex.escape_filter_path(burn)}{fonts}[outv]"

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
