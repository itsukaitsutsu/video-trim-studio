/* Program Monitor — Premiere-Pro-style transport, timecode, overlays, scopes.
 *
 * This module is the "monitor brain" that sits on top of stage.js (which is
 * only the compositor).  It owns:
 *
 *   1. transport      J/K/L shuttle (1x/2x/4x/8x both directions), playback
 *                     speed menu, loop, Mark In/Out (I/O), Play In to Out,
 *                     Home/End, markers (M), jump to previous/next marker
 *   2. timecode       click-to-type, timecode / frames / seconds, elapsed or
 *                     remaining, dropped-frame + fps read-out
 *   3. playback       Full .. 1/16 playback and paused resolution, High Quality
 *   4. overlays       action (10%) / title (20%) safe margins, optional 4:3 box,
 *                     custom margin, centre crosshair, rule-of-thirds, alpha
 *   5. audio          L/R meters off the real program mix, monitor volume + mute
 *   6. scopes         waveform, RGB parade, vectorscope, histogram, sampled from
 *                     the composited program frame
 *   7. frame          Export Frame to a full-resolution PNG, panel gear menu,
 *                     button editor, fullscreen
 *
 * Everything that needs pixels (reduced-resolution playback, alpha view, the
 * scopes and Export Frame) goes through monDrawComposite(), which re-draws the
 * same clip stack stage.js is showing into a 2D canvas.  That keeps the feature
 * honest: what the scopes measure and what Export Frame writes is the actual
 * composite, not a DOM guess.
 */
"use strict";

/* ------------------------------------------------------------------ state */

const MON_KEY = "video-trim-studio.monitor.v1";

const MON_RES = [
  { v: 1, label: "Full", short: "Full" },
  { v: 0.5, label: "1/2", short: "1/2" },
  { v: 0.25, label: "1/4", short: "1/4" },
  { v: 0.125, label: "1/8", short: "1/8" },
  { v: 0.0625, label: "1/16", short: "1/16" },
];

const MON_SPEEDS = [0.1, 0.25, 0.5, 1, 1.5, 2, 4, 8];
const MON_JKL = [1, 2, 4, 8];

const MON_DEFAULTS = {
  playRes: 1, pausedRes: 1, hq: true,
  // Off by default, like Premiere: safe margins are something you turn on.
  safeAction: false, safeTitle: false, safeFour3: false, safeCustom: 0,
  guideCenter: false, guideThirds: false,
  alpha: false,
  tcMode: "tc", tcRemain: false,
  loop: false,
  meters: true, volume: 100, muted: false,
  scopes: false,
  hidden: "",
  marks: {},     // project path -> [{id, t, name}]
  inOut: {},     // project path -> { i, o }
  scopesOn: true,
};

const MON = Object.assign({}, MON_DEFAULTS, monLoad());
MON.rate = 1;                       // not persisted: always start at 1x
if (!Array.isArray(MON.hidden)) MON.hidden = [];
if (!MON.marks || typeof MON.marks !== "object") MON.marks = {};
if (!MON.inOut || typeof MON.inOut !== "object") MON.inOut = {};

function monLoad() {
  try {
    const raw = localStorage.getItem(MON_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch (_) { return {}; }
}
function monStore() {
  try { localStorage.setItem(MON_KEY, JSON.stringify(MON)); } catch (_) { /* private mode */ }
}

/* --------------------------------------------------------------- helpers */

function monFps() {
  const v = (S.project && S.project.info && S.project.info.video) || {};
  const fps = Number(v.fps) || Number(S.project && S.project.profile && S.project.profile.fps) || 30;
  return Math.max(1, Math.round(fps * 1000) / 1000);
}
function monFpsInt() { return Math.max(1, Math.round(monFps())); }

/** Project frame size — what Export Frame writes and what resolutions divide. */
function monFrameSize() {
  const v = (S.project && S.project.info && S.project.info.video) || {};
  const pr = (S.project && S.project.profile) || {};
  const w = Math.round(Number(pr.output_width) || Number(v.width) || 1920);
  const h = Math.round(Number(pr.output_height) || Number(v.height) || 1080);
  return { w: Math.max(16, w), h: Math.max(9, h) };
}

function monProjKey() {
  if (!S.project) return "_";
  return String(S.project.path || (S.project.info && S.project.info.path) || "_");
}
function monMarks() {
  const k = monProjKey();
  if (!Array.isArray(MON.marks[k])) MON.marks[k] = [];
  return MON.marks[k];
}
function monInOut() {
  const k = monProjKey();
  if (!MON.inOut[k] || typeof MON.inOut[k] !== "object") MON.inOut[k] = { i: null, o: null };
  return MON.inOut[k];
}
const monClamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const monPad = (n, w = 2) => String(Math.floor(n)).padStart(w, "0");

/** 00:00:00:00-style timecode, frame-exact at the project frame rate. */
function monTC(t) {
  const fps = monFpsInt();
  let frames = Math.round((Number(t) || 0) * fps);
  if (frames < 0) frames = 0;
  const ff = frames % fps;
  const totalSec = Math.floor(frames / fps);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  return `${monPad(hh)}:${monPad(mm)}:${monPad(ss)}:${monPad(ff)}`;
}
function monFrames(t) { return String(Math.round((Number(t) || 0) * monFpsInt())); }
function monSeconds(t) { return (Number(t) || 0).toFixed(2); }

/** The displayed value of a time, in the user's chosen timecode mode. */
function monFmt(t, mode = MON.tcMode) {
  if (mode === "frames") return `${monFrames(t)} f`;
  if (mode === "seconds") return `${monSeconds(t)} s`;
  return monTC(t);
}
/** Plain (unit-less) value used while the timecode box is being typed in. */
function monFmtRaw(t, mode = MON.tcMode) {
  if (mode === "frames") return monFrames(t);
  if (mode === "seconds") return monSeconds(t);
  return monTC(t);
}

/** Parse anything a user may type in the timecode box back to seconds.
 *  Accepts 01:02:03:04 (tc), 02:03:04 (mm:ss:ff), 02:03 (mm:ss),
 *  1234f (frames), 12.5s / 12.5 (seconds) and +2/-2 (relative seconds). */
function monParseTC(text, current) {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return null;
  const fps = monFpsInt();
  if (/^[+-]/.test(raw) && !raw.includes(":")) {
    const n = Number(raw.slice(1));
    if (!Number.isFinite(n)) return null;
    return Math.max(0, (current || 0) + (raw[0] === "-" ? -n : n));
  }
  let m = raw.match(/^(\d+)\s*f(?:rames?)?$/);
  if (m) return Number(m[1]) / fps;
  m = raw.match(/^(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?$/);
  if (m) return Number(m[1]);
  if (raw.includes(":")) {
    const parts = raw.split(":").map((x) => Number(x) || 0);
    while (parts.length < 4) parts.unshift(0);
    const [hh, mm, ss, ff] = parts.slice(-4);
    return hh * 3600 + mm * 60 + ss + ff / fps;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // A bare number means seconds in timecode mode, and the raw unit otherwise.
  return MON.tcMode === "frames" ? n / fps : n;
}

/* ------------------------------------------------------------------ icons */

const MON_PATHS = {
  skipStart: '<path d="M19 20 9 12l10-8z"/><path d="M5 4v16"/>',
  skipEnd: '<path d="M5 4l10 8-10 8z"/><path d="M19 4v16"/>',
  play: '<path d="M6 3.5 20 12 6 20.5z"/>',
  pause: '<path d="M8 4v16M16 4v16"/>',
  stepBack: '<path d="M18 5v14"/><path d="M15 12 7 6v12z"/>',
  stepFwd: '<path d="M6 5v14"/><path d="M9 12l8-6v12z"/>',
  markIn: '<path d="M7 4v16"/><path d="M11 12h10"/><path d="m17 8 4 4-4 4"/>',
  markOut: '<path d="M17 4v16"/><path d="M3 12h10"/><path d="m7 8-4 4 4 4"/>',
  playInOut: '<path d="M3 5v14"/><path d="M21 5v14"/><path d="M8 12l6-4.5v9z"/>',
  marker: '<path d="M6 3v18"/><path d="M6 4h11l-2.2 4L17 12H6z"/>',
  prevMark: '<path d="M6 3v18"/><path d="m17 5-8 7 8 7z"/>',
  nextMark: '<path d="M18 3v18"/><path d="m7 5 8 7-8 7z"/>',
  loop: '<path d="m17 2 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  vol: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  volx: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a1.7 1.7 0 0 0-1.6-1H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 3 8.6a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 8 3V3a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 20.4 9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  full: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  fullExit: '<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/>',
  camera: '<path d="M4 7h3l2-2h6l2 2h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>',
  scopes: '<path d="M3 3v18h18"/><path d="M6 15c2-6 3 3 5-2s2 4 4-1 2 2 4-3"/>',
};

function monIcon(name) {
  const d = MON_PATHS[name] || "";
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

/* --------------------------------------------------------------- buttons */

const MON_BUTTONS = [
  { id: "mnStart", icon: "skipStart", label: "Go to start (Home)", act: () => monGoto(0) },
  { id: "mnPrevMark", icon: "prevMark", label: "Previous marker (,)", act: () => monJumpMarker(-1) },
  { id: "mnMarkIn", icon: "markIn", label: "Mark In (I) — Alt+click to clear", act: (ev) => ev.altKey ? monClearIn() : monMarkIn() },
  { id: "mnMarkOut", icon: "markOut", label: "Mark Out (O) — Alt+click to clear", act: (ev) => ev.altKey ? monClearOut() : monMarkOut() },
  { id: "mnPlayInOut", icon: "playInOut", label: "Play In to Out (Shift+Space)", act: () => monPlayInOut() },
  { id: "frameBack", icon: "stepBack", label: "Previous frame (Left arrow)", act: () => stepFrame(-1) },
  { id: "playBtn", icon: "play", label: "Play / pause (Space)", act: () => togglePlay(), fixed: true },
  { id: "frameFwd", icon: "stepFwd", label: "Next frame (Right arrow)", act: () => stepFrame(1) },
  { id: "mnNextMark", icon: "nextMark", label: "Next marker (.)", act: () => monJumpMarker(1) },
  { id: "mnEnd", icon: "skipEnd", label: "Go to end (End)", act: () => monGoto(timelineEnd()) },
  { id: "mnMarker", icon: "marker", label: "Add marker (M)", act: () => monAddMarker() },
  { id: "mnLoop", icon: "loop", label: "Loop playback", act: () => monToggleLoop(), toggle: () => MON.loop },
  { id: "mnMute", icon: "vol", label: "Mute the monitor (Shift+M is lane mute)", act: () => monToggleMute(), toggle: () => !MON.muted },
  { id: "mnScopes", icon: "scopes", label: "Show scopes", act: () => monToggleScopes(), toggle: () => MON.scopes },
  { id: "mnFull", icon: "full", label: "Fullscreen monitor (Ctrl+`)", act: () => monToggleFullscreen() },
  { id: "mnGear", icon: "gear", label: "Program Monitor settings", act: () => monToggleMenu(), fixed: true },
  { id: "mnFrame", icon: "camera", label: "Export frame as PNG (Ctrl+Shift+E)", act: () => monExportFrame() },
];

/* ------------------------------------------------------------------- init */

let monReady = false;

function monInit() {
  if (monReady) return;
  monReady = true;
  monBuildBar();
  monWireBar();
  monBuildGuides();
  monBindKeys();
  monBindGlobal();
  monApplyOverhead();
  monPaintTC();
  monPaintInfo();
  monSyncButtons();
}

function monBuildBar() {
  const bar = $("monBar");
  if (!bar) return;
  const hidden = new Set(MON.hidden);
  MON_BUTTONS.forEach((b) => {
    const el = $(b.id);
    if (!el) return;
    if (!el.dataset.monIcon) { el.innerHTML = monIcon(b.icon); el.dataset.monIcon = "1"; }
    el.title = b.label;
    el.setAttribute("aria-label", b.label);
    el.hidden = !b.fixed && hidden.has(b.id);
    el.classList.toggle("on", !!(b.toggle && b.toggle()));
  });

  const sp = $("mnSpeed");
  if (sp && !sp.options.length) {
    const rev = MON_SPEEDS.filter((v) => Number.isInteger(v)).slice().reverse();
    sp.innerHTML = [
      ...rev.map((v) => `<option value="-${v}">−${v}×</option>`),
      ...MON_SPEEDS.map((v) => `<option value="${v}">${v}×</option>`),
    ].join("");
  }
  if (sp) sp.value = String(MON.rate);
}

/** Event wiring for the bar — once, no matter how often the bar is rebuilt. */
function monWireBar() {
  const bar = $("monBar");
  if (!bar || bar.dataset.monWired) return;
  bar.dataset.monWired = "1";

  bar.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-mon-act]");
    if (!b) return;
    const def = MON_BUTTONS.find((x) => x.id === b.dataset.monAct);
    if (def && def.act) { ev.preventDefault(); def.act(ev); }
  });

  const sp = $("mnSpeed");
  if (sp) {
    sp.addEventListener("change", () => {
      const v = Number(sp.value) || 1;
      monSetRate(v);
      status(`playback ${v}×`);
    });
  }

  const tc = $("timecode");
  if (tc) {
    tc.addEventListener("click", () => monEditTC());
    tc.addEventListener("contextmenu", (ev) => { ev.preventDefault(); monCycleTCMode(); });
  }

  const zl = $("videoZoomLevel");
  if (zl) {
    zl.addEventListener("click", () => monZoomMenu(zl));
    zl.addEventListener("contextmenu", (ev) => { ev.preventDefault(); monZoomMenu(zl); });
    zl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); monZoomMenu(zl); }
    });
  }
  monBindTransportOnce();
}

