/* Timeline model for Video Trim Studio. Pure functions: no DOM, no network.
 * Loaded by the browser (window.TLM) and by the Node tests (module.exports).
 *
 *   tl    = { clips: [...], caps: [...], lanes: n }
 *   clip  = { id, start, end, in, kind, text }      video from the one source file
 *   cap   = { id, lane, start, end, text, style }   caption on a lane
 *
 * clip.in is the source time that plays at clip.start; captions have no `in`.
 * Every function returns a new timeline and never changes its input.
 */
(function (root) {
  "use strict";

  const MIN_LEN = 0.05;   // shortest clip or caption, in seconds
  const EPS = 1e-6;
  let seq = 0;

  function newId(prefix) {
    seq += 1;
    return `${prefix}${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const isClip = (it) => it.in !== undefined;
  const prefixOf = (it) => (isClip(it) ? "c" : "t");
  const overlaps = (a, b) => a.start < b.end - EPS && b.start < a.end - EPS;
  const byStart = (a, b) => a.start - b.start || a.end - b.end;
  const clamp = (x, lo, hi) => (hi < lo ? lo : Math.min(hi, Math.max(lo, x)));

  function emptyTimeline() {
    return { clips: [], caps: [], lanes: 1 };
  }

  function clipsFromSource(duration) {
    if (!(duration > 0)) return [];
    return [{ id: newId("c"), start: 0, end: r3(duration), in: 0, kind: null, text: "" }];
  }

  // Detection sections (source time == timeline time before any edit).
  function clipsFromSections(sections, duration) {
    const list = (sections || [])
      .filter((s) => s.end - s.start > EPS)
      .map((s) => ({
        id: newId("c"), start: r3(s.start), end: r3(s.end), in: r3(s.start),
        kind: s.kind || null, text: s.text || "",
      }));
    return list.length ? list : clipsFromSource(duration);
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

  // Map source-time cues onto the timeline through the video clips. A cue that
  // crosses a cut is split into pieces; parts in removed time are dropped.
  function capsFromCues(clips, cues) {
    const sorted = clips.slice().sort(byStart);
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
      if (isClip(it)) right.in = r3(it.in + (t - it.start));
      out.push(left, right);
    }
    return out;
  }

  // Overwrite: remove [a, b] from every item (except ids in `except`).
  function carveArr(arr, a, b, except) {
    const out = [];
    for (const it of arr) {
      if ((except && except.has(it.id)) || it.end <= a + EPS || it.start >= b - EPS) {
        out.push(it);
        continue;
      }
      const parts = [];
      if (it.start < a - EPS) parts.push([it.start, a]);
      if (it.end > b + EPS) parts.push([b, it.end]);
      parts.forEach(([s, e], i) => {
        if (e - s < MIN_LEN - EPS) return;
        const piece = { ...it, id: i === 0 ? it.id : newId(prefixOf(it)), start: r3(s), end: r3(e) };
        if (isClip(it)) piece.in = r3(it.in + (s - it.start));
        out.push(piece);
      });
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
        if (isClip(it)) piece.in = r3(it.in + (s - it.start));
        out.push(piece);
      });
    }
    return out;
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
    const out = clone(tl);
    const only = ids && ids.length ? new Set(ids) : null;
    out.clips = splitArr(out.clips, t, only);
    out.caps = splitArr(out.caps, t, only);
    return out;
  }

  // ripple=false ("lift") leaves a gap. ripple=true closes it on every track.
  function deleteItems(tl, ids, ripple) {
    const out = clone(tl);
    const sel = new Set(ids);
    const gone = [...out.clips, ...out.caps].filter((it) => sel.has(it.id));
    const goneClips = gone.filter(isClip);
    const goneCaps = gone.filter((it) => !isClip(it));
    out.clips = out.clips.filter((c) => !sel.has(c.id));
    out.caps = out.caps.filter((c) => !sel.has(c.id));
    if (ripple) {
      if (goneClips.length) {
        const ranges = goneClips.map((c) => [c.start, c.end]);
        out.clips = rippleArr(out.clips, ranges);
        out.caps = rippleArr(out.caps, ranges);     // captions follow the picture
      } else if (goneCaps.length) {
        out.caps = rippleArr(out.caps, goneCaps.map((c) => [c.start, c.end]));
      }
    }
    return out;
  }

  // Move the selected items by dt seconds. Clips overwrite whatever is under
  // them; captions move to a free lane when their lane is taken.
  function moveItems(tl, ids, dt, dLane) {
    const out = clone(tl);
    const sel = new Set(ids);
    const movedClips = out.clips.filter((c) => sel.has(c.id));
    const movedCaps = out.caps.filter((c) => sel.has(c.id));
    const all = movedClips.concat(movedCaps);
    if (!all.length) return out;
    const lowest = Math.min(...all.map((c) => c.start));
    const shift = r3(Math.max(dt, -lowest));
    out.clips = out.clips.filter((c) => !sel.has(c.id));
    out.caps = out.caps.filter((c) => !sel.has(c.id));
    for (const c of movedClips) {
      const moved = { ...c, start: r3(c.start + shift), end: r3(c.end + shift) };
      out.clips = carveArr(out.clips, moved.start, moved.end, null);
      out.clips.push(moved);
    }
    out.clips.sort(byStart);
    for (const c of movedCaps) {
      const moved = {
        ...c, start: r3(c.start + shift), end: r3(c.end + shift),
        lane: Math.max(0, c.lane + (dLane || 0)),
      };
      out.caps.push(placeCap(out.caps, moved));
    }
    out.lanes = lanesOf(out);
    return out;
  }

  // Trim one edge ('l' or 'r') of a clip or caption to time t.
  function trimItem(tl, id, edge, t, srcDur) {
    const out = clone(tl);
    const isC = out.clips.some((c) => c.id === id);
    const arr = isC ? out.clips : out.caps;
    const it = arr.find((c) => c.id === id);
    if (!it || !Number.isFinite(t)) return out;
    const others = arr.filter((c) => c.id !== id && (isC || c.lane === it.lane));
    const prevEnd = Math.max(0, ...others.filter((o) => o.end <= it.start + EPS).map((o) => o.end));
    const nextStart = Math.min(Infinity, ...others.filter((o) => o.start >= it.end - EPS).map((o) => o.start));
    if (edge === "l") {
      let lo = prevEnd;
      if (isC) lo = Math.max(lo, it.start - it.in);
      const ns = clamp(t, lo, it.end - MIN_LEN);
      if (isC) it.in = r3(it.in + (ns - it.start));
      it.start = r3(ns);
    } else {
      let hi = nextStart;
      if (isC) hi = Math.min(hi, it.start + (srcDur - it.in));
      it.end = r3(clamp(t, it.start + MIN_LEN, hi));
    }
    return out;
  }

  function copyItems(tl, ids) {
    const sel = new Set(ids);
    const items = [...tl.clips, ...tl.caps].filter((it) => sel.has(it.id));
    if (!items.length) return null;
    const base = Math.min(...items.map((it) => it.start));
    return {
      items: clone(items).map((it) => ({ ...it, start: r3(it.start - base), end: r3(it.end - base) })),
    };
  }

  // Paste at time `at`. insert=true opens a gap first (ripple paste);
  // otherwise clips overwrite what is underneath.
  function pasteItems(tl, clipboard, at, insert) {
    const out = clone(tl);
    const ids = [];
    if (!clipboard || !clipboard.items || !clipboard.items.length) return { tl: out, ids };
    const items = clipboard.items;
    const t0 = r3(at);
    const span = Math.max(...items.map((it) => it.end)) - Math.min(...items.map((it) => it.start));
    if (insert) {
      if (items.some(isClip)) out.clips = shiftArr(splitArr(out.clips, t0), t0, span);
      out.caps = shiftArr(splitArr(out.caps, t0), t0, span);
    }
    for (const it of items) {
      const copy = { ...it, id: newId(prefixOf(it)), start: r3(t0 + it.start), end: r3(t0 + it.end) };
      ids.push(copy.id);
      if (isClip(it)) {
        if (!insert) out.clips = carveArr(out.clips, copy.start, copy.end, null);
        out.clips.push(copy);
      } else {
        out.caps.push(placeCap(out.caps, copy));
      }
    }
    out.clips.sort(byStart);
    out.lanes = lanesOf(out);
    return { tl: out, ids };
  }

  // Alt-drag: copies of the selection land dt seconds later (overwriting).
  function duplicateItems(tl, ids, dt) {
    const clipboard = copyItems(tl, ids);
    if (!clipboard) return { tl: clone(tl), ids: [] };
    const sel = new Set(ids);
    const first = Math.min(...[...tl.clips, ...tl.caps].filter((it) => sel.has(it.id)).map((it) => it.start));
    return pasteItems(tl, clipboard, Math.max(0, first + dt), false);
  }

  function addCaption(tl, at, text, style, lane) {
    const out = clone(tl);
    const cap = {
      id: newId("t"), lane: lane || 0, start: r3(at), end: r3(at + 2),
      text, style: style ? clone(style) : null,
    };
    const placed = placeCap(out.caps, cap);
    out.caps.push(placed);
    out.lanes = lanesOf(out);
    return { tl: out, id: cap.id };
  }

  // Rename a clip. Captions on the timeline that carry the clip's old text and
  // lie inside its range are renamed too (detection makes the two match).
  function setClipText(tl, clipId, text) {
    const out = clone(tl);
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

  function timelineEnd(tl) {
    return tl.clips.reduce((m, c) => Math.max(m, c.end), 0);
  }

  function clipAt(tl, t) {
    return tl.clips.find((c) => t >= c.start - EPS && t < c.end - EPS) || null;
  }

  // Problems in a timeline (empty array = consistent). Used by the tests.
  function validate(tl) {
    const problems = [];
    const clips = tl.clips.slice().sort(byStart);
    for (let i = 1; i < clips.length; i += 1) {
      if (overlaps(clips[i - 1], clips[i])) problems.push(`clips ${clips[i - 1].id} and ${clips[i].id} overlap`);
    }
    for (const c of tl.clips) {
      if (c.end - c.start < MIN_LEN - EPS) problems.push(`clip ${c.id} is too short`);
      if (c.in < -EPS) problems.push(`clip ${c.id} has a negative in point`);
    }
    for (let i = 0; i < tl.caps.length; i += 1) {
      for (let j = i + 1; j < tl.caps.length; j += 1) {
        const a = tl.caps[i];
        const b = tl.caps[j];
        if (a.lane === b.lane && overlaps(a, b)) problems.push(`captions ${a.id} and ${b.id} overlap`);
      }
    }
    return problems;
  }

  const api = {
    MIN_LEN, newId, clone, isClip, emptyTimeline, clipsFromSource, clipsFromSections,
    capsFromCues, assignLanes, splitSelection, deleteItems, moveItems, trimItem,
    copyItems, pasteItems, duplicateItems, addCaption, setClipText, timelineEnd, clipAt,
    mergeRanges, validate,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TLM = api;
})(typeof window !== "undefined" ? window : globalThis);
