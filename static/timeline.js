/* Timeline editor for the one video: the V1 clip row, caption lanes below it,
 * copy/cut/paste, split, move/trim, undo/redo, playback and the glue to
 * detection and export. Loaded before app.js and uses the state S defined there.
 * Editing rules live in timeline-model.js (window.TLM). */
"use strict";

const TL = { gut: 46, ruler: 20, vTop: 20, vH: 56, laneTop: 80, laneH: 22, laneGap: 3, wave: 12 };
const laneY = (i) => TL.laneTop + i * (TL.laneH + TL.laneGap);
const laneCount = () => Math.max(1, S.tl.lanes || 1);
const tlHeight = () => laneY(laneCount()) + 4;
const CLIP_FALLBACK = "#2b4f6b";
const PV = { playing: false, raf: 0, last: 0 };
let saveTimer = null;
let statusTimer = null;

/* ------------------------------------------------------------ small helpers */

function status(msg) {
  const el = $("tlStatus");
  if (!el) return;
  el.textContent = msg || "";
  clearTimeout(statusTimer);
  if (msg) statusTimer = setTimeout(() => { el.textContent = ""; }, 4000);
}

function playheadTime() { return S.T || 0; }
function timelineEnd() { return TLM.timelineEnd(S.tl); }

function contentEnd() {
  return Math.max(S.duration || 0, timelineEnd(), ...S.tl.caps.map((c) => c.end), 0);
}

function selectedIds() { return [...S.sel]; }

function syncCapSel() {
  const caps = [...S.sel].filter((id) => S.tl.caps.some((c) => c.id === id));
  S.capSel = caps.length ? caps[caps.length - 1] : null;
}

function niceStep(raw) {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-3))));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

function clampView() {
  const end = Math.max(contentEnd(), 0.05);
  S.view.span = Math.max(0.05, Math.min(S.view.span, end));
  S.view.start = Math.max(0, Math.min(S.view.start, Math.max(0, end - S.view.span)));
}

function clampStart(start, span) {
  return Math.max(0, Math.min(Math.max(0, contentEnd() - span), start));
}

function zoomBy(factor) {
  const center = S.view.start + S.view.span / 2;
  const span = Math.min(Math.max(contentEnd(), 1), Math.max(0.2, S.view.span * factor));
  S.view.span = span;
  S.view.start = clampStart(center - span / 2, span);
  draw();
}

/* ------------------------------------------------------------ geometry */

function plotWidth() { return Math.max(1, $("timeline").clientWidth - TL.gut); }
function pxPerSec() { return plotWidth() / Math.max(S.view.span, 1e-6); }
const t2x = (t) => TL.gut + ((t - S.view.start) / S.view.span) * plotWidth();
const x2t = (x) => S.view.start + ((x - TL.gut) / plotWidth()) * S.view.span;

function rowAt(y) {
  if (y < TL.ruler) return { kind: "ruler" };
  if (y >= TL.vTop && y < TL.vTop + TL.vH + 2) return { kind: "video" };
  if (y >= TL.laneTop) {
    const lane = Math.floor((y - TL.laneTop) / (TL.laneH + TL.laneGap));
    if (lane < laneCount()) return { kind: "lane", lane };
  }
  return { kind: "none" };
}

function itemsOnRow(row) {
  if (row.kind === "video") return S.tl.clips;
  if (row.kind === "lane") return S.tl.caps.filter((c) => c.lane === row.lane);
  return [];
}

function hitItem(row, x) {
  let best = null;
  for (const it of itemsOnRow(row)) {
    if (x >= t2x(it.start) - 3 && x <= t2x(it.end) + 3) best = it;
  }
  return best;
}

function edgeAt(it, x) {
  const xs = t2x(it.start), xe = t2x(it.end);
  if (xe - xs >= 14) {
    if (Math.abs(x - xs) <= 6) return "l";
    if (Math.abs(x - xe) <= 6) return "r";
  }
  return "move";
}

/* ------------------------------------------------------------ drawing */

