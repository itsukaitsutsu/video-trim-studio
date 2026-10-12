/* Timeline editor for the one video: the V1 clip row, caption lanes below it,
 * copy/cut/paste, split, move/trim, undo/redo, playback and the glue to
 * detection and export. Loaded before app.js and uses the state S defined there.
 * Editing rules live in timeline-model.js (window.TLM). */
"use strict";

const TL = { labelW: 68, ruler: 20, vTop: 20, vH: 40, vGap: 4,
             aH: 26, aGap: 3, laneH: 22, laneGap: 3, wave: 12 };
const vTrackCount = () => TLM.vtracksOf(S.tl);
const aTrackCount = () => TLM.atracksOf(S.tl);
const vTrackTop = () => TL.vTop + vTrackCount() * (TL.vH + TL.vGap);
const vY = (track) => TL.vTop + Math.max(0, track || 0) * (TL.vH + TL.vGap);
// Audio lanes sit between the picture tracks and the caption lanes, one per
// video track (A1 is V1's sound) plus any spare for music / voice-over.
const aTop = () => vTrackTop() + 3;
const aY = (i) => aTop() + Math.max(0, i || 0) * (TL.aH + TL.aGap);
const aTrackTop = () => aTop() + aTrackCount() * (TL.aH + TL.aGap);
const laneY = (i) => aTrackTop() + i * (TL.laneH + TL.laneGap);
const laneCount = () => Math.max(1, S.tl.lanes || 1);
const tlHeight = () => laneY(laneCount()) + 4;
const tlItems = (tl) => [...(tl.clips || []), ...(tl.auds || []), ...(tl.caps || [])];
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
// Picture and sound: playback runs to the end of everything on the timeline.
function timelineEnd() { return TLM.contentEnd(S.tl); }

function contentEnd() {
  return Math.max(S.duration || 0, TLM.contentEnd(S.tl), 0);
}

function selectedIds() { return [...S.sel]; }

