"""Clip effects: transform, crop, audio, fades and keyframes.

This module is the shared vocabulary for per-clip effects, used by the
timeline validator (`vts/timeline.py`) and the ffmpeg export graph
(`vts/edl.py`). The browser preview mirrors the same maths in
`static/timeline-model.js` (`TLM.evalFxAt`), so what you see is close to
what is exported.

Effect model (all numbers are plain floats unless noted)::

    {
      "x": 0.0, "y": 0.0,     # position offset in % of frame size from centre
                              # (+x = right, +y = down), range -100..100
      "scale": 100.0,         # picture size in %, range 1..400
      "opacity": 100.0,       # %, range 0..100
      "crop_l": 0.0, "crop_t": 0.0, "crop_r": 0.0, "crop_b": 0.0,  # % per edge
      "volume": 100.0,        # %, range 0..400
      "mute": False,
      "fade_in": 0.0, "fade_out": 0.0,    # audio fades, seconds
      "vfade_in": 0.0, "vfade_out": 0.0,  # video fades, seconds
    }

Keyframes animate the transform subset only (x, y, scale, opacity)::

    [{"t": 1.25, "x": -20.0, "y": 0.0, "scale": 80.0, "opacity": 100.0}, ...]

`t` is seconds relative to the clip start. Evaluation is linear between
neighbouring keyframes and holds the end values outside the range.
"""

from __future__ import annotations

DEFAULT_FX: dict = {
    "x": 0.0,
    "y": 0.0,
    "scale": 100.0,
    "opacity": 100.0,
    "crop_l": 0.0,
    "crop_t": 0.0,
    "crop_r": 0.0,
    "crop_b": 0.0,
    "volume": 100.0,
    "mute": False,
    "fade_in": 0.0,
    "fade_out": 0.0,
    "vfade_in": 0.0,
    "vfade_out": 0.0,
    # Look (0 = untouched). Mirrored by static/stage.js as a CSS filter and by
    # ffmpeg's eq filter in the export graph.
    "brightness": 0.0,
    "contrast": 0.0,
    "saturation": 0.0,
    "fit": "fill",
}

# How a clip's (cropped) picture fills its box on the frame.
FIT_MODES = ("fill", "contain", "cover")

# Keyframe-animatable transform keys.
KF_KEYS = ("x", "y", "scale", "opacity")

MAX_KEYFRAMES = 64
MAX_VTRACKS = 64   # video lanes grow on demand, like caption lanes


def _f(value, default: float) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    if out != out or out in (float("inf"), float("-inf")):  # NaN / inf
        return default
    return out


def _clamp(value: float, lo: float, hi: float) -> float:
    return hi if value > hi else lo if value < lo else value


def clean_fx(raw) -> dict:
    """Coerce an effect dict to safe values, filling defaults."""
    src = raw if isinstance(raw, dict) else {}
    fx = dict(DEFAULT_FX)
    fx["x"] = round(_clamp(_f(src.get("x"), 0.0), -100.0, 100.0), 3)
    fx["y"] = round(_clamp(_f(src.get("y"), 0.0), -100.0, 100.0), 3)
    fx["scale"] = round(_clamp(_f(src.get("scale"), 100.0), 1.0, 400.0), 3)
    fx["opacity"] = round(_clamp(_f(src.get("opacity"), 100.0), 0.0, 100.0), 3)
    for key in ("crop_l", "crop_t", "crop_r", "crop_b"):
        fx[key] = round(_clamp(_f(src.get(key), 0.0), 0.0, 45.0), 3)
    # Never crop a dimension away entirely.
    if fx["crop_l"] + fx["crop_r"] >= 90.0:
        over = fx["crop_l"] + fx["crop_r"] - 89.0
        fx["crop_l"] = round(max(0.0, fx["crop_l"] - over / 2.0), 3)
        fx["crop_r"] = round(max(0.0, fx["crop_r"] - over / 2.0), 3)
    if fx["crop_t"] + fx["crop_b"] >= 90.0:
        over = fx["crop_t"] + fx["crop_b"] - 89.0
        fx["crop_t"] = round(max(0.0, fx["crop_t"] - over / 2.0), 3)
        fx["crop_b"] = round(max(0.0, fx["crop_b"] - over / 2.0), 3)
    fx["volume"] = round(_clamp(_f(src.get("volume"), 100.0), 0.0, 400.0), 3)
    fx["mute"] = bool(src.get("mute", False))
    for key in ("fade_in", "fade_out", "vfade_in", "vfade_out"):
        fx[key] = round(max(0.0, _f(src.get(key), 0.0)), 3)
    for key in ("brightness", "contrast", "saturation"):
        fx[key] = round(_clamp(_f(src.get(key), 0.0), -100.0, 100.0), 3)
    # How the (cropped) picture fills its box: fill stretches to the box,
    # contain letterboxes inside it, cover crops to fill it.
    fit = str(src.get("fit") or "fill").strip().lower()
    fx["fit"] = fit if fit in FIT_MODES else "fill"
    return fx