function canvasGeo() {
  const cv = $("timeline");
  const w = cv.clientWidth;
  const h = tlHeight();
  const dpr = window.devicePixelRatio || 1;
  cv.style.height = `${h}px`;
  if (cv.width !== Math.floor(w * dpr) || cv.height !== Math.floor(h * dpr)) {
    cv.width = Math.floor(w * dpr);
    cv.height = Math.floor(h * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function roundRectPath(ctx, x, y, w, h, r) {
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function drawFilmstrip(ctx, c, x, x2, y, h) {
  const th = S.thumbs;
  if (!th || !(th.interval > 0) || x2 - x < 24) return;
  const first = Math.max(0, Math.floor(c.in / th.interval));
  const last = Math.min(th.count - 1, Math.ceil((c.in + (c.end - c.start)) / th.interval));
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, x2 - x, h);
  ctx.clip();
  for (let i = first; i <= last; i += 1) {
    const img = S.thumbImgs[i];
    if (!img || !img.complete || !img.naturalWidth) continue;
    const px = t2x(c.start + (i * th.interval - c.in));
    const tw = img.naturalWidth * (h / img.naturalHeight);
    if (px + tw < x || px > x2) continue;
    ctx.globalAlpha = 0.9;
    ctx.drawImage(img, px, y, tw, h);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

function drawWave(ctx, c, x, x2, yBottom, h) {
  const n = S.peaks.length;
  if (!n || !S.duration) return;
  ctx.fillStyle = "rgba(46,160,67,0.9)";
  const mid = yBottom - h / 2;
  for (let px = Math.max(TL.gut, Math.floor(x)); px < Math.min(x2, $("timeline").clientWidth); px += 1) {
    const src = c.in + (x2t(px) - c.start);
    const idx = Math.floor((src / S.duration) * n);
    if (idx < 0 || idx >= n) continue;
    const amp = (S.peaks[idx] / 1000) * (h / 2);
    ctx.fillRect(px, mid - amp, 1, Math.max(1, amp * 2));
  }
}

function drawClip(ctx, c) {
  const x = t2x(c.start);
  const x2 = Math.max(x + 2, t2x(c.end));
  const bw = x2 - x;
  const y = TL.vTop + 2;
  const bh = TL.vH - 4;
  const selected = S.sel.has(c.id);
  ctx.fillStyle = (c.kind && KIND_COLOR[c.kind]) || CLIP_FALLBACK;
  ctx.globalAlpha = selected ? 0.95 : 0.8;
  ctx.fillRect(x, y, bw, bh);
  ctx.globalAlpha = 1;
  drawFilmstrip(ctx, c, x, x2, y, bh - TL.wave);
  drawWave(ctx, c, x, x2, y + bh, TL.wave);
  if (bw > 40 && (c.text || c.kind)) {
    const label = c.text || c.kind;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 3, y, bw - 6, bh);
    ctx.clip();
    ctx.font = "10px sans-serif";
    const tw = Math.min(bw - 8, ctx.measureText(label).width + 8);
    ctx.fillStyle = "rgba(8,12,18,0.62)";
    ctx.fillRect(x + 3, y + 3, tw, 13);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, x + 7, y + 13);
    ctx.restore();
  }
  ctx.strokeStyle = selected ? "#ffffff" : "#0a0d11";
  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1);
  ctx.lineWidth = 1;
}

function drawCap(ctx, c) {
  const y = laneY(c.lane) + 2;
  const bh = TL.laneH - 4;
  const x = t2x(c.start);
  const bw = Math.max(3, t2x(c.end) - x);
  const selected = S.sel.has(c.id);
  ctx.fillStyle = c.id === S.capSel ? "#388bfd" : selected ? "#2f6fd6" : "#274b8f";
  ctx.beginPath();
  roundRectPath(ctx, x, y, bw, bh, 3);
  ctx.fill();
  ctx.fillStyle = "rgba(240,246,252,.55)";
  ctx.fillRect(x, y, 2, bh);
  ctx.fillRect(x + bw - 2, y, 2, bh);
  if (selected) {
    ctx.strokeStyle = "#f0f6fc";
    ctx.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1);
  }
  if (bw > 30) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 4, y, bw - 8, bh);
    ctx.clip();
    ctx.fillStyle = "#e6edf3";
    ctx.font = "10px sans-serif";
    ctx.fillText(c.text || "", x + 5, y + bh / 2 + 3);
    ctx.restore();
  }
}

function draw() {
  if (!S.project) return;
  const { ctx, w, h } = canvasGeo();
  const v0 = S.view.start, v1 = S.view.start + S.view.span;
  ctx.fillStyle = "#0b0f14";
  ctx.fillRect(0, 0, w, h);

  // ruler
  ctx.fillStyle = "#11161d";
  ctx.fillRect(0, 0, w, TL.ruler);
  ctx.fillStyle = "#8b98a9";
  ctx.font = "10px ui-monospace, monospace";
  const step = niceStep(S.view.span / (plotWidth() / 110));
  for (let t = Math.ceil(v0 / step) * step; t <= v1 + 1e-9; t += step) {
    const x = t2x(t);
    ctx.fillRect(x, TL.ruler - 5, 1, 5);
    ctx.fillText(fmtTime(t, false), x + 3, 12);
  }

  // video row
  ctx.fillStyle = "#0d1218";
  ctx.fillRect(TL.gut, TL.vTop, w - TL.gut, TL.vH);
  ctx.fillStyle = "#5b6b7f";
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillText("V1", 8, TL.vTop + 22);
  for (const c of S.tl.clips) {
    if (c.end < v0 || c.start > v1) continue;
    drawClip(ctx, c);
  }

  // caption lanes
  for (let i = 0; i < laneCount(); i += 1) {
    const y = laneY(i);
    ctx.fillStyle = "#0d1218";
    ctx.fillRect(TL.gut, y, w - TL.gut, TL.laneH);
    ctx.fillStyle = "#5b6b7f";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText(`T${i + 1}`, 8, y + 15);
  }
  for (const c of S.tl.caps) {
    if (c.end < v0 || c.start > v1) continue;
    drawCap(ctx, c);
  }

  // marquee
  if (S.drag && S.drag.mode === "marquee" && S.drag.moved) {
    const d = S.drag;
    ctx.fillStyle = "rgba(88,166,255,.18)";
    ctx.fillRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1),
                 Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
  }

  // playhead
  const pt = playheadTime();
  if (pt >= v0 && pt <= v1) {
    const x = t2x(pt);
    ctx.fillStyle = "#f0f6fc";
    ctx.fillRect(x, 0, 1.5, h);
  }
}

/* ------------------------------------------------------------ history */

// Call after every change to S.tl. Compares with the last committed state,
// so in-place edits (caption text and style) are recorded too.
function commitTL() {
  const cur = JSON.stringify(S.tl);
  if (cur === S.lastJSON) return false;
  S.undo.push(S.lastJSON);
  if (S.undo.length > 200) S.undo.shift();
  S.redo = [];
  S.lastJSON = cur;
  scheduleSave();
  return true;
}

function refresh() {
  clampView();
  renderList();
  draw();
  updateTally();
  updateTimecode();
  layoutCapOverlay();
}

function setTL(next) {
  S.tl = next;
  syncCapSel();
  commitTL();
  refresh();
}

function commitCaptions() {        // legacy name, used by the caption box
  commitTL();
  refresh();
}

function undoTL() {
  if (!S.undo.length) return status("Nothing to undo.");
  S.redo.push(S.lastJSON);
  S.lastJSON = S.undo.pop();
  S.tl = JSON.parse(S.lastJSON);
  S.sel = new Set([...S.sel].filter((id) => [...S.tl.clips, ...S.tl.caps].some((c) => c.id === id)));
  syncCapSel();
  scheduleSave();
  refresh();
  status("Undone.");
}