function syncCapSel() {
  if (!S.tl || !S.tl.caps) { S.capSel = null; return; }
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

function plotWidth() { return Math.max(1, $("timeline").clientWidth); }
function pxPerSec() { return plotWidth() / Math.max(S.view.span, 1e-6); }
const t2x = (t) => ((t - S.view.start) / S.view.span) * plotWidth();
const x2t = (x) => S.view.start + (x / plotWidth()) * S.view.span;

function rowAt(y) {
  if (y < TL.ruler) return { kind: "ruler" };
  const vtEnd = vTrackTop();
  if (y >= TL.vTop && y < vtEnd) {
    const vtrack = Math.floor((y - TL.vTop) / (TL.vH + TL.vGap));
    return { kind: "video", vtrack: Math.min(vtrack, vTrackCount() - 1) };
  }
  const at = aTop(), atEnd = aTrackTop();
  if (y >= at && y < atEnd) {
    const atrack = Math.floor((y - at) / (TL.aH + TL.aGap));
    return { kind: "audio", atrack: Math.max(0, Math.min(atrack, aTrackCount() - 1)) };
  }
  if (y >= atEnd) {
    const lane = Math.floor((y - atEnd) / (TL.laneH + TL.laneGap));
    if (lane < laneCount()) return { kind: "lane", lane };
  }
  return { kind: "none" };
}

function itemsOnRow(row) {
  if (row.kind === "video") return (S.tl.clips || []).filter((c) => TLM.trackOf(c) === row.vtrack);
  if (row.kind === "audio") return (S.tl.auds || []).filter((c) => TLM.atrackOf(c) === row.atrack);
  if (row.kind === "lane") return (S.tl.caps || []).filter((c) => c.lane === row.lane);
  return [];
}

// The sound of a video clip is drawn on the matching audio lane. Clicking it
// selects the picture it belongs to, so the pair stays linked until the user
// unlinks it from the Clip panel.
function linkedAudioAt(row, x) {
  if (row.kind !== "audio") return null;
  return (S.tl.clips || []).find((c) => TLM.trackOf(c) === row.atrack
    && c.audio !== false && itemHasAudio(c)
    && x >= t2x(c.start) - 3 && x <= t2x(c.end) + 3) || null;
}

function itemHasAudio(it) {
  if (it.atrack !== undefined) return mediaHasAudio(it.src || TLM.MAIN_SRC);
  return mediaHasAudio(it.src || TLM.MAIN_SRC);
}

function hitItem(row, x) {
  let best = null;
  for (const it of itemsOnRow(row)) {
    if (itemHidden(it)) continue;
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

/* ------------------------------------------------------------ lane lock/eye */

// Video lane v -> "v0".., caption lane -> "c0".. The sets live on S so the
// workspace layout can persist them. Lock blocks timeline gestures
// (move/trim/razor/split/delete/cut/mute); the eye only declutters the
// timeline drawing — preview and export are unaffected.
function laneSets() {
  if (!S.laneHidden) S.laneHidden = new Set();
  if (!S.laneLocked) S.laneLocked = new Set();
}
function laneKeyOf(it) {
  if (TLM.isAudioItem(it)) return `a${TLM.atrackOf(it)}`;
  return TLM.isClip(it) ? `v${TLM.trackOf(it)}` : `c${it.lane}`;
}
function laneHidden(key) { laneSets(); return S.laneHidden.has(key); }
function laneLocked(key) { laneSets(); return S.laneLocked.has(key); }
function itemLocked(it) { return laneLocked(laneKeyOf(it)); }
function itemHidden(it) { return laneHidden(laneKeyOf(it)); }
function findTlItem(id) {
  return tlItems(S.tl).find((it) => it.id === id) || null;
}
function laneName(key) {
  const n = Number(key.slice(1)) + 1;
  return key[0] === "v" ? `V${n}` : key[0] === "a" ? `A${n}` : `T${n}`;
}
function laneLabelsDirty() {
  renderedLaneSig = "";
  if (S.project) draw();
}
const LANE_SVG = {
  lock: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="5" y="9" width="10" height="7" rx="1.4"/><path d="M7 9V6.8a3 3 0 0 1 6 0V9"/></svg>`,
  eye: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2.5 10S5.4 5.8 10 5.8 17.5 10 17.5 10 14.6 14.2 10 14.2 2.5 10 2.5 10Z"/><circle cx="10" cy="10" r="2.2"/></svg>`,
};
let renderedLaneSig = "";

function syncTrackLabels(height) {
  const rail = $("trackLabels");
  if (!rail) return;
  laneSets();
  // Prune lanes that no longer exist so stale keys never linger.
  for (const key of [...S.laneHidden, ...S.laneLocked]) {
    const n = Number(key.slice(1));
    const live = key[0] === "v" ? n < vTrackCount()
      : key[0] === "a" ? n < aTrackCount() : n < laneCount();
    if (!live) { S.laneHidden.delete(key); S.laneLocked.delete(key); }
  }
  const count = laneCount();
  const vc = vTrackCount();
  const ac = aTrackCount();
  const sig = `${vc}/${ac}/${count}/` +
    [...S.laneHidden].sort().join(",") + "|" + [...S.laneLocked].sort().join(",");
  if (sig !== renderedLaneSig) {
    const btn = (key, op, on, title, svg) =>
      `<button type="button" class="lanebtn${on ? "" : " off"}" data-lane="${key}" ` +
      `data-op="${op}" title="${title}">${svg}</button>`;
    const label = (key, name, cls, top, h) =>
      `<div class="track-name ${cls}${laneHidden(key) ? " lane-hidden" : ""}" ` +
      `style="top:${top}px;height:${h}px"><span class="tlabel">${name}</span>` +
      btn(key, "lock", laneLocked(key), `${name}: lock lane (blocks timeline edits)`, LANE_SVG.lock) +
      btn(key, "eye", !laneHidden(key), `${name}: show / hide lane on the timeline`, LANE_SVG.eye) +
      `</div>`;
    const videos = Array.from({ length: vc }, (_, v) =>
      label(`v${v}`, `V${v + 1}`, "video", vY(v), TL.vH)).join("");
    const audios = Array.from({ length: ac }, (_, a) =>
      label(`a${a}`, `A${a + 1}`, "audio", aY(a), TL.aH)).join("");
    const captions = Array.from({ length: count }, (_, lane) =>
      label(`c${lane}`, `T${lane + 1}`, "caption", laneY(lane), TL.laneH)).join("");
    rail.innerHTML = `<div class="track-ruler"></div>` + videos + audios + captions;
    renderedLaneSig = sig;
  }
  const viewport = $("timelineViewport");
  const visibleHeight = viewport?.style.height ? viewport.clientHeight : 0;
  rail.style.height = `${Math.max(height, visibleHeight)}px`;
  if (viewport) rail.style.transform = `translateX(${viewport.scrollLeft}px)`;
  const stage = rail.parentElement;
  if (stage) stage.style.gridTemplateColumns = `${TL.labelW}px minmax(0, 1fr)`;
}

function syncTrackLabelScroll() {
  const viewport = $("timelineViewport");
  const rail = $("trackLabels");
  if (viewport && rail) rail.style.transform = `translateX(${viewport.scrollLeft}px)`;
}

function canvasGeo() {
  const cv = $("timeline");
  const h = tlHeight();
  syncTrackLabels(h);
  const w = cv.clientWidth;
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

// Peaks for any asset: the main video reuses the project waveform, everything
// else is fetched from /api/bin/<id>/waveform the first time it is drawn.
function peaksFor(src) {
  if (!src || src === TLM.MAIN_SRC) return (S.peaks && S.peaks.length) ? S.peaks : null;
  const got = MEDIA.peaks.get(src);
  if (!got && typeof mediaPeaks === "function") mediaPeaks(src);
  return got || null;
}

function sourceDurationOf(src) {
  if (!src || src === TLM.MAIN_SRC) return S.duration || 0;
  return mediaDuration(src) || S.duration || 0;
}

function drawWave(ctx, item, x, x2, yBottom, h, src) {
  const srcId = src !== undefined ? src : (item.src || TLM.MAIN_SRC);
  const peaks = peaksFor(srcId);
  const dur = sourceDurationOf(srcId);
  const n = peaks ? peaks.length : 0;
  if (!n || !dur) return;
  ctx.fillStyle = "rgba(46,160,67,0.9)";
  const mid = yBottom - h / 2;
  for (let px = Math.max(0, Math.floor(x)); px < Math.min(x2, $("timeline").clientWidth); px += 1) {
    const at = (Number(item.in) || 0) + (x2t(px) - item.start);
    const idx = Math.floor((at / dur) * n);
    if (idx < 0 || idx >= n) continue;
    const amp = (peaks[idx] / 1000) * (h / 2);
    ctx.fillRect(px, mid - amp, 1, Math.max(1, amp * 2));
  }
}

// Poster frame for a bin asset (no filmstrip is generated for those).
const MEDIA_POSTERS = new Map();
function mediaPoster(src) {
  if (!src || src === TLM.MAIN_SRC) return null;
  if (MEDIA_POSTERS.has(src)) return MEDIA_POSTERS.get(src);
  const img = new Image();
  img.onload = () => { if (S.project) draw(); };
  img.src = mediaThumb(src);
  MEDIA_POSTERS.set(src, img);
  return img.complete && img.naturalWidth ? img : null;
}

function drawPoster(ctx, item, x, x2, y, h, src) {
  const img = mediaPoster(src);
  if (!img) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, x2 - x, h);
  ctx.clip();
  ctx.globalAlpha = 0.9;
  const scale = Math.max((x2 - x) / img.naturalWidth, h / img.naturalHeight);
  const w = img.naturalWidth * scale, hh = img.naturalHeight * scale;
  ctx.drawImage(img, x + ((x2 - x) - w) / 2, y + (h - hh) / 2, w, hh);
  ctx.restore();
  ctx.globalAlpha = 1;
}

function drawAud(ctx, a) {
  const x = t2x(a.start);
  const x2 = Math.max(x + 2, t2x(a.end));
  const bw = x2 - x;
  const y = aY(TLM.atrackOf(a)) + 1;
  const bh = TL.aH - 2;
  const selected = S.sel.has(a.id);
  ctx.fillStyle = selected ? "#3fb950" : "#238636";
  ctx.beginPath();
  roundRectPath(ctx, x, y, bw, bh, 3);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  roundRectPath(ctx, x, y, bw, bh, 3);
  ctx.clip();
  drawWave(ctx, a, x, x2, y + bh - 1, Math.max(4, bh - 6), a.src);
  ctx.restore();
  if (selected) {
    ctx.strokeStyle = "#f0f6fc";
    ctx.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1);
  }
  const fx = TLM.cleanFx(a.fx);
  if (fx.mute || fx.volume !== 100) {
    ctx.fillStyle = fx.mute ? "#f85149" : "#ffd54a";
    ctx.beginPath();
    ctx.arc(x + bw - 6, y + 6, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  if (bw > 34) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 3, y, bw - 6, bh);
    ctx.clip();
    ctx.fillStyle = "rgba(8,12,18,0.62)";
    const label = a.name || mediaName(a.src);
    ctx.font = "10px sans-serif";
    const tw = Math.min(bw - 8, ctx.measureText(label).width + 8);
    ctx.fillRect(x + 3, y + 2, tw, 12);
    ctx.fillStyle = "#e6edf3";
    ctx.fillText(label, x + 7, y + 11);
    ctx.restore();
  }
}

// A video clip's own sound, drawn on the audio lane with the same index.
function drawLinkedAudio(ctx, c) {
  const x = t2x(c.start);
  const x2 = Math.max(x + 2, t2x(c.end));
  const bw = x2 - x;
  const y = aY(TLM.trackOf(c)) + 1;
  const bh = TL.aH - 2;
  const selected = S.sel.has(c.id);
  const fx = TLM.cleanFx(c.fx);
  ctx.fillStyle = selected ? "#2f6fd6" : "#1f4b8f";
  ctx.beginPath();
  roundRectPath(ctx, x, y, bw, bh, 3);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  roundRectPath(ctx, x, y, bw, bh, 3);
  ctx.clip();
  ctx.globalAlpha = fx.mute ? 0.35 : 1;
  drawWave(ctx, c, x, x2, y + bh - 1, Math.max(4, bh - 6), c.src);
  ctx.restore();
  ctx.globalAlpha = 1;
  if (selected) {
    ctx.strokeStyle = "#f0f6fc";
    ctx.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1);
  }
  if (fx.mute) {
    ctx.strokeStyle = "#f85149";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + 4, y + bh - 4);
    ctx.lineTo(x + Math.min(bw - 4, 16), y + 4);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}

function drawClip(ctx, c) {
  const x = t2x(c.start);
  const x2 = Math.max(x + 2, t2x(c.end));
  const bw = x2 - x;
  const y = vY(TLM.trackOf(c)) + 2;
  const bh = TL.vH - 4;
  const selected = S.sel.has(c.id);
  const src = c.src || TLM.MAIN_SRC;
  const isMain = src === TLM.MAIN_SRC;
  ctx.fillStyle = (c.kind && KIND_COLOR[c.kind]) || (isMain ? CLIP_FALLBACK : "#3d3b52");
  ctx.globalAlpha = selected ? 0.95 : 0.8;
  ctx.fillRect(x, y, bw, bh);
  ctx.globalAlpha = 1;
  if (isMain) drawFilmstrip(ctx, c, x, x2, y, bh - TL.wave);
  else drawPoster(ctx, c, x, x2, y, bh - TL.wave, src);
  if (c.audio !== false && itemHasAudio(c)) drawWave(ctx, c, x, x2, y + bh, TL.wave, src);
  if (bw > 40 && (c.text || c.kind || !isMain)) {
    const label = c.text || c.kind || c.name || mediaName(src);
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
  // keyframe diamonds along the top edge + a dot when effects are set
  const kfs = Array.isArray(c.kf) ? c.kf : [];
  if (kfs.length) {
    ctx.fillStyle = "#ffd54a";
    for (const k of kfs) {
      const kx = t2x(c.start + (Number(k.t) || 0));
      if (kx < x || kx > x2) continue;
      ctx.beginPath();
      ctx.moveTo(kx, y + 1);
      ctx.lineTo(kx + 3, y + 5);
      ctx.lineTo(kx, y + 9);
      ctx.lineTo(kx - 3, y + 5);
      ctx.closePath();
      ctx.fill();
    }
  }
  if (!TLM.fxIsDefault(c.fx)) {
    ctx.fillStyle = "#39c5cf";
    ctx.beginPath();
    ctx.arc(x + bw - 8, y + bh - 8, 3, 0, Math.PI * 2);
    ctx.fill();
  }
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
  if (w < 10) return;   // the timeline panel is hidden; nothing to paint
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

  // video rows V1..Vn; the separate left rail holds the labels while this area pans.
  for (let v = 0; v < vTrackCount(); v += 1) {
    ctx.fillStyle = "#0d1218";
    ctx.fillRect(0, vY(v), w, TL.vH);
  }
  for (const c of S.tl.clips) {
    if (c.end < v0 || c.start > v1) continue;
    if (itemHidden(c)) continue;
    drawClip(ctx, c);
  }

  // audio lanes A1..An: standalone items, plus the sound of each V track.
  for (let a = 0; a < aTrackCount(); a += 1) {
    ctx.fillStyle = "#0b1017";
    ctx.fillRect(0, aY(a), w, TL.aH);
  }
  for (const c of S.tl.clips) {
    if (c.end < v0 || c.start > v1) continue;
    if (itemHidden(c) || c.audio === false) continue;
    if (TLM.trackOf(c) >= aTrackCount()) continue;
    if (!itemHasAudio(c)) continue;
    drawLinkedAudio(ctx, c);
  }
  for (const a of S.tl.auds) {
    if (a.end < v0 || a.start > v1) continue;
    drawAud(ctx, a);
  }

  // caption lanes; their T labels are kept in the independent left rail.
  for (let i = 0; i < laneCount(); i += 1) {
    const y = laneY(i);
    ctx.fillStyle = "#0d1218";
    ctx.fillRect(0, y, w, TL.laneH);
  }
  for (const c of S.tl.caps) {
    if (c.end < v0 || c.start > v1) continue;
    if (itemHidden(c)) continue;
    drawCap(ctx, c);
  }

  // marquee (selection) and zoom-rectangle share the rubber band
  if (S.drag && (S.drag.mode === "marquee" || S.drag.mode === "zoomrect") && S.drag.moved) {
    const d = S.drag;
    ctx.fillStyle = "rgba(88,166,255,.18)";
    ctx.fillRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1),
                 Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
  }

  drawDropHint(ctx, w);

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

function refresh(forcePreview = false) {
  // Keep the time-to-pixel mapping stable during a drag; clamp the viewport
  // once the gesture ends instead of letting the clip under the pointer jump.
  if (!S.drag) clampView();
  renderList();
  syncListPlayhead();
  draw();
  updateTally();
  updateTimecode();
  layoutCapOverlay();
  if (typeof ClipRefresh === "function") ClipRefresh();
  // The timeline is the source of truth. Edits can change which source frame
  // belongs under the unchanged playhead (or turn it into a gap), so keep the
  // video preview aligned whenever the edit list changes.
  syncPreview(forcePreview);
}

function setTL(next) {
  // Every path into the editor goes through here, so normalise once: a caller
  // that builds a bare { clips, caps } (detection, presets) still ends up with
  // the audio lanes the rest of the app assumes.
  S.tl = TLM.normalise(next);
  syncCapSel();
  commitTL();
  refresh(true);
}

function commitCaptions() {        // legacy name, used by the caption box
  commitTL();
  refresh();
}

function undoTL() {
  if (!S.undo.length) return status("Nothing to undo.");
  S.redo.push(S.lastJSON);
  S.lastJSON = S.undo.pop();
  S.tl = TLM.normalise(JSON.parse(S.lastJSON));
  S.sel = new Set([...S.sel].filter((id) => tlItems(S.tl).some((c) => c.id === id)));
  syncCapSel();
  scheduleSave();
  refresh(true);
  status("Undone.");
}

function redoTL() {
  if (!S.redo.length) return status("Nothing to redo.");
  S.undo.push(S.lastJSON);
  S.lastJSON = S.redo.pop();
  S.tl = TLM.normalise(JSON.parse(S.lastJSON));
  S.sel = new Set();
  syncCapSel();
  scheduleSave();
  refresh(true);
  status("Redone.");
}

// The edit list is saved a moment after the last change, and right away when
// the page is hidden or reloaded, so a quick edit before a refresh is kept.
let pendingSave = null;
let saveInFlight = false;

function scheduleSave() {
  if (!S.project) return;
  pendingSave = JSON.stringify(S.tl);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushSave(false), 250);
}

function flushSave(leaving) {
  clearTimeout(saveTimer);
  if (pendingSave === null || (saveInFlight && !leaving)) return;
  const body = pendingSave;
  saveInFlight = true;
  fetch("/api/timeline", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: body.length < 60000,
  }).then(async (r) => {
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.detail || r.statusText);
    }
    if (pendingSave === body) pendingSave = null;
  }).catch((e) => status(`Timeline not saved: ${e.message}`)).finally(() => {
    saveInFlight = false;
    // Serialize normal saves: an older response must never overwrite a newer edit.
    if (pendingSave !== null && pendingSave !== body) flushSave(false);
  });
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
  S.sel = new Set(tlItems(S.tl).map((c) => c.id));
  syncCapSel();
  refresh();
}

