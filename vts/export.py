"""Export: turn a deletion list into an ffmpeg job that matches the source.

Two modes:

  reencode  - frame-accurate. trim/atrim per kept segment, concat, short audio
              fades at every cut, then re-encode with the source-matched
              profile (codec, bitrate, fps, pix_fmt, colour, audio params).
  copy      - fast, lossless stream copy for a single kept range from t=0
              when source timestamps also start at zero. Start seeks, non-zero
              timestamps or multiple ranges fall back to re-encode to avoid
              concat-demuxer overlap and A/V desynchronization. Sources that
              carry a rotation/flip display tag fall back too, because a stream
              copy cannot bake that transform into the pixels.

Orientation: every export bakes the source rotation/flip into the picture and
writes no display-matrix tag, so the result looks identical in players and
editors that ignore rotation tags.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid

from .detect import _merge, complement
from .ffprobe import encoder_candidates, resolve_preset, run

# Jobs live in memory; this is a local single-user tool.
JOBS: dict[str, dict] = {}
_JOBS_LOCK = threading.Lock()


class JobError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Segment maths
# ---------------------------------------------------------------------------

def kept_segments(duration: float, deletions: list[tuple[float, float]],
                  min_segment_s: float = 0.05) -> list[tuple[float, float]]:
    return complement(deletions, duration, min_segment_s)


def removed_total(deletions: list[tuple[float, float]], duration: float) -> float:
    merged = _merge([(max(0.0, s), min(duration, e)) for s, e in deletions])
    return round(sum(e - s for s, e in merged), 3)


# ---------------------------------------------------------------------------
# Filter graph (frame-accurate mode)
# ---------------------------------------------------------------------------

def build_filter_complex(segments: list[tuple[float, float]], fade_ms: int,
                         has_audio: bool) -> str:
    """trim + concat every kept segment in a single graph."""
    parts: list[str] = []
    labels: list[str] = []
    for i, (start, end) in enumerate(segments):
        dur = end - start
        parts.append(
            f"[0:v]trim=start={start:.3f}:end={end:.3f},"
            f"setpts=PTS-STARTPTS[v{i}]"
        )
        if has_audio:
            audio = (f"[0:a]atrim=start={start:.3f}:end={end:.3f},"
                     f"asetpts=PTS-STARTPTS")
            if fade_ms > 0:
                fade = min(fade_ms / 1000.0, dur / 2)
                if fade > 0:
                    audio += (f",afade=t=in:d={fade:.3f},"
                              f"afade=t=out:st={max(0.0, dur - fade):.3f}:d={fade:.3f}")
            parts.append(audio + f"[a{i}]")
            labels.append(f"[v{i}][a{i}]")
        else:
            labels.append(f"[v{i}]")

    vflag = 1
    aflag = 1 if has_audio else 0
    outs = "[outv][outa]" if has_audio else "[outv]"
    parts.append(f"{''.join(labels)}concat=n={len(segments)}:v={vflag}:a={aflag}{outs}")
    return ";".join(parts)


# ---------------------------------------------------------------------------
# Encoder arguments
# ---------------------------------------------------------------------------

def build_encoder_args(opts: dict) -> list[str]:
    """`opts` comes from source_match_profile(), possibly edited by the user."""
    codec = opts["codec"]
    preset = resolve_preset(codec, opts.get("preset") or "medium")
    args = ["-c:v", codec]

    is_x26x = codec in ("libx264", "libx265")
    mode = opts.get("quality_mode", "bitrate")
    quality = int(opts.get("crf", 18))
    rate = f"{int(opts['video_bitrate_kbps'])}k"
    maxrate = f"{int(opts['video_bitrate_kbps'] * float(opts.get('maxrate_factor', 1.5)))}k"

    if is_x26x:
        if mode == "crf":
            args += ["-crf", str(quality), "-preset", preset]
        else:
            args += ["-b:v", rate, "-preset", preset]
    elif codec.endswith("_amf"):
        args += ["-quality", preset]
        if mode == "crf":
            # AMF calls this CQP; the value is an encoder-specific quality
            # target, not numerically identical to x264's CRF.
            args += ["-rc", "cqp", "-qp_i", str(quality), "-qp_p", str(quality)]
        else:
            args += ["-rc", "vbr_peak", "-b:v", rate, "-maxrate", maxrate]
    elif codec.endswith("_nvenc"):
        args += ["-preset", preset]
        if mode == "crf":
            args += ["-rc", "vbr", "-b:v", "0", "-cq", str(quality)]
        else:
            args += ["-rc", "vbr", "-b:v", rate, "-maxrate", maxrate,
                     "-cq", str(quality)]
    elif codec in ("libvpx-vp9", "libsvtav1"):
        args += ["-b:v", "0" if mode == "crf" else rate,
                 "-crf", str(quality)]
    else:
        args += ["-b:v", rate]
        if not codec.endswith(("_qsv", "_videotoolbox")):
            args += ["-preset", preset]

    if is_x26x and opts.get("threads"):
        args += ["-threads", str(int(opts["threads"]))]

    args += ["-pix_fmt", opts.get("pix_fmt") or "yuv420p"]

    if opts.get("match_fps") and opts.get("fps"):
        args += ["-r", f"{float(opts['fps']):.6f}", "-fps_mode", "cfr"]

    if opts.get("gop"):
        args += ["-g", str(int(opts["gop"]))]

    if opts.get("match_color"):
        for flag, key in (("-colorspace", "color_space"),
                          ("-color_primaries", "color_primaries"),
                          ("-color_trc", "color_transfer")):
            if opts.get(key) and opts[key] not in ("unknown", "unspecified", "N/A"):
                args += [flag, opts[key]]
        crange = opts.get("color_range")
        if crange in ("tv", "pc"):
            args += ["-color_range", crange]

    # Audio
    a_codec = opts.get("audio_codec", "aac")
    if a_codec and a_codec != "none":
        args += ["-c:a", a_codec]
        if opts.get("audio_bitrate_kbps"):
            args += ["-b:a", f"{int(opts['audio_bitrate_kbps'])}k"]
        if opts.get("audio_sample_rate"):
            args += ["-ar", str(int(opts["audio_sample_rate"]))]
        if opts.get("audio_channels"):
            args += ["-ac", str(int(opts["audio_channels"]))]
    return args


def has_display_transform(info: dict | None) -> bool:
    """True when the source carries a display matrix (rotation and/or flip).

    Both fields are checked because a flip-only matrix reports rotation 0 but
    must still be baked to keep the picture correct.
    """
    video = (info or {}).get("video") or {}
    return bool(video.get("has_display_matrix") or video.get("rotation"))


def build_command(source: str, output: str, segments: list[tuple[float, float]],
                  opts: dict, filter_script: str, has_audio: bool,
                  hwaccel: str = "auto") -> list[str]:
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
           "-progress", "pipe:1", "-nostats"]
    # No -noautorotate / -display_rotation here on purpose. FFmpeg's default
    # autorotate applies the source display matrix - rotation *and* flips -
    # while decoding, so the export gets the visible orientation baked into its
    # pixels and is written without a display-matrix tag. Players that ignore
    # rotation tags therefore still show the exported picture the right way up.
    if hwaccel and hwaccel != "none":
        cmd += ["-hwaccel", hwaccel]
    cmd += ["-i", source, "-filter_complex_script", filter_script,
            "-map", "[outv]"]
    if has_audio:
        cmd += ["-map", "[outa]"]
    cmd += build_encoder_args(opts)
    if opts.get("copy_metadata"):
        cmd += ["-map_metadata", "0"]
    cmd += list(opts.get("mux_flags") or [])
    cmd += [output]
    return cmd


def build_copy_command(source: str, concat_list: str, output: str,
                       opts: dict) -> list[str]:
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
           "-progress", "pipe:1", "-nostats",
           "-f", "concat", "-safe", "0", "-i", concat_list,
           "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy"]
    if opts.get("copy_metadata"):
        cmd += ["-map_metadata", "0"]
    cmd += list(opts.get("mux_flags") or [])
    cmd += [output]
    return cmd


def _sync_copy_reason(
    segments: list[tuple[float, float]], info: dict | None = None,
) -> str | None:
    """Stream-copy only cuts a single range safely in this editor.

    The concat demuxer can emit pre-roll packets around arbitrary inpoints.
    Joining those packets as-is may make DTS go backward and shift audio from
    video. A start trim also seeks to a keyframe and can give the streams
    different initial offsets. Non-zero source timestamps also make concat
    in/out points ambiguous relative to the UI's zero-based timeline. Prefer a
    slower, synchronized re-encode for any of these cases; a single range
    starting at source time zero needs no join or input seek and remains a true
    fast stream copy.
    """
    if len(segments) > 1:
        return ("Several kept sections must be joined. Stream-copy joins can "
                "desynchronize audio and video, so this export is being "
                "re-encoded to keep them in sync.")
    if segments and segments[0][0] > 1e-3:
        return ("This cut starts partway through the source. Stream-copy seeking "
                "can shift audio and video, so this export is being re-encoded "
                "to keep them in sync.")
    if info:
        starts = [info.get("start_time")]
        starts.extend((info.get(track) or {}).get("start_time")
                      for track in ("video", "audio"))
        if any(value is not None and abs(float(value)) > 0.05 for value in starts):
            return ("The source has non-zero stream start timestamps. Stream-copy "
                    "timing may not match the edit points, so this export is "
                    "being re-encoded to keep sync.")
    return None


def stream_copy_fallback_reason(
    segments: list[tuple[float, float]], info: dict | None = None,
) -> str | None:
    """Why a stream copy cannot be used, or None when it is safe.

    Besides the timestamp/join cases, a source with a rotation or flip display
    matrix cannot be stream-copied: the copy would keep the matrix as a *tag*
    and leave the orientation up to the player instead of baking it into the
    picture the way every other export does.
    """
    sync_reason = _sync_copy_reason(segments, info)
    if not has_display_transform(info):
        return sync_reason
    transform_reason = (
        "The source has a rotation/flip display tag, which a stream copy cannot "
        "apply to the pixels. This export is being re-encoded so the rotation is "
        "baked into the picture and the result looks the same in every player.")
    return f"{sync_reason} {transform_reason}" if sync_reason else transform_reason


# ---------------------------------------------------------------------------
# Job runner
# ---------------------------------------------------------------------------

OUT_TIME_RE = re.compile(r"out_time_us=(\d+)")
SPEED_RE = re.compile(r"speed=\s*(\S+)")


def _new_job(kind: str, output: str, total_s: float) -> dict:
    job = {
        "id": uuid.uuid4().hex[:12],
        "kind": kind,
        "output": output,
        "state": "running",
        "progress": 0.0,
        "speed": "",
        "elapsed": 0.0,
        "eta": None,
        "error": None,
        "total_s": total_s,
        "started": time.time(),
        "command": [],
    }
    with _JOBS_LOCK:
        JOBS[job["id"]] = job
    return job


def get_job(job_id: str) -> dict | None:
    with _JOBS_LOCK:
        job = JOBS.get(job_id)
        return dict(job) if job else None


def _without_hwaccel(cmd: list[str]) -> list[str]:
    """Return an ffmpeg argv list with any `-hwaccel VALUE` pair removed."""
    retry: list[str] = []
    i = 0
    while i < len(cmd):
        if cmd[i] == "-hwaccel":
            i += 2
            continue
        retry.append(cmd[i])
        i += 1
    return retry


def _watch(job: dict, cmd: list[str], total_s: float, hwaccel_fallback: bool) -> None:
    job["command"] = cmd
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
        )
    except FileNotFoundError:
        job.update(state="error", error="ffmpeg not found on PATH")
        return

    stderr_lines: list[str] = []
    t0 = time.time()

    def pump_stderr():
        assert proc.stderr is not None
        for line in proc.stderr:
            stderr_lines.append(line)
            if len(stderr_lines) > 400:
                stderr_lines.pop(0)

    th = threading.Thread(target=pump_stderr, daemon=True)
    th.start()

    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.strip()
        m = OUT_TIME_RE.search(line)
        if m and total_s > 0:
            done = int(m.group(1)) / 1_000_000
            pct = min(100.0, done / total_s * 100)
            elapsed = time.time() - t0
            job["progress"] = round(pct, 2)
            job["elapsed"] = round(elapsed, 1)
            job["eta"] = round(elapsed * (100 - pct) / pct, 1) if pct >= 1 else None
        sm = SPEED_RE.search(line)
        if sm:
            job["speed"] = sm.group(1)
    proc.wait()
    th.join(timeout=2)

    if proc.returncode != 0 and hwaccel_fallback:
        # GPU decode failed -> retry once on CPU (mirrors auto_trim_video_v2).
        # Remove the complete `-hwaccel VALUE` pair; retaining VALUE as a bare
        # positional input would make FFmpeg parse the fallback command wrong.
        retry = _without_hwaccel(cmd)
        retry_note = "GPU decode failed, retried with CPU decode"
        previous_note = job.get("note")
        job["note"] = f"{previous_note} · {retry_note}" if previous_note else retry_note
        job["progress"] = 0.0
        job["eta"] = None
        job["state"] = "running"
        return _watch(job, retry, total_s, False)

    if proc.returncode == 0:
        job.update(state="done", progress=100.0, elapsed=round(time.time() - t0, 1),
                   eta=0, size=os.path.getsize(job["output"])
                   if os.path.exists(job["output"]) else 0)
    else:
        job.update(state="error",
                   error="".join(stderr_lines)[-4000:] or f"ffmpeg exit {proc.returncode}")


def export(source: str, info: dict, deletions: list[tuple[float, float]],
           opts: dict, output: str) -> dict:
    """Kick off an export in a worker thread; returns the job dict."""
    duration = float(info["duration"])
    if not deletions:
        raise JobError("Nothing selected to delete.")

    merged = _merge([(max(0.0, float(s)), min(duration, float(e))) for s, e in deletions])
    if sum(e - s for s, e in merged) >= duration - 0.2:
        raise JobError("The selection covers the whole video; nothing would be left.")

    segments = kept_segments(duration, merged)
    if not segments:
        raise JobError("The selection leaves no video behind.")

    out_dir = os.path.dirname(os.path.abspath(output)) or "."
    os.makedirs(out_dir, exist_ok=True)

    mode = opts.get("mode", "reencode")
    has_audio = bool(info.get("audio"))

    if mode == "copy":
        fallback_note = stream_copy_fallback_reason(segments, info)
        if fallback_note:
            # Do not hand concat-demuxer timestamp overlap to the muxer, and do
            # not emit a copy that depends on a rotation tag. Reuse the normal
            # frame-accurate path (which bakes orientation) and make the mode
            # change explicit in the job details shown to the user.
            fallback_opts = {**opts, "mode": "reencode", "_mode_note": fallback_note}
            return export(source, info, merged, fallback_opts, output)

        # A single kept range beginning at source time zero requires no seek or
        # concat join, so stream copy is safe and remains genuinely fast.
        fd, list_path = tempfile.mkstemp(suffix=".txt", prefix="vts_concat_")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            quoted = source.replace("'", "'\\''")
            for s, e in segments:
                f.write(f"file '{quoted}'\n")
                if s > 0:
                    f.write(f"inpoint {s:.3f}\n")
                f.write(f"outpoint {e:.3f}\n")
        total = sum(e - s for s, e in segments)
        job = _new_job("copy", output, total)
        job["concat_list"] = list_path
        cmd = build_copy_command(source, list_path, output, opts)
        threading.Thread(target=_watch, args=(job, cmd, total, False), daemon=True).start()
        job_snapshot = get_job(job["id"])
        job_snapshot["segments"] = len(segments)
        return job_snapshot

    filter_graph = build_filter_complex(segments, int(opts.get("fade_ms", 30)), has_audio)
    fd, script_path = tempfile.mkstemp(suffix=".txt", prefix="vts_filter_")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(filter_graph)

    total = sum(e - s for s, e in segments)
    job = _new_job("reencode", output, total)
    if opts.get("_mode_note"):
        # A copy fallback note already explains itself, rotation included.
        job["note"] = opts["_mode_note"]
    elif has_display_transform(info):
        job["note"] = ("Rotation/flip is baked into the picture; the export "
                       "carries no rotation tag.")
    job["filter_script"] = script_path
    hwaccel = opts.get("hwaccel") or "auto"
    cmd = build_command(source, output, segments, opts, script_path, has_audio, hwaccel)

    fallback_cmd = None
    fallback_codec = None
    codec = opts.get("codec", "")
    if codec.endswith(("_amf", "_nvenc", "_qsv", "_videotoolbox")):
        vinfo = info.get("video") or {}
        fallback_codec = next(
            (c["name"] for c in encoder_candidates(vinfo.get("codec"))
             if not c["hw"] and c["name"] != codec),
            None,
        )
        if fallback_codec:
            fallback_opts = {**opts, "codec": fallback_codec, "hwaccel": "none"}
            fallback_cmd = build_command(
                source, output, segments, fallback_opts, script_path, has_audio, "none")

    threading.Thread(
        target=_watch_and_cleanup,
        args=(job, cmd, total, hwaccel in ("auto", "d3d11va", "cuda", "dxva2", "vaapi"),
              script_path, fallback_cmd, fallback_codec),
        daemon=True,
    ).start()
    snapshot = get_job(job["id"])
    snapshot["segments"] = len(segments)
    return snapshot


def _watch_and_cleanup(job, cmd, total, fallback, script_path,
                       encoder_fallback_cmd=None, fallback_codec=None):
    try:
        _watch(job, cmd, total, fallback)
        if job.get("state") == "error" and encoder_fallback_cmd:
            retry_note = f"Hardware encoder failed; retrying with {fallback_codec}"
            previous_note = job.get("note")
            job.update(
                state="running", progress=0.0, eta=None, error=None,
                note=f"{previous_note} · {retry_note}" if previous_note else retry_note,
            )
            _watch(job, encoder_fallback_cmd, total, False)
    finally:
        for key in ("filter_script", "concat_list"):
            path = job.get(key)
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass


def default_output_path(source: str, suffix: str = ".clean") -> str:
    root, ext = os.path.splitext(source)
    return f"{root}{suffix}{ext}"


def check_dependencies() -> list[str]:
    return [n for n in ("ffmpeg", "ffprobe") if shutil.which(n) is None]