function redoTL() {
  if (!S.redo.length) return status("Nothing to redo.");
  S.undo.push(S.lastJSON);
  S.lastJSON = S.redo.pop();
  S.tl = JSON.parse(S.lastJSON);
  S.sel = new Set();
  syncCapSel();
  scheduleSave();
  refresh();
  status("Redone.");
}

// The edit list is saved a moment after the last change, and right away when
// the page is hidden or reloaded, so a quick edit before a refresh is kept.
let pendingSave = null;

function scheduleSave() {
  if (!S.project) return;
  pendingSave = JSON.stringify(S.tl);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushSave(false), 250);
}

function flushSave(leaving) {
  clearTimeout(saveTimer);
  if (pendingSave === null) return;
  const body = pendingSave;
  pendingSave = null;
  fetch("/api/timeline", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: leaving && body.length < 60000,
  }).then(async (r) => {
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.detail || r.statusText);
    }
  }).catch((e) => status(`Timeline not saved: ${e.message}`));
}

window.addEventListener("pagehide", () => flushSave(true));

/* ------------------------------------------------------------ selection */

function selectOnly(id) {
  S.sel = new Set([id]);
  syncCapSel();
  refresh();
}

function toggleSel(id) {
  if (S.sel.has(id)) S.sel.delete(id);
  else S.sel.add(id);
  syncCapSel();
  refresh();
}

function clearSel() {
  S.sel = new Set();
  syncCapSel();
  refresh();
}

function selectAll() {
  S.sel = new Set([...S.tl.clips, ...S.tl.caps].map((c) => c.id));
  syncCapSel();
  refresh();
}

/* ------------------------------------------------------------ editing ops */

function deleteSel(ripple) {
  const ids = selectedIds();
  if (!ids.length) return status("Select a clip or caption first.");
  S.sel = new Set();
  setTL(TLM.deleteItems(S.tl, ids, ripple));
  status(ripple ? "Removed and closed the gap." : "Removed (gap left on the timeline).");
}

function copySel() {
  const ids = selectedIds();
  if (!ids.length) return status("Select something to copy.");
  S.clip = TLM.copyItems(S.tl, ids);
  status(`Copied ${S.clip.items.length} item(s).`);
}

function cutSel() {
  const ids = selectedIds();
  if (!ids.length) return status("Select something to cut.");
  S.clip = TLM.copyItems(S.tl, ids);
  S.sel = new Set();
  setTL(TLM.deleteItems(S.tl, ids, false));
  status(`Cut ${S.clip.items.length} item(s). Paste with Ctrl+V.`);
}

function pasteSel(insert) {
  if (!S.clip) return status("Nothing copied yet.");
  const at = playheadTime();
  const r = TLM.pasteItems(S.tl, S.clip, at, insert);
  S.sel = new Set(r.ids);
  setTL(r.tl);
  status(`${insert ? "Inserted" : "Pasted"} at ${fmtTime(at, false)}.`);
}

function splitAtPlayhead() {
  const ids = selectedIds();
  const at = playheadTime();
  const next = TLM.splitSelection(S.tl, at, ids.length ? ids : null);
  if (JSON.stringify(next) === JSON.stringify(S.tl)) return status("Nothing to split at the playhead.");
  setTL(next);
  status(`Split at ${fmtTime(at, false)}.`);
}

function addCaptionAtPlayhead() {
  if (!S.project) return alert("Open a video first.");
  const style = (S.capSel && S.tl.caps.find((c) => c.id === S.capSel)?.style) || CAPPOS;
  const r = TLM.addCaption(S.tl, playheadTime(), "New caption", style, 0);
  S.sel = new Set([r.id]);
  S.capSel = r.id;
  setTL(r.tl);
}

function addLane() {
  if (!S.project) return;
  S.tl = { ...S.tl, lanes: laneCount() + 1 };
  commitTL();
  refresh();
}

/* ------------------------------------------------------------ snapping */

function snapCandidates(exclude) {
  const list = [0, playheadTime(), timelineEnd()];
  for (const c of [...S.tl.clips, ...S.tl.caps]) {
    if (!exclude.has(c.id)) list.push(c.start, c.end);
  }
  return list;
}

function snapTime(t, exclude) {
  if (!$("tlSnap") || !$("tlSnap").checked) return t;
  const tol = 8 / Math.max(pxPerSec(), 1e-6);
  let best = t, bd = tol;
  for (const cand of snapCandidates(exclude)) {
    const dd = Math.abs(cand - t);
    if (dd < bd) { bd = dd; best = cand; }
  }
  return best;
}

// Snap a group move: the group's first or last edge may land on a candidate.
function snapShift(base, ids, dt) {
  if (!$("tlSnap") || !$("tlSnap").checked) return dt;
  const sel = new Set(ids);
  const items = [...base.clips, ...base.caps].filter((c) => sel.has(c.id));
  if (!items.length) return dt;
  const s0 = Math.min(...items.map((c) => c.start));
  const e0 = Math.max(...items.map((c) => c.end));
  const tol = 8 / Math.max(pxPerSec(), 1e-6);
  let best = dt, bd = tol;
  for (const cand of snapCandidates(sel)) {
    for (const edge of [s0, e0]) {
      const dd = Math.abs(edge + dt - cand);
      if (dd < bd) { bd = dd; best = cand - edge; }
    }
  }
  return best;
}

/* ------------------------------------------------------------ mouse */

function applyMarquee(d) {
  const a = Math.min(d.x0, d.x1), b = Math.max(d.x0, d.x1);
  const top = Math.min(d.y0, d.y1), bottom = Math.max(d.y0, d.y1);
  const picked = new Set(d.additive ? d.baseSel : []);
  for (const c of S.tl.clips) {
    if (t2x(c.end) >= a && t2x(c.start) <= b && TL.vTop <= bottom && TL.vTop + TL.vH >= top) picked.add(c.id);
  }
  for (const c of S.tl.caps) {
    const y0 = laneY(c.lane), y1 = y0 + TL.laneH;
    if (t2x(c.end) >= a && t2x(c.start) <= b && y0 <= bottom && y1 >= top) picked.add(c.id);
  }
  S.sel = picked;
}