/** Bind the three buttons timeline.js used to own (single owner, no doubling). */
function monBindTransportOnce() {
  ["playBtn", "frameBack", "frameFwd"].forEach((id) => {
    const b = $(id);
    if (!b || b.dataset.monBound) return;
    b.dataset.monBound = "1";
    b.addEventListener("click", () => {
      if (id === "playBtn") togglePlay();
      else stepFrame(id === "frameBack" ? -1 : 1);
    });
  });
}

function monSyncButtons() {
  const b = $("mnLoop"); if (b) b.classList.toggle("on", !!MON.loop);
  const m = $("mnMute");
  if (m) {
    m.classList.toggle("on", !!MON.muted);
    m.innerHTML = monIcon(MON.muted ? "volx" : "vol");
  }
  const s = $("mnScopes"); if (s) s.classList.toggle("on", !!MON.scopes);
  const f = $("mnFull"); if (f) f.innerHTML = monIcon(document.fullscreenElement ? "fullExit" : "full");
  const sp = $("mnSpeed");
  if (sp && Math.abs(Number(sp.value) - MON.rate) > 1e-6) {
    const want = String(MON.rate);
    if ([...sp.options].some((o) => o.value === want)) sp.value = want;
  }
}

/* -------------------------------------------------------------- transport */

function monGoto(t) {
  pausePlayback();
  setPlayhead(Math.max(0, Math.min(t, Math.max(timelineEnd(), 0))));
}

function monSetRate(rate) {
  MON.rate = Number(rate) || 1;
  monSyncButtons();
  if (MON.rate !== 0) {
    if (!PV.playing) startPlayback();
    else { PV.last = performance.now(); }
  } else if (PV.playing) {
    pausePlayback();
  }
}

function monToggleLoop() {
  MON.loop = !MON.loop;
  monStore(); monSyncButtons();
  status(MON.loop ? "loop playback on" : "loop playback off");
}

function monShuttle(dir) {
  // Repeat presses step 1x → 2x → 4x → 8x in the pressed direction.
  const cur = MON.rate;
  const sign = dir > 0 ? 1 : -1;
  let mag = Math.abs(cur);
  if (Math.sign(cur) !== sign) mag = 0;
  const idx = MON_JKL.indexOf(mag);
  const next = idx < 0 ? 1 : MON_JKL[Math.min(MON_JKL.length - 1, idx + 1)];
  monSetRate(sign * next);
  status(`playback ${sign > 0 ? "" : "reverse "}${next}×`);
}

function monStopShuttle() {
  MON.rate = 0;
  pausePlayback();
  status("paused");
  monSyncButtons();
}

/* ---- in / out ---------------------------------------------------------- */

function monMarkIn() {
  const io = monInOut();
  io.i = playheadTime();
  if (io.o != null && io.o <= io.i) io.o = null;
  monStore(); monPaintInfo(); draw();
  status(`mark in at ${monFmt(io.i)}`);
}
function monMarkOut() {
  const io = monInOut();
  io.o = playheadTime();
  if (io.i != null && io.i >= io.o) io.i = null;
  monStore(); monPaintInfo(); draw();
  status(`mark out at ${monFmt(io.o)}`);
}
function monClearIn() { monInOut().i = null; monStore(); draw(); monPaintInfo(); status("mark in cleared"); }
function monClearOut() { monInOut().o = null; monStore(); draw(); monPaintInfo(); status("mark out cleared"); }
function monClearInOut() {
  const io = monInOut(); io.i = null; io.o = null;
  monStore(); draw(); monPaintInfo(); status("in/out cleared");
}

function monPlayInOut() {
  const io = monInOut();
  if (io.i == null && io.o == null) return status("Set an In point (I) or an Out point (O) first.");
  pausePlayback();
  setPlayhead(io.i != null ? io.i : 0, false);
  MON.rate = 1;
  monSyncButtons();
  startPlayback();
}

/** Called from pvTick: stop/loop at the Out point (or the sequence end). */
function monPlaybackGate(t) {
  const io = monInOut();
  const end = Math.max(timelineEnd(), 0.001);
  const stop = io.o != null ? Math.min(io.o, end) : end;
  const start = io.i != null ? Math.max(0, io.i) : 0;
  if (MON.rate >= 0) {
    if (t >= stop - 1e-6) {
      if (MON.loop) return { action: "loop", t: start };
      return { action: "stop", t: stop };
    }
  } else if (t <= start + 1e-6) {
    if (MON.loop) return { action: "loop", t: stop };
    return { action: "stop", t: start };
  }
  return { action: "go" };
}