def fx_is_default(fx: dict | None) -> bool:
    """True when no export-visible effect is set (fast paths stay valid)."""
    if not fx:
        return True
    fx = clean_fx(fx)
    return all(fx[k] == DEFAULT_FX[k] for k in DEFAULT_FX)


def clean_keyframes(raw, clip_len: float) -> list[dict]:
    """Validate keyframes: sorted by t, clamped to the clip, capped in count."""
    clip_len = max(0.0, float(clip_len or 0.0))
    out: list[dict] = []
    if not isinstance(raw, (list, tuple)):
        return out
    for item in raw[:MAX_KEYFRAMES]:
        if not isinstance(item, dict):
            continue
        t = round(_clamp(_f(item.get("t"), -1.0), 0.0, clip_len), 3)
        if t < 0.0 or t > clip_len:
            continue
        kf = {"t": t}
        for key in KF_KEYS:
            lo, hi = (-100.0, 100.0) if key in ("x", "y") else (
                (1.0, 400.0) if key == "scale" else (0.0, 100.0))
            default = DEFAULT_FX[key]
            kf[key] = round(_clamp(_f(item.get(key), default), lo, hi), 3)
        out.append(kf)
    # Later duplicates win; keep chronological order.
    merged: dict[float, dict] = {}
    for kf in out:
        merged[kf["t"]] = kf
    return [merged[t] for t in sorted(merged)]


def _snapshot(base: dict, kf: dict) -> dict:
    return {k: kf.get(k, base.get(k, DEFAULT_FX[k])) for k in KF_KEYS}


def eval_fx_at(fx: dict | None, kf: list[dict] | None,
               clip_len: float, t_rel: float) -> dict:
    """Effective transform at `t_rel` seconds into the clip.

    Returns the full fx dict with x/y/scale/opacity interpolated through the
    keyframes; every other property comes from the base effect unchanged.
    """
    base = clean_fx(fx)
    keys = clean_keyframes(kf, clip_len)
    if not keys:
        return base
    t_rel = _clamp(float(t_rel or 0.0), 0.0, max(0.0, float(clip_len or 0.0)))
    if t_rel <= keys[0]["t"]:
        base.update(_snapshot(base, keys[0]))
        return base
    if t_rel >= keys[-1]["t"]:
        base.update(_snapshot(base, keys[-1]))
        return base
    for a, b in zip(keys, keys[1:]):
        if a["t"] <= t_rel <= b["t"]:
            span = b["t"] - a["t"]
            f = 0.0 if span <= 1e-9 else (t_rel - a["t"]) / span
            sa, sb = _snapshot(base, a), _snapshot(base, b)
            for k in KF_KEYS:
                base[k] = round(sa[k] + (sb[k] - sa[k]) * f, 3)
            return base
    base.update(_snapshot(base, keys[-1]))
    return base


def kf_for_piece(kf: list[dict] | None, rel_start: float, piece_len: float) -> list[dict]:
    """Keyframes surviving in a flattened piece, shifted to piece time."""
    out: list[dict] = []
    for k in kf or []:
        try:
            t = float(k.get("t", -1.0)) - float(rel_start or 0.0)
        except (TypeError, ValueError, AttributeError):
            continue
        if -1e-6 <= t <= float(piece_len or 0.0) + 1e-6:
            kk = dict(k)
            kk["t"] = round(min(max(t, 0.0), max(0.0, float(piece_len or 0.0))), 3)
            out.append(kk)
    return sorted(out, key=lambda k: k["t"])