function bindTimeline() {
  const cv = $("timeline");

  cv.addEventListener("mousedown", (ev) => {
    if (!S.project) return;
    const r = cv.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    const row = rowAt(y);
    if (row.kind === "ruler") {
      pausePlayback();
      S.drag = { mode: "scrub" };
      setPlayhead(x2t(x));
      return;
    }
    if (x < TL.gut || row.kind === "none") return;
    const hit = hitItem(row, x);
    if (hit) {
      const edge = edgeAt(hit, x);
      const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
      if (additive) toggleSel(hit.id);
      else if (!S.sel.has(hit.id)) selectOnly(hit.id);
      if (additive && !S.sel.has(hit.id)) return;     // it was just deselected
      S.drag = {
        mode: edge === "move" ? "move" : edge === "l" ? "trimL" : "trimR",
        id: hit.id, ids: selectedIds(), x0: x, y0: y, moved: false,
        base: JSON.parse(JSON.stringify(S.tl)), lane0: row.kind === "lane" ? row.lane : null,
        alt: ev.altKey, srcDur: S.duration, resultIds: null,
      };
      return;
    }
    S.drag = {
      mode: "marquee", x0: x, y0: y, x1: x, y1: y, moved: false,
      additive: ev.shiftKey, baseSel: new Set(S.sel),
    };
  });

  cv.addEventListener("dblclick", (ev) => {
    if (!S.project) return;
    const r = cv.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    const row = rowAt(y);
    if (row.kind !== "lane") return;
    const hit = hitItem(row, x);
    if (!hit) return;
    S.sel = new Set([hit.id]);
    S.capSel = hit.id;
    setPlayhead(hit.start + 0.05, true);
    startOverlayCaptionEdit();
  });

  window.addEventListener("mousemove", (ev) => {
    if (!S.project) return;
    const r = cv.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    const d = S.drag;
    if (!d) {
      updateCursor(cv, x, y);
      return;
    }
    if (d.mode === "scrub") {
      setPlayhead(x2t(Math.max(TL.gut, Math.min(r.width, x))));
      return;
    }
    if (!d.moved && (Math.abs(x - d.x0) > 3 || Math.abs(y - d.y0) > 3)) d.moved = true;
    if (d.mode === "marquee") {
      d.x1 = x;
      d.y1 = y;
      if (d.moved) applyMarquee(d);
      draw();
      return;
    }
    if (!d.moved) return;
    if (d.mode === "move") {
      const dt = snapShift(d.base, d.ids, (x - d.x0) / pxPerSec());
      const row = rowAt(y);
      const dLane = row.kind === "lane" && d.lane0 !== null ? row.lane - d.lane0 : 0;
      if (d.alt) {
        const dup = TLM.duplicateItems(d.base, d.ids, dt);
        S.tl = dup.tl;
        d.resultIds = dup.ids;
      } else {
        S.tl = TLM.moveItems(d.base, d.ids, dt, dLane);
      }
    } else {
      const t = snapTime(x2t(x), new Set([d.id]));
      S.tl = TLM.trimItem(d.base, d.id, d.mode === "trimL" ? "l" : "r", t, d.srcDur);
    }
    draw();
    layoutCapOverlay();
    updateTimecode();
  });

  window.addEventListener("mouseup", () => {
    const d = S.drag;
    S.drag = null;
    if (!d) return;
    if (d.mode === "scrub") return;
    if (d.mode === "marquee") {
      if (!d.moved) {
        if (!d.additive) clearSel();
        setPlayhead(x2t(d.x0));
        return;
      }
      syncCapSel();
      refresh();
      return;
    }
    if (!d.moved) {
      S.tl = d.base;
      refresh();
      return;
    }
    if (d.alt && d.resultIds) S.sel = new Set(d.resultIds);
    syncCapSel();
    commitTL();
    refresh();
  });

  cv.addEventListener("wheel", (ev) => {
    if (!S.project) return;
    ev.preventDefault();
    const r = cv.getBoundingClientRect();
    const anchor = x2t(ev.clientX - r.left);
    if (ev.ctrlKey || ev.metaKey) {
      const factor = ev.deltaY > 0 ? 1.25 : 0.8;
      const span = Math.min(Math.max(contentEnd(), 1), Math.max(0.2, S.view.span * factor));
      const frac = (anchor - S.view.start) / S.view.span;
      S.view.start = clampStart(anchor - frac * span, span);
      S.view.span = span;
    } else {
      const delta = (ev.deltaY + ev.deltaX) * (S.view.span / r.width);
      S.view.start = clampStart(S.view.start + delta, S.view.span);
    }
    draw();
  }, { passive: false });

  cv.addEventListener("mouseleave", () => { cv.style.cursor = "default"; });
}

function updateCursor(cv, x, y) {
  const row = rowAt(y);
  let cursor = "default";
  if (row.kind === "ruler") cursor = "pointer";
  else if (row.kind === "video" || row.kind === "lane") {
    const hit = hitItem(row, x);
    if (hit) cursor = edgeAt(hit, x) === "move" ? "grab" : "ew-resize";
  }
  cv.style.cursor = cursor;
}

/* ------------------------------------------------------------ playback */

function updateTimecode() {
  const el = $("timecode");
  if (el) el.textContent = `${fmtTime(playheadTime(), false)} / ${fmtTime(timelineEnd(), false)}`;
}

function followPlayhead() {
  if (!PV.playing) return;
  const t = playheadTime();
  if (t > S.view.start + S.view.span * 0.92 || t < S.view.start) {
    S.view.start = clampStart(t - S.view.span * 0.15, S.view.span);
  }
}

function setPlayhead(t, sync = true) {
  S.T = Math.max(0, Math.min(t, Math.max(0, contentEnd())));
  if (sync) syncPreview(true);
  followPlayhead();
  draw();
  updateTimecode();
  layoutCapOverlay();
}