/* ---- markers ----------------------------------------------------------- */

function monAddMarker() {
  if (!S.project) return status("Open a project first.");
  const t = playheadTime();
  const marks = monMarks();
  const near = marks.find((m) => Math.abs(m.t - t) < 0.5 / monFpsInt());
  if (near) {
    // Pressing M on an existing marker removes it, like toggling.
    marks.splice(marks.indexOf(near), 1);
    status("marker removed");
  } else {
    const name = window.prompt("Marker name", `Marker ${marks.length + 1}`);
    if (name === null) return;                  // cancelled: keep nothing
    marks.push({ id: `m${Date.now().toString(36)}`, t, name: name || `Marker ${marks.length + 1}` });
    marks.sort((a, b) => a.t - b.t);
    status(`marker added at ${monFmt(t)}`);
  }
  monStore(); draw(); monPaintInfo();
}

function monJumpMarker(dir) {
  const marks = monMarks();
  if (!marks.length) return status("No markers yet — press M to add one.");
  const t = playheadTime();
  const eps = 1e-4;
  const pool = dir > 0
    ? marks.filter((m) => m.t > t + eps)
    : marks.filter((m) => m.t < t - eps).reverse();
  const next = pool[0] || (dir > 0 ? marks[0] : marks[marks.length - 1]);
  setPlayhead(next.t);
  status(`${next.name || "marker"} · ${monFmt(next.t)}`);
}

function monRenameMarker(m) {
  const name = window.prompt("Marker name", m.name || "");
  if (name == null) return;
  m.name = name;
  monStore(); draw();
}
function monDeleteMarker(m) {
  const marks = monMarks();
  const idx = marks.indexOf(m);
  if (idx >= 0) marks.splice(idx, 1);
  monStore(); draw(); monPaintInfo();
  status("marker deleted");
}

/** Draw in/out shading and marker flags into the timeline ruler. */
function monRenderRulerMarks(ruler) {
  if (!ruler || !S.project) return;
  const k = monProjKey();
  const io = MON.inOut[k] || {};
  const marks = Array.isArray(MON.marks[k]) ? MON.marks[k] : [];
  if (io.i == null && io.o == null && !marks.length) return;
  const pps = pxPerSec();

  const layer = document.createElement("div");
  layer.className = "mon-marks";

  if (io.i != null || io.o != null) {
    const a = io.i != null ? io.i : 0;
    const b = io.o != null ? io.o : timelineEnd();
    const band = document.createElement("div");
    band.className = "mon-io";
    band.style.left = `${Math.round(a * pps)}px`;
    band.style.width = `${Math.max(2, Math.round((b - a) * pps))}px`;
    band.title = `In ${io.i != null ? monFmt(io.i) : "start"} → Out ${io.o != null ? monFmt(io.o) : "end"}`;
    layer.appendChild(band);
    [[io.i, "i"], [io.o, "o"]].forEach(([t, kind]) => {
      if (t == null) return;
      const flag = document.createElement("div");
      flag.className = `mon-ioflag ${kind}`;
      flag.style.left = `${Math.round(t * pps)}px`;
      flag.title = `${kind === "i" ? "In" : "Out"} ${monFmt(t)}`;
      layer.appendChild(flag);
    });
  }

  marks.forEach((m) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mon-mark";
    b.style.left = `${Math.round(m.t * pps)}px`;
    b.title = `${m.name || "Marker"} — ${monFmt(m.t)}\nclick: go · double-click: rename · right-click: delete`;
    b.innerHTML = `<svg viewBox="0 0 8 10" aria-hidden="true"><path d="M0 0h8v7L4 10 0 7z"/></svg>`;
    b.addEventListener("mousedown", (ev) => ev.stopPropagation());
    b.addEventListener("click", (ev) => { ev.stopPropagation(); setPlayhead(m.t); });
    b.addEventListener("dblclick", (ev) => { ev.stopPropagation(); monRenameMarker(m); });
    b.addEventListener("contextmenu", (ev) => { ev.preventDefault(); ev.stopPropagation(); monDeleteMarker(m); });
    layer.appendChild(b);
  });

  ruler.appendChild(layer);
}

/* --------------------------------------------------------------- timecode */

function monPaintTC() {
  const el = $("timecode");
  if (!el || el.dataset.editing) return;
  if (!S.project) { el.textContent = "--:--:--:--"; return; }
  const t = playheadTime();
  const end = timelineEnd();
  const head = monFmt(t);
  const tail = MON.tcRemain ? `−${monFmt(Math.max(0, end - t))}` : monFmt(end);
  const text = `${head} / ${tail}`;
  if (el.textContent !== text) {
    el.textContent = text;
    el.title = `Current ${monTC(t)} · sequence ${monTC(end)}\n` +
      `Click to type · right-click to switch timecode / frames / seconds`;
  }
}

function monCycleTCMode() {
  const order = ["tc", "frames", "seconds"];
  MON.tcMode = order[(order.indexOf(MON.tcMode) + 1) % order.length];
  monStore(); monPaintTC(); monPaintInfo();
  status(`timecode display: ${MON.tcMode === "tc" ? "timecode" : MON.tcMode}`);
}

function monEditTC() {
  const el = $("timecode");
  if (!el || !S.project || el.dataset.editing) return;
  el.dataset.editing = "1";
  const old = el.textContent;
  const input = document.createElement("input");
  input.className = "mon-tc-input";
  input.value = monFmtRaw(playheadTime());
  input.setAttribute("aria-label", "Type a timecode");
  el.textContent = "";
  el.appendChild(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) {
      const t = monParseTC(input.value, playheadTime());
      if (t != null && Number.isFinite(t)) setPlayhead(t);
      else status(`couldn't read “${input.value}” as a time`);
    }
    delete el.dataset.editing;
    el.textContent = old;
    monPaintTC();
  };
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
    else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}

/* ------------------------------------------------------------- frame info */

const MON_STATS = { dropped: 0, frames: 0, win: [], lastNow: 0, skip: 0 };

function monCountFrame(dt) {
  // The first frames after a start carry the setup stall; don't blame the user
  // for a dropped frame the click caused.
  if (MON_STATS.skip > 0) { MON_STATS.skip -= 1; dt = 0; }
  const fps = monFps();
  if (dt > 0 && dt < 0.4) {
    const expected = 1 / fps;
    if (dt > expected * 1.6) MON_STATS.dropped += Math.max(1, Math.round(dt * fps) - 1);
  }
  const now = performance.now();
  MON_STATS.win.push(now);
  while (MON_STATS.win.length > 90) MON_STATS.win.shift();
  if (MON_STATS.win.length > 2) {
    const span = MON_STATS.win[MON_STATS.win.length - 1] - MON_STATS.win[0];
    MON_STATS.fps = span > 0 ? (MON_STATS.win.length - 1) * 1000 / span : 0;
  }
  monPaintPlayInfo();
}

function monResLabel(v) {
  const r = MON_RES.find((x) => Math.abs(x.v - v) < 1e-6);
  return r ? r.label : `${v}`;
}

function monQualityFrac(playing) {
  const raw = playing ? Number(MON.playRes) : Number(MON.pausedRes);
  return Math.min(1, Math.max(1 / 32, Number(raw) || 1));
}

let monLastPlayInfo = null;
function monPaintPlayInfo() {
  const el = $("playInfo");
  if (!el) return;
  if (!S.project) { el.textContent = ""; return; }
  const frac = monQualityFrac(PV.playing);
  const bits = [];
  if (PV.playing) {
    bits.push(`${MON.rate < 0 ? "◀" : "▶"} ${Math.abs(MON.rate)}×`);
    if (MON_STATS.fps) bits.push(`${MON_STATS.fps.toFixed(0)} fps`);
  }
  // Idle, the transport already shows the rate; only speak up when the picture
  // is degraded or something went wrong.
  if (frac < 1) bits.push(MON_RES.find((r) => Math.abs(r.v - frac) < 1e-6)?.short || `${frac}`);
  if (MON_STATS.dropped) bits.push(`drop ${MON_STATS.dropped}`);
  if (MON.alpha) bits.push("alpha");
  const text = bits.join(" · ");
  if (text !== monLastPlayInfo) { monLastPlayInfo = text; el.textContent = text; }
}

function monPaintInfo() {
  const el = $("monInfo");
  if (!el) return;
  if (!S.project) { el.textContent = ""; return; }
  const { w, h } = monFrameSize();
  const fps = monFps();
  const io = monInOut();
  const parts = [`${w}×${h}`, `${fps % 1 ? fps.toFixed(2) : fps} fps`];
  parts.push(`play ${monResLabel(monQualityFrac(true))}`);
  if (Math.abs(monQualityFrac(true) - monQualityFrac(false)) > 1e-6)
    parts.push(`paused ${monResLabel(monQualityFrac(false))}`);
  if (MON.hq) parts.push("HQ");
  if (MON_STATS.dropped) parts.push(`${MON_STATS.dropped} dropped`);
  if (io.i != null || io.o != null)
    parts.push(`in ${io.i != null ? monFmt(io.i) : "—"} · out ${io.o != null ? monFmt(io.o) : "—"}`);
  const marks = monMarks().length;
  if (marks) parts.push(`${marks} marker${marks === 1 ? "" : "s"}`);
  el.textContent = parts.join(" · ");
}