/* ------------------------------------------------------------ editing ops */

function deleteSel(ripple) {
  const ids = selectedIds();
  if (!ids.length) return status("Select a clip or caption first.");
  const open = ids.filter((id) => { const it = findTlItem(id); return it && !itemLocked(it); });
  if (!open.length) return status("That lane is locked.");
  S.sel = new Set();
  setTL(TLM.deleteItems(S.tl, open, ripple));
  status((ripple ? "Removed and closed the gap." : "Removed (gap left on the timeline).") +
    (open.length < ids.length ? " A locked lane was skipped." : ""));
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
  const open = ids.filter((id) => { const it = findTlItem(id); return it && !itemLocked(it); });
  S.sel = new Set();
  if (open.length) setTL(TLM.deleteItems(S.tl, open, false));
  status(open.length < ids.length
    ? `Copied ${S.clip.items.length} item(s) — a locked lane was left in place.`
    : `Cut ${S.clip.items.length} item(s). Paste with Ctrl+V.`);
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
  const at = playheadTime();
  const pool = selectedIds().length
    ? selectedIds().map(findTlItem).filter(Boolean)
    : tlItems(S.tl);
  const skipped = pool.filter((it) => itemLocked(it) && at > it.start + 0.05 && at < it.end - 0.05);
  const cut = pool.filter((it) => !itemLocked(it)).map((it) => it.id);
  if (!cut.length) return status(skipped.length ? "That lane is locked." : "Nothing to split at the playhead.");
  const next = TLM.splitSelection(S.tl, at, cut);
  if (JSON.stringify(next) === JSON.stringify(S.tl)) {
    return status(skipped.length ? "Nothing to split (a locked lane was skipped)." : "Nothing to split at the playhead.");
  }
  setTL(next);
  status(`Split at ${fmtTime(at, false)}${skipped.length ? " (a locked lane was skipped)" : ""}.`);
}

function addCaptionAtPlayhead() {
  if (!S.project) return alert("Open a video first.");
  const style = (S.capSel && S.tl.caps.find((c) => c.id === S.capSel)?.style) || CAPPOS;
  const r = TLM.addCaption(S.tl, playheadTime(), "New caption", style, 0);
  S.sel = new Set([r.id]);
  S.capSel = r.id;
  setTL(dodgeLockedLane(r.tl, r.id));
}