// Show the source frame for the clip under the playhead; black in gaps.
function syncPreview(force) {
  const p = $("player");
  const shade = $("gapShade");
  if (!S.project || !p.hasAttribute("src")) return;
  const clip = TLM.clipAt(S.tl, playheadTime());
  if (!clip) {
    if (shade) shade.hidden = false;
    if (!p.paused) p.pause();
    return;
  }
  if (shade) shade.hidden = true;
  const want = clip.in + (playheadTime() - clip.start);
  if (force || Math.abs(p.currentTime - want) > 0.25) {
    try { p.currentTime = want; } catch (_) { /* metadata not loaded yet */ }
  }
  if (PV.playing && p.paused) {
    const pr = p.play();
    if (pr && pr.catch) pr.catch(() => {});
  } else if (!PV.playing && !p.paused) {
    p.pause();
  }
}

function togglePlay() {
  if (PV.playing) pausePlayback();
  else startPlayback();
}

function startPlayback() {
  if (!S.project || PV.playing) return;
  if (!S.tl.clips.length) return status("The timeline is empty.");
  if (playheadTime() >= timelineEnd() - 0.01) setPlayhead(0, false);
  PV.playing = true;
  PV.last = performance.now();
  $("playBtn").textContent = "❚❚ pause";
  syncPreview(true);
  PV.raf = requestAnimationFrame(pvTick);
}

function pausePlayback() {
  if (PV.playing) {
    PV.playing = false;
    cancelAnimationFrame(PV.raf);
  }
  const btn = $("playBtn");
  if (btn) btn.textContent = "▶ play";
  const p = $("player");
  if (p && !p.paused) p.pause();
  if (S.project) {
    syncPreview(false);
    draw();
    updateTimecode();
    layoutCapOverlay();
  }
}

function pvTick(now) {
  if (!PV.playing) return;
  const dt = Math.min(0.25, Math.max(0, (now - PV.last) / 1000));
  PV.last = now;
  const p = $("player");
  let t = playheadTime() + dt;
  const clip = TLM.clipAt(S.tl, playheadTime());
  // While a clip plays, the video clock is the more accurate reference.
  if (clip && !p.paused && p.readyState >= 2) {
    const vt = clip.start + (p.currentTime - clip.in);
    if (Math.abs(vt - t) < 0.3) t = vt;
  }
  const end = timelineEnd();
  if (t >= end) {
    S.T = end;
    pausePlayback();
    return;
  }
  S.T = t;
  syncPreview(false);
  followPlayhead();
  draw();
  updateTimecode();
  layoutCapOverlay();
  PV.raf = requestAnimationFrame(pvTick);
}

function stepFrame(dir) {
  if (!S.project) return;
  const fps = Number(S.project.info?.video?.fps) || 30;
  pausePlayback();
  setPlayhead(playheadTime() + dir / fps);
}

function bindPlayer() {
  const p = $("player");
  p.addEventListener("seeked", () => { draw(); updateTimecode(); });
  p.addEventListener("loadedmetadata", () => {
    if (!S.duration && p.duration) {
      S.duration = p.duration;
      S.view = { start: 0, span: S.duration };
    }
    syncPreview(true);
    draw();
    // A container can demux while the video track stays undecodable (HEVC
    // without a hardware decoder). Give it a moment, then check for frames.
    setTimeout(() => { if (!p.videoWidth && !p.error) maybeRequestProxy(); }, 1500);
  });
  p.addEventListener("error", () => maybeRequestProxy());
  p.addEventListener("ended", () => { if (PV.playing) pausePlayback(); });
}

/* ------------------------------------------------------------ keyboard */

function bindKeys() {
  document.addEventListener("keydown", (ev) => {
    const el = ev.target;
    const tag = el && el.tagName;
    const typing = el && (el.isContentEditable || tag === "TEXTAREA" || tag === "SELECT" ||
      (tag === "INPUT" && !["checkbox", "radio", "button", "submit", "reset"].includes(el.type)));
    if (typing || !S.project) return;
    const key = ev.key;
    if (key === " " || ev.code === "Space") {
      if (el && (el.matches?.("input[type=checkbox], input[type=radio]") || el.closest?.("button, [role=button]"))) return;
      ev.preventDefault();
      if (!ev.repeat) togglePlay();
      return;
    }
    if (ev.ctrlKey || ev.metaKey) {
      const k = key.toLowerCase();
      const map = {
        z: () => (ev.shiftKey ? redoTL() : undoTL()),
        y: () => redoTL(),
        a: () => selectAll(),
        c: () => copySel(),
        x: () => cutSel(),
        v: () => pasteSel(ev.shiftKey),
        k: () => splitAtPlayhead(),
      };
      if (map[k]) {
        ev.preventDefault();
        map[k]();
      }
      return;
    }
    if (key === "Delete" || key === "Backspace") {
      if (S.sel.size) {
        ev.preventDefault();
        deleteSel(ev.shiftKey);
      }
      return;
    }
    if (key === "Escape") { clearSel(); return; }
    if (key === "ArrowLeft" || key === "ArrowRight") {
      ev.preventDefault();
      if (ev.shiftKey) setPlayhead(playheadTime() + (key === "ArrowLeft" ? -1 : 1));
      else stepFrame(key === "ArrowLeft" ? -1 : 1);
    }
  });
}

/* ------------------------------------------------------------ clip list */