def slice_spans(fx: dict | None, kf: list[dict] | None,
                clip_len: float, max_slices: int = 240) -> list[tuple[float, float, dict]]:
    """Split a clip into spans with (near-)static effects for export.

    ffmpeg has no first-class keyframe track for crop/scale/position, so v1
    bakes animation by slicing an animated clip into short spans, each
    rendered with the transform evaluated at its midpoint. Clips without
    keyframes always return a single span.
    """
    clip_len = round(max(0.0, float(clip_len or 0.0)), 3)
    base = clean_fx(fx)
    keys = clean_keyframes(kf, clip_len)
    if not keys or clip_len <= 0.0:
        return [(0.0, clip_len, base)]
    step = max(0.2, clip_len / max(1, max_slices))
    spans: list[tuple[float, float, dict]] = []
    rel = 0.0
    while rel < clip_len - 1e-6:
        nxt = min(clip_len, rel + step)
        mid = (rel + nxt) / 2.0
        spans.append((round(rel, 3), round(nxt, 3), eval_fx_at(base, keys, clip_len, mid)))
        rel = nxt
    return spans or [(0.0, clip_len, base)]


# ---------------------------------------------------------------------------
# ffmpeg filter builders (pure string maths; safe to unit-test)
# ---------------------------------------------------------------------------