/* -------------------------------------------------------------- overlays */

function monBuildGuides() {
  const g = $("monGuides");
  if (!g) return;
  g.innerHTML = `
    <div class="mg mg-action" data-mg="action"></div>
    <div class="mg mg-title" data-mg="title"></div>
    <div class="mg mg-four3" data-mg="four3"></div>
    <div class="mg mg-custom" data-mg="custom"></div>
    <div class="mg mg-center" data-mg="center"><i class="v"></i><i class="h"></i></div>
    <div class="mg mg-thirds" data-mg="thirds">
      <i class="v" style="left:33.333%"></i><i class="v" style="left:66.667%"></i>
      <i class="h" style="top:33.333%"></i><i class="h" style="top:66.667%"></i>
    </div>`;
}

function monApplyOverhead() {
  const g = $("monGuides");
  const stage = $("previewStage");
  if (!g || !stage) return;
  const { w, h } = monFrameSize();
  const aspect = w / h;
  const show = MON.safeAction || MON.safeTitle || MON.safeFour3 || MON.safeCustom > 0 ||
    MON.guideCenter || MON.guideThirds;
  g.hidden = !show;
  const put = (name, on, style) => {
    const el = g.querySelector(`[data-mg="${name}"]`);
    if (!el) return;
    el.hidden = !on;
    if (on && style) Object.assign(el.style, style);
  };
  put("action", MON.safeAction, { inset: "10%" });
  put("title", MON.safeTitle, { inset: "20%" });
  const box = MON.safeCustom > 0 ? Math.min(45, MON.safeCustom) : 0;
  put("custom", box > 0, { inset: `${box}%` });
  // A 4:3 box centred inside the frame: full height when the frame is wider.
  const four3Style = aspect >= 4 / 3
    ? { left: `${(1 - (4 / 3) / aspect) / 2 * 100}%`, right: `${(1 - (4 / 3) / aspect) / 2 * 100}%`, top: "0", bottom: "0" }
    : { top: `${(1 - aspect / (4 / 3)) / 2 * 100}%`, bottom: `${(1 - aspect / (4 / 3)) / 2 * 100}%`, left: "0", right: "0" };
  put("four3", MON.safeFour3, four3Style);
  put("center", MON.guideCenter, {});
  put("thirds", MON.guideThirds, {});
  stage.classList.toggle("mon-alpha", !!MON.alpha);
}

/* ------------------------------------------------------- composite render */

/** Draw the clip stack at the playhead into a 2D context of size W×H.
 *  Mirrors stage.js geometry exactly (same fx numbers), but paints into a
 *  canvas so reduced-resolution playback, scopes, alpha and Export Frame all
 *  see the real composite. */
function monDrawComposite(ctx, W, H, opts = {}) {
  if (!ctx) return false;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (opts.background !== false) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
  }
  const t = playheadTime();
  let drew = false;
  const stack = TLM.clipStackAt(S.tl, t);
  for (const clip of stack) {
    const rec = STAGE.layers.get(clip.id);
    if (!rec) continue;
    const src = rec.media;
    const isImg = src.tagName === "IMG";
    if (isImg && !(src.complete && src.naturalWidth)) continue;
    if (!isImg && (src.readyState < 2 || !src.videoWidth)) continue;
    const fx = TLM.evalFxAt(clip, t);
    const env = TLM.fadeEnv(clip, t);
    const alpha = monClamp01((Number(fx.opacity) || 0) / 100) * monClamp01(env.video);
    if (alpha <= 0.002) continue;

    const s = Math.max(0.01, (Number(fx.scale) || 100) / 100);
    const boxW = s * W, boxH = s * H;
    const boxL = (W - boxW) / 2 + (Number(fx.x) || 0) / 100 * W;
    const boxT = (H - boxH) / 2 + (Number(fx.y) || 0) / 100 * H;

    const cl = Math.min(45, Math.max(0, Number(fx.crop_l) || 0)) / 100;
    const cr = Math.min(45, Math.max(0, Number(fx.crop_r) || 0)) / 100;
    const ct = Math.min(45, Math.max(0, Number(fx.crop_t) || 0)) / 100;
    const cb = Math.min(45, Math.max(0, Number(fx.crop_b) || 0)) / 100;
    const fw = Math.max(0.1, 1 - cl - cr);
    const fh = Math.max(0.1, 1 - ct - cb);

    // The media box is the crop window blown up to the layer box.
    const mbW = boxW / fw, mbH = boxH / fh;
    const mbL = boxL - boxW * (cl / fw);
    const mbT = boxT - boxH * (ct / fh);

    const sw = src.videoWidth || src.naturalWidth || 0;
    const sh = src.videoHeight || src.naturalHeight || 0;
    if (!sw || !sh) continue;

    const fit = fx.fit === "contain" ? "contain" : fx.fit === "cover" ? "cover" : "fill";
    let dW = mbW, dH = mbH, dX = mbL, dY = mbT;
    if (fit !== "fill") {
      const k = fit === "cover" ? Math.max(mbW / sw, mbH / sh) : Math.min(mbW / sw, mbH / sh);
      dW = sw * k; dH = sh * k;
      dX = mbL + (mbW - dW) / 2;
      dY = mbT + (mbH - dH) / 2;
    }

    // Rotate the crop window about its centre; everything after this works in
    // the window's own coordinates (0,0 .. boxW,boxH), exactly like the CSS.
    const rot = Number(fx.rot) || 0;
    const mask = fx.mask && fx.mask.on ? fx.mask : null;
    ctx.save();
    ctx.translate(boxL + boxW / 2, boxT + boxH / 2);
    if (Math.abs(rot) > 0.001) ctx.rotate(rot * Math.PI / 180);
    ctx.translate(-boxW / 2, -boxH / 2);

    const lx = dX - boxL, ly = dY - boxT;
    const paint = (c) => {
      if (MON.hq && c.filter !== undefined) {
        const gt = (v) => 1 + (Number(v) || 0) / 100;
        const look = [Number(fx.brightness), Number(fx.contrast), Number(fx.saturation)];
        c.filter = look.some((v) => Math.abs(v) > 0.001)
          ? `brightness(${gt(fx.brightness)}) contrast(${gt(fx.contrast)}) saturate(${gt(fx.saturation)})`
          : "none";
      }
      try { c.drawImage(src, lx, ly, dW, dH); return true; } catch (_) { return false; }
    };

    // Feather needs a real blur, so the picture goes through an offscreen
    // buffer and the shape is punched into its alpha. Hard-edged masks clip
    // directly - cheaper, and pixel-identical.
    const featherPx = mask ? (Number(mask.feather) || 0) / 100
      * Math.min(mask.w, mask.h) / 200 * Math.min(boxW, boxH) : 0;
    if (mask && featherPx >= 0.6) {
      const bw = Math.max(1, Math.round(boxW)), bh = Math.max(1, Math.round(boxH));
      let buf = monDrawComposite.buf;
      if (!buf) buf = monDrawComposite.buf = document.createElement("canvas");
      if (buf.width !== bw || buf.height !== bh) { buf.width = bw; buf.height = bh; }
      const bc = buf.getContext("2d");
      bc.setTransform(1, 0, 0, 1, 0, 0);
      bc.filter = "none";
      bc.globalCompositeOperation = "source-over";
      bc.globalAlpha = 1;
      bc.clearRect(0, 0, bw, bh);
      const kx = bw / boxW, ky = bh / boxH;
      bc.save(); bc.scale(kx, ky);
      const ok = paint(bc);
      bc.restore();
      if (ok) {
        // Soft edge: punch the blurred shape into the alpha (or, inverted,
        // wipe the blurred shape out of a full frame).
        bc.globalAlpha = 1;
        bc.fillStyle = "#fff";
        bc.globalCompositeOperation = mask.invert ? "destination-out" : "destination-in";
        bc.filter = `blur(${Math.max(0.4, featherPx * (kx + ky) / 2).toFixed(2)}px)`;
        bc.beginPath();
        monMaskPath(bc, mask, bw, bh);
        bc.fill();
        bc.filter = "none";
        bc.globalCompositeOperation = "source-over";
        ctx.globalAlpha = alpha;
        ctx.drawImage(buf, 0, 0, boxW, boxH);
        drew = true;
      }
    } else {
      // Clip to the window, then to the mask (a shape, no soft edge).
      if (mask && mask.invert) {
        // even-odd: the window minus the shape.
        ctx.beginPath();
        ctx.rect(0, 0, boxW, boxH);
        monMaskPath(ctx, mask, boxW, boxH);
        ctx.clip("evenodd");
      } else {
        ctx.beginPath();
        ctx.rect(0, 0, boxW, boxH);
        ctx.clip();
        if (mask) {
          ctx.beginPath();
          monMaskPath(ctx, mask, boxW, boxH);
          ctx.clip();
        }
      }
      ctx.globalAlpha = alpha;
      if (paint(ctx)) drew = true;
    }
    ctx.restore();
  }
  ctx.restore();
  return drew;
}

