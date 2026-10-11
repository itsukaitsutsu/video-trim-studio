/* Timeline model for Video Trim Studio. Pure functions: no DOM, no network.
 * Loaded by the browser (window.TLM) and by the Node tests (module.exports).
 *
 *   tl    = { clips: [...], auds: [...], caps: [...], lanes, vtracks, atracks }
 *
 *   clip  = { id, src, track, start, end, in, kind, text, fx, kf, audio }
 *           src   = media-bin asset id ("src" is the project's main video).
 *           track = video lane V1..Vn. Tracks COMPOSITE: a clip on V2 is
 *                   drawn over whatever V1 shows, using its own transform,
 *                   crop and opacity - that is how B-roll / picture-in-picture
 *                   is built. Clips may not overlap *on the same track*, so a
 *                   drop that would clash restacks onto the first free lane
 *                   instead of overwriting.
 *           audio = false once the sound is unlinked (it becomes an `auds`
 *                   item the user can move to its own lane).
 *           fx    = { x, y, scale, opacity, crop_l/t/r/b, volume, mute,
 *                     fade_in/out, vfade_in/out } (see vts/fx.py).
 *           kf    = [{ t, x, y, scale, opacity }, ...] with t relative to the
 *                   clip start; animates the transform, evaluated by evalFxAt().
 *   aud   = { id, src, atrack, start, end, in, name, fx }
 *           A sound-only item on an audio lane A1..An. Several may play at
 *           once: audio lanes MIX instead of stacking.
 *   cap   = { id, lane, start, end, text, style }   caption on a lane
 *
 * clip.in is the source time that plays at clip.start; captions have no `in`.
 * Every function returns a new timeline and never changes its input.
 */
