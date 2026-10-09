"""Single-video timeline: validation and caption cues for export.

The timeline is an edit list over the ONE source video of a project:

    clips  - pieces of the source placed on the timeline. `in` is the source
             time where the clip starts, `start`/`end` are timeline seconds.
             Clips never overlap on the video track, but they may repeat or
             appear out of source order (copy/paste).
    caps   - caption items on caption lanes (`lane` = 0, 1, 2...). Items on
             the same lane never overlap; different lanes stack.

Gaps between clips export as black picture and silence. Captions are stored
in timeline time, so the exported .srt/.ass uses the same times as the editor.
"""

from __future__ import annotations

import math
import uuid

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


def normalize(raw: dict, duration: float) -> dict:
    """Validate an editor timeline and return a clean copy.

    Raises TimelineError with a message the editor can show the user."""
    if not isinstance(raw, dict):
        raise TimelineError("The timeline must be an object.")
    clips: list[dict] = []
    for item in raw.get("clips") or []:
        if not isinstance(item, dict):
            raise TimelineError("Each clip must be an object.")
        cid = _item_id(item, "c")
        start = round(_num(item.get("start"), f"clip {cid} start"), 3)
        end = round(_num(item.get("end"), f"clip {cid} end"), 3)
        src_in = round(_num(item.get("in", start), f"clip {cid} in"), 3)
        if start < -_EPS or end - start < MIN_LEN - _EPS:
            raise TimelineError(f"Clip {cid} is shorter than {MIN_LEN}s or starts before 0.")
        if src_in < -_EPS:
            raise TimelineError(f"Clip {cid} starts before the beginning of the video.")
        if src_in + (end - start) > duration + 0.02:
            raise TimelineError(f"Clip {cid} runs past the end of the video.")
        clips.append({
            "id": cid,
            "start": max(0.0, start),
            "end": end,
            "in": max(0.0, src_in),
            "kind": str(item.get("kind") or "") or None,
            "text": str(item.get("text") or "")[:500],
        })
    clips.sort(key=lambda c: (c["start"], c["end"]))
    for a, b in zip(clips, clips[1:]):
        if b["start"] < a["end"] - _EPS:
            raise TimelineError("Video clips overlap on the timeline.")

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
        caps.append({
            "id": cid,
            "lane": lane,
            "start": max(0.0, start),
            "end": end,
            "text": str(item.get("text") or "")[:2000],
            "style": style,
        })
        lanes = max(lanes, lane + 1)
    caps.sort(key=lambda c: (c["lane"], c["start"]))
    for a, b in zip(caps, caps[1:]):
        if a["lane"] == b["lane"] and b["start"] < a["end"] - _EPS:
            raise TimelineError("Captions overlap on the same lane.")
    return {"clips": clips, "caps": caps, "lanes": lanes}


def video_length(tl: dict) -> float:
    """Length of the exported picture: the end of the last video clip."""
    return max((c["end"] for c in tl.get("clips", [])), default=0.0)


def export_cues(tl: dict, length: float) -> list[dict]:
    """Caption cues on the exported timeline (same times as the editor)."""
    cues: list[dict] = []
    for item in tl.get("caps", []):
        text = (item.get("text") or "").strip()
        if not text or item["start"] >= length - 1e-6:
            continue
        cue = {
            "start": round(item["start"], 3),
            "end": round(min(item["end"], length), 3),
            "text": text,
        }
        if item.get("style"):
            cue["style"] = item["style"]
        cues.append(cue)
    cues.sort(key=lambda c: (c["start"], c["end"]))
    return cues