/** Trace one mask shape in boxW x boxH space. Percentages are of the clip's
 *  own picture, matching vts/fx.py's mask_filter(). */
function monMaskPath(ctx, m, boxW, boxH) {
  const cx = m.x / 100 * boxW, cy = m.y / 100 * boxH;
  const rx = Math.max(0.5, m.w / 200 * boxW), ry = Math.max(0.5, m.h / 200 * boxH);
  if (m.shape === "ellipse") ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  else ctx.rect(cx - rx, cy - ry, rx * 2, ry * 2);
}

/** Is every layer under the playhead showing a decoded frame yet?
 *  A seek settles a frame or two later, and grabbing pixels (or drawing the
 *  reduced-resolution canvas) before that yields a black frame. */
function monFrameReady() {
  if (!S.project) return true;
  const stack = TLM.clipStackAt(S.tl, playheadTime());
  if (!stack.length) return true;          // a gap is legitimately black
  return stack.every((clip) => {
    const rec = STAGE.layers.get(clip.id);
    if (!rec) return false;
    const m = rec.media;
    if (m.tagName === "IMG") return !!(m.complete && m.naturalWidth);
    return m.readyState >= 2 && !m.seeking;
  });
}

/** Run `cb` once the frame at the playhead is available (bounded retries). */
function monWhenFrameReady(cb, tries = 8, delay = 90) {
  if (monFrameReady() || tries <= 0) { cb(); return; }
  setTimeout(() => monWhenFrameReady(cb, tries - 1, delay), delay);
}

/* -------------------------------------------------- playback resolution */

let monLastQualitySig = "";

function monApplyQuality(force) {
  const canvas = $("monCanvas");
  const stage = $("previewStage");
  if (!canvas || !stage) return;
  if (!S.project) {
    if (!canvas.hidden) { canvas.hidden = true; stage.classList.remove("mon-mq"); }
    return;
  }
  const frac = monQualityFrac(PV.playing);
  const alpha = !!MON.alpha;
  const sig = `${frac}|${alpha}`;
  if (!force && sig === monLastQualitySig && !alpha) return;
  monLastQualitySig = sig;

  if (frac >= 1 && !alpha) {
    if (!canvas.hidden) {
      canvas.hidden = true;
      canvas.width = 0; canvas.height = 0;
      ctx0(canvas);
    }
    stage.classList.remove("mon-mq");
    monPaintBadge();
    return;
  }

  const { w, h } = monFrameSize();
  const cw = Math.max(16, Math.round(w * frac));
  const ch = Math.max(9, Math.round(h * frac));
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  const ctx = canvas.getContext("2d");
  if (alpha) {
    // Alpha view: draw the frame into an offscreen buffer, then keep only its
    // alpha and paint it white — a matte, exactly like Premiere's alpha mode.
    let buf = monApplyQuality.buf;
    if (!buf) buf = monApplyQuality.buf = document.createElement("canvas");
    if (buf.width !== cw || buf.height !== ch) { buf.width = cw; buf.height = ch; }
    const bctx = buf.getContext("2d");
    monDrawComposite(bctx, cw, ch, { background: false });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cw, ch);
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(buf, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cw, ch);
    ctx.globalCompositeOperation = "source-over";
  } else {
    monDrawComposite(ctx, cw, ch);
  }
  canvas.hidden = false;
  canvas.style.imageRendering = frac <= 0.25 ? "pixelated" : "auto";
  stage.classList.add("mon-mq");
  monPaintBadge();
  // The frame may still be decoding after a seek: repaint when it lands.
  if (!monFrameReady()) monWhenFrameReady(() => monApplyQuality(true), 8);
}

function ctx0(canvas) {
  try { const c = canvas.getContext("2d"); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, canvas.width, canvas.height); } catch (_) {}
}

function monPaintBadge() {
  const b = $("monBadge");
  if (!b) return;
  if (!S.project) { b.hidden = true; return; }
  const frac = monQualityFrac(PV.playing);
  const txt = MON.alpha ? "ALPHA" : frac < 1 ? monResLabel(frac) : "";
  b.hidden = !txt;
  b.textContent = txt;
}

/* --------------------------------------------------------------- scopes */

const MON_SCOPE = { canvas: null, ctx: null, w: 192, h: 108, last: 0, gain: 1.4, timer: 0 };

function monSampleFrame() {
  if (!MON_SCOPE.canvas) {
    MON_SCOPE.canvas = document.createElement("canvas");
    MON_SCOPE.canvas.width = MON_SCOPE.w;
    MON_SCOPE.canvas.height = MON_SCOPE.h;
    MON_SCOPE.ctx = MON_SCOPE.canvas.getContext("2d", { willReadFrequently: true });
  }
  monDrawComposite(MON_SCOPE.ctx, MON_SCOPE.w, MON_SCOPE.h);
  try { return MON_SCOPE.ctx.getImageData(0, 0, MON_SCOPE.w, MON_SCOPE.h); }
  catch (_) { return null; }
}

function monScopesTick(force) {
  if (!MON.scopes) return;
  const now = performance.now();
  if (!force && now - MON_SCOPE.last < 110) return;
  MON_SCOPE.last = now;
  const img = monSampleFrame();
  if (!img) return;
  monDrawWaveform(img);
  monDrawParade(img);
  monDrawVector(img);
  monDrawHist(img);
}

function monScopeCanvas(id) {
  const c = $(id);
  if (!c) return null;
  const ctx = c.getContext("2d");
  return { c, ctx };
}

function monScopeFrame(ctx, c, title) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#08090c";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = "#1c2331";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = Math.round(c.height * i / 4) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(c.width, y); ctx.stroke();
  }
  return title;
}

function monDrawWaveform(img) {
  const view = monScopeCanvas("scopeWave");
  if (!view) return;
  const { c, ctx } = view;
  monScopeFrame(ctx, c);
  const W = c.width, H = c.height;
  const src = img.data, sw = img.width, sh = img.height;
  const bins = new Uint16Array(W * 256);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4;
      const luma = Math.min(255, Math.max(0, Math.round(
        0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2])));
      const col = Math.min(W - 1, Math.floor(x / sw * W));
      bins[col * 256 + luma]++;
    }
  }
  const out = ctx.createImageData(W, H);
  const gain = MON_SCOPE.gain * 12;
  for (let x = 0; x < W; x++) {
    for (let v = 0; v < 256; v++) {
      const n = bins[x * 256 + v];
      if (!n) continue;
      const y = Math.min(H - 1, Math.round((1 - v / 255) * (H - 1)));
      const a = Math.min(1, (n / gain) * 0.9);
      const p = (y * W + x) * 4;
      out.data[p] = 70 + 120 * a;
      out.data[p + 1] = 200 * a + 40;
      out.data[p + 2] = 130 + 80 * a;
      out.data[p + 3] = Math.max(out.data[p + 3], Math.round(a * 235));
    }
  }
  const tmp = document.createElement("canvas");
  tmp.width = W; tmp.height = H;
  tmp.getContext("2d").putImageData(out, 0, 0);
  ctx.drawImage(tmp, 0, 0);
}

function monDrawParade(img) {
  const view = monScopeCanvas("scopeParade");
  if (!view) return;
  const { c, ctx } = view;
  monScopeFrame(ctx, c);
  const W = c.width, H = c.height;
  const src = img.data, sw = img.width, sh = img.height;
  const panelW = Math.floor(W / 3);
  const bins = new Uint16Array(W * 256);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4;
      const col = Math.min(panelW - 1, Math.floor(x / sw * panelW));
      for (let ch = 0; ch < 3; ch++) {
        bins[(ch * panelW + col) * 256 + src[i + ch]]++;
      }
    }
  }
  const out = ctx.createImageData(W, H);
  const gain = MON_SCOPE.gain * 10;
  const tint = [[255, 80, 80], [80, 230, 90], [90, 140, 255]];
  for (let ch = 0; ch < 3; ch++) {
    for (let x = 0; x < panelW; x++) {
      const px = ch * panelW + x;
      for (let v = 0; v < 256; v++) {
        const n = bins[(ch * panelW + x) * 256 + v];
        if (!n) continue;
        const y = Math.min(H - 1, Math.round((1 - v / 255) * (H - 1)));
        const a = Math.min(1, (n / gain) * 0.9);
        const p = (y * W + px) * 4;
        out.data[p] = tint[ch][0];
        out.data[p + 1] = tint[ch][1];
        out.data[p + 2] = tint[ch][2];
        out.data[p + 3] = Math.max(out.data[p + 3], Math.round(a * 235));
      }
    }
  }
  const tmp = document.createElement("canvas");
  tmp.width = W; tmp.height = H;
  tmp.getContext("2d").putImageData(out, 0, 0);
  ctx.drawImage(tmp, 0, 0);
  ctx.strokeStyle = "#263043";
  ctx.beginPath();
  ctx.moveTo(panelW + 0.5, 0); ctx.lineTo(panelW + 0.5, H);
  ctx.moveTo(panelW * 2 + 0.5, 0); ctx.lineTo(panelW * 2 + 0.5, H);
  ctx.stroke();
}