function addLane() {
  if (!S.project) return;
  S.tl = { ...S.tl, lanes: laneCount() + 1 };
  commitTL();
  refresh();
}

// An empty Vn (and its An) to drop another layer on.
function addVideoTrack() {
  if (!S.project) return;
  const v = vTrackCount();
  S.tl = TLM.normalise({ ...S.tl, vtracks: v + 1, atracks: Math.max(aTrackCount(), v + 1) });
  commitTL();
  refresh();
  status(`V${v + 1} added — drop media on it to overlay the tracks below.`);
}


/* ------------------------------------------------------------ snapping */

function snapCandidates(exclude) {
  const list = [0, playheadTime(), timelineEnd()];
  for (const c of tlItems(S.tl)) {
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
  const items = tlItems(base).filter((c) => sel.has(c.id));
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
    if (itemHidden(c)) continue;
    const cy0 = vY(TLM.trackOf(c)), cy1 = cy0 + TL.vH;
    if (t2x(c.end) >= a && t2x(c.start) <= b && cy0 <= bottom && cy1 >= top) picked.add(c.id);
  }
  for (const c of S.tl.caps) {
    if (itemHidden(c)) continue;
    const y0 = laneY(c.lane), y1 = y0 + TL.laneH;
    if (t2x(c.end) >= a && t2x(c.start) <= b && y0 <= bottom && y1 >= top) picked.add(c.id);
  }
  for (const a2 of S.tl.auds) {
    const y0 = aY(TLM.atrackOf(a2)), y1 = y0 + TL.aH;
    if (t2x(a2.end) >= a && t2x(a2.start) <= b && y0 <= bottom && y1 >= top) picked.add(a2.id);
  }
  S.sel = picked;
}


/* ------------------------------------------------------------ tools */

const TL_TOOLS = [
  { id: "select", key: "V", hint: "Select / move" },
  { id: "razor", key: "R", hint: "Razor: click a clip or caption to split it" },
  { id: "text", key: "T", hint: "Caption: click the timeline to add one" },
  { id: "hand", key: "H", hint: "Pan: drag to scroll the timeline" },
  { id: "zoom", key: "Z", hint: "Zoom: drag a range, click to zoom in (Alt = out)" },
  { id: "mute", key: "M", hint: "Mute: click a clip to mute / unmute it" },
];
let curTool = "select";

function toolCursor() {
  return { select: "default", razor: "crosshair", text: "text", hand: "grab", zoom: "zoom-in", mute: "pointer" }[curTool] || "default";
}

function setTool(id) {
  if (!TL_TOOLS.some((t) => t.id === id)) id = "select";
  curTool = id;
  document.querySelectorAll("#tlTools .tl-tool").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === id);
  });
  const cv = $("timeline");
  if (cv) cv.style.cursor = toolCursor();
  const t = TL_TOOLS.find((t) => t.id === id);
  status(`Tool: ${t.hint} (${t.key})`);
}

function bindTools() {
  document.querySelectorAll("#tlTools .tl-tool").forEach((b) => {
    b.addEventListener("click", () => setTool(b.dataset.tool));
  });
}

function razorSplit(item, t) {
  if (itemLocked(item)) return status(`${laneName(laneKeyOf(item))} is locked.`);
  if (!(t > item.start + 0.05 && t < item.end - 0.05)) {
    return status("Too close to the edge to split.");
  }
  const next = TLM.splitSelection(S.tl, t, [item.id]);
  if (JSON.stringify(next) === JSON.stringify(S.tl)) return status("Nothing to split here.");
  setTL(next);
  status(`Split at ${fmtTime(t, false)}.`);
}

function dodgeLockedLane(tl, id) {
  // New captions restack past locked lanes (and anything already there).
  const cap = tl.caps.find((c) => c.id === id);
  if (!cap) return tl;
  const others = tl.caps.filter((c) => c.id !== id);
  while (laneLocked(`c${cap.lane}`) ||
         others.some((o) => o.lane === cap.lane && o.start < cap.end && o.end > cap.start)) {
    cap.lane += 1;
  }
  return { ...tl, lanes: Math.max(tl.lanes || 1, cap.lane + 1) };
}

function addCaptionAt(t) {
  if (!S.project) return;
  const style = (S.capSel && S.tl.caps.find((c) => c.id === S.capSel)?.style) || CAPPOS;
  const r = TLM.addCaption(S.tl, Math.max(0, t), "New caption", style, 0);
  S.sel = new Set([r.id]);
  S.capSel = r.id;
  setTL(dodgeLockedLane(r.tl, r.id));
  status("Caption added — double-click it to edit the text.");
}

function toggleClipMute(id) {
  const clip = (S.tl.clips || []).find((c) => c.id === id)
    || (S.tl.auds || []).find((c) => c.id === id);
  if (!clip) return;
  if (itemLocked(clip)) return status(`${laneName(laneKeyOf(clip))} is locked.`);
  if (!clip.fx || typeof clip.fx !== "object") clip.fx = TLM.defaultFx();
  if (!Array.isArray(clip.kf)) clip.kf = [];
  clip.fx.mute = !clip.fx.mute;
  commitTL();
  refresh();
  status(clip.fx.mute ? "Muted (M tool: click again to unmute)." : "Unmuted.");
}

// While a bin tile is dragged over the canvas, the target lane and time are
// highlighted so the drop point is obvious before releasing.
function setDropHint(active) {
  if (!active) S.dropHint = null;
  draw();
}

function dropTargetFor(ev, cv) {
  const r = cv.getBoundingClientRect();
  const x = ev.clientX - r.left, y = ev.clientY - r.top;
  const row = rowAt(y);
  const t = Math.max(0, snapTime(x2t(x), new Set()));
  return { x, y, row, t };
}

function drawDropHint(ctx, w) {
  const d = S.dropHint;
  if (!d) return;
  const isAudio = d.kind === "audio";
  let top, height;
  if (isAudio) {
    const lane = d.row.kind === "audio" ? d.row.atrack : 0;
    top = aY(lane); height = TL.aH;
  } else {
    const lane = d.row.kind === "video" ? d.row.vtrack : d.lane;
    top = vY(lane); height = TL.vH;
  }
  const x = t2x(d.t);
  const bw = Math.max(3, (d.duration || 2) * pxPerSec());
  ctx.fillStyle = "rgba(63,185,80,0.22)";
  ctx.fillRect(0, top, w, height);
  ctx.strokeStyle = "#3fb950";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x + 0.5, top + 0.5, bw, height - 1);
  ctx.lineWidth = 1;
  ctx.fillStyle = "#3fb950";
  ctx.font = "10px sans-serif";
  ctx.fillText(`${isAudio ? "A" : "V"}${d.lane + 1} · ${fmtTime(d.t, false)}`, x + 4, top + 11);
}