(function (root) {
  "use strict";

  const MAIN_SRC = "src";      // asset id of the video the project opened
  const MIN_LEN = 0.05;   // shortest clip or caption, in seconds
  const EPS = 1e-6;
  const MAX_VTRACKS = 64;   // lanes grow on demand, like captions
  const MAX_ATRACKS = 64;
  const KF_KEYS = ["x", "y", "scale", "opacity"];
  let seq = 0;

  const DEFAULT_FX = {
    x: 0, y: 0, scale: 100, opacity: 100,
    crop_l: 0, crop_t: 0, crop_r: 0, crop_b: 0,
    volume: 100, mute: false,
    fade_in: 0, fade_out: 0, vfade_in: 0, vfade_out: 0,
    fit: "fill",
  };
  const FIT_MODES = ["fill", "contain", "cover"];

  function newId(prefix) {
    seq += 1;
    return `${prefix}${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const isClip = (it) => it.in !== undefined;
  const isAudioItem = (it) => !!(it && it.in !== undefined && it.atrack !== undefined);
  const prefixOf = (it) => (isAudioItem(it) ? "n" : isClip(it) ? "c" : "t");
  // Which array an item lives in. Clips and audio items both carry `in`.
  const bucketOf = (it) => (isAudioItem(it) ? "auds" : isClip(it) ? "clips" : "caps");
  const overlaps = (a, b) => a.start < b.end - EPS && b.start < a.end - EPS;
  const byStart = (a, b) => a.start - b.start || a.end - b.end;
  const clamp = (x, lo, hi) => (hi < lo ? lo : Math.min(hi, Math.max(lo, x)));
  const num = (v, dflt) => (Number.isFinite(Number(v)) ? Number(v) : dflt);

  function trackOf(it) {
    const t = Math.floor(num(it && it.track, 0));
    return Math.max(0, Math.min(MAX_VTRACKS - 1, t));
  }

  function atrackOf(it) {
    const t = Math.floor(num(it && it.atrack, 0));
    return Math.max(0, Math.min(MAX_ATRACKS - 1, t));
  }

  function vtracksOf(tl) {
    let n = Math.max(1, Math.floor(num(tl && tl.vtracks, 1)) || 1);
    for (const c of (tl && tl.clips) || []) n = Math.max(n, trackOf(c) + 1);
    return Math.min(MAX_VTRACKS, n);
  }

  function atracksOf(tl) {
    let n = Math.max(1, Math.floor(num(tl && tl.atracks, 1)) || 1);
    for (const a of (tl && tl.auds) || []) n = Math.max(n, atrackOf(a) + 1);
    // A1..An mirror V1..Vn so every video clip has a lane for its sound.
    return Math.min(MAX_ATRACKS, Math.max(n, vtracksOf(tl)));
  }

  // ------------------------------------------------------------ effects

  function defaultFx() { return { ...DEFAULT_FX }; }

  function cleanFx(raw) {
    const s = (raw && typeof raw === "object") ? raw : {};
    const fx = defaultFx();
    fx.x = r3(clamp(num(s.x, 0), -100, 100));
    fx.y = r3(clamp(num(s.y, 0), -100, 100));
    fx.scale = r3(clamp(num(s.scale, 100), 1, 400));
    fx.opacity = r3(clamp(num(s.opacity, 100), 0, 100));
    for (const k of ["crop_l", "crop_t", "crop_r", "crop_b"]) {
      fx[k] = r3(clamp(num(s[k], 0), 0, 45));
    }
    if (fx.crop_l + fx.crop_r >= 90) {
      const over = (fx.crop_l + fx.crop_r - 89) / 2;
      fx.crop_l = r3(Math.max(0, fx.crop_l - over));
      fx.crop_r = r3(Math.max(0, fx.crop_r - over));
    }
    if (fx.crop_t + fx.crop_b >= 90) {
      const over = (fx.crop_t + fx.crop_b - 89) / 2;
      fx.crop_t = r3(Math.max(0, fx.crop_t - over));
      fx.crop_b = r3(Math.max(0, fx.crop_b - over));
    }
    fx.volume = r3(clamp(num(s.volume, 100), 0, 400));
    fx.mute = !!s.mute;
    for (const k of ["fade_in", "fade_out", "vfade_in", "vfade_out"]) {
      fx[k] = r3(Math.max(0, num(s[k], 0)));
    }
    // fill = stretch to the box, contain = letterbox inside it, cover = crop.
    const fit = String(s.fit || "fill").toLowerCase();
    fx.fit = FIT_MODES.includes(fit) ? fit : "fill";
    return fx;
  }

  function fxIsDefault(fx) {
    if (!fx) return true;
    const c = cleanFx(fx);
    return Object.keys(DEFAULT_FX).every((k) => c[k] === DEFAULT_FX[k]);
  }

  function cleanKf(raw, clipLen) {
    const len = Math.max(0, num(clipLen, 0));
    if (!Array.isArray(raw)) return [];
    const seen = new Map();
    for (const item of raw.slice(0, 64)) {
      if (!item || typeof item !== "object") continue;
      const t = r3(clamp(num(item.t, -1), 0, len));
      if (!(t >= 0)) continue;
      seen.set(t, {
        t,
        x: r3(clamp(num(item.x, DEFAULT_FX.x), -100, 100)),
        y: r3(clamp(num(item.y, DEFAULT_FX.y), -100, 100)),
        scale: r3(clamp(num(item.scale, DEFAULT_FX.scale), 1, 400)),
        opacity: r3(clamp(num(item.opacity, DEFAULT_FX.opacity), 0, 100)),
      });
    }
    return [...seen.keys()].sort((a, b) => a - b).map((t) => seen.get(t));
  }

  // Effective transform at an absolute timeline time: base fx with x/y/scale/
  // opacity interpolated linearly through the keyframes. Mirrors vts/fx.py.
  function evalFxAt(clip, tAbs) {
    const fx = cleanFx(clip && clip.fx);
    const len = Math.max(0, (clip ? clip.end - clip.start : 0) || 0);
    const keys = cleanKf(clip && clip.kf, len);
    if (!keys.length) return fx;
    const t = clamp(num(tAbs, 0) - (clip ? clip.start : 0), 0, len);
    const snap = (k) => {
      const o = {};
      for (const key of KF_KEYS) o[key] = num(k[key], fx[key]);
      return o;
    };
    if (t <= keys[0].t + EPS) return { ...fx, ...snap(keys[0]) };
    if (t >= keys[keys.length - 1].t - EPS) return { ...fx, ...snap(keys[keys.length - 1]) };
    for (let i = 0; i + 1 < keys.length; i += 1) {
      const a = keys[i], b = keys[i + 1];
      if (t >= a.t - EPS && t <= b.t + EPS) {
        const span = b.t - a.t;
        const f = span > 1e-9 ? (t - a.t) / span : 0;
        const sa = snap(a), sb = snap(b), o = {};
        for (const key of KF_KEYS) o[key] = r3(sa[key] + (sb[key] - sa[key]) * f);
        return { ...fx, ...o };
      }
    }
    return { ...fx, ...snap(keys[keys.length - 1]) };
  }

  // Audio/video fade envelopes at an absolute timeline time, 0..1.
  function fadeEnv(clip, tAbs) {
    const fx = cleanFx(clip && clip.fx);
    const t = num(tAbs, 0) - (clip ? clip.start : 0);
    const len = Math.max(0, (clip ? clip.end - clip.start : 0) || 0);
    const env = (fi, fo) => {
      let e = 1;
      if (fi > 0.001 && t < fi) e = Math.min(e, Math.max(0, t / fi));
      if (fo > 0.001 && t > len - fo) e = Math.min(e, Math.max(0, (len - t) / fo));
      return e;
    };
    return { audio: env(fx.fade_in, fx.fade_out), video: env(fx.vfade_in, fx.vfade_out) };
  }

  function withClipFx(piece, src) {
    piece.fx = clone(src.fx || defaultFx());
    piece.kf = clone(src.kf || []);
    return piece;
  }

  // Keyframes surviving in a piece that covers [pieceStart, pieceStart+len]
  // of the source clip, shifted to piece-relative time.
  function kfForPiece(kf, pieceStartRel, pieceLen) {
    const out = [];
    for (const k of kf || []) {
      const t = num(k && k.t, -1) - pieceStartRel;
      if (t < -EPS || t > pieceLen + EPS) continue;
      out.push({ ...clone(k), t: r3(clamp(t, 0, pieceLen)) });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  function emptyTimeline() {
    return { clips: [], auds: [], caps: [], lanes: 1, vtracks: 1, atracks: 1 };
  }

  function normalise(tl) {
    const out = clone(tl || {});
    if (!Array.isArray(out.clips)) out.clips = [];
    if (!Array.isArray(out.auds)) out.auds = [];
    if (!Array.isArray(out.caps)) out.caps = [];
    out.lanes = Math.max(1, num(out.lanes, 1));
    out.vtracks = vtracksOf(out);
    out.atracks = atracksOf(out);
    return out;
  }

  function clipsFromSource(duration, src) {
    if (!(duration > 0)) return [];
    return [{
      id: newId("c"), src: src || MAIN_SRC, track: 0,
      start: 0, end: r3(duration), in: 0,
      kind: null, text: "", fx: defaultFx(), kf: [], audio: true,
    }];
  }

  // Detection sections (source time == timeline time before any edit).
  function clipsFromSections(sections, duration, src) {
    const list = (sections || [])
      .filter((s) => s.end - s.start > EPS)
      .map((s) => ({
        id: newId("c"), src: src || MAIN_SRC, track: 0,
        start: r3(s.start), end: r3(s.end), in: r3(s.start),
        kind: s.kind || null, text: s.text || "", fx: defaultFx(), kf: [], audio: true,
      }));
    return list.length ? list : clipsFromSource(duration, src);
  }

  // First-fit lane assignment so captions that overlap stack on new lanes.
  function assignLanes(caps) {
    const lastEnd = [];
    for (const c of caps.slice().sort(byStart)) {
      let lane = lastEnd.findIndex((e) => e <= c.start + EPS);
      if (lane < 0) {
        lane = lastEnd.length;
        lastEnd.push(0);
      }
      lastEnd[lane] = c.end;
      c.lane = lane;
    }
    return Math.max(1, lastEnd.length);
  }

  // Map source-time cues onto the timeline through the V1 clips. A cue that
  // crosses a cut is split into pieces; parts in removed time are dropped.
  function capsFromCues(clips, cues) {
    const sorted = clips.filter((k) => trackOf(k) === 0).sort(byStart);
    const caps = [];
    for (const cue of cues || []) {
      const cs = Number(cue.start);
      const ce = Number(cue.end);
      if (!(ce > cs)) continue;
      const text = String(cue.text || "").trim();
      for (const k of sorted) {
        const srcEnd = k.in + (k.end - k.start);
        const a = Math.max(cs, k.in);
        const b = Math.min(ce, srcEnd);
        if (b - a < MIN_LEN - EPS) continue;
        caps.push({
          id: newId("t"), lane: 0,
          start: r3(k.start + (a - k.in)), end: r3(k.start + (b - k.in)),
          text, style: cue.style ? clone(cue.style) : null,
        });
      }
    }
    const lanes = assignLanes(caps);
    return { caps, lanes };
  }

  // ---------------------------------------------------------- primitives

  // Split items that straddle t. `only` (a Set of ids) limits which items split.
  function splitArr(arr, t, only) {
    const out = [];
    for (const it of arr) {
      const ok = (!only || only.has(it.id)) &&
        t > it.start + EPS && t < it.end - EPS &&
        t - it.start >= MIN_LEN - EPS && it.end - t >= MIN_LEN - EPS;
      if (!ok) {
        out.push(it);
        continue;
      }
      const left = { ...it, end: r3(t) };
      const right = { ...it, id: newId(prefixOf(it)), start: r3(t) };
      if (isClip(it)) {
        const rel = t - it.start;
        right.in = r3(it.in + rel);
        withClipFx(left, it);
        withClipFx(right, it);
        if (isAudioItem(it)) {
          // Audio has no keyframes, but keep the fx/fade split honest.
          left.fx = clone(it.fx || defaultFx());
          right.fx = clone(it.fx || defaultFx());
        } else {
          left.kf = kfForPiece(it.kf, 0, rel);
          right.kf = kfForPiece(it.kf, rel, it.end - t);
          // A keyframe exactly on the cut belongs to both halves.
          for (const k of it.kf || []) {
            if (Math.abs(num(k && k.t, -1) - rel) <= EPS) {
              const kc = clone(k);
              if (!left.kf.some((q) => Math.abs(q.t - kc.t) <= EPS)) left.kf.push({ ...kc });
              if (!right.kf.some((q) => q.t <= EPS)) right.kf.unshift({ ...kc, t: 0 });
            }
          }
        }
      }
      out.push(left, right);
    }
    return out;
  }

  // Move everything at or after t by span (used by insert).
  function shiftArr(arr, t, span) {
    return arr.map((it) => (it.start >= t - EPS
      ? { ...it, start: r3(it.start + span), end: r3(it.end + span) }
      : it));
  }

  function mergeRanges(ranges) {
    const sorted = ranges.filter(([a, b]) => b - a > EPS).sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const [a, b] of sorted) {
      const last = out[out.length - 1];
      if (last && a <= last[1] + EPS) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  }

  function removedBefore(merged, x) {
    let total = 0;
    for (const [a, b] of merged) {
      if (x <= a) break;
      total += Math.min(x, b) - a;
    }
    return total;
  }

  // Ripple: cut the ranges out of the time line and close the gaps.
  function rippleArr(arr, ranges) {
    const merged = mergeRanges(ranges);
    if (!merged.length) return arr;
    const out = [];
    for (const it of arr) {
      const kept = [];
      let cur = it.start;
      for (const [a, b] of merged) {
        if (b <= cur + EPS) continue;
        if (a >= it.end - EPS) break;
        if (a > cur + EPS) kept.push([cur, Math.min(a, it.end)]);
        cur = Math.max(cur, b);
        if (cur >= it.end - EPS) break;
      }
      if (cur < it.end - EPS) kept.push([cur, it.end]);
      kept.forEach(([s, e], i) => {
        if (e - s < 1e-3) return;
        const piece = {
          ...it,
          id: i === 0 ? it.id : newId(prefixOf(it)),
          start: r3(s - removedBefore(merged, s)),
          end: r3(e - removedBefore(merged, e)),
        };
        if (isClip(it)) {
          piece.in = r3(it.in + (s - it.start));
          withClipFx(piece, it);
          if (!isAudioItem(it)) piece.kf = kfForPiece(it.kf, s - it.start, e - s);
          else piece.kf = [];
        }
        out.push(piece);
      });
    }
    return out;
  }

  // Place a clip on its track, or on the lowest track where it fits.
  // Video lanes never overwrite: a clash restacks onto a free lane, which is
  // what turns "drop this here" into a real overlay on the track above.
  function placeClip(list, clip) {
    const want = trackOf(clip);
    const clash = (track) => list.some((o) => trackOf(o) === track && overlaps(o, clip));
    if (!clash(want)) return clip;
    let track = 0;
    while (clash(track)) track += 1;
    return { ...clip, track: Math.min(track, MAX_VTRACKS - 1) };
  }

  // Audio lanes mix: overlapping sounds are allowed on the same lane.
  function placeAudio(list, item) {
    return { ...item, atrack: atrackOf(item) };
  }

  // Place a caption on its lane, or on the lowest lane where it fits.
  function placeCap(list, cap) {
    const clash = (lane) => list.some((o) => o.lane === lane && overlaps(o, cap));
    if (!clash(cap.lane)) return cap;
    let lane = 0;
    while (clash(lane)) lane += 1;
    return { ...cap, lane };
  }

  function lanesOf(tl) {
    return Math.max(1, tl.lanes || 1, ...tl.caps.map((c) => c.lane + 1));
  }

  // ------------------------------------------------------------ operations

  // Razor: cut items that straddle t. With ids, only those items are cut.
  function splitSelection(tl, t, ids) {
    const out = normalise(tl);
    const only = ids && ids.length ? new Set(ids) : null;
    out.clips = splitArr(out.clips, t, only);
    out.auds = splitArr(out.auds, t, only);
    out.caps = splitArr(out.caps, t, only);
    out.vtracks = vtracksOf(out);
    out.atracks = atracksOf(out);
    return out;
  }

  // ripple=false ("lift") leaves a gap. ripple=true closes it on every track.
  function deleteItems(tl, ids, ripple) {
    const out = normalise(tl);
    const sel = new Set(ids);
    const gone = [...out.clips, ...out.auds, ...out.caps].filter((it) => sel.has(it.id));
    const goneClips = gone.filter((it) => bucketOf(it) === "clips");
    const goneAudio = gone.filter(isAudioItem);
    const goneCaps = gone.filter((it) => bucketOf(it) === "caps");
    out.clips = out.clips.filter((c) => !sel.has(c.id));
    out.auds = out.auds.filter((c) => !sel.has(c.id));
    out.caps = out.caps.filter((c) => !sel.has(c.id));
    if (ripple) {
      if (goneClips.length) {
        const ranges = goneClips.map((c) => [c.start, c.end]);
        out.clips = rippleArr(out.clips, ranges);
        out.auds = rippleArr(out.auds, ranges);   // sound follows the picture
        out.caps = rippleArr(out.caps, ranges);   // captions follow the picture
      } else {
        const ranges = [...goneAudio, ...goneCaps].map((c) => [c.start, c.end]);
        if (goneAudio.length) out.auds = rippleArr(out.auds, ranges);
        if (goneCaps.length) out.caps = rippleArr(out.caps, ranges);
      }
    }
    out.vtracks = vtracksOf(out);
    out.atracks = atracksOf(out);
    return out;
  }

  // Move the selected items by dt seconds. Video clips restack onto a free
  // lane when their lane is taken (nothing is ever overwritten); audio items
  // overlap freely because lanes mix. dVTrack shifts video lanes, dATrack
  // audio lanes, dLane caption lanes.
  function moveItems(tl, ids, dt, dLane, dVTrack, dATrack) {
    const out = normalise(tl);
    const sel = new Set(ids);
    const movedClips = out.clips.filter((c) => sel.has(c.id));
    const movedAuds = out.auds.filter((c) => sel.has(c.id));
    const movedCaps = out.caps.filter((c) => sel.has(c.id));
    const all = movedClips.concat(movedAuds, movedCaps);
    if (!all.length) return out;
    const lowest = Math.min(...all.map((c) => c.start));
    const shift = r3(Math.max(dt, -lowest));
    const dv = Math.round(num(dVTrack, 0));
    const da = Math.round(num(dATrack, dv));
    out.clips = out.clips.filter((c) => !sel.has(c.id));
    out.auds = out.auds.filter((c) => !sel.has(c.id));
    out.caps = out.caps.filter((c) => !sel.has(c.id));
    for (const c of movedClips) {
      const moved = {
        ...c,
        start: r3(c.start + shift), end: r3(c.end + shift),
        track: clamp(trackOf(c) + dv, 0, MAX_VTRACKS - 1),
      };
      out.clips.push(placeClip(out.clips, moved));
    }
    out.clips.sort(byStart);
    for (const c of movedAuds) {
      const moved = {
        ...c,
        start: r3(Math.max(0, c.start + shift)), end: r3(Math.max(MIN_LEN, c.end + shift)),
        atrack: clamp(atrackOf(c) + da, 0, MAX_ATRACKS - 1),
      };
      out.auds.push(placeAudio(out.auds, moved));
    }
    out.auds.sort(byStart);
    for (const c of movedCaps) {
      const moved = {
        ...c, start: r3(c.start + shift), end: r3(c.end + shift),
        lane: Math.max(0, c.lane + (dLane || 0)),
      };
      out.caps.push(placeCap(out.caps, moved));
    }
    out.lanes = lanesOf(out);
    out.vtracks = vtracksOf(out);
    out.atracks = atracksOf(out);
    return out;
  }

  // Trim one edge ('l' or 'r') of a clip, audio item or caption to time t.
  function trimItem(tl, id, edge, t, srcDur) {
    const out = normalise(tl);
    let arr = null;
    if (out.clips.some((c) => c.id === id)) arr = out.clips;
    else if (out.auds.some((c) => c.id === id)) arr = out.auds;
    else arr = out.caps;
    const it = arr.find((c) => c.id === id);
    if (!it || !Number.isFinite(t)) return out;
    const isAud = isAudioItem(it);
    const isC = isClip(it);
    const others = arr.filter((c) => {
      if (c.id === id) return false;
      if (isAud) return c.atrack !== undefined;            // audio lanes mix
      if (isC) return trackOf(c) === trackOf(it);
      return c.lane === it.lane;
    });
    const prevEnd = Math.max(0, ...others.filter((o) => o.end <= it.start + EPS).map((o) => o.end));
    const nextStart = Math.min(Infinity, ...others.filter((o) => o.start >= it.end - EPS).map((o) => o.start));
    if (edge === "l") {
      let lo = isAud ? 0 : prevEnd;
      if (isC) lo = Math.max(lo, it.start - it.in);
      const oldStart = it.start;
      const ns = clamp(t, lo, it.end - MIN_LEN);
      if (isC) {
        it.in = r3(it.in + (ns - it.start));
        if (!isAud) it.kf = kfForPiece(it.kf, ns - oldStart, it.end - ns);
      }
      it.start = r3(ns);
    } else {
      let hi = isAud ? Infinity : nextStart;
      if (isC) hi = Math.min(hi, it.start + (srcDur - it.in));
      const ne = clamp(t, it.start + MIN_LEN, hi);
      if (isC && !isAud) it.kf = kfForPiece(it.kf, 0, ne - it.start);
      it.end = r3(ne);
    }
    out.vtracks = vtracksOf(out);
    out.atracks = atracksOf(out);
    return out;
  }

  function copyItems(tl, ids) {
    const items = [...(tl.clips || []), ...(tl.auds || []), ...(tl.caps || [])]
      .filter((it) => new Set(ids).has(it.id));
    if (!items.length) return null;
    const base = Math.min(...items.map((it) => it.start));
    return {
      items: clone(items).map((it) => ({ ...it, start: r3(it.start - base), end: r3(it.end - base) })),
    };
  }

  // Paste at time `at`. insert=true opens a gap first (ripple paste);
  // otherwise pasted clips restack onto free lanes like captions.
  function pasteItems(tl, clipboard, at, insert) {
    const out = normalise(tl);
    const ids = [];
    if (!clipboard || !clipboard.items || !clipboard.items.length) return { tl: out, ids };
    const items = clipboard.items;
    const t0 = r3(at);
    const span = Math.max(...items.map((it) => it.end)) - Math.min(...items.map((it) => it.start));
    if (insert) {
      if (items.some((it) => bucketOf(it) === "clips")) {
        out.clips = shiftArr(splitArr(out.clips, t0), t0, span);
        out.auds = shiftArr(splitArr(out.auds, t0), t0, span);
      }
      out.caps = shiftArr(splitArr(out.caps, t0), t0, span);
    }
    for (const it of items) {
      const copy = { ...it, id: newId(prefixOf(it)), start: r3(t0 + it.start), end: r3(t0 + it.end) };
      if (isAudioItem(copy)) copy.atrack = atrackOf(copy);
      else if (isClip(copy)) copy.track = trackOf(copy);
      ids.push(copy.id);
      if (isAudioItem(it)) out.auds.push(placeAudio(out.auds, copy));
      else if (isClip(it)) out.clips.push(insert ? copy : placeClip(out.clips, copy));
      else out.caps.push(placeCap(out.caps, copy));
    }
    out.clips.sort(byStart);
    out.auds.sort(byStart);
    out.lanes = lanesOf(out);
    out.vtracks = vtracksOf(out);
    out.atracks = atracksOf(out);
    return { tl: out, ids };
  }

  // Alt-drag: copies of the selection land dt seconds later (overwriting).
  function duplicateItems(tl, ids, dt) {
    const clipboard = copyItems(tl, ids);
    if (!clipboard) return { tl: normalise(tl), ids: [] };
    const sel = new Set(ids);
    const pool = [...(tl.clips || []), ...(tl.auds || []), ...(tl.caps || [])];
    const first = Math.min(...pool.filter((it) => sel.has(it.id)).map((it) => it.start));
    return pasteItems(tl, clipboard, Math.max(0, first + dt), false);
  }

  function addCaption(tl, at, text, style, lane) {
    const out = normalise(tl);
    const cap = {
      id: newId("t"), lane: lane || 0, start: r3(at), end: r3(at + 2),
      text, style: style ? clone(style) : null,
    };
    const placed = placeCap(out.caps, cap);
    out.caps.push(placed);
    out.lanes = lanesOf(out);
    return { tl: out, id: cap.id };
  }

  // ------------------------------------------------------------ media bin

  // A clip built from a bin asset. `at` is the timeline drop point and
  // `track` the lane it was dropped on; clashes restack one lane up, which is
  // exactly the B-roll gesture (a clip dropped over V1 lands on V2).
  function makeClip(asset, at, track, opts) {
    const o = opts || {};
    const dur = o.duration !== undefined ? Math.max(MIN_LEN, o.duration)
      : Math.max(MIN_LEN, Number(asset.duration) || MIN_LEN);
    return {
      id: newId("c"),
      src: asset.id,
      track: Math.max(0, Math.min(MAX_VTRACKS - 1, track || 0)),
      start: r3(Math.max(0, at)),
      end: r3(Math.max(0, at) + dur),
      in: r3(Math.max(0, o.in || 0)),
      kind: null,
      text: "",
      fx: defaultFx(),
      kf: [],
      audio: asset.has_audio !== false && asset.kind !== "image",
      name: asset.name || "",
    };
  }

  function makeAudioItem(asset, at, atrack, opts) {
    const o = opts || {};
    const dur = o.duration !== undefined ? Math.max(MIN_LEN, o.duration)
      : Math.max(MIN_LEN, Number(asset.duration) || MIN_LEN);
    return {
      id: newId("n"),
      src: asset.id,
      atrack: Math.max(0, Math.min(MAX_ATRACKS - 1, atrack || 0)),
      start: r3(Math.max(0, at)),
      end: r3(Math.max(0, at) + dur),
      in: r3(Math.max(0, o.in || 0)),
      name: asset.name || "",
      fx: defaultFx(),
    };
  }

  // Drop a bin asset on the timeline. Video/image -> a clip on V tracks,
  // audio-only -> an item on A tracks. Returns { tl, id, moved }.
  function addMedia(tl, asset, at, track, opts) {
    const out = normalise(tl);
    const want = Math.max(0, track || 0);
    if (asset.kind === "audio") {
      const item = makeAudioItem(asset, at, want, opts);
      out.auds.push(placeAudio(out.auds, item));
      out.auds.sort(byStart);
      out.atracks = atracksOf(out);
      return { tl: out, id: item.id, moved: 0 };
    }
    const clip = makeClip(asset, at, want, opts);
    const placed = placeClip(out.clips, clip);
    out.clips.push(placed);
    out.clips.sort(byStart);
    out.vtracks = vtracksOf(out);
    out.atracks = atracksOf(out);
    return { tl: out, id: placed.id, moved: placed.track - want };
  }

  // Lowest lane with room at [start, end] (used by the bin's "add at playhead").
  function firstFreeTrack(clips, start, end) {
    const s = r3(start), e = r3(Math.max(end, s + MIN_LEN));
    let track = 0;
    while (clips.some((c) => trackOf(c) === track && overlaps(c, { start: s, end: e }))) {
      track += 1;
      if (track >= MAX_VTRACKS - 1) break;
    }
    return track;
  }

  // --------------------------------------------------------- linked audio

  // Unlink a clip's sound: the picture stays, the sound becomes a free
  // standing item on the same-numbered audio lane the user can move.
  function unlinkClipAudio(tl, clipId) {
    const out = normalise(tl);
    const clip = out.clips.find((c) => c.id === clipId);
    if (!clip) return { tl: out, id: null };
    const src = clip.src || MAIN_SRC;
    const item = {
      id: newId("n"),
      src,
      atrack: trackOf(clip),
      start: r3(clip.start),
      end: r3(clip.end),
      in: r3(clip.in),
      name: clip.name || "",
      fx: cleanFx({ ...(clip.fx || {}), x: 0, y: 0, scale: 100, opacity: 100,
        crop_l: 0, crop_t: 0, crop_r: 0, crop_b: 0,
        vfade_in: 0, vfade_out: 0 }),
      from: clipId,
    };
    clip.audio = false;
    out.auds.push(placeAudio(out.auds, item));
    out.auds.sort(byStart);
    out.atracks = atracksOf(out);
    return { tl: out, id: item.id };
  }

  // Put the sound back on the picture (drops the unlinked audio item).
  function relinkClipAudio(tl, clipId) {
    const out = normalise(tl);
    const clip = out.clips.find((c) => c.id === clipId);
    if (!clip) return out;
    clip.audio = true;
    out.auds = out.auds.filter((a) => !(a.from === clipId));
    out.atracks = atracksOf(out);
    return out;
  }

  // The audio item a clip's sound was unlinked into, if any.
  function linkedAudioOf(tl, clipId) {
    return (tl.auds || []).find((a) => a.from === clipId) || null;
  }

  // Rename a clip. Captions on the timeline that carry the clip's old text and
  // lie inside its range are renamed too (detection makes the two match).
  function setClipText(tl, clipId, text) {
    const out = normalise(tl);
    const clip = out.clips.find((c) => c.id === clipId);
    if (!clip) return out;
    const old = clip.text || "";
    clip.text = String(text || "");
    if (old) {
      for (const cap of out.caps) {
        if (cap.text === old && cap.start < clip.end - EPS && cap.end > clip.start + EPS) {
          cap.text = clip.text;
        }
      }
    }
    return out;
  }

  // Rename one timeline caption. A matching section label in the same time
  // range follows it, mirroring setClipText() in the other direction.
  function setCaptionText(tl, captionId, text) {
    const out = normalise(tl);
    const cap = out.caps.find((c) => c.id === captionId);
    if (!cap) return out;
    const old = cap.text || "";
    cap.text = String(text || "");
    if (old) {
      for (const clip of out.clips) {
        if (clip.text === old && clip.start < cap.end - EPS && clip.end > cap.start + EPS) {
          clip.text = cap.text;
        }
      }
    }
    return out;
  }

  function timelineEnd(tl) {
    return (tl.clips || []).reduce((m, c) => Math.max(m, c.end), 0);
  }

  // Everything that makes the timeline longer: picture, sound, captions.
  function contentEnd(tl) {
    return Math.max(
      (tl.clips || []).reduce((m, c) => Math.max(m, c.end), 0),
      (tl.auds || []).reduce((m, c) => Math.max(m, c.end), 0),
      (tl.caps || []).reduce((m, c) => Math.max(m, c.end), 0),
      0,
    );
  }

  // Topmost clip under t (highest track wins); null in gaps.
  function clipAt(tl, t) {
    const stack = clipStackAt(tl, t);
    return stack.length ? stack[stack.length - 1] : null;
  }

  // Every clip under t, lowest track first. This is the composite stack the
  // program monitor draws and the export renders.
  function clipStackAt(tl, t) {
    return (tl.clips || [])
      .filter((c) => t >= c.start - EPS && t < c.end - EPS)
      .sort((a, b) => trackOf(a) - trackOf(b) || a.start - b.start);
  }

  // Audio items under t (all lanes; they mix).
  function audioStackAt(tl, t) {
    return (tl.auds || [])
      .filter((a) => t >= a.start - EPS && t < a.end - EPS)
      .sort((a, b) => atrackOf(a) - atrackOf(b) || a.start - b.start);
  }

  // Flatten overlapping lanes into one virtual track (highest lane wins),
  // the picture a "flattened" export would show. Kept for the fast copy path
  // and the tests; the exporter composites instead (see vts/edl.py).
  function flattenClips(clips) {
    const list = clips || [];
    const bounds = [...new Set(list.flatMap((c) => [r3(c.start), r3(c.end)]))].sort((a, b) => a - b);
    const wins = [];
    for (let i = 0; i + 1 < bounds.length; i += 1) {
      const s = bounds[i], e = bounds[i + 1];
      if (e - s < 1e-3) continue;
      const covering = list.filter((c) => c.start <= s + 1e-6 && c.end >= e - 1e-6);
      if (!covering.length) continue;   // a gap; preview/export show black
      covering.sort((a, b) => trackOf(a) - trackOf(b) || a.start - b.start);
      wins.push({ s, e, clip: covering[covering.length - 1] });
    }
    const merged = [];
    for (const w of wins) {
      const last = merged[merged.length - 1];
      if (last && last.clip.id === w.clip.id && Math.abs(last.e - w.s) < 1e-6) last.e = w.e;
      else merged.push({ ...w });
    }
    return merged.map((p) => {
      const c = p.clip;
      const rel = p.s - c.start;
      return {
        start: r3(p.s), end: r3(p.e), in: r3(c.in + rel),
        fx: clone(c.fx || defaultFx()),
        kf: kfForPiece(c.kf, rel, p.e - p.s),
        from: c.id,
      };
    });
  }

  // Problems in a timeline (empty array = consistent). Used by the tests.
  function validate(tl) {
    const problems = [];
    const t = normalise(tl);
    const clips = t.clips.slice().sort((a, b) => trackOf(a) - trackOf(b) || a.start - b.start);
    for (let i = 1; i < clips.length; i += 1) {
      if (trackOf(clips[i - 1]) === trackOf(clips[i]) && overlaps(clips[i - 1], clips[i])) {
        problems.push(`clips ${clips[i - 1].id} and ${clips[i].id} overlap on V${trackOf(clips[i]) + 1}`);
      }
    }
    for (const c of clips) {
      if (c.end - c.start < MIN_LEN - EPS) problems.push(`clip ${c.id} is too short`);
      if (c.in < -EPS) problems.push(`clip ${c.id} has a negative in point`);
    }
    for (const a of t.auds) {
      if (a.end - a.start < MIN_LEN - EPS) problems.push(`audio item ${a.id} is too short`);
      if (a.in < -EPS) problems.push(`audio item ${a.id} has a negative in point`);
      if (a.atrack === undefined) problems.push(`audio item ${a.id} has no lane`);
    }
    for (let i = 0; i < t.caps.length; i += 1) {
      for (let j = i + 1; j < t.caps.length; j += 1) {
        const a = t.caps[i];
        const b = t.caps[j];
        if (a.lane === b.lane && overlaps(a, b)) problems.push(`captions ${a.id} and ${b.id} overlap`);
      }
    }
    return problems;
  }

  const api = {
    MAIN_SRC, MIN_LEN, MAX_VTRACKS, MAX_ATRACKS, DEFAULT_FX, FIT_MODES, newId, clone,
    isClip, isAudioItem, bucketOf, prefixOf, trackOf, atrackOf,
    vtracksOf, atracksOf, normalise,
    defaultFx, cleanFx, fxIsDefault, cleanKf, evalFxAt, fadeEnv,
    emptyTimeline, clipsFromSource, clipsFromSections,
    capsFromCues, assignLanes, splitSelection, deleteItems, moveItems, trimItem,
    copyItems, pasteItems, duplicateItems, addCaption, setClipText, setCaptionText,
    timelineEnd, contentEnd, clipAt, clipStackAt, audioStackAt, flattenClips,
    placeClip, placeAudio, placeCap, makeClip, makeAudioItem, addMedia,
    firstFreeTrack, unlinkClipAudio, relinkClipAudio, linkedAudioOf,
    mergeRanges, validate,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TLM = api;
})(typeof window !== "undefined" ? window : globalThis);
