/* Timeline editor — kconcat-style redesign (DOM-based, no canvas).
 * Ported from vts-timeline-preview.html <script> (behavior reference)
 * Rewired to real VTS state: S.tl via TLM, S.view/S.T, S.sel, S.filter,
 * S.laneHidden/S.laneLocked, S.laneH, S.magnetic/S.snap/pan, undo/redo.
 * Covers: tray, lane grid (Premiere-style V-over-A, mixed V, floating caps),
 * ruler + section strip, playhead, lane heights, pan/razor, drag/trim, zoom,
 * statusline/legend/edge-handle, keyboard. See vts-timeline-redesign.md.
 */
"use strict";

/* ---------- icons (Lucide-style, like kconcat icons.slint) ---------- */
const P = {
  plus: '<path d="M5 12h14M12 5v14"/>',
  minus: '<path d="M5 12h14"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13"/>',
  split: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/>',
  razor: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M12 7v10"/>',
  merge: '<path d="m8 6 4-4 4 4"/><path d="M12 2v10.3a4 4 0 0 1-1.172 2.872L4 22"/><path d="m20 22-5-5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
  hand: '<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>',
  trimfollow: '<path d="M9 3v18"/><path d="M9 12h10M15 8l4 4-4 4"/>',
  magnet: '<path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15"/><path d="m5 8 4 4M12 15l4 4"/>',
  magnetic: '<path d="m7 15 5 5 5-5M7 9l5-5 5 5"/>',
  type: '<path d="M4 7V5h16v2M12 5v14M9 19h6"/>',
  fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/>',
  vol: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  volx: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="m22 9-6 6M16 9l6 6"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  more: '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  film: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
};
const icon = (n, sw) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw || 2}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n]}</svg>`;
const setIcon = (id, n, sw) => { const el = document.getElementById(id); if (el) el.innerHTML = icon(n, sw); };

/* ---------- small globals (S itself lives in app.js, which loads later;
 * never touch S at parse time — only inside functions) ---------- */
let toastT = null;
let statusTimer = null;
let curTool = "select"; // select | razor ; pan is S.pan toggle
let popEl = null;
let saveTimer = null;

const CLIP_FALLBACK = "#2b4f6b";
const PV = { playing: false, raf: 0, last: 0 }; // playback, kept for app.js compat

function toast(msg) {
  const t = document.getElementById("tlToast") || document.getElementById("pvToast");
  if (!t) return;
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2200);
}
function status(msg) {
  const el = document.getElementById("status") || document.getElementById("tlStatus");
  if (!el) return;
  el.textContent = msg || "";
  clearTimeout(statusTimer);
  if (msg) statusTimer = setTimeout(() => { el.textContent = ""; }, 4000);
}
function playheadTime() { return S.T || 0; }
function timelineEnd() { return TLM.contentEnd(S.tl); }
function contentEnd() { return Math.max(S.duration || 0, TLM.contentEnd(S.tl), 0); }
function selectedIds() { return [...S.sel]; }
function tlItems(tl) { return [...(tl.clips || []), ...(tl.auds || []), ...(tl.caps || [])]; }
function findTlItem(id) { return tlItems(S.tl).find((it) => it.id === id) || null; }

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
// Keep S.view.start (used by followPlayhead/app state) in sync with the scroller.
function syncViewStart() {
  const sc = document.getElementById("scroll");
  if (sc) S.view.start = sc.scrollLeft / Math.max(pxPerSec(), 1e-6);
}
const clamp01 = (v) => Math.min(1, Math.max(0, v));
function caretFraction(cell) {
  try {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return -1;
    const range = sel.getRangeAt(0);
    const pre = range.cloneRange();
    pre.selectNodeContents(cell);
    pre.setEnd(range.endContainer, range.endOffset);
    const off = pre.toString().length;
    const len = (cell.textContent || "").length;
    if (!len) return -1;
    return clamp01(off / len);
  } catch { return -1; }
}
function zoomBy(factor) {
  const sc = document.getElementById("scroll");
  const vw = plotWidth();
  const center = sc ? (sc.scrollLeft + vw / 2) / Math.max(pxPerSec(), 1e-6) : S.view.start + S.view.span / 2;
  const span = Math.min(Math.max(contentEnd(), 1), Math.max(0.2, S.view.span * factor));
  S.view.span = span;
  draw();
  if (sc) sc.scrollLeft = Math.max(0, center * pxPerSec() - vw / 2);
  syncViewStart();
}

/* ---------- geometry ----------
 * Absolute mapping: x = t * pxPerSec(). The #scroll viewport width sets the
 * scale (view.span seconds fill one viewport width); panning is scrollLeft.
 * NEVER measure #lanes here — renderLanes() sets its width FROM this scale. */
function plotWidth() {
  const sc = document.getElementById("scroll");
  if (sc && sc.clientWidth) return Math.max(1, sc.clientWidth);
  return 800;
}
function pxPerSec() { return plotWidth() / Math.max(S.view.span, 1e-6); }
const t2x = (t) => t * pxPerSec();
const x2t = (x) => x / Math.max(pxPerSec(), 1e-6);

/* ---------- lane helpers ---------- */
function laneSets() {
  if (!S.laneHidden) S.laneHidden = new Set();
  if (!S.laneLocked) S.laneLocked = new Set();
  if (!S.laneH) S.laneH = {};
  if (!S.audioMuted) S.audioMuted = new Set();
  if (S.magnetic === undefined) S.magnetic = false;
  if (S.snap === undefined) S.snap = true;
  if (S.pan === undefined) S.pan = false;
}
function laneLabelsDirty() { /* legacy hook from app.js — DOM render reads S directly */ if (typeof S !== "undefined" && S.project) draw(); }
function laneKeyOf(it) {
  if (TLM.isAudioItem(it)) return `a${TLM.atrackOf(it)}`;
  if (TLM.isClip(it)) return `v${TLM.trackOf(it)}`;
  // captions live on their own C lanes above the video tracks (Premiere-style)
  return `c${capLaneOf(it)}`;
}
function capLaneOf(c) { return c.lane ?? c.track ?? 0; }
function cLanesOf() {
  // derive from the captions themselves — a stale tl.lanes counter
  // must not conjure empty caption lanes
  const caps = (S.tl && S.tl.caps) || [];
  if (!caps.length) return 0;
  let n = 1;
  for (const c of caps) n = Math.max(n, capLaneOf(c) + 1);
  return n;
}
function cDisplayOrder() {
  const n = cLanesOf();
  const arr = [];
  for (let i = n - 1; i >= 0; i--) arr.push(i);
  return arr;
}
function laneHidden(key) { laneSets(); return S.laneHidden.has(key); }
function laneLocked(key) { laneSets(); return S.laneLocked.has(key); }
function itemLocked(it) { return laneLocked(laneKeyOf(it)); }
function itemHidden(it) { return laneHidden(laneKeyOf(it)); }
function laneName(key) {
  if (key[0] === "v") return `V${Number(key.slice(1)) + 1}`;
  if (key[0] === "a") return `A${Number(key.slice(1)) + 1}`;
  return `C${Number(key.slice(1)) + 1}`;
}
function rowHForKey(key) {
  const v = S.laneH[key];
  if (v != null) return v;
  if (key[0] === "c") return 32;
  return key[0] === "a" ? 44 : 56;
}
function trackNameV(idx) {
  // V numbers bottom-up: model 0 = V1 (bottom), so number is idx+1
  return `V${idx + 1}`;
}
function trackNameA(idx) { return `A${idx + 1}`; }
function vDisplayOrder() {
  const n = TLM.vtracksOf(S.tl);
  const arr = [];
  for (let i = n - 1; i >= 0; i--) arr.push(i);
  return arr;
}
function aDisplayOrder() {
  const n = TLM.atracksOf(S.tl);
  const arr = [];
  for (let i = 0; i < n; i++) arr.push(i);
  return arr;
}
/* mediaName / mediaHasAudio / mediaThumb / mediaPeaks / mediaDuration /
 * mediaDefaultFit come from media.js (loaded before this file). */

/* ---------- history ---------- */
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
  if (!S.drag) clampView();
  draw();
  if (typeof renderList === "function") renderList();
  if (typeof syncListPlayhead === "function") syncListPlayhead();
  if (typeof updateTally === "function") updateTally();
  updateTimecode();
  if (typeof layoutCapOverlay === "function") layoutCapOverlay();
  if (typeof ClipRefresh === "function") ClipRefresh();
  syncPreview(forcePreview);
}
function setTL(next) {
  S.tl = TLM.normalise(next);
  syncCapSel();
  commitTL();
  refresh(true);
}
function commitCaptions() { commitTL(); refresh(); }
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
    if (pendingSave !== null && pendingSave !== body) flushSave(false);
  });
}
window.addEventListener("pagehide", () => flushSave(true));

/* ---------- selection ---------- */
function selectOnly(id) { S.sel = new Set([id]); syncCapSel(); refresh(); }
function toggleSel(id) { if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id); syncCapSel(); refresh(); }
function clearSel() { S.sel = new Set(); syncCapSel(); refresh(); }
function selectAll() { S.sel = new Set(tlItems(S.tl).map((c) => c.id)); syncCapSel(); refresh(); }
function itemHasAudio(it) {
  if (it.atrack !== undefined) return mediaHasAudio(it.src || TLM.MAIN_SRC);
  return mediaHasAudio(it.src || TLM.MAIN_SRC);
}

/* ---------- editing ops ---------- */
function deleteSel(ripple) {
  const ids = selectedIds();
  if (!ids.length) return status("Select a clip or caption first.");
  const open = ids.filter((id) => { const it = findTlItem(id); return it && !itemLocked(it); });
  if (!open.length) return status("That lane is locked.");
  const useRipple = ripple || S.magnetic;
  S.sel = new Set();
  setTL(TLM.deleteItems(S.tl, open, useRipple));
  status((useRipple ? "Removed and closed the gap." : "Removed (gap left on the timeline).") + (open.length < ids.length ? " A locked lane was skipped." : ""));
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
  status(open.length < ids.length ? `Copied ${S.clip.items.length} item(s) — a locked lane was left in place.` : `Cut ${S.clip.items.length} item(s). Paste with Ctrl+V.`);
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
  const pool = selectedIds().length ? selectedIds().map(findTlItem).filter(Boolean) : tlItems(S.tl);
  const skipped = pool.filter((it) => itemLocked(it) && at > it.start + 0.05 && at < it.end - 0.05);
  const cut = pool.filter((it) => !itemLocked(it)).map((it) => it.id);
  if (!cut.length) return status(skipped.length ? "That lane is locked." : "Nothing to split at the playhead.");
  const next = TLM.splitSelection(S.tl, at, cut);
  if (JSON.stringify(next) === JSON.stringify(S.tl)) return status(skipped.length ? "Nothing to split (a locked lane was skipped)." : "Nothing to split at the playhead.");
  setTL(next);
  status(`Split at ${fmtTime(at, false)}${skipped.length ? " (a locked lane was skipped)" : ""}.`);
}
function addCaptionAtPlayhead() {
  if (!S.project) return alert("Open a video first.");
  const style = (S.capSel && S.tl.caps.find((c) => c.id === S.capSel)?.style) || (typeof CAPPOS !== "undefined" ? CAPPOS : null);
  // Premiere-style: captions stack onto their own C lanes above the video.
  // addCaption picks the lowest free caption lane automatically.
  laneSets();
  const r = TLM.addCaption(S.tl, playheadTime(), "New caption", style);
  const made = r.tl.caps.find((c) => c.id === r.id);
  const key = `c${made ? capLaneOf(made) : 0}`;
  if (S.laneLocked.has(key)) return toast(`lane ${laneName(key)} is locked`);
  S.sel = new Set([r.id]);
  S.capSel = r.id;
  setTL(r.tl);
  toast(`caption added on ${laneName(key)} at ${fmtTime(playheadTime(), false)}`);
}
function addLane() { // legacy still used nowhere, keep for compat
  if (!S.project) return;
  S.tl = { ...S.tl, lanes: Math.max(1, (S.tl.lanes || 1) + 1) };
  commitTL(); refresh();
}
function addVideoTrack() {
  if (!S.project) return;
  const v = TLM.vtracksOf(S.tl);
  S.tl = TLM.normalise({ ...S.tl, vtracks: v + 1, atracks: Math.max(TLM.atracksOf(S.tl), v + 1) });
  commitTL(); refresh();
  status(`V${v + 1} added — drop media on it to overlay the tracks below.`);
}

/* ---------- snapping ---------- */
function snapCandidates(exclude) {
  const list = [0, playheadTime(), timelineEnd()];
  for (const c of tlItems(S.tl)) if (!exclude.has(c.id)) list.push(c.start, c.end);
  return list;
}
function snapTime(t, exclude) {
  if (!S.snap) return t;
  const tol = 8 / Math.max(pxPerSec(), 1e-6);
  let best = t, bd = tol;
  for (const cand of snapCandidates(exclude)) {
    const dd = Math.abs(cand - t);
    if (dd < bd) { bd = dd; best = cand; }
  }
  return best;
}
function snapShift(base, ids, dt) {
  if (!S.snap) return dt;
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

/* ---------- tools ---------- */
const TL_TOOLS = [
  { id: "select", key: "V", hint: "Select / move" },
  { id: "razor", key: "R", hint: "Razor: click a clip or caption to split it" },
];
let pendingMKeys = 0;
function setTool(id) {
  if (id !== "select" && id !== "razor") id = "select";
  curTool = id;
  renderTray();
  const t = TL_TOOLS.find((x) => x.id === id);
  if (t) status(`Tool: ${t.hint} (${t.key})`);
}
function toolCursor() { return curTool === "razor" ? "crosshair" : "default"; }
function razorSplit(item, t) {
  if (itemLocked(item)) return status(`${laneName(laneKeyOf(item))} is locked.`);
  if (!(t > item.start + 0.05 && t < item.end - 0.05)) return status("Too close to the edge to split.");
  const next = TLM.splitSelection(S.tl, t, [item.id]);
  if (JSON.stringify(next) === JSON.stringify(S.tl)) return status("Nothing to split here.");
  setTL(next);
  status(`Split at ${fmtTime(t, false)}.`);
}
function toggleClipMute(id) {
  const clip = (S.tl.clips || []).find((c) => c.id === id) || (S.tl.auds || []).find((c) => c.id === id);
  if (!clip) return;
  if (itemLocked(clip)) return status(`${laneName(laneKeyOf(clip))} is locked.`);
  if (!clip.fx || typeof clip.fx !== "object") clip.fx = TLM.defaultFx();
  if (!Array.isArray(clip.kf)) clip.kf = [];
  clip.fx.mute = !clip.fx.mute;
  commitTL(); refresh();
  status(clip.fx.mute ? "Muted (M tool: click again to unmute)." : "Unmuted.");
}

/* ---------- rendering ---------- */
const GROUPS = [
  { label: "Video", kinds: ["V"], color: "#3373d1" },
  { label: "Audio", kinds: ["A"], color: "#34c46f" },
];
const CAP_GROUP_COLOR = "#e75fa0";
const KIND_ICON = { video: "film", audio: "music", caption: "type", image: "film" };

function fmt(s) {
  const m = Math.floor(s / 60), sc = Math.floor(s % 60);
  return `${m}:${String(sc).padStart(2, "0")}`;
}
function fmtTC(s) {
  const f = Math.floor((s % 1) * 30);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}
function endTime() { return Math.max(10, contentEnd() + 4); }

function render() {
  if (!S.project) {
    // empty state still shows headers/lanes empty but tray disabled
    renderTray();
    const hrows = document.getElementById("hrows");
    if (hrows) hrows.innerHTML = "";
    const lanes = document.getElementById("lanes");
    if (lanes) lanes.innerHTML = '<div class="ruler" style="height:28px"></div>';
    const tc = document.getElementById("tc");
    if (tc) tc.textContent = `${fmtTime(playheadTime(), false)} / ${fmtTime(timelineEnd(), false)}`;
    return;
  }
  renderHeaders();
  renderLanes();
  renderTray();
  const tc = document.getElementById("tc");
  if (tc) tc.textContent = `${fmtTime(playheadTime(), false)} / ${fmtTime(timelineEnd(), false)}`;
  const st = document.getElementById("status");
  if (st && !st.textContent) st.textContent = "click = select + seek · shift = add · drag = move (↕ = change track) · edges = trim · alt-drag = copy · ctrl+wheel = zoom";
}
function draw() { render(); }

function renderTray() {
  const undoBtn = document.getElementById("btnUndo");
  const redoBtn = document.getElementById("btnRedo");
  if (undoBtn) undoBtn.disabled = !S.undo.length;
  if (redoBtn) redoBtn.disabled = !S.redo.length;
  const razor = document.getElementById("btnRazor");
  if (razor) razor.classList.toggle("on", curTool === "razor");
  const pan = document.getElementById("btnPan");
  if (pan) pan.classList.toggle("on", !!S.pan);
  const snap = document.getElementById("btnSnap");
  if (snap) snap.classList.toggle("on", !!S.snap);
  const mag = document.getElementById("btnMagnet");
  if (mag) mag.classList.toggle("on", !!S.magnetic);
  const n = [...S.sel].length;
  const trash = document.getElementById("btnTrash");
  if (trash) trash.disabled = !n;
  const sc = document.getElementById("selCount");
  if (sc) { sc.hidden = n < 2; sc.textContent = String(n); }
  // pills ↔ S.filter
  document.querySelectorAll("[data-pill]").forEach((b) => {
    const k = b.dataset.pill;
    const on = S.filter.kinds.has(k);
    b.classList.toggle("on", on);
  });
  // also sync List chips
  document.querySelectorAll(".chip[data-kind]").forEach((chip) => {
    chip.classList.toggle("on", S.filter.kinds.has(chip.dataset.kind));
  });
  // remove-selected visibility: show when any selected (S.sel has items that are sections)
  const pillRemove = document.getElementById("pillRemove");
  if (pillRemove) pillRemove.hidden = S.sel.size === 0;
  // also update selRemove in List if exists
  const lanes = document.getElementById("lanes");
  if (lanes) lanes.style.cursor = curTool === "razor" ? "crosshair" : S.pan ? "grab" : "";
}

function renderHeaders() {
  const box = document.getElementById("hrows");
  if (!box) return;
  box.innerHTML = "";
  laneSets();
  // prune stale keys
  const vc = TLM.vtracksOf(S.tl), ac = TLM.atracksOf(S.tl), cc = cLanesOf();
  for (const key of [...S.laneHidden, ...S.laneLocked]) {
    const n = Number(key.slice(1));
    let live = false;
    if (key[0] === "v") live = n < vc;
    else if (key[0] === "a") live = n < ac;
    else if (key[0] === "c") live = n < cc;
    if (!live) { S.laneHidden.delete(key); S.laneLocked.delete(key); }
  }
  // Caption group on top (Premiere-style: captions above video tracks)
  const cOrder = cDisplayOrder();
  if (cOrder.length) {
    const bar = document.createElement("div");
    bar.className = "gbar";
    bar.innerHTML = `<span class="dot" style="background:${CAP_GROUP_COLOR}"></span>CAPTIONS`;
    box.appendChild(bar);
    cOrder.forEach((idx) => box.appendChild(headerRowC(idx)));
  }
  // Video group (display top lane = top layer = highest index first)
  const vOrder = vDisplayOrder();
  if (vOrder.length) {
    const bar = document.createElement("div");
    bar.className = "gbar";
    bar.innerHTML = `<span class="dot" style="background:${GROUPS[0].color}"></span>VIDEO`;
    box.appendChild(bar);
    vOrder.forEach((idx) => box.appendChild(headerRowV(idx)));
  }
  const aOrder = aDisplayOrder();
  if (aOrder.length) {
    const bar = document.createElement("div");
    bar.className = "gbar";
    bar.innerHTML = `<span class="dot" style="background:${GROUPS[1].color}"></span>AUDIO`;
    box.appendChild(bar);
    aOrder.forEach((idx) => box.appendChild(headerRowA(idx)));
  }
}
function headerRowC(idx) {
  const key = `c${idx}`;
  const r = document.createElement("div");
  r.className = "hrow"; r.style.height = rowHForKey(key) + "px";
  const name = laneName(key);
  const locked = laneLocked(key);
  const hidden = laneHidden(key);
  r.innerHTML =
    `<button class="hbtn ${locked ? "on" : ""}" data-h="lock" title="${locked ? "Unlock" : "Lock"} lane ${name}">${icon(locked ? "lock" : "unlock", 2)}</button>` +
    `<button class="hbtn ${hidden ? "on" : ""}" data-h="vis" title="${hidden ? "Show" : "Hide"} lane ${name}">${icon(hidden ? "eyeoff" : "eye", 2)}</button>` +
    `<span class="kind">${name}</span><span class="hsp"></span>` +
    `<button class="hbtn" data-h="more" title="More actions for lane ${name}">${icon("more", 2)}</button>`;
  r.title = `Alt+scroll: lane height · double-click: auto height (${name})`;
  r.querySelectorAll(".hbtn").forEach((b) => b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    headerActC(idx, b.dataset.h, b);
  }));
  r.addEventListener("wheel", (ev) => {
    if (!ev.altKey) return;
    ev.preventDefault();
    const cur = rowHForKey(key);
    S.laneH[key] = Math.min(140, Math.max(24, cur + (ev.deltaY < 0 ? 4 : -4)));
    render();
    status(`lane ${name} height ${S.laneH[key]}px (double-click header for auto)`);
  }, { passive: false });
  r.addEventListener("dblclick", (ev) => {
    if (ev.target.closest(".hbtn")) return;
    delete S.laneH[key];
    render();
    status(`lane ${name} height: auto`);
  });
  return r;
}
function headerActC(idx, act, btn) {
  const key = `c${idx}`;
  laneSets();
  if (act === "lock") {
    if (S.laneLocked.has(key)) S.laneLocked.delete(key);
    else S.laneLocked.add(key);
    saveWorkspaceLayout();
    render();
    status(`lane ${laneName(key)} ${S.laneLocked.has(key) ? "locked" : "unlocked"}`);
  } else if (act === "vis") {
    if (S.laneHidden.has(key)) S.laneHidden.delete(key);
    else S.laneHidden.add(key);
    saveWorkspaceLayout();
    render();
    status(`lane ${laneName(key)} ${S.laneHidden.has(key) ? "hidden" : "shown"}`);
  } else if (act === "more") {
    openMoreMenu(key, btn || null);
  }
}
function headerRowV(idx) {
  const key = `v${idx}`;
  const r = document.createElement("div");
  r.className = "hrow"; r.style.height = rowHForKey(key) + "px";
  const name = trackNameV(idx);
  const locked = laneLocked(key);
  const hidden = laneHidden(key);
  const visIcon = hidden ? "eyeoff" : "eye";
  r.innerHTML =
    `<button class="hbtn ${locked ? "on" : ""}" data-h="lock" title="${locked ? "Unlock" : "Lock"} lane ${name}">${icon(locked ? "lock" : "unlock", 2)}</button>` +
    `<button class="hbtn ${!hidden ? "" : "on"}" data-h="vis" title="${hidden ? "Show" : "Hide"} lane ${name}">${icon(visIcon, 2)}</button>` +
    `<span class="kind">${name}</span><span class="hsp"></span>` +
    `<button class="hbtn" data-h="more" title="More actions for lane ${name}">${icon("more", 2)}</button>`;
  r.title = `Alt+scroll: lane height · double-click: auto height (${name})`;
  r.querySelectorAll(".hbtn").forEach((b) => b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    headerActV(idx, b.dataset.h, b);
  }));
  r.addEventListener("wheel", (ev) => {
    if (!ev.altKey) return;
    ev.preventDefault();
    const cur = rowHForKey(key);
    S.laneH[key] = Math.min(140, Math.max(24, cur + (ev.deltaY < 0 ? 4 : -4)));
    render();
    status(`lane ${name} height ${S.laneH[key]}px (double-click header for auto)`);
  }, { passive: false });
  r.addEventListener("dblclick", (ev) => {
    if (ev.target.closest(".hbtn")) return;
    delete S.laneH[key];
    render();
    status(`lane ${name} height: auto`);
  });
  return r;
}
function headerRowA(idx) {
  const key = `a${idx}`;
  const r = document.createElement("div");
  r.className = "hrow"; r.style.height = rowHForKey(key) + "px";
  const name = trackNameA(idx);
  const locked = laneLocked(key);
  const muted = laneHidden(key) ? false : (S.laneH[key + "_mute"] ? true : false); // we repurpose? Actually audio mute is separate flag stored as laneHidden? In old, laneHidden was eye, laneLocked lock. For audio, mute is same as hidden? Spec: mute-switch vs output-eye. Let's store A mute in S.laneHidden? No, spec says output-eye (V) or mute-switch (A). For V, eye toggles visibility (preview unaffected per old but spec says same). For A, mute switch toggles mute. We can store mute state in S.laneHidden for A as well? But need separate. Simpler: store A mute in separate Set S.audioMuted. If not exists, create.
  if (!S.audioMuted) S.audioMuted = new Set();
  const isMuted = S.audioMuted.has(key);
  r.innerHTML =
    `<button class="hbtn ${locked ? "on" : ""}" data-h="lock" title="${locked ? "Unlock" : "Lock"} lane ${name}">${icon(locked ? "lock" : "unlock", 2)}</button>` +
    `<button class="hbtn ${isMuted ? "on" : ""}" data-h="mute" title="${isMuted ? "Unmute" : "Mute"} lane ${name} (M)">${icon(isMuted ? "volx" : "vol", 2)}</button>` +
    `<span class="kind">${name}</span><span class="hsp"></span>` +
    `<button class="hbtn" data-h="more" title="More actions for lane ${name}">${icon("more", 2)}</button>`;
  r.title = `Alt+scroll: lane height · double-click: auto height (${name})`;
  r.querySelectorAll(".hbtn").forEach((b) => b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    headerActA(idx, b.dataset.h, b);
  }));
  r.addEventListener("wheel", (ev) => {
    if (!ev.altKey) return;
    ev.preventDefault();
    const cur = rowHForKey(key);
    S.laneH[key] = Math.min(140, Math.max(24, cur + (ev.deltaY < 0 ? 4 : -4)));
    render();
    status(`lane ${name} height ${S.laneH[key]}px (double-click header for auto)`);
  }, { passive: false });
  r.addEventListener("dblclick", (ev) => {
    if (ev.target.closest(".hbtn")) return;
    delete S.laneH[key];
    render();
    status(`lane ${name} height: auto`);
  });
  return r;
}
function headerActV(idx, act, btn) {
  const key = `v${idx}`;
  laneSets();
  if (act === "lock") {
    if (S.laneLocked.has(key)) S.laneLocked.delete(key);
    else S.laneLocked.add(key);
    saveWorkspaceLayout();
    render();
    status(`lane ${laneName(key)} ${S.laneLocked.has(key) ? "locked" : "unlocked"}`);
  } else if (act === "vis") {
    if (S.laneHidden.has(key)) S.laneHidden.delete(key);
    else S.laneHidden.add(key);
    saveWorkspaceLayout();
    render();
    status(`lane ${laneName(key)} ${S.laneHidden.has(key) ? "hidden" : "shown"}`);
  } else if (act === "more") {
    openMoreMenu(key, btn || null);
  }
}
function headerActA(idx, act, btn) {
  const key = `a${idx}`;
  laneSets();
  if (act === "lock") {
    if (S.laneLocked.has(key)) S.laneLocked.delete(key);
    else S.laneLocked.add(key);
    saveWorkspaceLayout();
    render();
    status(`lane ${laneName(key)} ${S.laneLocked.has(key) ? "locked" : "unlocked"}`);
  } else if (act === "mute") {
    if (S.audioMuted.has(key)) S.audioMuted.delete(key);
    else S.audioMuted.add(key);
    saveWorkspaceLayout();
    render();
    status(`lane ${laneName(key)} ${S.audioMuted.has(key) ? "muted" : "unmuted"} (M)`);
  } else if (act === "more") {
    openMoreMenu(key, btn || null);
  }
}

function renderLanes() {
  const L = document.getElementById("lanes");
  const scroll = document.getElementById("scroll");
  if (!L || !scroll) return;
  const W = Math.ceil(endTime() * pxPerSec()) + 40;
  L.style.width = W + "px";
  L.innerHTML = "";
  // ruler
  const ruler = document.createElement("div");
  ruler.className = "ruler"; ruler.style.width = W + "px";
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
  const step = steps.find((s) => s * pxPerSec() >= 70) || 120;
  let gridHTML = "";
  for (let t = 0; t <= endTime(); t += step) {
    const x = Math.round(t * pxPerSec());
    ruler.insertAdjacentHTML("beforeend", `<span class="tick" style="left:${x}px">${fmt(t)}</span>`);
    gridHTML += `<span class="gridline" style="left:${x}px"></span>`;
  }
  // section strip (6px along ruler foot) — click bar to mark/unmark selection
  const strip = document.createElement("div");
  strip.className = "secstrip";
  const KN = ["caption", "silence", "other"];
  // S.sections is derived from clips (each clip is a section). Use S.tl.clips
  const sections = S.tl.clips || [];
  sections.forEach((sec) => {
    const kindIdx = sec.kind === "silence" ? 1 : sec.kind === "caption" ? 0 : 2;
    const isSel = S.sel.has(sec.id);
    const isOff = !S.filter.kinds.has(KN[kindIdx]);
    const b = document.createElement("button");
    b.className = `sec k${kindIdx}${isSel ? " sel" : ""}${isOff ? " off" : ""}`;
    b.style.left = (sec.start * pxPerSec()) + "px";
    b.style.width = Math.max(2, (sec.end - sec.start) * pxPerSec()) + "px";
    b.title = `${KN[kindIdx]} ${fmt(sec.start)}–${fmt(sec.end)} — click to ${isSel ? "deselect" : "select for removal"}`;
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (S.sel.has(sec.id)) S.sel.delete(sec.id);
      else S.sel.add(sec.id);
      syncCapSel();
      render();
      if (typeof renderList === "function") renderList();
      status(S.sel.has(sec.id) ? "section marked for removal" : "section unmarked");
    });
    strip.appendChild(b);
  });
  ruler.appendChild(strip);
  L.appendChild(ruler);

  // rows + clips, grouped Premiere-style (video on top, audio bottom)
  const vOrder = vDisplayOrder();
  const aOrder = aDisplayOrder();
  // Caption lanes on top (Premiere-style: captions in their own tracks, never overlapping video)
  const cOrder = cDisplayOrder();
  if (cOrder.length) {
    const bar = document.createElement("div");
    bar.className = "gbar-lane"; bar.style.width = W + "px";
    L.appendChild(bar);
    cOrder.forEach((idx) => {
      const key = `c${idx}`;
      const row = document.createElement("div");
      row.className = `row b${idx % 2}${laneLocked(key) ? " locked" : ""}`;
      row.style.cssText += `;width:${W}px;height:${rowHForKey(key)}px`;
      row.dataset.trackKey = key;
      row.innerHTML = gridHTML;
      row.addEventListener("mousedown", (ev) => { if (ev.target === row) lanePress(ev, idx, "c"); });
      (S.tl.caps || []).filter((c) => capLaneOf(c) === idx).forEach((c) => {
        row.appendChild(clipElCap(c, key, idx));
      });
      L.appendChild(row);
    });
  }
  // Video tracks
  if (vOrder.length) {
    const bar = document.createElement("div");
    bar.className = "gbar-lane"; bar.style.width = W + "px";
    L.appendChild(bar);
    vOrder.forEach((idx) => {
      const key = `v${idx}`;
      const row = document.createElement("div");
      row.className = `row b${idx % 2}${laneLocked(key) ? " locked" : ""}`;
      row.style.cssText += `;width:${W}px;height:${rowHForKey(key)}px`;
      row.dataset.trackKey = key;
      row.innerHTML = gridHTML;
      row.addEventListener("mousedown", (ev) => { if (ev.target === row) lanePress(ev, idx, "v"); });
      // video/image clips on this track
      (S.tl.clips || []).filter((c) => TLM.trackOf(c) === idx).forEach((c) => {
        row.appendChild(clipEl(c, key, idx, "video"));
      });
      L.appendChild(row);
    });
  }
  // Audio tracks
  if (aOrder.length) {
    const bar = document.createElement("div");
    bar.className = "gbar-lane"; bar.style.width = W + "px";
    L.appendChild(bar);
    aOrder.forEach((idx) => {
      const key = `a${idx}`;
      const row = document.createElement("div");
      row.className = `row b${idx % 2}${laneLocked(key) ? " locked" : ""}`;
      row.style.cssText += `;width:${W}px;height:${rowHForKey(key)}px`;
      row.dataset.trackKey = key;
      row.innerHTML = gridHTML;
      row.addEventListener("mousedown", (ev) => { if (ev.target === row) lanePress(ev, idx, "a"); });
      // standalone audio items
      (S.tl.auds || []).filter((a) => TLM.atrackOf(a) === idx).forEach((a) => {
        row.appendChild(clipElAudio(a, key, idx));
      });
      // linked clip audio: the sound of V-track clips rides the same-numbered A lane
      (S.tl.clips || [])
        .filter((c) => TLM.trackOf(c) === idx && c.audio !== false && itemHasAudio(c))
        .forEach((c) => { row.appendChild(clipElLinkedAudio(c, key, idx)); });
      L.appendChild(row);
    });
  }

  // blade + playhead
  const blade = document.createElement("div");
  blade.className = "blade"; blade.id = "blade"; blade.hidden = true;
  L.appendChild(blade);
  const ph = document.createElement("div");
  ph.className = "playhead"; ph.id = "tlPlayhead";
  ph.style.left = t2x(playheadTime()) + "px";
  L.appendChild(ph);

  ruler.addEventListener("mousedown", (ev) => {
    if (ev.target === ruler || ev.target.classList.contains("tick")) seekEv(ev);
  });
  // drop hint for media bin
  L.addEventListener("dragover", onDragOver);
  L.addEventListener("dragleave", onDragLeave);
  L.addEventListener("drop", onDropMedia);
  L.onmousemove = bladeEv;
  L.onmouseleave = () => { const b = document.getElementById("blade"); if (b) b.hidden = true; };
}

function clipEl(c, key, idx, kindHint) {
  const isV = key[0] === "v";
  const locked = laneLocked(key);
  const hidden = laneHidden(key);
  const isMutedLane = S.audioMuted && S.audioMuted.has(key);
  const sel = S.sel.has(c.id);
  const kind = c.kind ? c.kind : (c.src && c.src !== TLM.MAIN_SRC ? "image" : "video");
  // Determine actual kind for styling: caption handled separately, so this is video/image/other/silence
  let styleKind = "video";
  if (kind === "silence") styleKind = "video"; // silence uses video style? In legend, silence is separate color but we treat as video with different mark?
  else if (kind === "image") styleKind = "image";
  else if (kind === "other") styleKind = "video";
  const top = 4, h = Math.max(8, rowHForKey(key) - 10);
  const d = document.createElement("div");
  d.className = `clip k-${styleKind}${sel ? " selected" : ""}${isMutedLane ? " mutedlane" : ""}${hidden ? " hiddenlane" : ""}`;
  // filter dim if kind filtered off? Preview had off opacity for secs, but clips should still show? We'll dim if filtered
  const kindMap = { caption: "caption", silence: "silence", other: "other" };
  const clipKindKey = c.kind || "other";
  if (!S.filter.kinds.has(clipKindKey === "caption" ? "caption" : clipKindKey === "silence" ? "silence" : "other")) {
    d.style.opacity = "0.25";
  }
  d.style.cssText += `;left:${t2x(c.start)}px;top:${top}px;width:${Math.max(3, t2x(c.end) - t2x(c.start))}px;height:${h}px`;
  let body = "";
  const bh = Math.max(0, h - 17);
  if (bh > 4) {
    if (styleKind === "audio") body = `<div class="cbody" style="height:${bh}px"><div class="wave"></div></div>`;
    else body = `<div class="cbody" style="height:${bh}px"><div class="frames"></div><div class="wave" style="top:auto;height:${Math.min(bh, 8)}px"></div></div>`;
  }
  const fxBadge = c.fx && !TLM.fxIsDefault(c.fx) ? '<span class="fx">fx</span>' : "";
  const muteFlag = c.fx && c.fx.mute ? '<span class="muteflag">🔇</span>' : "";
  const label = c.text || c.name || mediaName(c.src) || `V${idx + 1}`;
  d.innerHTML = `<div class="chead">${icon(KIND_ICON[styleKind] || "film", 2)}<span style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(label)}</span>${fxBadge}${muteFlag}</div>${body}<div class="outline"></div>`;
  d.title = `${label} — ${laneName(key)} ${fmt(c.start)}–${fmt(c.end)}`;
  // trim handles detection via edge
  d.addEventListener("mousedown", (ev) => { ev.stopPropagation(); clipPress(ev, c, key, idx); });
  // add trim hit areas
  const edge = document.createElement("div");
  edge.style.cssText = "position:absolute;left:0;top:0;bottom:0;width:6px;cursor:ew-resize";
  edge.addEventListener("mousedown", (ev) => { ev.stopPropagation(); startTrim(ev, c, "l"); });
  d.appendChild(edge);
  const edgeR = document.createElement("div");
  edgeR.style.cssText = "position:absolute;right:0;top:0;bottom:0;width:6px;cursor:ew-resize";
  edgeR.addEventListener("mousedown", (ev) => { ev.stopPropagation(); startTrim(ev, c, "r"); });
  d.appendChild(edgeR);
  return d;
}
function clipElCap(c, key, idx) {
  const sel = S.sel.has(c.id);
  const hidden = laneHidden(key);
  const isMutedLane = S.audioMuted && S.audioMuted.has(key);
  const top = 4, h = Math.max(8, rowHForKey(key) - 10);
  const d = document.createElement("div");
  d.className = `clip k-caption${sel ? " selected" : ""}${isMutedLane ? " mutedlane" : ""}${hidden ? " hiddenlane" : ""}`;
  // caption occupies its own C lane like any other clip (Premiere-style)
  d.style.cssText += `;left:${t2x(c.start)}px;top:${top}px;width:${Math.max(3, t2x(c.end) - t2x(c.start))}px;height:${h}px`;
  let body = "";
  const bh = Math.max(0, h - 17);
  if (bh > 10) body = `<div class="cbody" style="height:${bh}px"><div class="captext">“${escapeHtml(c.text || "caption")}”</div></div>`;
  const label = c.text || "caption";
  d.innerHTML = `<div class="chead">${icon("type", 2)}<span style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(label)}</span></div>${body}<div class="outline"></div>`;
  d.title = `${label} — ${laneName(key)} ${fmt(c.start)}–${fmt(c.end)}`;
  d.addEventListener("mousedown", (ev) => { ev.stopPropagation(); clipPress(ev, c, key, idx); });
  // trim edges
  const edge = document.createElement("div");
  edge.style.cssText = "position:absolute;left:0;top:0;bottom:0;width:6px;cursor:ew-resize";
  edge.addEventListener("mousedown", (ev) => { ev.stopPropagation(); startTrim(ev, c, "l"); });
  d.appendChild(edge);
  const edgeR = document.createElement("div");
  edgeR.style.cssText = "position:absolute;right:0;top:0;bottom:0;width:6px;cursor:ew-resize";
  edgeR.addEventListener("mousedown", (ev) => { ev.stopPropagation(); startTrim(ev, c, "r"); });
  d.appendChild(edgeR);
  d.addEventListener("dblclick", (ev) => {
    ev.stopPropagation();
    S.sel = new Set([c.id]); syncCapSel(); refresh();
    setPlayhead(c.start + 0.05, true);
    if (typeof startOverlayCaptionEdit === "function") startOverlayCaptionEdit();
  });
  return d;
}
function clipElAudio(a, key, idx) {
  const sel = S.sel.has(a.id);
  const locked = laneLocked(key);
  const top = 4, h = Math.max(8, rowHForKey(key) - 10);
  const d = document.createElement("div");
  d.className = `clip k-audio${sel ? " selected" : ""}${locked ? " locked" : ""}`;
  d.style.cssText += `;left:${t2x(a.start)}px;top:${top}px;width:${Math.max(3, t2x(a.end) - t2x(a.start))}px;height:${h}px`;
  const bh = Math.max(0, h - 17);
  let body = bh > 4 ? `<div class="cbody" style="height:${bh}px"><div class="wave"></div></div>` : "";
  const label = a.name || mediaName(a.src) || `A${idx + 1}`;
  d.innerHTML = `<div class="chead">${icon("music", 2)}<span style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(label)}</span></div>${body}<div class="outline"></div>`;
  d.title = `${label} — ${laneName(key)} ${fmt(a.start)}–${fmt(a.end)}`;
  d.addEventListener("mousedown", (ev) => { ev.stopPropagation(); clipPress(ev, a, key, idx); });
  const edge = document.createElement("div");
  edge.style.cssText = "position:absolute;left:0;top:0;bottom:0;width:6px;cursor:ew-resize";
  edge.addEventListener("mousedown", (ev) => { ev.stopPropagation(); startTrim(ev, a, "l"); });
  d.appendChild(edge);
  const edgeR = document.createElement("div");
  edgeR.style.cssText = "position:absolute;right:0;top:0;bottom:0;width:6px;cursor:ew-resize";
  edgeR.addEventListener("mousedown", (ev) => { ev.stopPropagation(); startTrim(ev, a, "r"); });
  d.appendChild(edgeR);
  return d;
}
function clipElLinkedAudio(c, key, idx) {
  const sel = S.sel.has(c.id);
  const top = 4, h = Math.max(8, rowHForKey(key) - 10);
  const d = document.createElement("div");
  d.className = `clip k-audio${sel ? " selected" : ""}`;
  d.style.cssText += `;left:${t2x(c.start)}px;top:${top}px;width:${Math.max(3, t2x(c.end) - t2x(c.start))}px;height:${h}px;opacity:0.85`;
  const bh = Math.max(0, h - 17);
  let body = bh > 4 ? `<div class="cbody" style="height:${bh}px"><div class="wave" style="opacity:0.6"></div></div>` : "";
  const label = c.name || mediaName(c.src) || `V${TLM.trackOf(c) + 1} sound`;
  d.innerHTML = `<div class="chead" style="background:#1f4b8f">${icon("music", 2)}<span style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(label)}</span></div>${body}<div class="outline"></div>`;
  d.title = `Linked audio of ${label} — ${laneName(key)} (click selects video)`;
  d.addEventListener("mousedown", (ev) => { ev.stopPropagation(); clipPress(ev, c, key, idx); });
  return d;
}

/* ---------- gestures ---------- */
function lanesX(ev) {
  const r = document.getElementById("lanes").getBoundingClientRect();
  return ev.clientX - r.left;
}
function seekEv(ev) {
  if (S.pan || curTool === "razor") return;
  const t = Math.max(0, x2t(lanesX(ev)));
  setPlayhead(t, true);
  // clear selection on seek? preview cleared selection; spec says click=select+preview, so seek without item clears?
  // We'll not clear sel here; just seek.
  status(`playhead ${fmtTC(t)}`);
}
function lanePress(ev, idx, kind) {
  if (S.pan) { startPan(ev); return; }
  if (curTool === "razor") { status("razor: click a clip to split it"); return; }
  const t = Math.max(0, x2t(lanesX(ev)));
  setPlayhead(t, true);
  // clicking empty lane clears selection unless shift
  if (!ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
    S.sel = new Set(); syncCapSel(); render();
  }
}
function clipPress(ev, item, key, idx) {
  const locked = itemLocked(item);
  if (S.pan) { startPan(ev); return; }
  if (locked) { status(`lane ${laneName(key)} is locked — unlock it to move or trim.`); return; }
  if (curTool === "razor") {
    const at = x2t(lanesX(ev));
    if (at <= item.start + 0.05 || at >= item.end - 0.05) { status("too close to the edge to split"); return; }
    razorSplit(item, at);
    return;
  }
  const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
  if (additive) {
    if (S.sel.has(item.id)) S.sel.delete(item.id);
    else S.sel.add(item.id);
    syncCapSel(); render();
    if (typeof renderList === "function") renderList();
    return;
  } else {
    if (!S.sel.has(item.id)) {
      S.sel = new Set([item.id]);
      syncCapSel(); render();
      if (typeof renderList === "function") renderList();
    }
  }
  // start drag move
  const ids = [...S.sel];
  // verify all drag items are on unlocked lanes
  const blocked = ids.some((id) => { const it = findTlItem(id); return it && itemLocked(it); });
  if (blocked) { status("A selected lane is locked."); return; }
  S.drag = {
    mode: "move",
    ids: ids.slice(),
    x0: ev.clientX,
    y0: ev.clientY,
    t0: item.start,
    base: JSON.parse(JSON.stringify(S.tl)),
    alt: ev.altKey,
    key0: key,
    idx0: idx,
    kind0: key[0],
    moved: false,
    resultIds: null,
  };
  // for caption lane moves, dLane = targetTrack - sourceTrack
  ev.preventDefault();
  const onMove = (e) => {
    if (!S.drag) return;
    const dx = e.clientX - S.drag.x0;
    if (!S.drag.moved && Math.abs(dx) < 3) return;
    S.drag.moved = true;
    const dt = snapShift(S.drag.base, S.drag.ids, dx / Math.max(pxPerSec(), 1e-6));
    // determine lane delta from pointer y
    let dLane = 0;
    if (e.clientY !== undefined) {
      const lanesEl = document.getElementById("lanes");
      const rows = [...lanesEl.querySelectorAll(".row")];
      let targetRow = null;
      for (const r of rows) {
        const rect = r.getBoundingClientRect();
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) { targetRow = r; break; }
      }
      if (targetRow && targetRow.dataset.trackKey) {
        const targetKey = targetRow.dataset.trackKey;
        // only shift lanes within the same group (c→c, v→v, a→a) —
        // dragging a caption over a video row must not re-lane it
        if (targetKey[0] === S.drag.key0[0]) {
          const srcIdx = S.drag.idx0;
          const tgtIdx = Number(targetKey.slice(1));
          dLane = tgtIdx - srcIdx;
        }
      }
    }
    if (S.drag.alt) {
      const dup = TLM.duplicateItems(S.drag.base, S.drag.ids, dt);
      // apply lane shift to dup ids
      if (dLane && dup.ids && dup.ids.length) {
        S.tl = TLM.moveItems(dup.tl, dup.ids, 0, dLane, dLane, dLane);
        S.drag.resultIds = dup.ids;
      } else {
        S.tl = dup.tl;
        S.drag.resultIds = dup.ids;
      }
    } else {
      S.tl = TLM.moveItems(S.drag.base, S.drag.ids, dt, dLane, dLane, dLane);
    }
    // live preview during drag
    refresh();
  };
  const onUp = (e) => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    const d = S.drag;
    S.drag = null;
    if (!d) return;
    if (!d.moved) {
      // click without move: seek inside clip
      const at = x2t(lanesX(ev));
      const t = Math.min(item.end - 0.001, Math.max(item.start, at));
      setPlayhead(t, true);
      refresh();
      return;
    }
    if (d.alt && d.resultIds) S.sel = new Set(d.resultIds);
    syncCapSel();
    commitTL();
    refresh(true);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}
function startTrim(ev, item, edge) {
  if (itemLocked(item)) return status(`${laneName(laneKeyOf(item))} is locked.`);
  const id = item.id;
  const base = JSON.parse(JSON.stringify(S.tl));
  let moved = false;
  const onMove = (e) => {
    const t = snapTime(x2t(e.clientX - document.getElementById("lanes").getBoundingClientRect().left), new Set([id]));
    S.tl = TLM.trimItem(base, id, edge, t, S.duration);
    moved = true;
    refresh();
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    if (moved) { commitTL(); refresh(true); }
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}
function bladeEv(ev) {
  const b = document.getElementById("blade");
  if (!b) return;
  if (curTool !== "razor") { b.hidden = true; return; }
  const t = Math.round(x2t(lanesX(ev)) * 30) / 30;
  b.hidden = false; b.style.left = t2x(t) + "px";
  b.style.height = document.getElementById("lanes").scrollHeight + "px";
}
function startPan(ev) {
  const sc = document.getElementById("scroll");
  if (!sc) return;
  const x0 = ev.clientX, l0 = sc.scrollLeft;
  const lanesEl = document.getElementById("lanes");
  if (lanesEl) lanesEl.style.cursor = "grabbing";
  const mv = (e) => { sc.scrollLeft = l0 - (e.clientX - x0); };
  const up = () => {
    window.removeEventListener("mousemove", mv);
    window.removeEventListener("mouseup", up);
    if (lanesEl) lanesEl.style.cursor = "";
    renderTray();
  };
  window.addEventListener("mousemove", mv);
  window.addEventListener("mouseup", up);
}

/* ---------- header more menu ---------- */
function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
document.addEventListener("click", (ev) => { if (popEl && !popEl.contains(ev.target)) closePop(); });
function openPop(anchor, build, align) {
  closePop();
  popEl = document.createElement("div"); popEl.className = "tl-pop";
  build(popEl);
  document.body.appendChild(popEl);
  const r = anchor ? anchor.getBoundingClientRect() : { left: 100, top: 100, right: 100, bottom: 100 };
  const scrollX = window.scrollX || 0, scrollY = window.scrollY || 0;
  popEl.style.top = (r.bottom + scrollY + 6) + "px";
  if (align === "right") popEl.style.left = Math.max(8, r.right + scrollX - popEl.offsetWidth) + "px";
  else popEl.style.left = Math.min(r.left + scrollX, window.innerWidth - 210) + "px";
}
function openMoreMenu(key, anchor) {
  if (!anchor) {
    // find header row for key
    const rows = document.querySelectorAll(".hrow");
    for (const row of rows) {
      if (row.textContent.includes(laneName(key))) { anchor = row.querySelector('[data-h="more"]'); break; }
    }
  }
  openPop(anchor, (box) => {
    // caption lanes are never "the last lane standing" — video/audio remain
    const isLast = key[0] === "c" ? false : (TLM.vtracksOf(S.tl) + TLM.atracksOf(S.tl)) < 2;
    const b = document.createElement("button");
    b.className = "del";
    b.disabled = isLast;
    b.title = isLast ? "Cannot delete the last lane standing" : `Delete lane ${laneName(key)}`;
    b.innerHTML = `${icon("trash", 2)}<span>Delete</span>`;
    b.addEventListener("click", () => {
      closePop();
      if (isLast) return;
      const name = laneName(key);
      const kind = key[0];
      const idx = Number(key.slice(1));
      if (kind === "v") {
        // delete V lane: remove clips on that track (captions live on C lanes now)
        const keepClips = S.tl.clips.filter((c) => TLM.trackOf(c) !== idx);
        S.tl = TLM.normalise({ ...S.tl, clips: keepClips, vtracks: Math.max(1, TLM.vtracksOf(S.tl) - 1) });
        S.tl.clips.forEach((c) => { if (TLM.trackOf(c) > idx) c.track = TLM.trackOf(c) - 1; });
        S.tl = TLM.normalise(S.tl);
      } else if (kind === "a") {
        const keepAuds = S.tl.auds.filter((a) => TLM.atrackOf(a) !== idx);
        S.tl = TLM.normalise({ ...S.tl, auds: keepAuds, atracks: Math.max(1, TLM.atracksOf(S.tl) - 1) });
        S.tl.auds.forEach((a) => { if (TLM.atrackOf(a) > idx) a.atrack = TLM.atrackOf(a) - 1; });
        S.tl = TLM.normalise(S.tl);
      } else if (kind === "c") {
        // delete caption lane: drop its captions, shift higher lanes down
        const keepCaps = S.tl.caps.filter((c) => capLaneOf(c) !== idx)
          .map((c) => {
            const ln = capLaneOf(c);
            if (ln <= idx) return c;
            const m = { ...c, lane: ln - 1 };
            if (m.track !== undefined) m.track = ln - 1;
            return m;
          });
        S.tl = TLM.normalise({ ...S.tl, caps: keepCaps });
      }
      // cleanup laneH/lock/hidden for deleted key and reindex keys above
      laneSets();
      const newLocked = new Set(); const newHidden = new Set(); const newH = {};
      for (const k of S.laneLocked) {
        if (k === key) continue;
        if (k[0] === kind && Number(k.slice(1)) > idx) newLocked.add(`${kind}${Number(k.slice(1)) - 1}`);
        else newLocked.add(k);
      }
      for (const k of S.laneHidden) {
        if (k === key) continue;
        if (k[0] === kind && Number(k.slice(1)) > idx) newHidden.add(`${kind}${Number(k.slice(1)) - 1}`);
        else newHidden.add(k);
      }
      for (const [k, v] of Object.entries(S.laneH)) {
        if (k === key) continue;
        if (k[0] === kind && Number(k.slice(1)) > idx) newH[`${kind}${Number(k.slice(1)) - 1}`] = v;
        else newH[k] = v;
      }
      S.laneLocked = newLocked; S.laneHidden = newHidden; S.laneH = newH;
      if (typeof saveWorkspaceLayout === "function") saveWorkspaceLayout();
      // cleanup selection
      S.sel = new Set([...S.sel].filter((id) => tlItems(S.tl).some((c) => c.id === id)));
      syncCapSel();
      commitTL(); refresh(true);
      status(`deleted lane ${name}`);
    });
    box.appendChild(b);
  }, "right");
}

/* ---------- media bin drag ---------- */
let dropHint = null;
function onDragOver(ev) {
  const types = [...(ev.dataTransfer ? ev.dataTransfer.types : [])];
  if (!types.includes("text/vts-asset")) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = "copy";
  try {
    const id = ev.dataTransfer.getData("text/vts-asset");
    const asset = window.MEDIA && window.MEDIA.assets ? window.MEDIA.assets.get(id) : null;
    if (!asset) return;
    const lanesEl = document.getElementById("lanes");
    const rect = lanesEl.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const t = Math.max(0, snapTime(x2t(x), new Set()));
    const dur = asset.kind === "image" ? Math.max(TLM.MIN_LEN, Number(document.getElementById("mediaStillDur") ? document.getElementById("mediaStillDur").value : 5) || 5) : Math.max(TLM.MIN_LEN, Number(asset.duration) || TLM.MIN_LEN);
    // find target lane under cursor
    const rows = [...document.querySelectorAll(".row")];
    let targetKey = null, targetIdx = 0;
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (ev.clientY >= r.top && ev.clientY <= r.bottom) { targetKey = row.dataset.trackKey; targetIdx = Number(targetKey.slice(1)); break; }
    }
    if (!targetKey) {
      targetKey = asset.kind === "audio" ? `a0` : `v${TLM.vtracksOf(S.tl) - 1}`;
      targetIdx = Number(targetKey.slice(1));
    }
    dropHint = { t, kind: asset.kind, key: targetKey, idx: targetIdx, name: asset.name, dur };
    drawDropHint();
  } catch {}
}
function drawDropHint() {
  // visual hint: could add overlay, for now just status
  if (!dropHint) return;
}
function onDragLeave() { dropHint = null; }
function onDropMedia(ev) {
  const types = [...(ev.dataTransfer ? ev.dataTransfer.types : [])];
  if (!types.includes("text/vts-asset")) return;
  ev.preventDefault();
  dropHint = null;
  const id = ev.dataTransfer.getData("text/vts-asset");
  const asset = window.MEDIA && window.MEDIA.assets ? window.MEDIA.assets.get(id) : null;
  if (!asset) return;
  const rect = document.getElementById("lanes").getBoundingClientRect();
  const t = Math.max(0, snapTime(x2t(ev.clientX - rect.left), new Set()));
  // find target track under drop
  const rows = [...document.querySelectorAll(".row")];
  let targetKey = null, targetIdx = 0;
  for (const row of rows) {
    const r = row.getBoundingClientRect();
    if (ev.clientY >= r.top && ev.clientY <= r.bottom) { targetKey = row.dataset.trackKey; targetIdx = Number(targetKey.slice(1)); break; }
  }
  if (asset.kind === "audio") {
    const atrack = targetKey && targetKey[0] === "a" ? targetIdx : 0;
    const item = TLM.makeAudioItem(asset, t, atrack);
    S.tl = TLM.normalise({ ...S.tl, auds: [...(S.tl.auds || []), item] });
    commitTL(); refresh();
    S.sel = new Set([item.id]); syncCapSel(); draw();
    status(`${asset.name} → A${atrack + 1} at ${fmt(t)}.`);
    return;
  }
  const dur = asset.kind === "image" ? Math.max(TLM.MIN_LEN, Number(document.getElementById("mediaStillDur") ? document.getElementById("mediaStillDur").value : 5) || 5) : Math.max(TLM.MIN_LEN, Number(asset.duration) || TLM.MIN_LEN);
  let want = targetKey && targetKey[0] === "v" ? targetIdx : TLM.firstFreeTrack(S.tl.clips || [], t, t + dur);
  const res = TLM.addMedia(S.tl, asset, t, want, { duration: dur, in: 0, fit: mediaDefaultFit(asset) });
  if (!res || !res.id) return;
  S.tl = res.tl;
  S.sel = new Set([res.id]); syncCapSel(); commitTL(); refresh();
  status(res.moved ? `V${want + 1} was busy — ${asset.name} went to V${want + 1 + res.moved} so it overlays instead of overwriting.` : `${asset.name} → V${want + 1} at ${fmt(t)}.`);
}

/* ---------- tray wiring ---------- */
function zoomByFactor(f) { zoomBy(f); }
function setupTrayIcons() {
  setIcon("btnAdd", "plus", 2.2);
  setIcon("btnUndo", "undo");
  setIcon("btnRedo", "redo");
  setIcon("btnSplit", "split");
  setIcon("btnRazor", "razor");
  setIcon("btnMerge", "merge");
  setIcon("btnTrash", "trash");
  setIcon("btnPan", "hand");
  setIcon("btnTrimFollow", "trimfollow");
  setIcon("btnSnap", "magnet");
  setIcon("btnMagnet", "magnetic");
  setIcon("btnAddCap", "type");
  setIcon("btnFit", "fit");
  setIcon("btnZout", "minus", 2.2);
  setIcon("btnZin", "plus", 2.2);
}
function bindTray() {
  setupTrayIcons();
  const addBtn = document.getElementById("btnAdd");
  if (addBtn) addBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    openPop(ev.currentTarget, (box) => {
      const items = [
        ["Add video track", () => addTrackV()],
        ["Add audio track", () => addTrackA()],
      ];
      items.forEach(([label, fn]) => {
        const b = document.createElement("button"); b.textContent = label;
        b.addEventListener("click", () => { closePop(); fn(); });
        box.appendChild(b);
      });
    });
  });
  function addTrackV() {
    if (!S.project) return;
    const v = TLM.vtracksOf(S.tl);
    S.tl = TLM.normalise({ ...S.tl, vtracks: v + 1, atracks: Math.max(TLM.atracksOf(S.tl), v + 1) });
    commitTL(); refresh();
    status(`added video track V${v + 1} on top (top lane = top layer)`);
  }
  function addTrackA() {
    if (!S.project) return;
    const a = TLM.atracksOf(S.tl);
    S.tl = TLM.normalise({ ...S.tl, atracks: a + 1 });
    commitTL(); refresh();
    status(`added audio track A${a + 1} at bottom`);
  }
  document.getElementById("btnUndo")?.addEventListener("click", undoTL);
  document.getElementById("btnRedo")?.addEventListener("click", redoTL);
  document.getElementById("btnRazor")?.addEventListener("click", () => {
    curTool = curTool === "razor" ? "select" : "razor";
    S.pan = false;
    renderTray();
    status(curTool === "razor" ? "razor: click a clip to split it (R)" : "select / move (V)");
  });
  document.getElementById("btnPan")?.addEventListener("click", () => {
    S.pan = !S.pan;
    if (S.pan) curTool = "select";
    renderTray();
    status(S.pan ? "pan: drag to scroll (H)" : "select / move");
  });
  document.getElementById("btnSnap")?.addEventListener("click", () => {
    S.snap = !S.snap;
    renderTray();
    status(`snap ${S.snap ? "on" : "off"}`);
  });
  document.getElementById("btnMagnet")?.addEventListener("click", () => {
    S.magnetic = !S.magnetic;
    renderTray();
    status(S.magnetic ? "magnetic: deletes close the gap" : "magnetic off: deletes leave a gap");
  });
  document.getElementById("btnSplit")?.addEventListener("click", splitAtPlayhead);
  document.getElementById("btnTrash")?.addEventListener("click", () => deleteSel(false));
  document.getElementById("btnAddCap")?.addEventListener("click", addCaptionAtPlayhead);
  document.getElementById("btnFit")?.addEventListener("click", () => {
    S.view = { start: 0, span: Math.max(contentEnd(), 0.2) };
    const sc = document.getElementById("scroll");
    if (sc) sc.scrollLeft = 0;
    draw(); status("zoom to fit");
  });
  document.getElementById("btnZout")?.addEventListener("click", () => zoomBy(1.6));
  document.getElementById("btnZin")?.addEventListener("click", () => zoomBy(0.6));

  // pills ↔ S.filter
  document.querySelectorAll("[data-pill]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.pill;
    if (S.filter.kinds.has(k)) S.filter.kinds.delete(k);
    else S.filter.kinds.add(k);
    renderTray(); renderLanes();
    if (typeof renderList === "function") renderList();
    status(`${k} sections ${S.filter.kinds.has(k) ? "shown" : "hidden"}`);
  }));
  document.getElementById("pillAllSil")?.addEventListener("click", () => {
    // select every silence section
    const ids = (S.tl.clips || []).filter((c) => c.kind === "silence").map((c) => c.id);
    ids.forEach((id) => S.sel.add(id));
    syncCapSel(); renderTray(); renderLanes();
    if (typeof renderList === "function") renderList();
    status(`selected ${ids.length} silence section${ids.length === 1 ? "" : "s"}`);
  });
  document.getElementById("pillRemove")?.addEventListener("click", () => {
    // remove selected (S.sel) with magnetic gap close? Spec: remove selected sections
    if (!S.sel.size) return;
    deleteSel(S.magnetic);
  });
}

/* ---------- zoom/pan ---------- */
function bindZoomPan() {
  const sc = document.getElementById("scroll");
  if (!sc) return;
  sc.addEventListener("wheel", (ev) => {
    if (!S.project) return;
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      // keep the time under the cursor pinned while zooming
      const anchor = x2t(ev.clientX - document.getElementById("lanes").getBoundingClientRect().left);
      const cursorInView = ev.clientX - sc.getBoundingClientRect().left;
      const factor = ev.deltaY > 0 ? 1.25 : 0.8;
      S.view.span = Math.min(Math.max(contentEnd(), 1), Math.max(0.2, S.view.span * factor));
      draw();
      sc.scrollLeft = Math.max(0, anchor * pxPerSec() - cursorInView);
      syncViewStart();
    } else if (ev.altKey) {
      // Alt+wheel is handled per-header for lane heights; if not over header, ignore
      // to avoid zooming accidentally
    }
  }, { passive: false });
  sc.addEventListener("scroll", syncViewStart);
}

/* ---------- playback helpers (kept for compat) ---------- */
function updateTimecode() {
  const el = document.getElementById("timecode");
  if (el) el.textContent = `${fmtTime(playheadTime(), false)} / ${fmtTime(timelineEnd(), false)}`;
}
function followPlayhead() {
  if (!PV.playing) return;
  const sc = document.getElementById("scroll");
  if (!sc) return;
  syncViewStart();
  const t = playheadTime();
  if (t > S.view.start + S.view.span * 0.92 || t < S.view.start) {
    sc.scrollLeft = Math.max(0, t2x(t) - plotWidth() * 0.15);
    syncViewStart();
  }
}
function setPlayhead(t, sync = true) {
  S.T = Math.max(0, Math.min(t, Math.max(0, contentEnd())));
  if (sync) syncPreview(true);
  followPlayhead();
  if (typeof syncListPlayhead === "function") syncListPlayhead();
  if (typeof syncListScroll === "function") syncListScroll(true);
  draw(); updateTimecode();
  if (typeof layoutCapOverlay === "function") layoutCapOverlay();
  if (typeof ClipRefresh === "function") ClipRefresh();
}
function syncPreview(force) {
  if (!S.project) return;
  if (typeof stageSync === "function") stageSync(playheadTime(), PV.playing, !!force);
  const shade = document.getElementById("gapShade");
  if (shade) {
    const stack = TLM.clipStackAt(S.tl, playheadTime());
    shade.hidden = stack.length > 0;
  }
}
function togglePlay() { if (PV.playing) pausePlayback(); else startPlayback(); }
function startPlayback() {
  if (!S.project || PV.playing) return;
  if (!(S.tl.clips || []).length) return status("The timeline is empty.");
  if (playheadTime() >= timelineEnd() - 0.01) setPlayhead(0, false);
  PV.playing = true; PV.last = performance.now();
  const btn = document.getElementById("playBtn"); if (btn) btn.textContent = "❚❚ pause";
  syncPreview(true); PV.raf = requestAnimationFrame(pvTick);
}
function pausePlayback() {
  if (PV.playing) { PV.playing = false; cancelAnimationFrame(PV.raf); }
  const btn = document.getElementById("playBtn"); if (btn) btn.textContent = "▶ play";
  if (S.project) { syncPreview(true); if (typeof syncListPlayhead === "function") syncListPlayhead(); draw(); updateTimecode(); if (typeof layoutCapOverlay === "function") layoutCapOverlay(); }
}
function pvTick(now) {
  if (!PV.playing) return;
  const dt = Math.min(0.25, Math.max(0, (now - PV.last) / 1000));
  PV.last = now;
  let t = playheadTime() + dt;
  const ref = typeof stageClockReference === "function" ? stageClockReference(t) : null;
  if (ref !== null && Number.isFinite(ref) && Math.abs(ref - t) < 0.35) t = ref;
  const end = Math.max(timelineEnd(), 0.001);
  if (t >= end) { S.T = end; pausePlayback(); return; }
  S.T = t; syncPreview(false); followPlayhead();
  if (typeof syncListPlayhead === "function") syncListPlayhead();
  draw(); updateTimecode();
  if (typeof layoutCapOverlay === "function") layoutCapOverlay();
  if (typeof ClipTick === "function") ClipTick();
  PV.raf = requestAnimationFrame(pvTick);
}
function stepFrame(dir) {
  if (!S.project) return;
  const fps = Number(S.project.info?.video?.fps) || 30;
  pausePlayback(); setPlayhead(playheadTime() + dir / fps);
}
function bindPlayer() {
  const p = document.getElementById("player");
  if (!p) return;
  p.addEventListener("loadedmetadata", () => {
    if (!S.duration && p.duration) { S.duration = p.duration; S.view = { start: 0, span: S.duration }; }
    syncPreview(true); draw();
  });
}

/* ---------- keyboard ---------- */
function bindKeys() {
  document.addEventListener("keydown", (ev) => {
    const el = ev.target; const tag = el && el.tagName;
    const typing = el && (el.isContentEditable || tag === "TEXTAREA" || tag === "SELECT" || (tag === "INPUT" && !["checkbox", "radio", "button", "submit", "reset"].includes(el.type)));
    if (typing || !S.project) return;
    const key = ev.key;
    if (key === " " || ev.code === "Space") {
      if (el && (el.matches?.("input[type=checkbox], input[type=radio]") || el.closest?.("button, [role=button]"))) return;
      ev.preventDefault(); if (!ev.repeat) togglePlay(); return;
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
      if (map[k]) { ev.preventDefault(); map[k](); }
      return;
    }
    if (key === "Delete" || key === "Backspace") {
      if (S.sel.size) { ev.preventDefault(); deleteSel(ev.shiftKey); }
      return;
    }
    if (key === "Escape") { if (curTool !== "razor") setTool("select"); clearSel(); return; }
    if (key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      const toolByKey = { v: "select", r: "razor" };
      if (key.toLowerCase() === "t") { ev.preventDefault(); addCaptionAtPlayhead(); return; }
      if (key.toLowerCase() === "v") { ev.preventDefault(); setTool("select"); return; }
      if (key.toLowerCase() === "r") { ev.preventDefault(); setTool(curTool === "razor" ? "select" : "razor"); return; }
      if (key.toLowerCase() === "h") { ev.preventDefault(); S.pan = !S.pan; renderTray(); status(S.pan ? "pan: drag to scroll" : "select / move"); return; }
      if (key.toLowerCase() === "m") {
        ev.preventDefault();
        // M: mute on A lanes, output toggle on V lanes (selected clip's lane else first lane)
        let targetKey = null;
        const sel = [...S.sel].map(findTlItem).filter(Boolean);
        if (sel.length) {
          const it = sel[0];
          targetKey = laneKeyOf(it);
        } else {
          targetKey = TLM.vtracksOf(S.tl) ? `v${TLM.vtracksOf(S.tl) - 1}` : `a0`;
        }
        if (!targetKey) return;
        if (targetKey[0] === "a") {
          if (!S.audioMuted) S.audioMuted = new Set();
          if (S.audioMuted.has(targetKey)) S.audioMuted.delete(targetKey);
          else S.audioMuted.add(targetKey);
          render();
          status(`lane ${laneName(targetKey)} ${S.audioMuted.has(targetKey) ? "muted" : "unmuted"} (M)`);
        } else {
          laneSets();
          if (S.laneHidden.has(targetKey)) S.laneHidden.delete(targetKey);
          else S.laneHidden.add(targetKey);
          saveWorkspaceLayout();
          render();
          status(`lane ${laneName(targetKey)} ${S.laneHidden.has(targetKey) ? "hidden" : "shown"} (M)`);
        }
        return;
      }
      if (tool) { ev.preventDefault(); setTool(tool); return; }
    }
    if (key === "ArrowLeft" || key === "ArrowRight") {
      ev.preventDefault();
      if (ev.shiftKey) setPlayhead(playheadTime() + (key === "ArrowLeft" ? -1 : 1));
      else stepFrame(key === "ArrowLeft" ? -1 : 1);
    }
  });
}

/* ---------- list glue (keep old renderList etc working) ---------- */
function escapeHtml(str) {
  return String(str).replace(/[&<>\"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function allListItems() {
  const entries = [
    ...S.tl.clips.map((item) => ({ id: item.id, item, type: "clip", track: `V${TLM.trackOf(item) + 1}`, kind: item.kind || "other" })),
    ...S.tl.caps.map((item) => {
      const tr = item.track !== undefined ? item.track : (item.lane || 0);
      return ({ id: item.id, item, type: "caption", track: `T${Math.max(0, tr) + 1}`, kind: "caption" });
    }),
  ];
  const rank = (entry) => entry.type === "clip" ? 0 : 1;
  return entries.sort((a, b) => a.item.start - b.item.start || rank(a) - rank(b) || (a.type === "caption" ? (a.item.lane || a.item.track || 0) - (b.item.lane || b.item.track || 0) : 0) || a.item.end - b.item.end || a.id.localeCompare(b.id));
}
function visibleListItems() {
  const q = (S.filter.q || "").trim().toLowerCase();
  return allListItems().filter((entry) => {
    const item = entry.item;
    if (!S.filter.kinds.has(entry.kind)) return false;
    if (entry.type === "clip" && item.end - item.start < S.filter.minDur) return false;
    if (q && !(item.text || "").toLowerCase().includes(q)) return false;
    return true;
  });
}
function listActiveIdsAt(t) {
  const ids = new Set();
  for (const clip of TLM.clipStackAt(S.tl, t)) ids.add(clip.id);
  for (const cap of S.tl.caps) if (t >= cap.start && t <= cap.end) ids.add(cap.id);
  return ids;
}
function listScrollTargetId(t) {
  const activeIds = listActiveIdsAt(t);
  if (S.capSel && activeIds.has(S.capSel)) return S.capSel;
  const activeClip = TLM.clipAt(S.tl, t);
  if (activeClip && S.sel.has(activeClip.id)) return activeClip.id;
  const selectedCaption = S.tl.caps.filter((cap) => activeIds.has(cap.id) && S.sel.has(cap.id)).sort((a, b) => (a.lane || a.track || 0) - (b.lane || b.track || 0) || a.start - b.start)[0];
  if (selectedCaption) return selectedCaption.id;
  const activeCaption = S.tl.caps.filter((cap) => activeIds.has(cap.id)).sort((a, b) => (a.lane || a.track || 0) - (b.lane || b.track || 0) || a.start - b.start)[0];
  return activeCaption?.id || activeClip?.id || null;
}
let lastListScrollId = null;
function syncListScroll(force = false) {
  const id = listScrollTargetId(playheadTime());
  if (!id) { lastListScrollId = null; return; }
  if (!force && id === lastListScrollId) return;
  const tb = document.querySelector("#secTable tbody");
  const row = tb && [...tb.querySelectorAll("tr[data-id]")].find((item) => item.dataset.id === id);
  if (!row) { lastListScrollId = null; return; }
  const scroller = row.closest(".list-scroll");
  if (!scroller) return;
  const viewport = scroller.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const head = scroller.querySelector("thead");
  const stickyHead = head ? head.getBoundingClientRect().height : 0;
  const visibleTop = Math.min(viewport.bottom, viewport.top + stickyHead + 1);
  if (rowRect.top < visibleTop) scroller.scrollTop -= visibleTop - rowRect.top;
  else if (rowRect.bottom > viewport.bottom) scroller.scrollTop += rowRect.bottom - viewport.bottom;
  lastListScrollId = id;
}
function listItemById(id) { return allListItems().find((entry) => entry.id === id) || null; }
function renderList() {
  const tb = document.querySelector("#secTable tbody");
  if (!tb) return;
  const rows = visibleListItems();
  const activeIds = listActiveIdsAt(playheadTime());
  tb.innerHTML = rows.map((entry) => {
    const { item, type, track, kind, id } = entry;
    const classes = [S.sel.has(id) ? "sel" : "", activeIds.has(id) ? "at-playhead" : ""].filter(Boolean).join(" ");
    const title = type === "caption" ? "Edit this caption cue's text." : "Edit section text. Matching timeline captions are updated too.";
    return `<tr data-id="${escapeHtml(id)}" data-type="${type}" class="${classes}">` +
      `<td class="check-cell"><input type="checkbox" ${S.sel.has(id) ? "checked" : ""}></td>` +
      `<td class="track">${escapeHtml(track)}</td>` +
      `<td>${fmtTime(item.start, false)}</td><td>${fmtTime(item.end, false)}</td>` +
      `<td>${fmtTime(item.end - item.start, false)}</td><td>${escapeHtml(kind)}</td>` +
      `<td class="txt txt-edit" contenteditable="true" spellcheck="false" title="${escapeHtml(title)}">${escapeHtml(item.text || "")}</td></tr>`;
  }).join("");
  const empty = document.getElementById("listEmpty");
  if (empty) {
    const hasTimelineItems = S.tl.clips.length > 0 || S.tl.caps.length > 0;
    empty.hidden = rows.length > 0;
    empty.textContent = hasTimelineItems ? "No timeline items match these filters." : "No timeline items yet — open a video or add captions first.";
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
  const same = nextIds.size === lastActiveListIds.size && [...nextIds].every((id) => lastActiveListIds.has(id));
  const stale = [...activeListRows.values()].some((row) => !row.isConnected);
  if (same && !stale) return;
  activeListRows.clear();
  for (const row of tb.querySelectorAll("tr[data-id]")) {
    const active = nextIds.has(row.dataset.id);
    row.classList.toggle("at-playhead", active);
    if (active) activeListRows.set(row.dataset.id, row);
  }
  lastActiveListIds = nextIds;
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
  syncCapSel(); syncListSelection(); draw(); if (typeof layoutCapOverlay === "function") layoutCapOverlay();
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
  ev.preventDefault();
  try { checkbox.focus({ preventScroll: true }); } catch (_) { checkbox.focus(); }
  tb.classList.add("checklist-dragging");
  try { tb.setPointerCapture(ev.pointerId); } catch (_) {}
  const ids = ev.shiftKey && lastListId ? listRangeIds(lastListId, id) : [id];
  applyListSelection(ids, selected); lastListId = id;
}
function moveChecklistDrag(ev) {
  const drag = checklistDrag;
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const id = checklistRowAtPoint(ev, drag.tb);
  if (!id || id === drag.lastId) return;
  const ids = listRangeIds(drag.lastId, id);
  applyListSelection(ids, drag.selected); drag.lastId = id; lastListId = id;
}
function endChecklistDrag(ev) {
  const drag = checklistDrag;
  if (!drag || (ev && ev.pointerId !== drag.pointerId)) return;
  checklistDrag = null;
  drag.tb.classList.remove("checklist-dragging");
  try { drag.tb.releasePointerCapture(drag.pointerId); } catch (_) {}
  suppressChecklistClick = true;
  setTimeout(() => { suppressChecklistClick = false; }, 0);
}
function bindList() {
  const tb = document.querySelector("#secTable tbody");
  if (!tb) return;
  tb.addEventListener("pointerdown", (ev) => beginChecklistDrag(tb, ev));
  document.addEventListener("pointermove", moveChecklistDrag);
  document.addEventListener("pointerup", endChecklistDrag);
  document.addEventListener("pointercancel", endChecklistDrag);
  tb.addEventListener("click", (ev) => {
    if (suppressChecklistClick) { suppressChecklistClick = false; ev.preventDefault(); ev.stopPropagation(); return; }
    if (ev.target.closest && ev.target.closest("td.txt")) return;
    const tr = ev.target.closest("tr[data-id]");
    if (!tr) return;
    const id = tr.dataset.id;
    const entry = listItemById(id);
    const checkbox = ev.target.closest && ev.target.closest('input[type="checkbox"]');
    if (checkbox && tr.contains(checkbox)) {
      const selected = !S.sel.has(id);
      const ids = ev.shiftKey && lastListId ? listRangeIds(lastListId, id) : [id];
      applyListSelection(ids, selected); lastListId = id; return;
    }
    if (entry) { selectOnly(id); const item = entry.item; setPlayhead(Math.min(item.start + 0.01, item.end - 0.001)); lastListId = id; }
  });
  tb.addEventListener("keydown", (ev) => {
    if (!ev.target.closest || !ev.target.closest("td.txt")) return;
    ev.stopPropagation();
    if (ev.key === "Enter") {
      ev.preventDefault();
      const cell = ev.target.closest("td.txt");
      const row = cell.closest("tr[data-id]"); const id = row && row.dataset.id; const type = row && row.dataset.type;
      const frac = caretFraction(cell);
      ev.target.blur();
      if (id) {
        let next = S.tl;
        if (type === "caption") next = TLM.splitCaption(S.tl, id, frac);
        else {
          next = TLM.splitClip(S.tl, id, frac);
          const clip = S.tl.clips.find((c) => c.id === id);
          if (clip) { const cap = S.tl.caps.find((c) => c.start < clip.end - 1e-6 && c.end > clip.start + 1e-6); if (cap) next = TLM.splitCaption(next, cap.id, frac); }
        }
        if (next !== S.tl) { setTL(next); status("Caption split at the cursor (CapCut-style)."); return; }
        status("Caption is too short to split."); return;
      }
      return;
    } else if (ev.key === "Escape") { ev.target.dataset.cancel = "1"; ev.target.blur(); }
  });
  tb.addEventListener("focusout", (ev) => {
    const cell = ev.target.closest && ev.target.closest("td.txt");
    if (!cell) return;
    const row = cell.closest("tr[data-id]"); const id = row.dataset.id;
    const item = row.dataset.type === "caption" ? S.tl.caps.find((c) => c.id === id) : S.tl.clips.find((c) => c.id === id);
    const cancel = cell.dataset.cancel === "1"; delete cell.dataset.cancel;
    if (!item) return;
    const text = cell.textContent.replace(/\s+/g, " ").trim();
    if (cancel || text === (item.text || "")) { cell.textContent = item.text || ""; return; }
    if (row.dataset.type === "caption") { setTL(TLM.setCaptionText(S.tl, id, text)); status("Caption updated (matching section text follows)."); }
    else { setTL(TLM.setClipText(S.tl, id, text)); status("Text updated (captions on the timeline with the same text too)."); }
  });
  const bindIf = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  bindIf("selVisible", () => { S.sel = new Set([...S.sel, ...visibleListItems().map((entry) => entry.id)]); syncCapSel(); refresh(); });
  bindIf("selNone", () => clearSel());
  bindIf("selInvert", () => {
    const next = new Set(S.sel);
    for (const entry of visibleListItems()) { if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id); }
    S.sel = next; syncCapSel(); refresh();
  });
  bindIf("selAllSilence", () => { S.sel = new Set(S.tl.clips.filter((c) => c.kind === "silence").map((c) => c.id)); syncCapSel(); refresh(); });
  bindIf("selAllCaptions", () => { S.sel = new Set([...S.tl.clips.filter((c) => c.kind === "caption").map((c) => c.id), ...S.tl.caps.map((c) => c.id)]); syncCapSel(); refresh(); });
  bindIf("selRemove", () => deleteSel(true));
}

/* ---------- sidebar tally etc (keep old) ---------- */
function updateTally() {
  const used = S.tl.clips.reduce((a, c) => a + (c.end - c.start), 0);
  const tSrc = document.getElementById("tSrc");
  const tCut = document.getElementById("tCut");
  const tOut = document.getElementById("tOut");
  if (tSrc) tSrc.textContent = fmtTime(S.duration, false);
  if (tCut) tCut.textContent = fmtTime(Math.max(0, S.duration - used), false);
  if (tOut) tOut.textContent = fmtTime(timelineEnd(), false);
  const warn = [];
  if (S.tl.clips.length > 300) warn.push("Many clips: the export will take longer.");
  if ((S.tl.clips || []).length && timelineEnd() < 0.5) warn.push("The timeline is very short.");
  const planWarn = document.getElementById("planWarn");
  if (planWarn) planWarn.textContent = warn.join(" ");
  const exportBtn = document.getElementById("exportBtn");
  if (exportBtn) exportBtn.disabled = !S.project || !S.tl.clips.length;
}
function updateCaptionExportInfo() {
  const el = document.getElementById("xCapInfo");
  if (!el) return;
  const modeEl = document.getElementById("xCaptions");
  if (!modeEl) return;
  const mode = modeEl.value;
  const capStyleRow = document.getElementById("capStyleRow");
  if (capStyleRow) capStyleRow.hidden = !(mode === "burn" || mode === "both");
  if (typeof layoutCapOverlay === "function") layoutCapOverlay();
  if (mode === "none") { el.textContent = ""; return; }
  const n = S.tl.caps.filter((c) => (c.text || "").trim()).length;
  if (!n) { el.textContent = "no captions on the timeline yet"; return; }
  const bits = [`${n} caption(s) from the timeline`, "times match the exported video"];
  if (mode === "burn" || mode === "both") bits.push("burning re-encodes, even in stream-copy mode");
  el.textContent = bits.join(" · ");
}
function isPristine() {
  const c = S.tl.clips;
  return c.length === 1 && c[0].start === 0 && c[0].in === 0 && !c[0].kind && S.tl.caps.length === 0;
}
async function runDetect() {
  if (!S.project) return alert("Open a video first.");
  if (!isPristine() && !confirm("Detection rebuilds the cut list from the source, and your current edits and captions are replaced. You can undo this with Ctrl+Z.")) return;
  const btn = document.getElementById("detectBtn");
  if (!btn) return;
  btn.disabled = true; btn.textContent = "Detecting…";
  const detectInfo = document.getElementById("detectInfo");
  if (detectInfo) detectInfo.textContent = "running ffmpeg silencedetect / parsing subtitles…";
  try {
    const body = {
      silence_thresh_db: Number(document.getElementById("dThresh").value),
      min_silence_ms: Number(document.getElementById("dMinSilence").value),
      min_section_ms: Number(document.getElementById("dMinSection").value),
      detect_silence: document.getElementById("dSilence").checked,
      use_cues: document.getElementById("dCues").checked,
      subtitles_text: S.subsText,
      subtitles_path: document.getElementById("dSubPath").value.trim() || null,
    };
    const data = await api("/api/detect", { method: "POST", body: JSON.stringify(body) });
    const clips = TLM.clipsFromSections(data.sections, S.duration);
    let caps = [], lanes = 1;
    if (document.getElementById("dCues").checked && Array.isArray(data.captions) && data.captions.length) {
      ({ caps, lanes } = TLM.capsFromCues(clips, data.captions));
    }
    S.sel = new Set(); S.capSel = null;
    setTL({ clips, caps, lanes, vtracks: 1, auds: [], atracks: 1 });
    const sm = data.summary;
    if (detectInfo) detectInfo.innerHTML = `${clips.length} clips &middot; ${data.silence_count} silences (${fmtTime(sm.seconds_by_kind.silence, false)})` + ` &middot; ${caps.length} caption(s)` + (sm.seconds_by_kind.other ? ` &middot; other audio ${fmtTime(sm.seconds_by_kind.other, false)}` : "");
  } catch (e) {
    if (detectInfo) detectInfo.textContent = `Error: ${e.message}`;
  } finally { btn.disabled = false; btn.textContent = "Detect sections"; }
}
async function doExport() {
  if (!S.project) return;
  if (!S.tl.clips.length) return alert("The timeline is empty.");
  const btn = document.getElementById("exportBtn");
  if (!btn) return;
  btn.disabled = true; btn.textContent = "Starting…";
  const jobError = document.getElementById("jobError");
  if (jobError) jobError.hidden = true;
  const exportInfo = document.getElementById("exportInfo");
  if (exportInfo) exportInfo.textContent = "";
  try {
    const mode = document.getElementById("xCaptions").value;
    const job = await api("/api/export/timeline", {
      method: "POST",
      body: JSON.stringify({
        output: document.getElementById("xOutput").value.trim(),
        opts: collectOpts(),
        timeline: S.tl,
        caption_mode: mode,
        caption_style: ["burn", "both"].includes(mode) ? { ...CAPPOS } : {},
      }),
    });
    S.job = job;
    const progWrap = document.getElementById("progWrap");
    if (progWrap) progWrap.hidden = false;
    const cap = job.captions ? ` · captions: ${job.captions.cues} cue(s)` + (job.captions.burned ? " burned in" : "") + (job.captions.positioned ? " at your preview position" : "") + ` → ${job.captions.srt.split(/[\\/]/).pop()}` : "";
    if (exportInfo) exportInfo.textContent = (job.note ? `⚠ ${job.note} ` : "") + `Job ${job.id} · ${job.kind} · ${job.segments} clip(s) → ${job.output}` + cap;
    pollJob(job.id);
  } catch (e) {
    if (jobError) { jobError.hidden = false; jobError.textContent = e.message; }
    btn.disabled = false; btn.textContent = "Export clean cut";
  }
}

/* ---------- caption overlay helpers needed before app.js loads ---------- */
function capActiveCuesAt(t) { return S.capCues.filter((c) => c.start <= t && t <= c.end); }
function capActiveCue() {
  const act = capActiveCuesAt(playheadTime());
  return act.find((c) => c.id === S.capSel) || act[0] || null;
}

/* ---------- overlay caption editing (dbl-click a caption on the preview) ---------- */
function startOverlayCaptionEdit() {
  if (CAP_EDITING) return;
  const cue = capActiveCue();
  if (!cue) return;
  CAP_EDITING = true;
  pausePlayback();
  const box = document.getElementById("capBox"), textEl = document.getElementById("capBoxText");
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
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      // CapCut-style: Enter splits the caption at the caret. (Shift+Enter
      // still inserts a line break inside the caption text.)
      const raw = ta.value;
      const norm = raw.replace(/\s+/g, " ");
      const caret = ta.selectionStart;
      const frac = norm.length ? clamp01(caret / norm.length) : 0.5;
      const live = S.tl.caps.find((c) => c.id === cue.id);
      if (live && norm.trim() !== (cue.text || "")) live.text = norm.trim();
      const next = live ? TLM.splitCaption(S.tl, live.id, frac) : null;
      if (next && next !== S.tl) {
        S.tl = next;
        done = true; CAP_EDITING = false;
        ta.remove();
        textEl.style.visibility = "";
        textEl.dataset.raw = live ? (live.text || "") : (cue.text || "");
        commitTL(); refresh();
        status("Caption split at the cursor (CapCut-style).");
      } else {
        if (live) { textEl.dataset.raw = live.text || ""; commitTL(); }
        done = true; CAP_EDITING = false;
        ta.remove(); textEl.style.visibility = ""; refresh();
        if (live) status("Caption is too short to split.");
      }
      return;
    }
    if (ev.key === "Escape") finish(false);
  });
  ta.addEventListener("blur", () => {
    setTimeout(() => { if (!done && document.activeElement !== ta) finish(true); }, 0);
  });
}

/* ---------- project open ---------- */
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
  const subInfo = document.getElementById("subInfo");
  if (subInfo) subInfo.textContent = data.demo_subtitles ? "Bundled demo subtitles ready" : "";
  const dSubPath = document.getElementById("dSubPath");
  if (dSubPath) dSubPath.value = data.demo_subtitles || "";
  const pathInput = document.getElementById("pathInput");
  if (pathInput) pathInput.value = data.info.path;
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
  const fileMeta = document.getElementById("fileMeta");
  if (fileMeta) fileMeta.textContent =
    `${v.width}×${v.height} · ${v.codec} · ${v.fps} fps · ` +
    `${fmtBytes(v.bitrate_bps * 0.125)}/s video` +
    (a ? ` · ${a.codec} ${a.channels}ch ${a.sample_rate}Hz` : " · no audio") +
    ` · ${fmtTime(S.duration, false)} · ${fmtBytes(data.info.size_bytes)}`;

  applyProfile(data.profile);
  defaultOutput();
  resetCaptionCard();
  const detectInfo = document.getElementById("detectInfo");
  if (detectInfo) detectInfo.textContent = "";
  const exportBtn = document.getElementById("exportBtn");
  if (exportBtn) exportBtn.disabled = true;
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

/* ---------- bind timeline (replace old bindTimeline/bindTools/bindTimelineTools) ---------- */
function bindTimeline() {
  bindTray();
  bindZoomPan();
  bindKeys();
  bindPlayer();
  bindList();
  // transport buttons (old tool rail is gone; these live by the preview)
  document.getElementById("playBtn")?.addEventListener("click", togglePlay);
  document.getElementById("frameBack")?.addEventListener("click", () => stepFrame(-1));
  document.getElementById("frameFwd")?.addEventListener("click", () => stepFrame(1));
  // ruler sync: headers ride along on scroll
  const sc = document.getElementById("scroll");
  if (sc) {
    sc.addEventListener("scroll", () => {
      const hrows = document.getElementById("hrows");
      if (hrows) hrows.style.transform = `translateY(${-sc.scrollTop}px)`;
    });
  }
  // viewport height handle already bound via app.js, but we add double-click reset here too
  const handle = document.getElementById("tlResizeHandle");
  if (handle) {
    handle.addEventListener("dblclick", () => {
      const vp = document.getElementById("scroll");
      if (vp) vp.style.height = "";
      status("timeline viewing area: auto height");
      if (typeof saveWorkspaceLayout === "function") saveWorkspaceLayout();
    });
  }
}
function bindTools() { /* old tool rail gone; kept for compat */ }
function bindTimelineTools() {
  // legacy buttons no longer exist; keep no-op but wire new equivalents already via bindTray
}

/* ---------- boot wiring ---------- */
function bindUI() {
  // original bindUI from old timeline.js is now split; we keep a wrapper for app.js boot compatibility
  // app.js calls bindTimelineViewportResize() etc; we override those via patching after load
  const openBtn = document.getElementById("openBtn");
  if (openBtn) openBtn.onclick = () => openPath(document.getElementById("pathInput").value.trim());
  const demoBtn = document.getElementById("demoBtn");
  if (demoBtn) demoBtn.onclick = async () => {
    const fm = document.getElementById("fileMeta");
    if (fm) fm.textContent = "opening demo…";
    try { await onProjectOpen(await api("/api/demo", { method: "POST", body: "{}" })); } catch (e) { if (fm) fm.textContent = ""; alert(e.message); }
  };
  const speechBtn = document.getElementById("speechDemoBtn");
  if (speechBtn) speechBtn.onclick = async () => {
    const fm = document.getElementById("fileMeta");
    if (fm) fm.textContent = "opening speech demo…";
    try { await onProjectOpen(await api("/api/demo/speech", { method: "POST", body: "{}" })); } catch (e) { if (fm) fm.textContent = ""; alert(e.message); }
  };
  const pathInput = document.getElementById("pathInput");
  if (pathInput) pathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") openPath(e.target.value.trim()); });
  const modal = document.getElementById("browserModal");
  if (modal) {
    const browseBtn = document.getElementById("browseBtn");
    if (browseBtn) browseBtn.onclick = () => openBrowserFor("open");
    const close = document.getElementById("browserClose");
    if (close) close.onclick = () => { modal.hidden = true; };
    modal.onclick = (e) => { if (e.target.id === "browserModal") modal.hidden = true; };
  }
  const uploadInput = document.getElementById("uploadInput");
  if (uploadInput) uploadInput.onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const fd = new FormData(); fd.append("file", f);
    const fm = document.getElementById("fileMeta");
    if (fm) fm.textContent = `uploading ${fmtBytes(f.size)}…`;
    try { await onProjectOpen(await api("/api/upload", { method: "POST", body: fd })); } catch (err) { alert(err.message); if (fm) fm.textContent = ""; }
  };
  const dSubFile = document.getElementById("dSubFile");
  if (dSubFile) dSubFile.onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const fd = new FormData(); fd.append("file", f);
    try {
      const data = await api("/api/parse-subtitles", { method: "POST", body: fd });
      S.subsText = null;
      document.getElementById("dSubPath").value = data.saved_path || "";
      const subInfo = document.getElementById("subInfo");
      if (subInfo) subInfo.textContent = `${data.count} cues loaded (${f.name}) — editable`;
      const dCues = document.getElementById("dCues"); if (dCues) dCues.checked = true;
      updateCaptionExportInfo();
    } catch (err) { alert(err.message); }
  };
  const detectBtn = document.getElementById("detectBtn");
  if (detectBtn) detectBtn.onclick = runDetect;
  const capBtn = document.getElementById("capBtn");
  if (capBtn) capBtn.onclick = startCaption;
  const capCancel = document.getElementById("capCancel");
  if (capCancel) capCancel.onclick = cancelCaption;
  const capUse = document.getElementById("capUse");
  if (capUse) capUse.onclick = useCaptions;
  const capNewBtn = document.getElementById("capNewBtn");
  if (capNewBtn) capNewBtn.onclick = newBlankCaptions;
  const capOpenSrtBtn = document.getElementById("capOpenSrtBtn");
  if (capOpenSrtBtn) capOpenSrtBtn.onclick = openCaptionsFile;
  const capAddCue = document.getElementById("capAddCue");
  if (capAddCue) capAddCue.onclick = addCueRow;
  const capRevert = document.getElementById("capRevert");
  if (capRevert) capRevert.onclick = revertCues;
  const capSave = document.getElementById("capSave");
  if (capSave) capSave.onclick = () => saveCues(false);
  if (typeof bindCaptionOverlay === "function") bindCaptionOverlay();
  const xCaptions = document.getElementById("xCaptions");
  if (xCaptions) xCaptions.addEventListener("change", updateCaptionExportInfo);
  const dSubPath = document.getElementById("dSubPath");
  if (dSubPath) dSubPath.addEventListener("input", updateCaptionExportInfo);
  updateCaptionExportInfo();
  const capCueBody = document.getElementById("capCueBody");
  if (capCueBody) capCueBody.addEventListener("click", (ev) => {
    const del = ev.target.closest(".cue-del");
    if (!del) return;
    del.closest("tr").remove(); renumberCues();
  });
  const cEngine = document.getElementById("cEngine");
  if (cEngine) cEngine.addEventListener("change", updateEngineUI);
  const wDlBtn = document.getElementById("wDlBtn");
  if (wDlBtn) wDlBtn.onclick = downloadWcppModel;
  const capRecheck = document.getElementById("capRecheck");
  if (capRecheck) capRecheck.onclick = async () => {
    capRecheck.disabled = true; capRecheck.textContent = "Checking…";
    await loadEnv();
    capRecheck.disabled = false; capRecheck.textContent = "Re-check for faster-whisper";
  };
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.onclick = () => {
      const k = chip.dataset.kind;
      chip.classList.toggle("on");
      if (chip.classList.contains("on")) S.filter.kinds.add(k); else S.filter.kinds.delete(k);
      renderList(); renderTray(); renderLanes();
    };
  });
  const minDur = document.getElementById("minDur");
  if (minDur) minDur.oninput = (e) => { S.filter.minDur = Number(e.target.value) || 0; renderList(); };
  const searchBox = document.getElementById("searchBox");
  if (searchBox) searchBox.oninput = (e) => { S.filter.q = e.target.value; renderList(); };
  const xMode = document.getElementById("xMode");
  if (xMode) xMode.onchange = syncQualityRows;
  const xQuality = document.getElementById("xQuality");
  if (xQuality) xQuality.onchange = syncQualityRows;
  const resetOpts = document.getElementById("resetOpts");
  if (resetOpts) resetOpts.onclick = () => { if (S.project) { applyProfile(S.project.profile); defaultOutput(); } };
  const exportBtn = document.getElementById("exportBtn");
  if (exportBtn) exportBtn.onclick = doExport;
  window.addEventListener("resize", () => { if (S.project) draw(); });
  bindTimeline();
  // old bindTimelineTools/ bindTools are no-ops
}

/* app.js owns applyTimelineViewportHeight / bindTimelineViewportResize /
 * saveWorkspaceLayout and already targets #scroll + #tlResizeHandle + S.laneH.
 * bindUI() (called from app.js boot) wires everything here. */