function bindTimeline() {
  const cv = $("timeline");
  const viewport = $("timelineViewport");
  const rail = $("trackLabels");
  if (rail && rail.dataset.laneBound !== "true") {
    rail.dataset.laneBound = "true";
    rail.addEventListener("click", (ev) => {
      const b = ev.target.closest(".lanebtn");
      if (!b || !S.project) return;
      ev.stopPropagation();
      laneSets();
      const set = b.dataset.op === "lock" ? S.laneLocked : S.laneHidden;
      const key = b.dataset.lane;
      if (set.has(key)) set.delete(key);
      else set.add(key);
      saveWorkspaceLayout();
      laneLabelsDirty();
      const name = laneName(key);
      status(b.dataset.op === "lock"
        ? (set.has(key) ? `${name} locked — timeline edits blocked.` : `${name} unlocked.`)
        : (set.has(key) ? `${name} hidden on the timeline (preview/export unaffected).` : `${name} shown.`));
    });
  }
  if (viewport && viewport.dataset.trackRailScrollBound !== "true") {
    viewport.addEventListener("scroll", syncTrackLabelScroll, { passive: true });
    viewport.dataset.trackRailScrollBound = "true";
    syncTrackLabelScroll();
  }

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
    if (row.kind === "none") return;
    if (curTool === "razor") {
      const hit = hitItem(row, x);
      if (hit) razorSplit(hit, x2t(x));
      return;
    }
    if (curTool === "text") {
      addCaptionAt(x2t(x));
      return;
    }
    if (curTool === "hand") {
      S.drag = {
        mode: "pan", x0: x, clientY0: ev.clientY, vStart: S.view.start,
        scrollTop: viewport ? viewport.scrollTop : 0,
      };
      cv.style.cursor = "grabbing";
      return;
    }
    if (curTool === "zoom") {
      S.drag = { mode: "zoomrect", x0: x, y0: y, x1: x, y1: y, moved: false, alt: ev.altKey };
      return;
    }
    if (curTool === "mute") {
      let hit = hitItem(row, x);
      if (!hit && row.kind === "audio") hit = linkedAudioAt(row, x);
      if (hit && (TLM.isClip(hit) || TLM.isAudioItem(hit))) toggleClipMute(hit.id);
      else status("Only clips with audio can be muted.");
      return;
    }
    let hit = hitItem(row, x);
    if (!hit && row.kind === "audio") hit = linkedAudioAt(row, x);
    if (hit) {
      if (itemLocked(hit)) {
        if (!ev.shiftKey && !ev.ctrlKey && !ev.metaKey) selectOnly(hit.id);
        return status(`${laneName(laneKeyOf(hit))} is locked — unlock it to move or trim.`);
      }
      const edge = edgeAt(hit, x);
      const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
      if (additive) toggleSel(hit.id);
      else if (!S.sel.has(hit.id)) selectOnly(hit.id);
      if (additive && !S.sel.has(hit.id)) return;     // it was just deselected
      S.drag = {
        mode: edge === "move" ? "move" : edge === "l" ? "trimL" : "trimR",
        id: hit.id, ids: selectedIds(), x0: x, y0: y, moved: false,
        base: JSON.parse(JSON.stringify(S.tl)), lane0: row.kind === "lane" ? row.lane : null,
        vtrack0: row.kind === "video" ? row.vtrack : null,
        atrack0: row.kind === "audio" ? row.atrack : null,
        alt: ev.altKey, srcDur: S.duration, resultIds: null,
      };
      return;
    }
    S.drag = {
      mode: "marquee", x0: x, y0: y, x1: x, y1: y, moved: false,
      additive: ev.shiftKey, baseSel: new Set(S.sel),
    };
  });

  // Drop a media-bin tile onto the timeline.
  const assetDrag = (ev) => [...(ev.dataTransfer ? ev.dataTransfer.types : [])]
    .includes("text/vts-asset");
  cv.addEventListener("dragover", (ev) => {
    if (!S.project || !assetDrag(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
    const asset = MEDIA.assets.get(ev.dataTransfer.getData("text/vts-asset"));
    if (!asset) return;
    const d = dropTargetFor(ev, cv);
    const dur = asset.kind === "image"
      ? Math.max(TLM.MIN_LEN, Number($("mediaStillDur") ? $("mediaStillDur").value : 5) || 5)
      : Math.max(TLM.MIN_LEN, Number(asset.duration) || TLM.MIN_LEN);
    const lane = asset.kind === "audio"
      ? (d.row.kind === "audio" ? d.row.atrack : 0)
      : (d.row.kind === "video" ? d.row.vtrack : TLM.firstFreeTrack(S.tl.clips || [], d.t, d.t + dur));
    S.dropHint = { ...d, kind: asset.kind, lane, duration: dur, name: asset.name };
    draw();
  });
  cv.addEventListener("dragleave", () => { if (S.dropHint) { S.dropHint = null; draw(); } });
  cv.addEventListener("drop", (ev) => {
    if (!S.project || !assetDrag(ev)) return;
    ev.preventDefault();
    S.dropHint = null;
    const id = ev.dataTransfer.getData("text/vts-asset");
    const asset = MEDIA.assets.get(id);
    if (!asset) return;
    const d = dropTargetFor(ev, cv);
    if (asset.kind === "audio") {
      const atrack = d.row.kind === "audio" ? d.row.atrack : 0;
      const item = TLM.makeAudioItem(asset, d.t, atrack);
      setTL(TLM.normalise({ ...S.tl, auds: [...(S.tl.auds || []), item] }));
      S.sel = new Set([item.id]);
      syncCapSel();
      draw();
      status(`${asset.name} → A${atrack + 1} at ${fmtTime(d.t, false)}.`);
      return;
    }
    const dur = asset.kind === "image"
      ? Math.max(TLM.MIN_LEN, Number($("mediaStillDur") ? $("mediaStillDur").value : 5) || 5)
      : Math.max(TLM.MIN_LEN, Number(asset.duration) || TLM.MIN_LEN);
    const want = d.row.kind === "video"
      ? d.row.vtrack
      : TLM.firstFreeTrack(S.tl.clips || [], d.t, d.t + dur);
    const res = TLM.addMedia(S.tl, asset, d.t, want,
      { duration: dur, in: 0, fit: mediaDefaultFit(asset) });
    if (!res || !res.id) return;
    setTL(res.tl);
    S.sel = new Set([res.id]);
    syncCapSel();
    draw();
    status(res.moved
      ? `V${want + 1} was busy — ${asset.name} went to V${want + 1 + res.moved} so it overlays instead of overwriting.`
      : `${asset.name} → V${want + 1} at ${fmtTime(d.t, false)}.`);
  });

  cv.addEventListener("dblclick", (ev) => {
    if (!S.project) return;
    const r = cv.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    const row = rowAt(y);
    if (row.kind !== "lane") return;
    const hit = hitItem(row, x);
    if (!hit) return;
    if (itemLocked(hit)) return status(`${laneName(laneKeyOf(hit))} is locked.`);
    S.sel = new Set([hit.id]);
    S.capSel = hit.id;
    refresh();
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
      setPlayhead(x2t(Math.max(0, Math.min(r.width, x))));
      return;
    }
    if (!d.moved && (Math.abs(x - d.x0) > 3 || Math.abs(y - d.y0) > 3)) d.moved = true;
    if (d.mode === "pan") {
      S.view.start = clampStart(d.vStart - (x - d.x0) / pxPerSec(), S.view.span);
      if (viewport) viewport.scrollTop = d.scrollTop - (ev.clientY - d.clientY0);
      draw();
      return;
    }
    if (d.mode === "zoomrect") {
      d.x1 = x;
      d.y1 = y;
      draw();
      return;
    }
    if (d.mode === "marquee") {
      d.x1 = x;
      d.y1 = y;
      if (d.moved) {
        applyMarquee(d);
        syncCapSel();
        syncListSelection();
      }
      draw();
      layoutCapOverlay();
      return;
    }
    if (!d.moved) return;
    if (d.mode === "move") {
      const dt = snapShift(d.base, d.ids, (x - d.x0) / pxPerSec());
      const row = rowAt(y);
      const dLane = row.kind === "lane" && d.lane0 !== null ? row.lane - d.lane0 : 0;
      const dVTrack = row.kind === "video" && d.vtrack0 !== null ? row.vtrack - d.vtrack0 : 0;
      const dATrack = row.kind === "audio" && d.atrack0 !== null ? row.atrack - d.atrack0 : dVTrack;
      if (d.alt) {
        const dup = TLM.duplicateItems(d.base, d.ids, dt);
        S.tl = dVTrack ? TLM.moveItems(dup.tl, dup.ids, 0, 0, dVTrack) : dup.tl;
        d.resultIds = dup.ids;
      } else {
        S.tl = TLM.moveItems(d.base, d.ids, dt, dLane, dVTrack, dATrack);
      }
    } else {
      const t = snapTime(x2t(x), new Set([d.id]));
      S.tl = TLM.trimItem(d.base, d.id, d.mode === "trimL" ? "l" : "r", t, d.srcDur);
    }
    // Keep all views live while a clip is being moved or trimmed. Rebuilding
    // the small section table here means its times stay in step with the
    // canvas, while refresh also seeks the preview through the new edit list.
    refresh();
  });

  window.addEventListener("mouseup", () => {
    const d = S.drag;
    S.drag = null;
    if (!d) return;
    if (d.mode === "scrub") return;
    if (d.mode === "pan") {
      cv.style.cursor = toolCursor();
      return;
    }
    if (d.mode === "zoomrect") {
      const a = Math.min(d.x0, d.x1), b = Math.max(d.x0, d.x1);
      if (d.moved && b - a > 6) {
        const t0 = x2t(a);
        const span = Math.max(0.2, x2t(b) - t0);
        S.view.span = span;
        S.view.start = clampStart(t0, span);
      } else {
        const anchor = x2t(d.x0);
        const factor = d.alt ? 2 : 0.5;
        const span = Math.min(Math.max(contentEnd(), 1), Math.max(0.2, S.view.span * factor));
        const frac = (anchor - S.view.start) / S.view.span;
        S.view.start = clampStart(anchor - frac * span, span);
        S.view.span = span;
      }
      draw();
      return;
    }
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
      const item = d.id && [...d.base.clips, ...d.base.caps].find((it) => it.id === d.id);
      if (item) {
        // A click on a block both selects it and shows that exact frame in the
        // preview; the row at the playhead is highlighted in the clip list.
        const t = Math.min(item.end - 0.001, Math.max(item.start, x2t(d.x0)));
        setPlayhead(t, true);
      }
      refresh();
      return;
    }
    if (d.alt && d.resultIds) S.sel = new Set(d.resultIds);
    syncCapSel();
    commitTL();
    refresh(true);
  });

  viewport.addEventListener("wheel", (ev) => {
    if (!S.project) return;
    const verticalOverflows = viewport.scrollHeight > viewport.clientHeight + 1;
    // Alt+wheel is a dedicated vertical-scroll shortcut for the V/T track
    // stack. If everything already fits, consume the gesture without zooming
    // or panning the timeline.
    if (ev.altKey && ev.deltaY) {
      ev.preventDefault();
      if (verticalOverflows) viewport.scrollTop += ev.deltaY;
      return;
    }
    if (ev.ctrlKey && verticalOverflows && ev.deltaY) {
      ev.preventDefault();
      viewport.scrollTop += ev.deltaY;
      return;
    }
    ev.preventDefault();
    const r = cv.getBoundingClientRect();
    const anchor = x2t(ev.clientX - r.left);
    const stageOverflows = viewport.scrollWidth > viewport.clientWidth + 1;
    if (!(ev.ctrlKey || ev.metaKey) && stageOverflows && (ev.deltaX || ev.shiftKey)) {
      viewport.scrollLeft += ev.deltaX || ev.deltaY;
      syncTrackLabelScroll();
      return;
    }
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
  if (curTool !== "select" || (S.drag && S.drag.mode === "pan")) {
    cv.style.cursor = (S.drag && S.drag.mode === "pan") ? "grabbing" : toolCursor();
    return;
  }
  const row = rowAt(y);
  let cursor = "default";
  if (row.kind === "ruler") cursor = "pointer";
  else if (row.kind === "video" || row.kind === "lane" || row.kind === "audio") {
    let hit = hitItem(row, x);
    if (!hit && row.kind === "audio") hit = linkedAudioAt(row, x);
    if (hit) cursor = itemLocked(hit) ? "not-allowed" : edgeAt(hit, x) === "move" ? "grab" : "ew-resize";
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
  syncListPlayhead();
  syncListScroll(true);
  draw();
  updateTimecode();
  layoutCapOverlay();
  if (typeof ClipRefresh === "function") ClipRefresh();
}

// Composite every video track under the playhead, lowest track first, so V2
// really is drawn over V1 (B-roll / picture-in-picture) instead of only the
// topmost clip being visible. Nothing here is black in a gap: the whole stack
// is dropped and the black stage shows through, exactly like the export.
function syncPreview(force) {
  if (!S.project) return;
  if (typeof stageSync !== "function") return;
  const shade = $("gapShade");
  const stack = TLM.clipStackAt(S.tl, playheadTime());
  if (shade) shade.hidden = stack.length > 0;
  stageSync(playheadTime(), PV.playing, !!force);
}

// Mirror the clip's evaluated effects on a preview <video> (CSS approximation
// of the ffmpeg graph: position, size, crop, opacity, volume and fades).
function applyClipFx(el, clip, tAbs) {
  if (!el || !clip) return;
  const fx = TLM.evalFxAt(clip, tAbs);
  const env = TLM.fadeEnv(clip, tAbs);
  const vol = fx.mute ? 0 : (fx.volume / 100) * env.audio;
  try { el.volume = Math.max(0, Math.min(1, vol)); } catch (_) { /* not ready */ }
  el.style.transform =
    `translate(${fx.x.toFixed(2)}%, ${fx.y.toFixed(2)}%) scale(${(fx.scale / 100).toFixed(4)})`;
  el.style.opacity = ((fx.opacity / 100) * env.video).toFixed(3);
  if (fx.crop_l || fx.crop_t || fx.crop_r || fx.crop_b) {
    el.style.clipPath =
      `inset(${fx.crop_t}% ${fx.crop_r}% ${fx.crop_b}% ${fx.crop_l}%)`;
  } else {
    el.style.clipPath = "";
  }
}

function resetLayerFx(el) {
  if (!el) return;
  el.style.transform = "";
  el.style.opacity = "";
  el.style.clipPath = "";
  try { el.volume = 1; } catch (_) { /* not ready */ }
}

function togglePlay() {
  if (PV.playing) pausePlayback();
  else startPlayback();
}

function startPlayback() {
  if (!S.project || PV.playing) return;
  if (!(S.tl.clips || []).length) return status("The timeline is empty.");
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
  if (S.project) {
    syncPreview(true);          // settle every layer on the exact frame
    syncListPlayhead();
    draw();
    updateTimecode();
    layoutCapOverlay();
  }
}

function pvTick(now) {
  if (!PV.playing) return;
  const dt = Math.min(0.25, Math.max(0, (now - PV.last) / 1000));
  PV.last = now;
  // The playhead is the master clock. Layers are nudged onto it (see
  // stageSync), so a buffering clip can never drag the playhead backwards -
  // which is what used to make the preview stutter and lose sync.
  let t = playheadTime() + dt;
  const ref = typeof stageClockReference === "function" ? stageClockReference(t) : null;
  if (ref !== null && Number.isFinite(ref) && Math.abs(ref - t) < 0.35) t = ref;
  const end = Math.max(timelineEnd(), 0.001);
  if (t >= end) {
    S.T = end;
    pausePlayback();
    return;
  }
  S.T = t;
  syncPreview(false);
  followPlayhead();
  syncListPlayhead();
  draw();
  updateTimecode();
  layoutCapOverlay();
  if (typeof ClipTick === "function") ClipTick();
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
  // #player is now the frame reference the preview is measured against (its
  // video size drives the stage layout and the caption overlay geometry).
  // The picture itself is composited by stage.js, so it must stay silent.
  p.muted = true;
  try { p.volume = 0; } catch (_) { /* not ready */ }
  p.classList.add("player-reference");
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
    if (key === "Escape") {
      if (curTool !== "select") setTool("select");
      clearSel();
      return;
    }
    if (key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      const toolByKey = { v: "select", r: "razor", t: "text", h: "hand", z: "zoom", m: "mute" };
      const tool = toolByKey[key.toLowerCase()];
      if (tool) {
        ev.preventDefault();
        setTool(tool);
        return;
      }
    }
    if (key === "ArrowLeft" || key === "ArrowRight") {
      ev.preventDefault();
      if (ev.shiftKey) setPlayhead(playheadTime() + (key === "ArrowLeft" ? -1 : 1));
      else stepFrame(key === "ArrowLeft" ? -1 : 1);
    }
  });
}

