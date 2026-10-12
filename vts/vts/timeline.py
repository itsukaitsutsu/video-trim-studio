"""Multi-track timeline: validation and caption cues for export.

The timeline is an edit list over the media in the project bin:

    clips  - video pieces on V1..Vn. `src` is the media asset id (see
             vts/medialib.py; "src" is the project's main video), `in` is the
             source time where the clip starts, `start`/`end` are timeline
             seconds. Tracks **composite**: a clip on V2 is drawn over
             whatever V1 shows, honouring its transform, crop and opacity, so
             overlapping tracks are how you build picture-in-picture B-roll.
             Clips may not overlap *on the same track* - a drop that would
             clash is restacked onto the first free track instead of
             overwriting. Each clip carries `fx` (transform/crop/audio/fades,
             see vts/fx.py) and `kf` (keyframes animating the transform).
    auds   - audio-only items on A1..An: {id, src, atrack, start, end, in,
             fx, name}. Several may play at once; they are mixed.
    caps   - caption items on caption lanes (`lane` = 0, 1, 2...). Items on
             the same lane never overlap; different lanes stack.

A video clip keeps its own source sound unless `audio` is False (the user
unlinked it, which turns the sound into a free-standing item in `auds`).

Gaps between clips export as black picture and silence. Captions are stored
in timeline time, so the exported .srt/.ass uses the same times as the editor.
"""

from __future__ import annotations

import math
import uuid

from . import fx as fx_mod
from . import segmenter
from .medialib import MAIN_ID

MIN_LEN = 0.05          # shortest clip or caption that may exist (seconds)
MAX_LANES = 64
_EPS = 1e-3


class TimelineError(ValueError):
    """The timeline sent by the editor is not consistent (400 to the client)."""


