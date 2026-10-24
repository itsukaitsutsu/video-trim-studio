"""Export a multi-track timeline with FFmpeg.

Tracks **composite**. Every clip is trimmed from its own source (an asset in
the media bin), transformed, and overlaid onto a black canvas at its timeline
position with ``overlay`` - so V2 sits on top of V1, a scaled-down V2 becomes
picture-in-picture B-roll, and opacity/video-fades become real alpha fades
that reveal the layer underneath instead of fading to black.

Audio is mixed, not flattened: the sound of every video clip plus every item
on the A tracks is trimmed, delayed to its timeline position, given its
volume/fade envelope and summed with ``amix``.

Per-clip effects (transform, crop, opacity, volume, fades) and keyframes
(baked into short spans) come from vts/fx.py. The encoder settings,
orientation handling, hardware fallback and job progress all come from
export.py, exactly like the legacy deletion-based export.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import threading

from . import export as ex
from . import fx as fx_mod
from .ffprobe import encoder_candidates
from .media import display_size
from .medialib import MAIN_ID

PIX_FORMATS = {"yuv420p", "yuv422p", "yuv444p",
               "yuv420p10le", "yuv422p10le", "yuv444p10le"}

_FILTER_CACHE: set[str] | None = None
_FILTER_LOCK = threading.Lock()


def available_filters() -> set[str]:
    """Filter names in this ffmpeg build (cached; empty set when unknown)."""
    global _FILTER_CACHE
    with _FILTER_LOCK:
        if _FILTER_CACHE is not None:
            return _FILTER_CACHE
        names: set[str] = set()
        try:
            proc = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error",
                                   "-filters"], capture_output=True, text=True)
            for line in proc.stdout.splitlines():
                parts = line.split()
                # " .. name   D->V  description"
                if len(parts) >= 3 and parts[1] not in ("->",):
                    names.add(parts[1])
        except (OSError, subprocess.SubprocessError):
            names = set()
        _FILTER_CACHE = names
        return names


class Input:
    """One ``-i`` on the ffmpeg command line."""

    def __init__(self, path: str, kind: str, index: int, fps: float = 30.0,
                 has_audio: bool = True, has_video: bool = True):
        self.path = path
        self.kind = kind
        self.index = index
        self.fps = fps
        # A "video" file may carry no audio track, and an image carries none.
        self.has_audio = bool(has_audio) and kind != "image"
        self.has_video = bool(has_video) and kind != "audio"

    @property
    def args(self) -> list[str]:
        if self.kind == "image":
            # A still must look like a video stream that `trim` can slice.
            return ["-loop", "1", "-framerate", f"{self.fps:.6f}"]
        return []

    @property
    def vlabel(self) -> str:
        return f"[{self.index}:v:0]"

    @property
    def alabel(self) -> str:
        return f"[{self.index}:a:0]"


def _clip_track(clip: dict) -> int:
    try:
        return max(0, int(clip.get("track", 0)))
    except (TypeError, ValueError):
        return 0


def _audio_track(item: dict) -> int:
    try:
        return max(0, int(item.get("atrack", 0)))
    except (TypeError, ValueError):
        return 0


def _clamp_pos(value, lo, hi):
    return hi if value > hi else lo if value < lo else value


def _f(value: float) -> str:
    return fx_mod.fmt_num(value)


def _micro_fade(d: float, fade_ms: int, at_in: bool, at_out: bool,
                user_in: float, user_out: float) -> str:
    """Short anti-click fade, skipped under user fades."""
    out: list[str] = []
    span = min(fade_ms / 1000.0, d / 2.0)
    if fade_ms > 0 and span > 0:
        if at_in and user_in < 0.05:
            out.append(f"afade=t=in:st=0:d={span:.3f}")
        if at_out and user_out < 0.05:
            out.append(f"afade=t=out:st={max(0.0, d - span):.3f}:d={span:.3f}")
    return ",".join(out)


# ---------------------------------------------------------------------------
# Video
# ---------------------------------------------------------------------------

def _layer_chain(inp: Input, src_in: float, d: float, start: float, end: float,
                 eff: dict, w: int, h: int, fps: float, pix_fmt: str,
                 label: str, parts: list[str]) -> tuple[str, int, int]:
    """One composited slice of one clip.

    Appends the filter that renders it and returns ``(label, x, y)`` for the
    overlay that drops it onto the canvas. The layer keeps its own size and is
    positioned with overlay's x/y, so whatever is beside it stays visible -
    padding it out to a full frame would hide the track underneath.
    """
    chain = [f"{inp.vlabel}trim=start={src_in:.6f}:duration={d:.6f}",
             # Land the slice on the timeline: overlay reads absolute time.
             f"setpts=PTS-STARTPTS+{start:.6f}/TB"]
    crop_txt, cw, ch = fx_mod.crop_filter(eff, w, h)
    if crop_txt:
        chain.append(crop_txt)
    # Look (Inspector > Effect > Look). Applied before the alpha format
    # conversion so eq always sees a plain YUV frame; still images are skipped
    # because their alpha is the cut-out.
    if inp.kind != "image":
        b = float(eff.get("brightness") or 0.0)
        c = float(eff.get("contrast") or 0.0)
        sat = float(eff.get("saturation") or 0.0)
        if abs(b) > 1e-9 or abs(c) > 1e-9 or abs(sat) > 1e-9:
            chain.append(f"eq=brightness={b / 100.0:.4f}:"
                         f"contrast={1 + c / 100.0:.4f}:"
                         f"saturation={max(0.0, 1 + sat / 100.0):.4f}")

    fi = min(eff["vfade_in"], d / 2.0) if eff["vfade_in"] else 0.0
    fo = min(eff["vfade_out"], d / 2.0) if eff["vfade_out"] else 0.0
    rot_txt, cos_a, sin_a = fx_mod.rotate_filter(eff)
    mask_txt = fx_mod.mask_filter(eff)
    needs_alpha = (eff["opacity"] < 100.0 - 1e-9 or fi > 0.001 or fo > 0.001
                   or eff.get("fit") == "contain"
                   or bool(rot_txt) or bool(mask_txt))
    if needs_alpha:
        # Before the pad: `contain` writes transparent letterbox bars, and an
        # alpha fade must reveal the track below instead of going to black.
        chain.append("format=yuva420p")

    scale_filters, bw, bh = fx_mod.fit_filter(eff, cw, ch, w, h)
    chain.extend(scale_filters)

    # Rotate around the centre; the bounding box grows, the centre does not
    # move, so the overlay placement below keeps the picture where it was.
    if rot_txt:
        chain.append(rot_txt)
        bw, bh = fx_mod.rotated_size(bw, bh, cos_a, sin_a)
    # Mask after rotate: the shape is defined in the picture the viewer sees.
    if mask_txt:
        chain.append(mask_txt)

    dx = w * eff["x"] / 100.0
    dy = h * eff["y"] / 100.0
    # The monitor lets you drag a picture past the frame edge, so the export
    # lets it hang over too (Premiere does the same); only absurd values clamp.
    px = int(_clamp_pos(round((w - bw) / 2.0 + dx), -bw, w))
    py = int(_clamp_pos(round((h - bh) / 2.0 + dy), -bh, h))

    chain.append(f"fps={fps:.6f}")
    chain.append("setsar=1")
    if needs_alpha:
        if eff["opacity"] < 100.0 - 1e-9:
            chain.append(f"colorchannelmixer=aa={eff['opacity'] / 100.0:.4f}")
        if fi > 0.001:
            chain.append(f"fade=t=in:st={start:.6f}:d={fi:.3f}:alpha=1")
        if fo > 0.001:
            chain.append(f"fade=t=out:st={end - fo:.6f}:d={fo:.3f}:alpha=1")
    else:
        chain.append(f"format={pix_fmt}")
    parts.append(",".join(chain) + label)
    return label, px, py


def _video_graph(clips: list[dict], inputs: dict[str, Input], total: float,
                 fps: float, size: tuple[int, int], pix_fmt: str,
                 parts: list[str]) -> str:
    """Overlay every clip onto a black canvas; returns the final video label."""
    w, h = size
    parts.append(f"color=c=black:s={w}x{h}:r={fps:.6f}:d={max(total, 0.05):.6f},"
                 f"format={pix_fmt},setsar=1[bv0]")
    prev = "[bv0]"
    n = 0
    for clip in sorted(clips, key=lambda c: (_clip_track(c), c["start"])):
        inp = inputs.get(clip.get("src") or MAIN_ID)
        if inp is None or not inp.has_video:
            continue
        clip_len = float(clip["end"]) - float(clip["start"])
        if clip_len <= 0:
            continue
        fx = fx_mod.clean_fx(clip.get("fx"))
        kf = fx_mod.clean_keyframes(clip.get("kf"), clip_len)
        for rel0, rel1, eff in fx_mod.slice_spans(fx, kf, clip_len):
            s = float(clip["start"]) + rel0
            e = float(clip["start"]) + rel1
            d = e - s
            if d <= 1e-4:
                continue
            label = f"[ln{n}]"
            label, px, py = _layer_chain(inp, float(clip["in"]) + rel0, d, s, e, eff,
                                         w, h, fps, pix_fmt, label, parts)
            parts.append(
                f"{prev}{label}overlay=x={px}:y={py}:format=auto:"
                f"enable='gte(t,{s:.6f})*lt(t,{e:.6f})'[bv{n + 1}]")
            prev = f"[bv{n + 1}]"
            n += 1
    return prev


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------

def _audio_graph(items: list[dict], inputs: dict[str, Input], total: float,
                 sample_rate: int, layout: str, fade_ms: int,
                 parts: list[str]) -> str | None:
    """Mix every audible source; returns the final audio label or None."""
    labels: list[str] = []
    for i, item in enumerate(items):
        inp = inputs.get(item.get("src") or MAIN_ID)
        if inp is None or not inp.has_audio:
            continue
        d = float(item["end"]) - float(item["start"])
        if d <= 1e-4:
            continue
        eff = fx_mod.clean_fx(item.get("fx"))
        vol = 0.0 if eff["mute"] else eff["volume"] / 100.0
        delay_ms = int(round(float(item["start"]) * 1000))
        chain = [f"{inp.alabel}atrim=start={float(item['in']):.6f}:duration={d:.6f}",
                 "asetpts=PTS-STARTPTS",
                 f"aformat=sample_fmts=fltp:sample_rates={sample_rate}:"
                 f"channel_layouts={layout}"]
        # Level keys ride the sound too: a volume filter per span, gated to
        # it, so a keyed duck exports exactly as the panel draws it. The span
        # times are relative to this trimmed stream, whose t=0 is the clip's
        # own start.
        keys = fx_mod.clean_keyframes(item.get("kf"), d)
        if keys:
            for a, b, span_eff in fx_mod.slice_spans(eff, keys, d, min_step=0.1):
                level = 0.0 if eff["mute"] else span_eff["volume"] / 100.0
                if abs(level - 1.0) > 1e-9:
                    chain.append(f"volume={_f(level)}:"
                                 f"enable='between(t,{a:.6f},{b:.6f})'")
        elif abs(vol - 1.0) > 1e-9:
            chain.append(f"volume={_f(vol)}")
        user = fx_mod.audio_chain(eff, d)
        if user:
            # audio_chain() includes volume; strip it back out (already applied).
            user = ",".join(p for p in user.split(",")
                            if not p.startswith("volume="))
            if user:
                chain.append(user)
        micro = _micro_fade(d, fade_ms, True, True, eff["fade_in"], eff["fade_out"])
        if micro:
            chain.append(micro)
        if delay_ms > 0:
            channels = 1 if layout == "mono" else 2
            chain.append("adelay=" + "|".join([str(delay_ms)] * channels))
        label = f"[ax{i}]"
        parts.append(",".join(chain) + label)
        labels.append(label)

    if not labels:
        return None

    if len(labels) == 1:
        mixed = labels[0]
    else:
        parts.append("".join(labels) +
                     f"amix=inputs={len(labels)}:normalize=0:"
                     f"dropout_transition=0[amx]")
        mixed = "[amx]"
        if "alimiter" in available_filters():
            parts.append(f"{mixed}alimiter=limit=0.95[aml]")
            mixed = "[aml]"
    # Silence after the last sound so audio and picture stay the same length.
    parts.append(f"{mixed}apad,atrim=start=0:end={max(total, 0.05):.6f},"
                 f"aformat=sample_fmts=fltp:sample_rates={sample_rate}:"
                 f"channel_layouts={layout}[outa]")
    return "[outa]"


# ---------------------------------------------------------------------------
# Whole graph
# ---------------------------------------------------------------------------

def collect_inputs(clips: list[dict], auds: list[dict],
                   resolve, fps: float) -> tuple[list[Input], dict[str, Input]]:
    """One ffmpeg input per distinct asset, in a stable order."""
    by_asset: dict[str, Input] = {}
    order: list[Input] = []
    def make(key: str) -> Input:
        got = resolve(key) or ()
        path = got[0] if len(got) > 0 else ""
        kind = got[1] if len(got) > 1 else "video"
        # Optional third element: does the file actually carry sound?
        has_audio = got[2] if len(got) > 2 else kind != "image"
        return Input(path, kind, len(order), fps, has_audio=has_audio)

    for item in list(clips) + list(auds):
        key = item.get("src") or MAIN_ID
        if key in by_asset:
            continue
        inp = make(key)
        by_asset[key] = inp
        order.append(inp)
    if not order:
        inp = make(MAIN_ID)
        by_asset[MAIN_ID] = inp
        order.append(inp)
    return order, by_asset


def build_filter(clips: list[dict], auds: list[dict], total: float, fps: float,
                 size: tuple[int, int], pix_fmt: str, sample_rate: int,
                 layout: str, fade_ms: int, inputs: dict[str, Input],
                 burn_srt: str | None = None,
                 fonts_dir: str | None = None) -> tuple[str, bool]:
    """The full filter_complex plus whether it produces an audio stream."""
    parts: list[str] = []
    vlabel = _video_graph(sorted(clips, key=lambda c: (_clip_track(c), c["start"])),
                          inputs, total, fps, size, pix_fmt, parts)

    audible: list[dict] = []
    for clip in clips:
        inp = inputs.get(clip.get("src") or MAIN_ID)
        if (clip.get("audio", True) is False or inp is None
                or not inp.has_audio):
            continue
        audible.append({"src": clip.get("src") or MAIN_ID,
                        "start": float(clip["start"]), "end": float(clip["end"]),
                        "in": float(clip["in"]),
                        "fx": fx_mod.clean_fx(clip.get("fx")),
                        "kf": clip.get("kf")})
    for item in auds:
        inp = inputs.get(item.get("src") or MAIN_ID)
        if inp is None or not inp.has_audio:
            continue
        audible.append({"src": item.get("src") or MAIN_ID,
                        "start": float(item["start"]), "end": float(item["end"]),
                        "in": float(item["in"]),
                        "fx": fx_mod.clean_fx(item.get("fx")),
                        "kf": item.get("kf")})
    audible.sort(key=lambda a: (a["start"], a["end"]))

    has_audio = _audio_graph(audible, inputs, total, sample_rate, layout,
                             fade_ms, parts) is not None

    outv = "[basev]" if burn_srt else "[outv]"
    parts.append(f"{vlabel}null{outv}")
    graph = ";".join(parts)
    if burn_srt:
        fonts = (":fontsdir=" + ex.escape_filter_path(fonts_dir)) if fonts_dir else ""
        graph += f";{outv}subtitles={ex.escape_filter_path(burn_srt)}{fonts}[outv]"
    return graph, has_audio


def build_command_multi(inputs: list[Input], filter_script: str, opts: dict,
                        output: str, has_audio: bool, total: float,
                        hwaccel: str = "auto") -> list[str]:
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
           "-progress", "pipe:1", "-nostats"]
    # No -noautorotate: ffmpeg's default autorotate bakes the source display
    # matrix (rotation and flips) into the pixels, so exports need no tag.
    if hwaccel and hwaccel != "none":
        cmd += ["-hwaccel", hwaccel]
    for inp in inputs:
        cmd += inp.args
        cmd += ["-i", inp.path]
    cmd += ["-filter_complex_script", filter_script, "-map", "[outv]"]
    if has_audio:
        cmd += ["-map", "[outa]"]
    cmd += ex.build_encoder_args(opts)
    if opts.get("copy_metadata"):
        cmd += ["-map_metadata", "0"]
    cmd += list(opts.get("mux_flags") or [])
    cmd += ["-t", f"{max(total, 0.05):.6f}", output]
    return cmd


# ---------------------------------------------------------------------------
# Legacy single-virtual-track helpers (kept for compatibility / tests)
# ---------------------------------------------------------------------------

def flatten_clips(clips: list[dict]) -> list[dict]:
    """Resolve overlapping lanes into one virtual track (highest lane wins).

    Kept for the fast stream-copy check and the tests. The real export now
    composites instead (see build_filter).
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