/* ------------------------------------------------------------ clip list */

function allListItems() {
  const entries = [
    ...S.tl.clips.map((item) => ({
      id: item.id, item, type: "clip", track: `V${TLM.trackOf(item) + 1}`, kind: item.kind || "other",
    })),
    ...S.tl.caps.map((item) => ({
      id: item.id, item, type: "caption", track: `T${Math.max(0, item.lane || 0) + 1}`,
      kind: "caption",
    })),
  ];
  const rank = (entry) => entry.type === "clip" ? 0 : 1;
  return entries.sort((a, b) =>
    a.item.start - b.item.start || rank(a) - rank(b) ||
    (a.type === "caption" ? a.item.lane - b.item.lane : 0) ||
    a.item.end - b.item.end || a.id.localeCompare(b.id));
}

function visibleListItems() {
  const q = (S.filter.q || "").trim().toLowerCase();
  return allListItems().filter((entry) => {
    const item = entry.item;
    if (!S.filter.kinds.has(entry.kind)) return false;
    // The min-duration control historically filters detected V1 sections;
    // don't hide short timeline captions from their lane cards.
    if (entry.type === "clip" && item.end - item.start < S.filter.minDur) return false;
    if (q && !(item.text || "").toLowerCase().includes(q)) return false;
    return true;
  });
}