function monDrawVector(img) {
  const view = monScopeCanvas("scopeVector");
  if (!view) return;
  const { c, ctx } = view;
  monScopeFrame(ctx, c);
  const W = c.width, H = c.height;
  const src = img.data, sw = img.width, sh = img.height;
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 6;
  const bins = new Uint16Array(W * H);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4;
      const r = src[i] / 255, g = src[i + 1] / 255, b = src[i + 2] / 255;
      // BT.601 YCbCr, the space a vectorscope is drawn in.
      const cb = -0.1687 * r - 0.3313 * g + 0.5 * b;
      const cr = 0.5 * r - 0.4187 * g - 0.0813 * b;
      const px = Math.round(cx + cb * 2 * R);
      const py = Math.round(cy - cr * 2 * R);
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      bins[py * W + px]++;
    }
  }
  const out = ctx.createImageData(W, H);
  const gain = MON_SCOPE.gain * 9;
  for (let p = 0; p < W * H; p++) {
    const n = bins[p];
    if (!n) continue;
    const a = Math.min(1, (n / gain) * 0.9);
    const q = p * 4;
    out.data[q] = 90 * a + 20;
    out.data[q + 1] = 220 * a + 30;
    out.data[q + 2] = 120 * a + 30;
    out.data[q + 3] = Math.round(a * 235);
  }
  const tmp = document.createElement("canvas");
  tmp.width = W; tmp.height = H;
  tmp.getContext("2d").putImageData(out, 0, 0);
  ctx.drawImage(tmp, 0, 0);
  // graticule: circle + skin-tone line
  ctx.strokeStyle = "rgba(120,150,190,.35)";
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, R / 2, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
  ctx.stroke();
}