def _num(value, what: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise TimelineError(f"{what} must be a number")
    if not math.isfinite(number):
        raise TimelineError(f"{what} must be finite")
    return number


def _item_id(raw: dict, prefix: str) -> str:
    value = str(raw.get("id") or "").strip()
    return value[:64] if value else f"{prefix}{uuid.uuid4().hex[:10]}"


def _src_id(raw: dict) -> str:
    value = str(raw.get("src") or "").strip()
    return value[:64] if value else MAIN_ID


def _clamp_track(raw: dict, key: str, top: int, what: str) -> int:
    try:
        track = int(raw.get(key, 0))
    except (TypeError, ValueError):
        raise TimelineError(f"{what} has an invalid track.")
    if not 0 <= track < top:
        raise TimelineError(f"{what} is on an invalid track.")
    return track


def _length_of(media, src_id, fallback, what):
    """Source duration for `src_id`, or the project duration when unknown."""
    if media is None:
        return float(fallback or 0.0)
    try:
        asset = media(src_id)
    except Exception:
        asset = None
    if not asset:
        return float(fallback or 0.0)
    try:
        return max(0.0, float(asset.get("duration") or 0.0))
    except (TypeError, ValueError):
        return float(fallback or 0.0)


def normalize(raw: dict, duration: float, media=None) -> dict:
    """Validate an editor timeline and return a clean copy.

    `media` maps an asset id to its bin record (or None), so each clip is
    checked against the duration of *its own* source rather than the main
    video's. Raises TimelineError with a message the editor can show.
    """
    if not isinstance(raw, dict):
        raise TimelineError("The timeline must be an object.")

    clips: list[dict] = []
    for item in raw.get("clips") or []:
        if not isinstance(item, dict):
            raise TimelineError("Each clip must be an object.")
        cid = _item_id(item, "c")
        src = _src_id(item)
        start = round(_num(item.get("start"), f"clip {cid} start"), 3)
        end = round(_num(item.get("end"), f"clip {cid} end"), 3)
        src_in = round(_num(item.get("in", start), f"clip {cid} in"), 3)
        if start < -_EPS or end - start < MIN_LEN - _EPS:
            raise TimelineError(f"Clip {cid} is shorter than {MIN_LEN}s or starts before 0.")
        if src_in < -_EPS:
            raise TimelineError(f"Clip {cid} starts before the beginning of its media.")
        src_dur = _length_of(media, src, duration, cid)
        if src_dur > 0 and src_in + (end - start) > src_dur + 0.05:
            raise TimelineError(f"Clip {cid} runs past the end of its media.")
        track = _clamp_track(item, "track", fx_mod.MAX_VTRACKS, f"Clip {cid}")
        fx = fx_mod.clean_fx(item.get("fx"))
        kf = fx_mod.clean_keyframes(item.get("kf"), end - start)
        clips.append({
            "id": cid,
            "src": src,
            "track": track,
            "start": max(0.0, start),
            "end": end,
            "in": max(0.0, src_in),
            "kind": str(item.get("kind") or "") or None,
            "text": str(item.get("text") or "")[:500],
            "fx": fx,
            "kf": kf,
            # False once the user unlinks the sound (it lives in `auds` then).
            "audio": item.get("audio", True) is not False,
        })
    clips.sort(key=lambda c: (c["track"], c["start"], c["end"]))
    for a, b in zip(clips, clips[1:]):
        if a["track"] == b["track"] and b["start"] < a["end"] - _EPS:
            raise TimelineError(f"Video clips overlap on track V{a['track'] + 1}.")

    auds: list[dict] = []
    atracks = 0
    for item in raw.get("auds") or []:
        if not isinstance(item, dict):
            raise TimelineError("Each audio item must be an object.")
        cid = _item_id(item, "n")
        src = _src_id(item)
        start = round(_num(item.get("start"), f"audio {cid} start"), 3)
        end = round(_num(item.get("end"), f"audio {cid} end"), 3)
        src_in = round(_num(item.get("in", start), f"audio {cid} in"), 3)
        if start < -_EPS or end - start < MIN_LEN - _EPS:
            raise TimelineError(f"Audio item {cid} is shorter than {MIN_LEN}s or starts before 0.")
        if src_in < -_EPS:
            raise TimelineError(f"Audio item {cid} starts before the beginning of its media.")
        src_dur = _length_of(media, src, duration, cid)
        if src_dur > 0 and src_in + (end - start) > src_dur + 0.05:
            raise TimelineError(f"Audio item {cid} runs past the end of its media.")
        atrack = _clamp_track(item, "atrack", fx_mod.MAX_VTRACKS, f"Audio item {cid}")
        atracks = max(atracks, atrack + 1)
        auds.append({
            "id": cid,
            "src": src,
            "atrack": atrack,
            "start": max(0.0, start),
            "end": end,
            "in": max(0.0, src_in),
            "name": str(item.get("name") or "")[:200],
            "fx": fx_mod.clean_fx(item.get("fx")),
        })
    auds.sort(key=lambda c: (c["atrack"], c["start"]))

    lanes = max(1, min(MAX_LANES, int(raw.get("lanes") or 1)))
    caps: list[dict] = []
    for item in raw.get("caps") or []:
        if not isinstance(item, dict):
            raise TimelineError("Each caption must be an object.")
        cid = _item_id(item, "t")
        lane = int(_num(item.get("lane", 0), f"caption {cid} lane"))
        if not 0 <= lane < MAX_LANES:
            raise TimelineError(f"Caption {cid} is on an invalid lane.")
        start = round(_num(item.get("start"), f"caption {cid} start"), 3)
        end = round(_num(item.get("end"), f"caption {cid} end"), 3)
        if start < -_EPS or end - start < MIN_LEN - _EPS:
            raise TimelineError(f"Caption {cid} is shorter than {MIN_LEN}s.")
        style = item.get("style") if isinstance(item.get("style"), dict) else None
        cap = {
            "id": cid,
            "lane": lane,
            "start": max(0.0, start),
            "end": end,
            "text": str(item.get("text") or "")[:2000],
            "style": style,
        }
        # Word-level timings ride with the caption: absolute timeline seconds,
        # so every move/trim/ripple is a plain shift or slice on both.
        words = segmenter.clean_words(item.get("words"), cap["start"], cap["end"])
        if words:
            cap["words"] = words
            src = segmenter.clean_word_source(item.get("word_source"))
            if src:
                cap["word_source"] = src
        caps.append(cap)
        lanes = max(lanes, lane + 1)
    caps.sort(key=lambda c: (c["lane"], c["start"]))
    for a, b in zip(caps, caps[1:]):
        if a["lane"] == b["lane"] and b["start"] < a["end"] - _EPS:
            raise TimelineError("Captions overlap on the same lane.")

    vtracks = 1
    try:
        vtracks = max(1, min(fx_mod.MAX_VTRACKS, int(raw.get("vtracks") or 1)))
    except (TypeError, ValueError):
        vtracks = 1
    if clips:
        vtracks = max(vtracks, max(c["track"] for c in clips) + 1)
    try:
        atracks = max(atracks, min(fx_mod.MAX_VTRACKS, int(raw.get("atracks") or 1)))
    except (TypeError, ValueError):
        atracks = max(atracks, 1)
    atracks = max(1, atracks, vtracks)
    return {"clips": clips, "auds": auds, "caps": caps,
            "lanes": lanes, "vtracks": vtracks, "atracks": atracks}


def video_length(tl: dict) -> float:
    """Length of the exported picture: the end of the last clip, any track."""
    return max((c["end"] for c in tl.get("clips", [])), default=0.0)


def timeline_length(tl: dict) -> float:
    """Longest end of anything on the timeline, audio included."""
    return max(
        [c["end"] for c in tl.get("clips", [])] +
        [a["end"] for a in tl.get("auds", [])] +
        [c["end"] for c in tl.get("caps", [])],
        default=0.0,
    )


def export_cues(tl: dict, length: float) -> list[dict]:
    """Caption cues on the exported timeline (same times as the editor).

    Word timings travel with the cue; a cue that had to be clipped at the end
    of the picture has its words clipped the same way.
    """
    cues: list[dict] = []
    for item in tl.get("caps", []):
        text = (item.get("text") or "").strip()
        if not text or item["start"] >= length - 1e-6:
            continue
        start = round(item["start"], 3)
        end = round(min(item["end"], length), 3)
        cue = {"start": start, "end": end, "text": text}
        if item.get("style"):
            cue["style"] = item["style"]
        words = segmenter.clean_words(item.get("words"), start, end)
        if words:
            cue["words"] = words
            if item.get("word_source"):
                cue["word_source"] = item["word_source"]
        cues.append(cue)
    cues.sort(key=lambda c: (c["start"], c["end"]))
    return cues