function listActiveIdsAt(t) {
  const ids = new Set();
  for (const clip of TLM.clipStackAt(S.tl, t)) ids.add(clip.id);
  for (const cap of S.tl.caps) {
    if (t >= cap.start && t <= cap.end) ids.add(cap.id);
  }
  return ids;
}

function listScrollTargetId(t) {
  const activeIds = listActiveIdsAt(t);
  if (S.capSel && activeIds.has(S.capSel)) return S.capSel;

  const activeClip = TLM.clipAt(S.tl, t);
  if (activeClip && S.sel.has(activeClip.id)) return activeClip.id;

  const selectedCaption = S.tl.caps
    .filter((cap) => activeIds.has(cap.id) && S.sel.has(cap.id))
    .sort((a, b) => a.lane - b.lane || a.start - b.start)[0];
  if (selectedCaption) return selectedCaption.id;

  const activeCaption = S.tl.caps
    .filter((cap) => activeIds.has(cap.id))
    .sort((a, b) => a.lane - b.lane || a.start - b.start)[0];
  return activeCaption?.id || activeClip?.id || null;
}

let lastListScrollId = null;

function syncListScroll(force = false) {
  const id = listScrollTargetId(playheadTime());
  if (!id) { lastListScrollId = null; return; }
  if (!force && id === lastListScrollId) return;

  const tb = document.querySelector("#secTable tbody");
  const row = tb && [...tb.querySelectorAll("tr[data-id]")]
    .find((item) => item.dataset.id === id);
  if (!row) { lastListScrollId = null; return; } // a list filter may hide it
  const scroller = row.closest(".list-scroll");
  if (!scroller) return;

  const viewport = scroller.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const head = scroller.querySelector("thead");
  const stickyHead = head ? head.getBoundingClientRect().height : 0;
  const visibleTop = Math.min(viewport.bottom, viewport.top + stickyHead + 1);
  if (rowRect.top < visibleTop) {
    scroller.scrollTop -= visibleTop - rowRect.top;
  } else if (rowRect.bottom > viewport.bottom) {
    scroller.scrollTop += rowRect.bottom - viewport.bottom;
  }
  lastListScrollId = id;
}

function listItemById(id) {
  return allListItems().find((entry) => entry.id === id) || null;
}

function renderList() {
  const tb = document.querySelector("#secTable tbody");
  if (!tb) return;
  const rows = visibleListItems();
  const activeIds = listActiveIdsAt(playheadTime());
  tb.innerHTML = rows.map((entry) => {
    const { item, type, track, kind, id } = entry;
    const classes = [
      S.sel.has(id) ? "sel" : "",
      activeIds.has(id) ? "at-playhead" : "",
    ].filter(Boolean).join(" ");
    const title = type === "caption"
      ? "Edit this caption cue's text."
      : "Edit section text. Matching timeline captions are updated too.";
    return `<tr data-id="${escapeHtml(id)}" data-type="${type}" class="${classes}">` +
      `<td class="check-cell"><input type="checkbox" ${S.sel.has(id) ? "checked" : ""}></td>` +
      `<td class="track">${escapeHtml(track)}</td>` +
      `<td>${fmtTime(item.start, false)}</td><td>${fmtTime(item.end, false)}</td>` +
      `<td>${fmtTime(item.end - item.start, false)}</td><td>${escapeHtml(kind)}</td>` +
      `<td class="txt txt-edit" contenteditable="true" spellcheck="false" ` +
      `title="${escapeHtml(title)}">${escapeHtml(item.text || "")}</td></tr>`;
  }).join("");
  const empty = $("listEmpty");
  if (empty) {
    const hasTimelineItems = S.tl.clips.length > 0 || S.tl.caps.length > 0;
    empty.hidden = rows.length > 0;
    empty.textContent = hasTimelineItems
      ? "No timeline items match these filters."
      : "No timeline items yet — open a video or add captions first.";
  }
}

let lastListId = null;
let activeListRows = new Map();
let lastActiveListIds = new Set();
let checklistDrag = null;
let suppressChecklistClick = false;

function syncListPlayhead() {
  const tb = document.querySelector("#secTable tbody");
  if (!tb) return;
  const nextIds = listActiveIdsAt(playheadTime());
  const same = nextIds.size === lastActiveListIds.size &&
    [...nextIds].every((id) => lastActiveListIds.has(id));
  const stale = [...activeListRows.values()].some((row) => !row.isConnected);
  if (same && !stale) return;

  activeListRows.clear();
  for (const row of tb.querySelectorAll("tr[data-id]")) {
    const active = nextIds.has(row.dataset.id);
    row.classList.toggle("at-playhead", active);
    if (active) activeListRows.set(row.dataset.id, row);
  }
  lastActiveListIds = nextIds;
  // Follow the cue on the selected lane (or the first active caption) when
  // the playhead enters a different set of timeline items.
  syncListScroll(false);
}

function syncListSelection() {
  const tb = document.querySelector("#secTable tbody");
  if (!tb) return;
  for (const row of tb.querySelectorAll("tr[data-id]")) {
    const selected = S.sel.has(row.dataset.id);
    row.classList.toggle("sel", selected);
    const checkbox = row.querySelector("input[type=checkbox]");
    if (checkbox) checkbox.checked = selected;
  }
}

function applyListSelection(ids, selected) {
  let changed = false;
  for (const id of ids) {
    if (selected && !S.sel.has(id)) { S.sel.add(id); changed = true; }
    else if (!selected && S.sel.delete(id)) changed = true;
  }
  if (!changed) return;
  syncCapSel();
  syncListSelection();
  draw();
  layoutCapOverlay();
}

function listRangeIds(anchor, id) {
  const ids = visibleListItems().map((entry) => entry.id);
  const a = ids.indexOf(anchor), b = ids.indexOf(id);
  if (a < 0 || b < 0) return [id];
  return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
}

function checklistRowAtPoint(ev, tb) {
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  const row = el && el.closest ? el.closest("tr[data-id]") : null;
  return row && tb.contains(row) ? row.dataset.id : null;
}

function beginChecklistDrag(tb, ev) {
  const checkbox = ev.target.closest && ev.target.closest('input[type="checkbox"]');
  if (!checkbox || !tb.contains(checkbox) || checkbox.disabled || checklistDrag) return;
  if (ev.isPrimary === false || (ev.pointerType === "mouse" && ev.button !== 0)) return;
  const row = checkbox.closest("tr[data-id]");
  if (!row) return;

  const id = row.dataset.id;
  const selected = !S.sel.has(id);
  checklistDrag = { pointerId: ev.pointerId, lastId: id, selected, tb };
  ev.preventDefault(); // we toggle from the shared selection state, not the native click
  try { checkbox.focus({ preventScroll: true }); } catch (_) { checkbox.focus(); }
  tb.classList.add("checklist-dragging");
  try { tb.setPointerCapture(ev.pointerId); } catch (_) { /* document listeners still handle it */ }

  const ids = ev.shiftKey && lastListId ? listRangeIds(lastListId, id) : [id];
  applyListSelection(ids, selected);
  lastListId = id;
}