function monDrawHist(img) {
  const view = monScopeCanvas("scopeHist");
  if (!view) return;
  const { c, ctx } = view;
  monScopeFrame(ctx, c);
  const W = c.width, H = c.height;
  const src = img.data;
  const n = src.length / 4;
  const hist = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
  for (let i = 0; i < src.length; i += 4) {
    hist[0][src[i]]++; hist[1][src[i + 1]]++; hist[2][src[i + 2]]++;
  }
  // Include the clipping bins: crushed blacks and blown highlights are the
  // spikes people look for, so they must not be excluded from the peak.
  let peak = 1;
  for (let ch = 0; ch < 3; ch++) for (let v = 0; v < 256; v++) peak = Math.max(peak, hist[ch][v]);
  const colors = ["rgba(255,90,90,.72)", "rgba(90,230,120,.72)", "rgba(110,150,255,.72)"];
  ctx.globalCompositeOperation = "lighter";
  for (let ch = 0; ch < 3; ch++) {
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let v = 0; v < 256; v++) {
      const x = v / 255 * (W - 1);
      const y = H - Math.min(1, hist[ch][v] / peak) * (H - 8);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = colors[ch];
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
  void n;
}

function monToggleScopes(force) {
  MON.scopes = force == null ? !MON.scopes : !!force;
  const el = $("monScopes");
  if (el) el.hidden = !MON.scopes;
  monStore(); monSyncButtons();
  // Scopes need their own clock: a paused seek settles a frame or two after the
  // seek, and the playhead loop is not running then. Sampling on a light timer
  // means the traces always show the frame that is actually on screen.
  if (MON_SCOPE.timer) { clearInterval(MON_SCOPE.timer); MON_SCOPE.timer = 0; }
  if (MON.scopes) {
    monFitScopeCanvases();
    monScopesTick(true);
    MON_SCOPE.timer = setInterval(() => {
      if (!document.hidden) monScopesTick(true);
    }, 140);
    status("scopes on");
  } else {
    status("scopes off");
  }
}

/** Give every scope canvas the backing-store resolution it is displayed at, so
 *  the traces are sharp instead of a stretched 256×144 bitmap. */
function monFitScopeCanvases() {
  document.querySelectorAll("#monScopes canvas").forEach((c) => {
    const rect = c.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(64, Math.round(rect.width * dpr));
    const h = Math.max(48, Math.round(rect.height * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  });
}

/* ---------------------------------------------------------------- audio */

const MON_AUDIO = {
  ctx: null, master: null, anL: null, anR: null, splitter: null,
  taps: new WeakMap(), failed: false, bufL: null, bufR: null,
  peak: { l: 0, r: 0 }, peakAge: { l: 0, r: 0 }, lastDraw: 0,
};

function monAudioGraph() {
  if (MON_AUDIO.failed) return null;
  if (!MON_AUDIO.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { MON_AUDIO.failed = true; return null; }
    try {
      const ctx = new AC();
      const master = ctx.createGain();
      master.gain.value = MON.muted ? 0 : (Number(MON.volume) || 0) / 100;
      const splitter = ctx.createChannelSplitter(2);
      const anL = ctx.createAnalyser(); anL.fftSize = 1024; anL.smoothingTimeConstant = 0.3;
      const anR = ctx.createAnalyser(); anR.fftSize = 1024; anR.smoothingTimeConstant = 0.3;
      master.connect(splitter);
      splitter.connect(anL, 0);
      splitter.connect(anR, 1);
      master.connect(ctx.destination);
      MON_AUDIO.ctx = ctx; MON_AUDIO.master = master; MON_AUDIO.splitter = splitter;
      MON_AUDIO.anL = anL; MON_AUDIO.anR = anR;
      MON_AUDIO.bufL = new Float32Array(anL.fftSize);
      MON_AUDIO.bufR = new Float32Array(anR.fftSize);
    } catch (_) { MON_AUDIO.failed = true; return null; }
  }
  if (MON_AUDIO.ctx.state === "suspended") MON_AUDIO.ctx.resume().catch(() => {});
  return MON_AUDIO;
}

/** Route one media element through the monitor bus — once, and only when the
 *  context is actually running, so a suspended context can never silence the
 *  preview by capturing an element it cannot output. */
function monTap(el) {
  if (!MON.meters || !el || MON_AUDIO.failed) return;
  if (MON_AUDIO.taps.has(el)) return;
  const g = monAudioGraph();
  if (!g || g.ctx.state !== "running") return;
  try {
    const src = g.ctx.createMediaElementSource(el);
    src.connect(g.master);
    MON_AUDIO.taps.set(el, src);
  } catch (_) { MON_AUDIO.taps.set(el, null); }
}

function monApplyVolume() {
  const g = MON_AUDIO.master;
  if (g) g.gain.value = MON.muted ? 0 : (Number(MON.volume) || 0) / 100;
  if (!g) {
    // No graph: fall back to element mute (re-applied after every stageSync).
    const els = [...STAGE.layers.values()].map((r) => r.media)
      .concat([...STAGE.audios.values()]);
    els.forEach((el) => { try { el.muted = !!MON.muted; } catch (_) {} });
  }
  monSyncButtons();
}

function monToggleMute() {
  MON.muted = !MON.muted;
  monStore(); monApplyVolume();
  status(MON.muted ? "monitor muted (Shift+M is lane mute)" : `monitor at ${MON.volume}%`);
}

function monMeterTick() {
  const meters = $("monMeters");
  if (!meters || meters.hidden) return;
  const now = performance.now();
  if (now - MON_AUDIO.lastDraw < 45) return;
  MON_AUDIO.lastDraw = now;

  const els = [...STAGE.layers.values()].map((r) => r.media)
    .concat([...STAGE.audios.values()]).filter((el) => el && el.tagName);
  if (MON.meters) els.forEach(monTap);

  let rl = 0, rr = 0;
  const g = MON_AUDIO;
  if (g.anL && g.ctx && g.ctx.state === "running") {
    g.anL.getFloatTimeDomainData(g.bufL);
    g.anR.getFloatTimeDomainData(g.bufR);
    rl = monRms(g.bufL); rr = monRms(g.bufR);
  } else if (!MON_AUDIO.failed) {
    // Graph not up yet (or browser refused): show a flat meter rather than lie.
    rl = rr = 0;
  }
  // When the graph is unavailable entirely, estimate from the element volumes
  // so a muted track still visibly reads zero.
  if (MON_AUDIO.failed) {
    const playing = els.some((el) => el.tagName === "VIDEO" && !el.paused && el.volume > 0) ||
      els.some((el) => el.tagName === "AUDIO" && !el.paused && el.volume > 0);
    rl = rr = playing && !MON.muted ? 0.25 : 0;
  }
  if (MON.muted) { rl = rr = 0; }
  monPaintMeter("l", rl, now);
  monPaintMeter("r", rr, now);
}

function monRms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

function monPaintMeter(ch, rms, now) {
  const fill = document.querySelector(`.mon-meter-fill[data-ch="${ch}"]`);
  const peakEl = document.querySelector(`.mon-meter-peak[data-ch="${ch}"]`);
  if (!fill) return;
  const db = rms > 0 ? 20 * Math.log10(Math.max(rms, 1e-6)) : -70;
  const pct = Math.max(0, Math.min(1, (db + 60) / 60));
  fill.style.height = `${(pct * 100).toFixed(1)}%`;
  fill.classList.toggle("hot", db > -3);
  if (peakEl) {
    if (db > MON_AUDIO.peak[ch]) { MON_AUDIO.peak[ch] = db; MON_AUDIO.peakAge[ch] = now; }
    if (now - MON_AUDIO.peakAge[ch] > 1200) MON_AUDIO.peak[ch] = Math.max(db, -70);
    const pp = Math.max(0, Math.min(1, (MON_AUDIO.peak[ch] + 60) / 60));
    peakEl.style.bottom = `${(pp * 100).toFixed(1)}%`;
  }
}

/* -------------------------------------------------------------- fullscreen */

function monToggleFullscreen() {
  const vp = $("previewViewport");
  if (!vp) return;
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else if (vp.requestFullscreen) {
    vp.requestFullscreen().catch((e) => status(`fullscreen refused: ${e.message}`));
  }
}

function monFullscreenChanged() {
  const vp = $("previewViewport");
  if (vp) vp.classList.toggle("is-fs", !!document.fullscreenElement);
  monSyncButtons();
  if (typeof layoutPreviewZoom === "function") layoutPreviewZoom();
}

/* ------------------------------------------------------------ export frame */

function monExportFrame() {
  if (!S.project) return status("Open a project first.");
  const { w, h } = monFrameSize();
  if (typeof syncPreview === "function") syncPreview(true);
  // Exporting right after a seek used to write a black PNG; wait for the
  // decoder, then take the frame.
  monWhenFrameReady(() => monExportFrame.write(w, h), 14, 100);
}

monExportFrame.write = (w, h) => {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  const drew = monDrawComposite(ctx, w, h);
  if (!drew) status("no frame at the playhead — the export will be black");
  c.toBlob((blob) => {
    if (!blob) return status("frame export failed");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `frame_${monTC(playheadTime()).replace(/:/g, "-")}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    status(`frame exported · ${w}×${h} PNG`);
  }, "image/png");
};

/* -------------------------------------------------------------- zoom menu */

function monZoomMenu(anchor) {
  monClosePopovers();
  const levels = (typeof PREVIEW_ZOOM_LEVELS !== "undefined" ? PREVIEW_ZOOM_LEVELS : [1])
    .concat([0.1, 0.125, 0.25, 0.33, 0.75, 6, 8])
    .filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
  const pop = document.createElement("div");
  pop.className = "mon-pop mon-zoom-pop";
  pop.innerHTML = `<div class="mon-pop-head">Zoom</div><div class="mon-zoom-list">` +
    levels.map((v) => `<button type="button" data-z="${v}">${Math.round(v * 100)}%</button>`).join("") +
    `</div>`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.min(window.innerWidth - 130, r.left)}px`;
  pop.style.top = `${Math.min(window.innerHeight - pop.offsetHeight - 8, r.bottom + 6)}px`;
  pop.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-z]");
    if (!b) return;
    if (typeof setPreviewZoom === "function") setPreviewZoom(Number(b.dataset.z));
    monClosePopovers();
  });
  monPop = pop;
}

let monPop = null;
function monClosePopovers() {
  if (monPop && monPop.isConnected) monPop.remove();
  monPop = null;
}

/* ------------------------------------------------------------ gear menu */

function monToggleMenu(force) {
  const el = $("monMenu");
  if (!el) return;
  const show = force == null ? el.hidden : !!force;
  if (!show) { el.hidden = true; return; }
  monBuildMenu();
  el.hidden = false;
  el.querySelector("select, input, button")?.focus({ preventScroll: true });
}

function monResOptions(sel) {
  return MON_RES.map((r) => `<option value="${r.v}"${Math.abs(r.v - sel) < 1e-6 ? " selected" : ""}>${r.label}</option>`).join("");
}

function monBuildMenu() {
  const el = $("monMenu");
  if (!el) return;
  const btnRows = MON_BUTTONS.filter((b) => !b.fixed).map((b) => {
    const on = !MON.hidden.includes(b.id);
    return `<label class="mon-menu-chk"><input type="checkbox" data-btn="${b.id}"${on ? " checked" : ""}> ${b.label.replace(/\s*\([^)]*\)\s*$/, "")}</label>`;
  }).join("");
  const marks = monMarks();
  el.innerHTML = `
    <div class="mon-menu-head">
      <strong>Program Monitor</strong>
      <span class="spacer"></span>
      <button type="button" class="mini" data-close title="Close">×</button>
    </div>
    <div class="mon-menu-body">
      <section>
        <h4>Playback</h4>
        <label class="mon-row"><span>Playback resolution</span><select data-set="playRes">${monResOptions(MON.playRes)}</select></label>
        <label class="mon-row"><span>Paused resolution</span><select data-set="pausedRes">${monResOptions(MON.pausedRes)}</select></label>
        <label class="mon-menu-chk"><input type="checkbox" data-tog="hq"${MON.hq ? " checked" : ""}> High quality playback <em>look filters on while playing</em></label>
        <label class="mon-menu-chk"><input type="checkbox" data-tog="loop"${MON.loop ? " checked" : ""}> Loop playback</label>
        <div class="mon-menu-note">Reduced resolutions redraw the program frame on a smaller canvas and scale it up — that is what makes them faster, and why the image goes soft.</div>
      </section>
      <section>
        <h4>Overlays</h4>
        <label class="mon-menu-chk"><input type="checkbox" data-tog="safeAction"${MON.safeAction ? " checked" : ""}> Action-safe margins <em>10%</em></label>
        <label class="mon-menu-chk"><input type="checkbox" data-tog="safeTitle"${MON.safeTitle ? " checked" : ""}> Title-safe margins <em>20%</em></label>
        <label class="mon-menu-chk"><input type="checkbox" data-tog="safeFour3"${MON.safeFour3 ? " checked" : ""}> 4:3 safe box</label>
        <label class="mon-row"><span>Custom margin</span><input type="number" min="0" max="45" step="1" data-num="safeCustom" value="${MON.safeCustom}"> %</label>
        <label class="mon-menu-chk"><input type="checkbox" data-tog="guideCenter"${MON.guideCenter ? " checked" : ""}> Centre crosshair</label>
        <label class="mon-menu-chk"><input type="checkbox" data-tog="guideThirds"${MON.guideThirds ? " checked" : ""}> Rule of thirds</label>
        <label class="mon-menu-chk"><input type="checkbox" data-tog="alpha"${MON.alpha ? " checked" : ""}> Alpha view <em>white = opaque</em></label>
      </section>
      <section>
        <h4>Timecode</h4>
        <label class="mon-row"><span>Display</span>
          <select data-set="tcMode">
            <option value="tc"${MON.tcMode === "tc" ? " selected" : ""}>Timecode</option>
            <option value="frames"${MON.tcMode === "frames" ? " selected" : ""}>Frames</option>
            <option value="seconds"${MON.tcMode === "seconds" ? " selected" : ""}>Seconds</option>
          </select>
        </label>
        <label class="mon-menu-chk"><input type="checkbox" data-tog="tcRemain"${MON.tcRemain ? " checked" : ""}> Show remaining instead of duration</label>
        <label class="mon-menu-chk"><input type="checkbox" data-tog="meters"${MON.meters ? " checked" : ""}> Audio meters</label>
      </section>
      <section>
        <h4>Audio</h4>
        <label class="mon-row"><span>Monitor volume</span><input type="range" min="0" max="100" step="1" data-num="volume" value="${MON.volume}"></label>
        <label class="mon-menu-chk"><input type="checkbox" data-tog="muted"${MON.muted ? " checked" : ""}> Mute the monitor</label>
      </section>
      <section>
        <h4>Scopes</h4>
        <label class="mon-menu-chk"><input type="checkbox" data-tog="scopes"${MON.scopes ? " checked" : ""}> Show scopes</label>
        <label class="mon-row"><span>Trace gain</span><input type="range" min="1" max="3" step="0.1" data-num="scopeGain" value="${MON_SCOPE.gain}"></label>
      </section>
      <section>
        <h4>Frame</h4>
        <button type="button" class="mini" data-act="frame">Export frame as PNG…</button>
        <button type="button" class="mini" data-act="full">Fullscreen monitor</button>
      </section>
      <section>
        <h4>Markers</h4>
        <div class="mon-mark-list">${marks.length
          ? marks.map((m) => `<div class="mon-mark-row"><button type="button" class="mini" data-gomark="${m.id}">${monTC(m.t)}</button><span>${monEscape(m.name || "")}</span><button type="button" class="mini" data-delmark="${m.id}" title="Delete marker">×</button></div>`).join("")
          : `<div class="mon-menu-note">No markers. Press M on the monitor to add one.</div>`}</div>
      </section>
      <section>
        <h4>Button bar</h4>
        <div class="mon-menu-grid">${btnRows}</div>
        <div class="mon-menu-note">Unticked buttons disappear from the transport bar. Play, timecode and the gear always stay.</div>
      </section>
      <section>
        <h4>Reset</h4>
        <button type="button" class="mini" data-act="reset">Reset monitor settings</button>
        <button type="button" class="mini" data-act="dropstats">Clear dropped-frame count</button>
      </section>
    </div>`;

  el.onclick = (ev) => {
    if (ev.target.closest("[data-close]")) { monToggleMenu(false); return; }
    const act = ev.target.closest("[data-act]");
    if (act) {
      const a = act.dataset.act;
      if (a === "frame") monExportFrame();
      else if (a === "full") monToggleFullscreen();
      else if (a === "reset") monReset();
      else if (a === "dropstats") { MON_STATS.dropped = 0; monPaintInfo(); monPaintPlayInfo(); }
      monToggleMenu(false);
      return;
    }
    const gm = ev.target.closest("[data-gomark]");
    if (gm) {
      const m = monMarks().find((x) => x.id === gm.dataset.gomark);
      if (m) { setPlayhead(m.t); monToggleMenu(false); }
      return;
    }
    const dm = ev.target.closest("[data-delmark]");
    if (dm) {
      const m = monMarks().find((x) => x.id === dm.dataset.delmark);
      if (m) { monDeleteMarker(m); monBuildMenu(); }
    }
  };
  el.onchange = (ev) => {
    const t = ev.target;
    if (t.dataset.btn) {
      // Button editor: hide or show one transport button.
      const id = t.dataset.btn;
      MON.hidden = (Array.isArray(MON.hidden) ? MON.hidden : []).filter((x) => x !== id);
      if (!t.checked) MON.hidden.push(id);
      monStore();
      monBuildBar();
      return;
    }
    if (t.dataset.set) {
      const key = t.dataset.set;
      const v = key === "tcMode" ? t.value : Number(t.value);
      MON[key] = v;
      monStore();
      if (key === "tcMode") monPaintTC();
      if (key === "playRes" || key === "pausedRes") { monLastQualitySig = ""; monApplyQuality(true); }
      monPaintInfo(); monPaintPlayInfo();
    } else if (t.dataset.tog) {
      MON[t.dataset.tog] = !!t.checked;
      monStore(); monAfterChange(t.dataset.tog);
    }
  };
  el.oninput = (ev) => {
    const t = ev.target;
    if (t.dataset.num) {
      const key = t.dataset.num;
      const v = Math.max(Number(t.min || 0), Math.min(Number(t.max || 100), Number(t.value) || 0));
      if (key === "scopeGain") { MON_SCOPE.gain = v; monScopesTick(true); return; }
      MON[key] = v;
      monStore();
      if (key === "volume") monApplyVolume();
      monPaintInfo();
    }
  };
}

function monEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Apply a settings toggle to whatever it controls. */
function monAfterChange(key) {
  if (key === "scopes") { monToggleScopes(MON.scopes); return; }
  if (key === "muted") { monApplyVolume(); return; }
  if (key === "meters") { const m = $("monMeters"); if (m) m.hidden = !MON.meters; return; }
  if (key === "loop") { monSyncButtons(); return; }
  if (key === "alpha" || key === "safeAction" || key === "safeTitle" || key === "safeFour3" ||
      key === "safeCustom" || key === "guideCenter" || key === "guideThirds") {
    monApplyOverhead(); monLastQualitySig = ""; monApplyQuality(true); return;
  }
  if (key === "tcRemain" || key === "tcMode") { monPaintTC(); return; }
  if (key === "hq") { monLastQualitySig = ""; monApplyQuality(true); monPaintInfo(); }
}

function monReset() {
  const keep = { marks: MON.marks, inOut: MON.inOut };
  Object.assign(MON, MON_DEFAULTS, keep);
  MON.rate = 1;
  monStore();
  monBuildBar(); monSyncButtons(); monApplyOverhead(); monApplyVolume(); monApplyQuality(true);
  monPaintTC(); monPaintInfo(); monPaintPlayInfo();
  const m = $("monMeters"); if (m) m.hidden = !MON.meters;
  monToggleScopes(MON.scopes);
  status("monitor settings reset");
}

/* -------------------------------------------------------------- keyboard */

function monBindKeys() {
  document.addEventListener("keydown", (ev) => {
    if (ev.defaultPrevented) return;
    const el = ev.target;
    const tag = el && el.tagName;
    const typing = el && (el.isContentEditable || tag === "TEXTAREA" || tag === "SELECT" ||
      (tag === "INPUT" && !["checkbox", "radio", "button", "submit", "reset", "range"].includes(el.type)));
    if (typing) return;
    if (!S.project) return;
    const key = ev.key;
    const lower = key.toLowerCase();

    if (ev.ctrlKey || ev.metaKey) {
      if (ev.shiftKey && lower === "e") { ev.preventDefault(); monExportFrame(); return; }
      if (key === "`" || key === "~") { ev.preventDefault(); monToggleFullscreen(); return; }
      return;
    }
    if (ev.altKey) return;

    switch (key) {
      case "j": case "J": ev.preventDefault(); monShuttle(-1); return;
      case "k": case "K": ev.preventDefault(); monStopShuttle(); return;
      case "l": case "L": ev.preventDefault(); monShuttle(1); return;
      case "i": case "I": ev.preventDefault(); monMarkIn(); return;
      case "o": case "O": ev.preventDefault(); monMarkOut(); return;
      case "Home": ev.preventDefault(); monGoto(0); return;
      case "End": ev.preventDefault(); monGoto(timelineEnd()); return;
      case ",": ev.preventDefault(); monJumpMarker(-1); return;
      case ".": ev.preventDefault(); monJumpMarker(1); return;
      default: break;
    }
    if (lower === "m") {
      ev.preventDefault();
      if (ev.shiftKey) return;     // Shift+M stays lane mute (timeline.js)
      monAddMarker();
      return;
    }
    if (key === " " && ev.shiftKey && !ev.repeat) { ev.preventDefault(); monPlayInOut(); return; }
  }, true);
}

/* --------------------------------------------------------------- global */

function monBindGlobal() {
  document.addEventListener("fullscreenchange", monFullscreenChanged);
  // A project can appear or change while nothing is playing; the monitor still
  // has to pick up its frame size, fps and the per-project markers.
  setInterval(() => monWatchProject(false), 800);
  let scopeResize = 0;
  window.addEventListener("resize", () => {
    if (!MON.scopes) return;
    clearTimeout(scopeResize);
    scopeResize = setTimeout(() => { monFitScopeCanvases(); monScopesTick(true); }, 120);
  });
  // Audio contexts start suspended; any gesture may resume ours.
  const resume = () => {
    if (MON_AUDIO.ctx && MON_AUDIO.ctx.state === "suspended") MON_AUDIO.ctx.resume().catch(() => {});
  };
  document.addEventListener("pointerdown", resume, true);
  document.addEventListener("keydown", resume, true);

  // Close popovers on outside click / Escape.
  document.addEventListener("pointerdown", (ev) => {
    if (monPop && !monPop.contains(ev.target)) monClosePopovers();
    const menu = $("monMenu");
    if (menu && !menu.hidden && !menu.contains(ev.target) && !ev.target.closest("#mnGear")) {
      monToggleMenu(false);
    }
  }, true);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { monClosePopovers(); monToggleMenu(false); }
  });

  // The meter column is optional.
  const m = $("monMeters");
  if (m) m.hidden = !MON.meters;
  const s = $("monScopes");
  if (s) s.hidden = !MON.scopes;
  const gain = $("monScopeGain");
  if (gain) {
    gain.value = String(MON_SCOPE.gain);
    gain.addEventListener("input", () => { MON_SCOPE.gain = Number(gain.value) || 1.4; monScopesTick(true); });
  }
  $("monScopesClose")?.addEventListener("click", () => monToggleScopes(false));
}