def _copy_fast_path(clips: list[dict], auds: list[dict], opts: dict,
                    info: dict, output: str, resolve) -> tuple[dict | None, str]:
    """True stream copy: one untouched clip from t=0 and nothing else.

    Returns ``(job, "")`` when the copy was started, or ``(None, why)`` with a
    short reason for the caller's note - the reason is what the user reads in
    the Export panel, so it has to name the thing that forced a re-encode.
    """
    if auds:
        return None, "audio items on their own lanes"
    pieces = flatten_clips(clips)
    single = pieces[0] if len(pieces) == 1 else None
    if single is None or len(clips) != 1:
        return None, "several clips"
    clip = clips[0]
    if not fx_mod.fx_is_default(clip.get("fx")) or clip.get("kf"):
        return None, "clip effects or keyframes"
    if single["start"] > 1e-3 or single["in"] > 1e-3:
        return None, "a clip that does not start at 0"
    if opts.get("burn_srt"):
        return None, "burned-in captions"
    if ex.has_display_transform(info):
        return None, "a rotated or flipped source"
    src_id = clip.get("src") or MAIN_ID
    # The bin resolver answers (path, kind, has_audio); older callers pass
    # (path, kind) and the no-bin fallback does too, so read by position.
    got = resolve(src_id) or ()
    path = got[0] if got else ""
    kind = got[1] if len(got) > 1 else "video"
    if not path:
        return None, "a source file that could not be found"
    if kind != "video":
        return None, "a still image"
    dur = single["end"] - single["start"]
    fd, list_path = tempfile.mkstemp(suffix=".txt", prefix="vts_concat_")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        quoted = path.replace("'", "'\\''")
        f.write(f"file '{quoted}'\n")
        f.write(f"outpoint {dur:.3f}\n")
    job = ex._new_job("copy", output, dur)
    job["concat_list"] = list_path
    cmd = ex.build_copy_command(path, list_path, output, opts)
    threading.Thread(target=ex._watch, args=(job, cmd, dur, False), daemon=True).start()
    snap = ex.get_job(job["id"])
    snap["segments"] = 1
    return snap, ""


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def export_timeline(source: str, info: dict, clips: list[dict],
                    opts: dict, output: str, media=None,
                    auds: list[dict] | None = None,
                    total: float | None = None) -> dict:
    """Render the edit list; returns the job dict.

    `media` maps an asset id to ``(path, kind, has_audio)``; ``(path, kind)``
    is still accepted. Without it every clip is trimmed from `source`, which is
    the pre-media-bin behaviour.
    """
    if not clips:
        raise ex.JobError("The timeline has no video clips left to export.")
    auds = list(auds or [])
    clips = sorted(clips, key=lambda c: (_clip_track(c), c["start"]))
    end = max([float(c["end"]) for c in clips] +
              [float(a["end"]) for a in auds], default=0.0)
    if total is not None:
        end = max(end, float(total))
    if end < 0.05:
        raise ex.JobError("The timeline is too short to export.")
    os.makedirs(os.path.dirname(os.path.abspath(output)) or ".", exist_ok=True)

    def resolve(asset_id):
        if media is not None:
            try:
                got = media(asset_id)
            except Exception:
                got = None
            if got:
                return got
        return (source, "video")

    vinfo = info.get("video") or {}
    ainfo = info.get("audio") or {}
    has_source_audio = bool(ainfo)
    fps = float(vinfo.get("fps") or 0) or 30.0
    if not 1.0 <= fps <= 240.0:
        fps = 30.0

    if opts.get("mode") == "copy":
        fast, why = _copy_fast_path(clips, auds, opts, info, output, resolve)
        if fast:
            return fast
        if not opts.get("_mode_note"):
            opts = {**opts, "_mode_note":
                    "Stream copy needs one untrimmed clip with nothing drawn on "
                    f"top of it; {why or 'this edit'} need frame-accurate "
                    "rendering, so this export was re-encoded."}

    pix = opts.get("pix_fmt") or vinfo.get("pix_fmt") or "yuv420p"
    if pix not in PIX_FORMATS:
        pix = "yuv420p"
    sample_rate = int(ainfo.get("sample_rate") or 48000)
    layout = "mono" if has_source_audio and int(ainfo.get("channels") or 2) == 1 else "stereo"
    w, h = display_size(vinfo)

    inputs, by_asset = collect_inputs(clips, auds, resolve, fps)
    burn = opts.get("burn_srt")
    graph, has_audio = build_filter(
        clips, auds, end, fps, (w, h), pix, sample_rate, layout,
        int(opts.get("fade_ms", 30)), by_asset,
        burn_srt=burn, fonts_dir=opts.get("fonts_dir"))

    fd, script_path = tempfile.mkstemp(suffix=".txt", prefix="vts_filter_")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(graph)

    job = ex._new_job("reencode", output, end)
    if opts.get("_burn_ass_cleanup"):
        job["burn_ass"] = opts["_burn_ass_cleanup"]
    if opts.get("_mode_note"):
        job["note"] = opts["_mode_note"]
    elif ex.has_display_transform(info):
        job["note"] = ("Rotation/flip is baked into the picture; the export "
                       "carries no rotation tag.")
    job["filter_script"] = script_path

    hwaccel = opts.get("hwaccel") or "auto"
    cmd = build_command_multi(inputs, script_path, opts, output, has_audio, end, hwaccel)

    fallback_cmd = None
    fallback_codec = None
    codec = opts.get("codec", "")
    if codec.endswith(("_amf", "_nvenc", "_qsv", "_videotoolbox")):
        fallback_codec = next(
            (c["name"] for c in encoder_candidates(vinfo.get("codec"))
             if not c["hw"] and c["name"] != codec), None)
        if fallback_codec:
            fallback_opts = {**opts, "codec": fallback_codec, "hwaccel": "none"}
            fallback_cmd = build_command_multi(inputs, script_path, fallback_opts,
                                               output, has_audio, end, "none")

    threading.Thread(
        target=ex._watch_and_cleanup,
        args=(job, cmd, end, hwaccel in ("auto", "d3d11va", "cuda", "dxva2", "vaapi"),
              script_path, fallback_cmd, fallback_codec),
        daemon=True,
    ).start()
    snap = ex.get_job(job["id"])
    snap["segments"] = len(clips)
    return snap