function moveChecklistDrag(ev) {
  const drag = checklistDrag;
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const id = checklistRowAtPoint(ev, drag.tb);
  if (!id || id === drag.lastId) return;
  const ids = listRangeIds(drag.lastId, id);
  applyListSelection(ids, drag.selected);
  drag.lastId = id;
  lastListId = id;
}

function endChecklistDrag(ev) {
  const drag = checklistDrag;
  if (!drag || (ev && ev.pointerId !== drag.pointerId)) return;
  checklistDrag = null;
  drag.tb.classList.remove("checklist-dragging");
  try { drag.tb.releasePointerCapture(drag.pointerId); } catch (_) { /* already released */ }
  // The pointer gesture already changed S.sel. Ignore the synthetic click that
  // browsers may dispatch on pointer-up so it cannot toggle the first box back.
  suppressChecklistClick = true;
  setTimeout(() => { suppressChecklistClick = false; }, 0);
}

function bindList() {
  const tb = document.querySelector("#secTable tbody");
  tb.addEventListener("pointerdown", (ev) => beginChecklistDrag(tb, ev));
  document.addEventListener("pointermove", moveChecklistDrag);
  document.addEventListener("pointerup", endChecklistDrag);
  document.addEventListener("pointercancel", endChecklistDrag);

  tb.addEventListener("click", (ev) => {
    if (suppressChecklistClick) {
      suppressChecklistClick = false;
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (ev.target.closest && ev.target.closest("td.txt")) return;   // editing text, not seeking
    const tr = ev.target.closest("tr[data-id]");
    if (!tr) return;
    const id = tr.dataset.id;
    const entry = listItemById(id);
    const checkbox = ev.target.closest && ev.target.closest('input[type="checkbox"]');
    if (checkbox && tr.contains(checkbox)) {
      const selected = !S.sel.has(id);
      const ids = ev.shiftKey && lastListId ? listRangeIds(lastListId, id) : [id];
      applyListSelection(ids, selected);
      lastListId = id;
      return;
    }
    if (entry) {
      selectOnly(id);
      const item = entry.item;
      setPlayhead(Math.min(item.start + 0.01, item.end - 0.001));
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
    const row = cell.closest("tr[data-id]");
    const id = row.dataset.id;
    const item = row.dataset.type === "caption"
      ? S.tl.caps.find((c) => c.id === id)
      : S.tl.clips.find((c) => c.id === id);
    const cancel = cell.dataset.cancel === "1";
    delete cell.dataset.cancel;
    if (!item) return;
    const text = cell.textContent.replace(/\s+/g, " ").trim();
    if (cancel || text === (item.text || "")) {
      cell.textContent = item.text || "";
      return;
    }
    if (row.dataset.type === "caption") {
      setTL(TLM.setCaptionText(S.tl, id, text));
      status("Caption updated (matching section text follows).");
    } else {
      setTL(TLM.setClipText(S.tl, id, text));
      status("Text updated (captions on the timeline with the same text too).");
    }
  });
  $("selVisible").onclick = () => {
    S.sel = new Set([...S.sel, ...visibleListItems().map((entry) => entry.id)]);
    syncCapSel(); refresh();
  };
  $("selNone").onclick = () => clearSel();
  $("selInvert").onclick = () => {
    const next = new Set(S.sel);
    for (const entry of visibleListItems()) {
      if (next.has(entry.id)) next.delete(entry.id);
      else next.add(entry.id);
    }
    S.sel = next;
    syncCapSel(); refresh();
  };
  $("selAllSilence").onclick = () => {
    S.sel = new Set(S.tl.clips.filter((c) => c.kind === "silence").map((c) => c.id));
    syncCapSel(); refresh();
  };
  $("selAllCaptions").onclick = () => {
    S.sel = new Set([
      ...S.tl.clips.filter((c) => c.kind === "caption").map((c) => c.id),
      ...S.tl.caps.map((c) => c.id),
    ]);
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
  if ((S.tl.clips || []).length && timelineEnd() < 0.5) warn.push("The timeline is very short.");
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
      // Cues straight from the caption card: they carry the word timings an
      // .srt cannot, so the seeded captions keep them.
      cues: S.subsCues || [],
    };
    const data = await api("/api/detect", { method: "POST", body: JSON.stringify(body) });
    const clips = TLM.clipsFromSections(data.sections, S.duration);
    let caps = [], lanes = 1;
    if ($("dCues").checked && Array.isArray(data.captions) && data.captions.length) {
      ({ caps, lanes } = TLM.capsFromCues(clips, data.captions));
    }
    S.sel = new Set();
    S.capSel = null;
    setTL({ clips, caps, lanes, vtracks: 1, auds: [], atracks: 1 });
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
  box.querySelector(":scope > .cap-shadow")?.remove();
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
  $("tlTrack").onclick = addVideoTrack;
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
    $("browseBtn").onclick = () => openBrowserFor("open");
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
      S.subsCues = null;             // a typed-in .srt has no word timings
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
  $("capResplit").onclick = resplitCaptions;
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
  bindTools();
  bindTimeline();
  bindTimelineTools();
  bindKeys();
  bindPlayer();
}

async function onProjectOpen(data) {
  S.projectReady = false;
  pausePlayback();
  S.project = data;
  S.duration = data.info.duration;
  S.T = 0;
  S.sel = new Set();
  lastListId = null;
  activeListRows = new Map();
  lastActiveListIds = new Set();
  lastListScrollId = null;
  S.capSel = null;
  S.undo = [];
  S.redo = [];
  const mainAsset = data.main_asset || TLM.MAIN_SRC;
  S.tl = { clips: TLM.clipsFromSource(S.duration, mainAsset), auds: [], caps: [],
           lanes: 1, vtracks: 1, atracks: 1 };
  S.lastJSON = JSON.stringify(S.tl);
  S.peaks = [];
  S.thumbs = null;
  S.thumbImgs = [];
  S.subsText = null;
  S.subsCues = null;
  $("subInfo").textContent = data.demo_subtitles ? "Bundled demo subtitles ready" : "";
  $("dSubPath").value = data.demo_subtitles || "";
  $("pathInput").value = data.info.path;
  S.preview = data.preview || { mode: "direct", ready: false, state: "none" };
  // The bin arrives with the project, so layers resolve before the first draw.
  MEDIA.assets = new Map((data.media || []).map((a) => [a.id, a]));
  MEDIA.main = mainAsset;
  if (typeof stageReset === "function") stageReset();
  if (typeof mediaInit === "function") mediaInit();
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
  refresh(true);

  // Restore only while untouched: late responses must not erase a new edit.
  const initialJSON = JSON.stringify(S.tl);
  try {
    const saved = await api("/api/timeline");
    if (S.project === data && JSON.stringify(S.tl) === initialJSON && saved.timeline && saved.timeline.clips) {
      S.tl = TLM.normalise(saved.timeline);
      S.lastJSON = JSON.stringify(S.tl);
      refresh(true);
    }
  } catch (_) {
    // No saved edit list: keep the default single clip.
  }

  // These FFmpeg scans compete for CPU and disk with a required proxy build.
  // Defer cosmetic timeline assets until the browser-friendly copy is ready.
  timelineAssetsPending = S.preview.mode === "proxy" && !S.preview.ready;
  if (!timelineAssetsPending) loadTimelineAssets();
  if (S.project === data) {
    S.projectReady = true;
    if (typeof mediaLoad === "function") mediaLoad();
  }
}