function visibleSections() {
  const q = (S.filter.q || "").trim().toLowerCase();
  return S.tl.clips.filter((c) => {
    if (!S.filter.kinds.has(c.kind || "other")) return false;
    if (c.end - c.start < S.filter.minDur) return false;
    if (q && !(c.text || "").toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderList() {
  const tb = document.querySelector("#secTable tbody");
  if (!tb) return;
  const rows = visibleSections();
  tb.innerHTML = rows.map((c) => {
    const kind = c.kind || "other";
    return `<tr data-id="${c.id}" class="${S.sel.has(c.id) ? "sel" : ""}">` +
      `<td class="check-cell"><input type="checkbox" ${S.sel.has(c.id) ? "checked" : ""}></td>` +
      `<td>${fmtTime(c.start, false)}</td><td>${fmtTime(c.end, false)}</td>` +
      `<td>${fmtTime(c.end - c.start, false)}</td><td>${escapeHtml(kind)}</td>` +
      `<td class="txt txt-edit" contenteditable="true" spellcheck="false" ` +
      `title="Edit the text. Captions on the timeline with the same text are updated too.">` +
      `${escapeHtml(c.text || "")}</td></tr>`;
  }).join("");
  const empty = $("listEmpty");
  if (empty) {
    empty.hidden = S.tl.clips.length > 0;
    empty.textContent = "No clips yet — open a video first.";
  }
}

let lastListId = null;

function bindList() {
  const tb = document.querySelector("#secTable tbody");
  tb.addEventListener("click", (ev) => {
    if (ev.target.closest && ev.target.closest("td.txt")) return;   // editing text, not seeking
    const tr = ev.target.closest("tr[data-id]");
    if (!tr) return;
    const id = tr.dataset.id;
    const clip = S.tl.clips.find((c) => c.id === id);
    if (ev.target.matches("input[type=checkbox]")) {
      if (ev.shiftKey && lastListId) {
        const rows = visibleSections().map((c) => c.id);
        const a = rows.indexOf(lastListId), b = rows.indexOf(id);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const on = !S.sel.has(id);
        for (const rid of rows.slice(lo, hi + 1)) {
          if (on) S.sel.add(rid); else S.sel.delete(rid);
        }
        syncCapSel();
        refresh();
      } else {
        toggleSel(id);
      }
      lastListId = id;
      return;
    }
    if (clip) {
      selectOnly(id);
      setPlayhead(clip.start + 0.01);
      lastListId = id;
    }
  });
  tb.addEventListener("keydown", (ev) => {
    if (!ev.target.closest || !ev.target.closest("td.txt")) return;
    ev.stopPropagation();                 // typing here must not trigger timeline shortcuts
    if (ev.key === "Enter") {
      ev.preventDefault();
      ev.target.blur();
    } else if (ev.key === "Escape") {
      ev.target.dataset.cancel = "1";
      ev.target.blur();
    }
  });
  tb.addEventListener("focusout", (ev) => {
    const cell = ev.target.closest && ev.target.closest("td.txt");
    if (!cell) return;
    const id = cell.closest("tr").dataset.id;
    const clip = S.tl.clips.find((c) => c.id === id);
    const cancel = cell.dataset.cancel === "1";
    delete cell.dataset.cancel;
    if (!clip) return;
    const text = cell.textContent.replace(/\s+/g, " ").trim();
    if (cancel || text === (clip.text || "")) {
      cell.textContent = clip.text || "";
      return;
    }
    setTL(TLM.setClipText(S.tl, id, text));
    status("Text updated (captions on the timeline with the same text too).");
  });
  $("selVisible").onclick = () => {
    S.sel = new Set([...S.sel, ...visibleSections().map((c) => c.id)]);
    syncCapSel(); refresh();
  };
  $("selNone").onclick = () => clearSel();
  $("selInvert").onclick = () => {
    const next = new Set(S.sel);
    for (const c of visibleSections()) {
      if (next.has(c.id)) next.delete(c.id);
      else next.add(c.id);
    }
    S.sel = next;
    syncCapSel(); refresh();
  };
  $("selAllSilence").onclick = () => {
    S.sel = new Set(S.tl.clips.filter((c) => c.kind === "silence").map((c) => c.id));
    syncCapSel(); refresh();
  };
  $("selAllCaptions").onclick = () => {
    S.sel = new Set(S.tl.clips.filter((c) => c.kind === "caption").map((c) => c.id));
    syncCapSel(); refresh();
  };
  $("selRemove").onclick = () => deleteSel(true);
}

/* ------------------------------------------------------------ sidebar */

function updateTally() {
  const used = S.tl.clips.reduce((a, c) => a + (c.end - c.start), 0);
  $("tSrc").textContent = fmtTime(S.duration, false);
  $("tCut").textContent = fmtTime(Math.max(0, S.duration - used), false);
  $("tOut").textContent = fmtTime(timelineEnd(), false);
  const warn = [];
  if (S.tl.clips.length > 300) warn.push("Many clips: the export will take longer.");
  if (S.tl.clips.length && timelineEnd() < 0.5) warn.push("The timeline is very short.");
  $("planWarn").textContent = warn.join(" ");
  $("exportBtn").disabled = !S.project || !S.tl.clips.length;
}

function updateCaptionExportInfo() {
  const el = $("xCapInfo");
  if (!el) return;
  const mode = $("xCaptions").value;
  $("capStyleRow").hidden = !(mode === "burn" || mode === "both");
  layoutCapOverlay();
  if (mode === "none") { el.textContent = ""; return; }
  const n = S.tl.caps.filter((c) => (c.text || "").trim()).length;
  if (!n) { el.textContent = "no captions on the timeline yet"; return; }
  const bits = [`${n} caption(s) from the timeline`, "times match the exported video"];
  if (mode === "burn" || mode === "both") bits.push("burning re-encodes, even in stream-copy mode");
  el.textContent = bits.join(" · ");
}

function isPristine() {
  const c = S.tl.clips;
  return c.length === 1 && c[0].start === 0 && c[0].in === 0 && !c[0].kind &&
    S.tl.caps.length === 0;
}

async function runDetect() {
  if (!S.project) return alert("Open a video first.");
  if (!isPristine() && !confirm("Detection rebuilds the cut list from the source, and your current " +
      "edits and captions are replaced. You can undo this with Ctrl+Z.")) return;
  const btn = $("detectBtn");
  btn.disabled = true;
  btn.textContent = "Detecting…";
  $("detectInfo").textContent = "running ffmpeg silencedetect / parsing subtitles…";
  try {
    const body = {
      silence_thresh_db: Number($("dThresh").value),
      min_silence_ms: Number($("dMinSilence").value),
      min_section_ms: Number($("dMinSection").value),
      detect_silence: $("dSilence").checked,
      use_cues: $("dCues").checked,
      subtitles_text: S.subsText,
      subtitles_path: $("dSubPath").value.trim() || null,
    };
    const data = await api("/api/detect", { method: "POST", body: JSON.stringify(body) });
    const clips = TLM.clipsFromSections(data.sections, S.duration);
    let caps = [], lanes = 1;
    if ($("dCues").checked && Array.isArray(data.captions) && data.captions.length) {
      ({ caps, lanes } = TLM.capsFromCues(clips, data.captions));
    }
    S.sel = new Set();
    S.capSel = null;
    setTL({ clips, caps, lanes });
    const sm = data.summary;
    $("detectInfo").innerHTML =
      `${clips.length} clips &middot; ${data.silence_count} silences (${fmtTime(sm.seconds_by_kind.silence, false)})` +
      ` &middot; ${caps.length} caption(s)` +
      (sm.seconds_by_kind.other ? ` &middot; other audio ${fmtTime(sm.seconds_by_kind.other, false)}` : "");
  } catch (e) {
    $("detectInfo").textContent = `Error: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Detect sections";
  }
}

async function doExport() {
  if (!S.project) return;
  if (!S.tl.clips.length) return alert("The timeline is empty.");
  const btn = $("exportBtn");
  btn.disabled = true;
  btn.textContent = "Starting…";
  $("jobError").hidden = true;
  $("exportInfo").textContent = "";
  try {
    const mode = $("xCaptions").value;
    const job = await api("/api/export/timeline", {
      method: "POST",
      body: JSON.stringify({
        output: $("xOutput").value.trim(),
        opts: collectOpts(),
        timeline: S.tl,
        caption_mode: mode,
        caption_style: ["burn", "both"].includes(mode) ? { ...CAPPOS } : {},
      }),
    });
    S.job = job;
    $("progWrap").hidden = false;
    const cap = job.captions
      ? ` · captions: ${job.captions.cues} cue(s)` +
        (job.captions.burned ? " burned in" : "") +
        (job.captions.positioned ? " at your preview position" : "") +
        ` → ${job.captions.srt.split(/[\\/]/).pop()}`
      : "";
    $("exportInfo").textContent =
      (job.note ? `⚠ ${job.note} ` : "") +
      `Job ${job.id} · ${job.kind} · ${job.segments} clip(s) → ${job.output}` + cap;
    pollJob(job.id);
  } catch (e) {
    $("jobError").hidden = false;
    $("jobError").textContent = e.message;
    btn.disabled = false;
    btn.textContent = "Export clean cut";
  }
}

/* ------------------------------------------------------------ caption text */

function startOverlayCaptionEdit() {
  // Double-click a caption on the preview: edit its text in place.
  if (CAP_EDITING) return;
  const cue = capActiveCue();
  if (!cue) return;
  CAP_EDITING = true;
  pausePlayback();
  const box = $("capBox"), textEl = $("capBoxText");
  const ta = document.createElement("textarea");
  ta.className = "cap-edit";
  ta.value = cue.text || "";
  ta.spellcheck = false;
  box.appendChild(ta);
  textEl.style.visibility = "hidden";
  ta.focus();
  ta.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    CAP_EDITING = false;
    ta.remove();
    textEl.style.visibility = "";
    const value = ta.value.replace(/\s+/g, " ").trim();
    const live = S.tl.caps.find((c) => c.id === cue.id);
    if (commit && live && value !== (cue.text || "")) {
      live.text = value;
      textEl.dataset.raw = value;
      commitTL();
    } else {
      textEl.dataset.raw = cue.text || "";
    }
    refresh();
  };
  ta.addEventListener("input", () => { textEl.dataset.raw = ta.value; });
  ta.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  ta.addEventListener("click", () => { if (!done && document.activeElement !== ta) ta.focus(); });
  ta.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); finish(true); }
    else if (ev.key === "Escape") finish(false);
  });
  ta.addEventListener("blur", () => {
    // Ignore transient focus flicker; commit once focus has really moved on.
    setTimeout(() => { if (!done && document.activeElement !== ta) finish(true); }, 0);
  });
}

/* ------------------------------------------------------------ project open */

function bindTimelineTools() {
  $("zoomIn").onclick = () => zoomBy(0.6);
  $("zoomOut").onclick = () => zoomBy(1.6);
  $("zoomFit").onclick = () => { S.view = { start: 0, span: Math.max(contentEnd(), 0.2) }; draw(); };
  $("capAdd").onclick = addCaptionAtPlayhead;
  $("capSplit").onclick = splitAtPlayhead;
  $("capDel").onclick = () => deleteSel(false);
  $("tlUndo").onclick = undoTL;
  $("tlRedo").onclick = redoTL;
  $("tlCopy").onclick = copySel;
  $("tlCut").onclick = cutSel;
  $("tlPaste").onclick = () => pasteSel(false);
  $("tlRipple").onclick = () => deleteSel(true);
  $("tlLane").onclick = addLane;
  $("playBtn").onclick = togglePlay;
  $("frameBack").onclick = () => stepFrame(-1);
  $("frameFwd").onclick = () => stepFrame(1);
}

function bindUI() {
  $("openBtn").onclick = () => openPath($("pathInput").value.trim());
  $("demoBtn").onclick = async () => {
    $("fileMeta").textContent = "opening demo…";
    try { await onProjectOpen(await api("/api/demo", { method: "POST", body: "{}" })); }
    catch (e) { $("fileMeta").textContent = ""; alert(e.message); }
  };
  $("speechDemoBtn").onclick = async () => {
    $("fileMeta").textContent = "opening speech demo…";
    try { await onProjectOpen(await api("/api/demo/speech", { method: "POST", body: "{}" })); }
    catch (e) { $("fileMeta").textContent = ""; alert(e.message); }
  };
  $("pathInput").addEventListener("keydown", (e) => { if (e.key === "Enter") openPath(e.target.value.trim()); });
  // The file-browser modal is optional markup: if it is absent, only browsing breaks.
  const modal = $("browserModal");
  if (modal) {
    $("browseBtn").onclick = async () => {
      modal.hidden = false;
      try { await browseTo(""); } catch (e) { alert(e.message); }
    };
    const close = $("browserClose");
    if (close) close.onclick = () => { modal.hidden = true; };
    modal.onclick = (e) => { if (e.target.id === "browserModal") modal.hidden = true; };
  } else {
    $("browseBtn").onclick = () => alert("The file browser is unavailable in this build.");
  }

  $("uploadInput").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    $("fileMeta").textContent = `uploading ${fmtBytes(f.size)}…`;
    try { await onProjectOpen(await api("/api/upload", { method: "POST", body: fd })); }
    catch (err) { alert(err.message); $("fileMeta").textContent = ""; }
  };

  $("dSubFile").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    try {
      const data = await api("/api/parse-subtitles", { method: "POST", body: fd });
      S.subsText = null;
      $("dSubPath").value = data.saved_path || "";
      $("subInfo").textContent = `${data.count} cues loaded (${f.name}) — editable`;
      $("dCues").checked = true;
      updateCaptionExportInfo();
    } catch (err) { alert(err.message); }
  };

  $("detectBtn").onclick = runDetect;
  $("capBtn").onclick = startCaption;
  $("capCancel").onclick = cancelCaption;
  $("capUse").onclick = useCaptions;
  $("capNewBtn").onclick = newBlankCaptions;
  $("capOpenSrtBtn").onclick = openCaptionsFile;
  $("capAddCue").onclick = addCueRow;
  $("capRevert").onclick = revertCues;
  $("capSave").onclick = () => saveCues(false);
  bindCaptionOverlay();
  $("xCaptions").addEventListener("change", updateCaptionExportInfo);
  $("dSubPath").addEventListener("input", updateCaptionExportInfo);
  updateCaptionExportInfo();
  $("capCueBody").addEventListener("click", (ev) => {
    const del = ev.target.closest(".cue-del");
    if (!del) return;
    del.closest("tr").remove();
    renumberCues();
  });
  $("cEngine").addEventListener("change", updateEngineUI);
  $("wDlBtn").onclick = downloadWcppModel;
  $("capRecheck").onclick = async () => {
    // faster-whisper is imported lazily when a job starts, so a package
    // installed in another terminal is picked up without restarting the app.
    const btn = $("capRecheck");
    btn.disabled = true;
    btn.textContent = "Checking…";
    await loadEnv();
    btn.disabled = false;
    btn.textContent = "Re-check for faster-whisper";
  };

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.onclick = () => {
      const k = chip.dataset.kind;
      chip.classList.toggle("on");
      if (chip.classList.contains("on")) S.filter.kinds.add(k); else S.filter.kinds.delete(k);
      renderList();
    };
  });
  $("minDur").oninput = (e) => { S.filter.minDur = Number(e.target.value) || 0; renderList(); };
  $("searchBox").oninput = (e) => { S.filter.q = e.target.value; renderList(); };

  $("xMode").onchange = syncQualityRows;
  $("xQuality").onchange = syncQualityRows;
  $("resetOpts").onclick = () => { if (S.project) { applyProfile(S.project.profile); defaultOutput(); } };
  $("exportBtn").onclick = doExport;

  window.addEventListener("resize", draw);
  bindList();
  bindTimeline();
  bindTimelineTools();
  bindKeys();
  bindPlayer();
}

async function onProjectOpen(data) {
  pausePlayback();
  S.project = data;
  S.duration = data.info.duration;
  S.T = 0;
  S.sel = new Set();
  S.capSel = null;
  S.undo = [];
  S.redo = [];
  S.tl = { clips: TLM.clipsFromSource(S.duration), caps: [], lanes: 1 };
  S.lastJSON = JSON.stringify(S.tl);
  S.peaks = [];
  S.thumbs = null;
  S.thumbImgs = [];
  S.subsText = null;
  $("subInfo").textContent = data.demo_subtitles ? "Bundled demo subtitles ready" : "";
  $("dSubPath").value = data.demo_subtitles || "";
  $("pathInput").value = data.info.path;
  S.preview = data.preview || { mode: "direct", ready: false, state: "none" };
  setupPreview(S.preview);
  S.view = { start: 0, span: S.duration };

  const v = data.info.video || {};
  const a = data.info.audio;
  $("fileMeta").textContent =
    `${v.width}×${v.height} · ${v.codec} · ${v.fps} fps · ` +
    `${fmtBytes(v.bitrate_bps * 0.125)}/s video` +
    (a ? ` · ${a.codec} ${a.channels}ch ${a.sample_rate}Hz` : " · no audio") +
    ` · ${fmtTime(S.duration, false)} · ${fmtBytes(data.info.size_bytes)}`;

  applyProfile(data.profile);
  defaultOutput();
  resetCaptionCard();
  $("detectInfo").textContent = "";
  $("exportBtn").disabled = true;
  refresh();

  // Restore this project's saved edit list after a page refresh.
  try {
    const saved = await api("/api/timeline");
    if (S.project === data && saved.timeline && saved.timeline.clips) {
      S.tl = saved.timeline;
      S.lastJSON = JSON.stringify(S.tl);
      refresh();
    }
  } catch (_) {
    // No saved edit list: keep the default single clip.
  }

  // These FFmpeg scans compete for CPU and disk with a required proxy build.
  // Defer cosmetic timeline assets until the browser-friendly copy is ready.
  timelineAssetsPending = S.preview.mode === "proxy" && !S.preview.ready;
  if (!timelineAssetsPending) loadTimelineAssets();
}