/* ------------------------------------------------------------ play state */

/** Called by timeline.js when playback starts or stops. */
function monPlayState(playing) {
  const btn = $("playBtn");
  if (btn) {
    btn.innerHTML = monIcon(playing ? "pause" : "play");
    btn.classList.toggle("playing", !!playing);
    btn.setAttribute("aria-label", playing ? "Pause (Space)" : "Play (Space)");
  }
  if (playing) MON_STATS.skip = 3;
  else { MON.rate = 0; monSyncButtons(); }
  monPaintPlayInfo(); monPaintBadge(); monPaintInfo();
}

/** Called from pvTick every frame (after the clock advanced). */
function monTick(dt) {
  monWatchProject(false);
  monCountFrame(dt);
  monApplyQuality(false);
  monScopesTick(false);
  monMeterTick();
  monPaintTC();
}

/** Called on every seek, paused or playing. */
function monSeek() {
  monPaintTC();
  monPaintInfo();
  monApplyQuality(true);
  if (MON.scopes) monScopesTick(true);
  monPaintBadge();
}

// Opening a project swaps the clip stack underneath us without a seek, so the
// monitor watches for the change instead of relying on the caller to tell it.
const MON_WATCH = { key: "", sig: "", at: 0 };
function monWatchProject(force) {
  const now = performance.now();
  if (!force && now - MON_WATCH.at < 500) return;
  MON_WATCH.at = now;
  const key = monProjKey();
  const { w, h } = monFrameSize();
  const sig = `${key}|${w}x${h}|${S.tl ? (S.tl.clips || []).length : 0}`;
  if (sig === MON_WATCH.sig) return;
  const first = !MON_WATCH.key;
  MON_WATCH.sig = sig;
  MON_WATCH.key = key;
  monPaintInfo(); monPaintTC(); monPaintBadge();
  if (!first && typeof draw === "function") draw();
}

/* ------------------------------------------------------------------ boot */

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", monInit);
} else {
  monInit();
}