def _even(value: float, minimum: int = 2) -> int:
    return max(minimum, int(round(value)) // 2 * 2)


def crop_box(fx: dict, w: int, h: int) -> tuple[int, int, int, int]:
    """(x, y, cw, ch) crop rectangle in pixels for a WxH frame."""
    lx = _even(w * fx["crop_l"] / 100.0, 0) if fx["crop_l"] else 0
    ty = _even(h * fx["crop_t"] / 100.0, 0) if fx["crop_t"] else 0
    rx = _even(w * fx["crop_r"] / 100.0, 0) if fx["crop_r"] else 0
    by = _even(h * fx["crop_b"] / 100.0, 0) if fx["crop_b"] else 0
    cw = max(2, _even(w - lx - rx))
    ch = max(2, _even(h - ty - by))
    return lx, ty, cw, ch


def scaled_size(fx: dict, cw: int, ch: int) -> tuple[int, int]:
    s = fx["scale"] / 100.0
    return max(2, _even(cw * s)), max(2, _even(ch * s))


def crop_filter(fx: dict, w: int, h: int) -> tuple[str, int, int]:
    """Crop filter plus the resulting (cw, ch). Empty string when unused."""
    if not any(fx[k] for k in ("crop_l", "crop_t", "crop_r", "crop_b")):
        return "", w, h
    x, y, cw, ch = crop_box(fx, w, h)
    return f"crop={cw}:{ch}:{x}:{y}", cw, ch


def scale_filter(fx: dict, cw: int, ch: int) -> tuple[str, int, int]:
    """Scale filter plus the resulting (sw, sh). Empty string at 100%."""
    sw, sh = scaled_size(fx, cw, ch)
    if sw == cw and sh == ch:
        return "", sw, sh
    return f"scale={sw}:{sh}:flags=lanczos", sw, sh


def compose_to_frame(sw: int, sh: int, w: int, h: int,
                     dx: float, dy: float) -> tuple[str, str]:
    """Filters that fit an swxsh picture exactly onto a WxH frame.

    Oversized dimensions are centre-cropped (shifted by dx/dy), undersized
    ones are padded with black. Returns (filter_chain, final_size_note).
    """
    parts: list[str] = []
    if sw > w:
        cx = _clamp(round((sw - w) / 2 + dx), 0, sw - w)
        parts.append(f"crop={w}:{sh}:{int(cx)}:0")
        sw = w
    if sh > h:
        cy = _clamp(round((sh - h) / 2 + dy), 0, sh - h)
        parts.append(f"crop={sw}:{h}:0:{int(cy)}")
        sh = h
    if sw < w or sh < h:
        px = _clamp(round((w - sw) / 2 + dx), 0, w - sw)
        py = _clamp(round((h - sh) / 2 + dy), 0, h - sh)
        parts.append(f"pad={w}:{h}:{int(px)}:{int(py)}:color=black")
    return ",".join(parts), f"{sw}x{sh}->{w}x{h}"


def fit_filter(fx: dict, cw: int, ch: int, w: int, h: int) -> tuple[list[str], int, int]:
    """Scale the cropped cw x ch picture into its box on a WxH frame.

    The box is the frame scaled by `scale` percent, so `scale` means the same
    thing for every source shape. Returns (filters, box_w, box_h).
    """
    s = fx["scale"] / 100.0
    tw, th = _even(w * s), _even(h * s)
    fit = fx.get("fit") or "fill"
    if fit == "contain":
        # Letterbox inside the box; the bars are transparent so an overlay
        # does not hide the track underneath.
        return ([f"scale={tw}:{th}:flags=lanczos:force_original_aspect_ratio=decrease",
                 f"pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2:color=black@0.0"], tw, th)
    if fit == "cover":
        return ([f"scale={tw}:{th}:flags=lanczos:force_original_aspect_ratio=increase",
                 f"crop={tw}:{th}"], tw, th)
    return ([f"scale={tw}:{th}:flags=lanczos"], tw, th)


def overlay_placement(fx: dict, sw: int, sh: int, w: int, h: int) -> tuple[list[str], int, int]:
    """Filters + the x/y position for compositing an swxsh picture onto WxH.

    Unlike :func:`compose_to_frame` (which pads out to a full opaque frame),
    this keeps the layer at its own size and returns the overlay offset, so
    the picture beside it stays visible instead of being covered by padding.
    Oversized layers are centre-cropped by the x/y offset, as before.
    """
    parts: list[str] = []
    dx = fx["x"] / 100.0 * w
    dy = fx["y"] / 100.0 * h
    if sw > w:
        cx = _clamp(round((sw - w) / 2 + dx), 0, sw - w)
        parts.append(f"crop={w}:{sh}:{int(cx)}:0")
        sw = w
    if sh > h:
        cy = _clamp(round((sh - h) / 2 + dy), 0, sh - h)
        parts.append(f"crop={sw}:{h}:0:{int(cy)}")
        sh = h
    px = _clamp(round((w - sw) / 2.0 + dx), 0, max(0, w - sw))
    py = _clamp(round((h - sh) / 2.0 + dy), 0, max(0, h - sh))
    return parts, int(px), int(py)


def fmt_num(value: float) -> str:
    text = f"{value:.6f}".rstrip("0").rstrip(".")
    return text if text not in ("", "-0") else "0"


def audio_chain(fx: dict, dur: float) -> str:
    """volume + user fades for one audio segment of `dur` seconds."""
    parts: list[str] = []
    vol = 0.0 if fx["mute"] else fx["volume"] / 100.0
    if abs(vol - 1.0) > 1e-9:
        parts.append(f"volume={fmt_num(vol)}")
    fi = min(fx["fade_in"], dur / 2.0)
    fo = min(fx["fade_out"], dur / 2.0)
    if fi > 0.001:
        parts.append(f"afade=t=in:st=0:d={fi:.3f}")
    if fo > 0.001:
        parts.append(f"afade=t=out:st={max(0.0, dur - fo):.3f}:d={fo:.3f}")
    return ",".join(parts)


def video_fade_chain(fx: dict, dur: float, alpha: bool) -> str:
    """Video fade in/out for one segment of `dur` seconds.

    `alpha=True` fades transparency (for pre-multiplied chains); otherwise
    fades to black.
    """
    parts: list[str] = []
    suffix = ":alpha=1" if alpha else ""
    fi = min(fx["vfade_in"], dur / 2.0)
    fo = min(fx["vfade_out"], dur / 2.0)
    if fi > 0.001:
        parts.append(f"fade=t=in:st=0:d={fi:.3f}{suffix}")
    if fo > 0.001:
        parts.append(f"fade=t=out:st={max(0.0, dur - fo):.3f}:d={fo:.3f}{suffix}")
    return ",".join(parts)
