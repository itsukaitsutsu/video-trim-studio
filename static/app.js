/* Video Trim Studio - frontend. No build step, no CDN, plain JS. */
"use strict";

const $ = (id) => document.getElementById(id);

const S = {
  env: null,
  project: null,
  preview: null,
  sections: [],
  selected: new Set(),
  peaks: [],
  thumbs: null,
  thumbImgs: [],
  duration: 0,
  view: { start: 0, span: 1 },
  filter: { kinds: new Set(["caption", "silence", "other"]), minDur: 0.4, q: "" },
  job: null,
  jobTimer: null,
  subsText: null,
  hoverT: null,
  drag: null,
};

const KIND_COLOR = { caption: "#1f6feb", silence: "#9e6a03", other: "#6e7681" };

/* ------------------------------------------------------------------ utils */

function fmtTime(sec, ms = true) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const base = h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(Math.floor(s)).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(Math.floor(s)).padStart(2, "0")}`;
  if (!ms) return base;
  return `${base}.${String(Math.floor((s % 1) * 1000)).padStart(3, "0")}`;
}

function fmtBytes(n) {
  if (!n) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body && !(opts.body instanceof FormData)
      ? { "Content-Type": "application/json" } : {},
    ...opts,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { detail: text }; }
  if (!res.ok) throw new Error(data.detail || `${res.status} ${res.statusText}`);
  return data;
}

function mergeRanges(ranges) {
  if (!ranges.length) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [[sorted[0][0], sorted[0][1]]];
  for (const [s, e] of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (s <= last[1] + 1e-6) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/* ------------------------------------------------------------- env + open */

async function loadEnv() {
  try {
    S.env = await api("/api/env");
  } catch (e) {
    $("env").className = "env bad";
    $("env").textContent = `Server error: ${e.message}`;
    return;
  }
  const el = $("env");
  if (S.env.ffmpeg_ok) {
    el.className = "env ok";
    const gpu = S.env.gpu_encoders.length ? S.env.gpu_encoders.join(", ") : "none (CPU only)";
    el.innerHTML = `ffmpeg OK &middot; python ${S.env.python}<br>` +
      `<span class="dim">GPU encoders: ${gpu}</span>`;
  } else {
    el.className = "env bad";
    el.textContent = `ffmpeg missing: ${S.env.error}`;
  }
  fillSelect($("xHwaccel"), S.env.hwaccels, "auto");
}

function fillSelect(sel, items, value) {
  sel.innerHTML = "";
  for (const it of items) {
    const o = document.createElement("option");
    o.value = o.textContent = it;
    if (it === value) o.selected = true;
    sel.appendChild(o);
  }
}

async function openPath(path) {
  if (!path) return;
  $("fileMeta").textContent = "probing…";
  try {
    const data = await api("/api/open", { method: "POST", body: JSON.stringify({ path }) });
    onProjectOpen(data);
  } catch (e) {
    $("fileMeta").textContent = "";
    alert(`Could not open:\n${e.message}`);
  }
}

function onProjectOpen(data) {
  S.project = data;
  S.duration = data.info.duration;
  S.sections = Array.isArray(data.sections) ? data.sections : [];
  S.selected.clear();
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
  renderList();
  draw();
  updateTally();
  $("detectInfo").textContent = "";
  $("exportBtn").disabled = true;
  loadWaveform();
  loadThumbs();
}

/* --------------------------------------------- browser preview (playability) */

let previewTimer = null;
let previewFallbackTried = false;

function setPreviewInfo(text) {
  const el = $("previewInfo");
  el.hidden = false;
  el.textContent = text;
}

function hidePreviewInfo() { $("previewInfo").hidden = true; }

/**
 * Point the <video> element at /api/media, waiting for a preview proxy when the
 * source is something browsers cannot play (AVI, MPEG-TS, WMV, DivX, AC3…).
 */
function setupPreview(preview) {
  if (previewTimer) { clearInterval(previewTimer); previewTimer = null; }
  previewFallbackTried = false;
  const p = $("player");
  const mode = (preview && preview.mode) || "direct";

  if (mode === "proxy" && !(preview && preview.ready)) {
    p.removeAttribute("src");
    p.load();
    setPreviewInfo(`${preview.reason || "This format is not playable in a browser."} ` +
                   "Building a browser-friendly preview… 0%");
    pollPreview();
    return;
  }
  hidePreviewInfo();
  loadPlayer();
}

function loadPlayer() {
  const p = $("player");
  // Cache-bust: /api/media may now serve a freshly built proxy, and the browser
  // would otherwise replay the cached (unplayable) response.
  p.src = `/api/media?t=${Date.now()}`;
  p.load();
}

function pollPreview() {
  if (previewTimer) clearInterval(previewTimer);
  previewTimer = setInterval(async () => {
    let st;
    try { st = await api("/api/preview-status"); } catch (_) { return; }
    S.preview = st;
    if (st.ready) {
      clearInterval(previewTimer); previewTimer = null;
      hidePreviewInfo();
      loadPlayer();
    } else if (st.state === "error") {
      clearInterval(previewTimer); previewTimer = null;
      setPreviewInfo(`Preview could not be built: ${st.error || "ffmpeg failed"}`);
    } else {
      const pct = Math.round((st.progress || 0) * 100);
      setPreviewInfo("Building a browser-friendly preview… " + pct + "%");
    }
  }, 700);
}

/**
 * Fallback for sources the server believed were playable (HEVC/AV1) but that
 * this browser has no decoder for: they load, report a duration, and still
 * produce no frames, so ask the server for a proxy.
 */
async function maybeRequestProxy() {
  if (previewFallbackTried || !S.project) return;
  if (S.preview && (S.preview.ready || S.preview.serving_proxy)) return;
  previewFallbackTried = true;
  setPreviewInfo("This browser cannot decode that file. Building a preview…");
  try {
    await api("/api/preview-proxy", { method: "POST", body: "{}" });
    pollPreview();
  } catch (e) {
    previewFallbackTried = false;
    setPreviewInfo(`Could not build a preview: ${e.message}`);
  }
}

function defaultOutput() {
  const p = S.project.info.path;
  const dot = p.lastIndexOf(".");
  const out = dot > 0 ? `${p.slice(0, dot)}.clean${p.slice(dot)}` : `${p}.clean.mp4`;
  $("xOutput").value = out;
}

function applyProfile(pr) {
  fillSelect($("xCodec"), pr.encoder_choices.length ? pr.encoder_choices : ["libx264"], pr.codec);
  $("xPreset").value = pr.preset || "medium";
  $("xQuality").value = pr.quality_mode;
  $("xBitrate").value = pr.video_bitrate_kbps;
  $("xCrf").value = pr.crf;
  $("xPixFmt").value = pr.pix_fmt || "yuv420p";
  $("xAudioCodec").value = pr.audio_codec === "none" ? "" : pr.audio_codec;
  $("xAudioBitrate").value = pr.audio_bitrate_kbps || "";
  $("xAudioRate").value = pr.audio_sample_rate || "";
  $("xMatchFps").checked = !!pr.match_fps;
  $("xMatchColor").checked = !!pr.match_color;
  $("xMeta").checked = pr.copy_metadata !== false;
  $("xNoRotate").checked = !!pr.no_autorotate;
  if (S.env && S.env.hwaccels.includes(pr.hwaccel)) $("xHwaccel").value = pr.hwaccel;
  syncQualityRows();
}

function collectOpts() {
  return {
    mode: $("xMode").value,
    codec: $("xCodec").value,
    quality_mode: $("xQuality").value,
    video_bitrate_kbps: Number($("xBitrate").value) || 0,
    crf: Number($("xCrf").value) || 18,
    preset: $("xPreset").value,
    pix_fmt: $("xPixFmt").value.trim() || "yuv420p",
    hwaccel: $("xHwaccel").value,
    match_fps: $("xMatchFps").checked,
    fps: S.project?.profile?.fps || 0,
    match_color: $("xMatchColor").checked,
    copy_metadata: $("xMeta").checked,
    no_autorotate: $("xNoRotate").checked,
    audio_codec: $("xAudioCodec").value.trim() || "none",
    audio_bitrate_kbps: Number($("xAudioBitrate").value) || 0,
    audio_sample_rate: Number($("xAudioRate").value) || 0,
    audio_channels: S.project?.profile?.audio_channels || 0,
    fade_ms: Number($("xFade").value) || 0,
  };
}

function syncQualityRows() {
  const crf = $("xQuality").value === "crf";
  $("rowBitrate").style.display = crf ? "none" : "flex";
  $("rowCrf").style.display = crf ? "flex" : "none";
  $("reencodeOpts").style.opacity = $("xMode").value === "copy" ? ".45" : "1";
}

/* ----------------------------------------------------------- file browser */

async function browseTo(path) {
  const data = await api(`/api/browse?path=${encodeURIComponent(path || "")}&exts_only=false`);
  $("browserCwd").textContent = data.cwd;
  const list = $("browserList");
  list.innerHTML = "";
  const add = (label, onClick, size) => {
    const row = document.createElement("div");
    row.innerHTML = `<span>${escapeHtml(label)}</span><span class="size">${escapeHtml(size || "")}</span>`;
    row.onclick = onClick;
    list.appendChild(row);
  };
  if (data.parent) add("⬆ ..", () => browseTo(data.parent));
  // Windows: every drive is its own tree, so list them here. This is both the
  // quick jump from any folder and the contents of the "This PC" level.
  const here = (data.cwd || "").replace(/\\+$/, "").toLowerCase();
  for (const drv of data.drives || []) {
    const label = drv.replace(/\\+$/, "");
    if (label.toLowerCase() === here) continue;   // don't list the drive we're in
    add(`💽 ${label}`, () => browseTo(drv));
  }
  for (const d of data.dirs) add(`📁 ${d.name}`, () => browseTo(d.path));
  for (const f of data.files) {
    const isVideo = /\.(mp4|mov|m4v|mkv|webm|avi|ts|mts|m2ts|mpg|mpeg|flv|wmv|3gp|vob)$/i.test(f.name);
    add(`${isVideo ? "🎬" : "📄"} ${f.name}`, () => {
      if (isVideo) { $("pathInput").value = f.path; $("browserModal").hidden = true; openPath(f.path); }
      else if (/\.(srt|vtt)$/i.test(f.name)) {
        $("dSubPath").value = f.path; $("browserModal").hidden = true;
        $("subInfo").textContent = f.path;
      } else { $("pathInput").value = f.path; }
    }, fmtBytes(f.size));
  }
}

/* --------------------------------------------------------------- detection */

async function runDetect() {
  if (!S.project) return alert("Open a video first.");
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
    S.sections = data.sections;
    S.selected.clear();
    const sm = data.summary;
    $("detectInfo").innerHTML =
      `${sm.count} sections &middot; ${data.silence_count} silences (${fmtTime(sm.seconds_by_kind.silence, false)})` +
      ` &middot; ${data.cue_count} captions (${fmtTime(sm.seconds_by_kind.caption, false)})` +
      (sm.seconds_by_kind.other ? ` &middot; other audio ${fmtTime(sm.seconds_by_kind.other, false)}` : "");
    renderList();
    draw();
    updateTally();
  } catch (e) {
    $("detectInfo").textContent = `Error: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Detect sections";
  }
}

/* ------------------------------------------------------------ section list */

function visibleSections() {
  const q = S.filter.q.trim().toLowerCase();
  return S.sections.filter((s) =>
    S.filter.kinds.has(s.kind) &&
    s.dur >= S.filter.minDur - 1e-6 &&
    (!q || (s.text || "").toLowerCase().includes(q)));
}

function renderList() {
  const tbody = $("secTable").querySelector("tbody");
  tbody.innerHTML = "";
  const rows = visibleSections();
  $("listEmpty").hidden = rows.length > 0;
  $("listEmpty").textContent = S.sections.length
    ? "No sections match the filters."
    : "No sections yet — open a video and run detection.";

  const frag = document.createDocumentFragment();
  const MAX = 2000;
  rows.slice(0, MAX).forEach((s) => {
    const tr = document.createElement("tr");
    tr.dataset.id = s.id;
    if (S.selected.has(s.id)) tr.className = "sel";
    tr.innerHTML =
      `<td><input type="checkbox" ${S.selected.has(s.id) ? "checked" : ""}></td>` +
      `<td class="tc">${fmtTime(s.start)}</td>` +
      `<td class="tc">${fmtTime(s.end)}</td>` +
      `<td class="tc">${s.dur.toFixed(2)}s</td>` +
      `<td><span class="badge ${s.kind}">${s.kind}</span></td>` +
      `<td class="txt">${escapeHtml(s.text || (s.kind === "silence" ? "— silence —" : "— uncaptioned audio —"))}</td>`;
    tr.querySelector("input").onclick = (ev) => {
      ev.stopPropagation();
      toggleSection(s.id, ev.target.checked);
    };
    tr.onclick = () => { $("player").currentTime = Math.max(0, s.start - 0.1); draw(); };
    frag.appendChild(tr);
  });
  tbody.appendChild(frag);
  if (rows.length > MAX) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6" class="dim" style="padding:10px">Showing first ${MAX} of ${rows.length} matching sections — narrow the filters to see more.</td>`;
    tbody.appendChild(tr);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toggleSection(id, on) {
  if (on) S.selected.add(id); else S.selected.delete(id);
  const tr = $(`secTable`).querySelector(`tr[data-id="${id}"]`);
  if (tr) {
    tr.classList.toggle("sel", on);
    const cb = tr.querySelector("input");
    if (cb) cb.checked = on;
  }
  updateTally();
  draw();
}

function setSelection(ids, on) {
  for (const id of ids) { if (on) S.selected.add(id); else S.selected.delete(id); }
  renderList(); updateTally(); draw();
}

/* ------------------------------------------------------------- timeline UI */

const TL = { filmH: 42, waveTop: 46, waveH: 48, secTop: 98, secH: 26, rulerTop: 126 };

function canvasGeo() {
  const cv = $("timeline");
  const w = cv.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.floor(w * dpr)) {
    cv.width = Math.floor(w * dpr);
    cv.height = Math.floor(132 * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h: 132 };
}

const t2x = (t) => ((t - S.view.start) / S.view.span) * $("timeline").clientWidth;
const x2t = (x) => S.view.start + (x / $("timeline").clientWidth) * S.view.span;

function deletions() {
  const ranges = S.sections.filter((s) => S.selected.has(s.id)).map((s) => [s.start, s.end]);
  return mergeRanges(ranges);
}

function draw() {
  if (!S.project) return;
  const { ctx, w, h } = canvasGeo();
  ctx.clearRect(0, 0, w, h);

  const v0 = S.view.start, v1 = S.view.start + S.view.span;

  // filmstrip
  ctx.fillStyle = "#0a0d11";
  ctx.fillRect(0, 0, w, TL.filmH);
  if (S.thumbs && S.thumbs.interval > 0) {
    const i0 = Math.max(0, Math.floor(v0 / S.thumbs.interval));
    const i1 = Math.min(S.thumbs.count - 1, Math.ceil(v1 / S.thumbs.interval));
    for (let i = i0; i <= i1; i++) {
      const t = i * S.thumbs.interval;
      const x = t2x(t);
      const img = S.thumbImgs[i];
      if (img && img.complete && img.naturalWidth) {
        const th = TL.filmH, tw = img.naturalWidth * (th / img.naturalHeight);
        ctx.drawImage(img, x, 0, tw, th);
      }
    }
  }

  // waveform
  if (S.peaks.length) {
    ctx.fillStyle = "#2ea043";
    const n = S.peaks.length;
    const mid = TL.waveTop + TL.waveH / 2;
    for (let px = 0; px < w; px++) {
      const t = x2t(px);
      const idx = Math.floor((t / S.duration) * n);
      if (idx < 0 || idx >= n) continue;
      const amp = (S.peaks[idx] / 1000) * (TL.waveH / 2);
      ctx.fillRect(px, mid - amp, 1, Math.max(1, amp * 2));
    }
  } else {
    ctx.fillStyle = "#30363d";
    ctx.font = "11px sans-serif";
    ctx.fillText("waveform not loaded yet", 8, TL.waveTop + 16);
  }

  // sections
  for (const s of S.sections) {
    if (s.end < v0 || s.start > v1) continue;
    const x = t2x(s.start), x2 = t2x(s.end);
    const wSec = Math.max(1, x2 - x);
    ctx.fillStyle = S.selected.has(s.id) ? "#8b1f1c" : KIND_COLOR[s.kind];
    ctx.globalAlpha = S.selected.has(s.id) ? 0.95 : 0.75;
    ctx.fillRect(x, TL.secTop, wSec, TL.secH);
    ctx.globalAlpha = 1;
    if (wSec > 3) {
      ctx.strokeStyle = "#0a0d11";
      ctx.strokeRect(x + .5, TL.secTop + .5, wSec - 1, TL.secH - 1);
    }
    if (wSec > 60 && s.text) {
      ctx.fillStyle = "#fff";
      ctx.font = "10px sans-serif";
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 3, TL.secTop, wSec - 6, TL.secH);
      ctx.clip();
      ctx.fillText(s.text, x + 4, TL.secTop + 16);
      ctx.restore();
    }
  }

  // deletion overlay
  ctx.fillStyle = "rgba(248,81,73,.20)";
  for (const [s, e] of deletions()) {
    if (e < v0 || s > v1) continue;
    ctx.fillRect(t2x(s), 0, Math.max(1, t2x(e) - t2x(s)), TL.rulerTop - 2);
  }

  // ruler
  ctx.fillStyle = "#8b98a9";
  ctx.font = "10px ui-monospace, monospace";
  const target = 110;
  let step = niceStep(S.view.span / (w / target));
  for (let t = Math.ceil(v0 / step) * step; t <= v1; t += step) {
    const x = t2x(t);
    ctx.fillRect(x, TL.rulerTop, 1, 6);
    ctx.fillText(fmtTime(t, false), x + 3, TL.rulerTop + 5);
  }

  // playhead
  const pt = $("player").currentTime || 0;
  if (pt >= v0 && pt <= v1) {
    const x = t2x(pt);
    ctx.fillStyle = "#f0f6fc";
    ctx.fillRect(x, 0, 1.5, TL.rulerTop);
  }

  // rubber band
  if (S.drag && S.drag.moved) {
    const a = Math.min(S.drag.x0, S.drag.x1), b = Math.max(S.drag.x0, S.drag.x1);
    ctx.fillStyle = "rgba(88,166,255,.22)";
    ctx.fillRect(a, 0, b - a, TL.rulerTop);
  }

  // hover readout
  if (S.hoverT !== null) {
    const x = t2x(S.hoverT);
    ctx.strokeStyle = "rgba(255,255,255,.25)";
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, TL.rulerTop); ctx.stroke();
  }
}

function niceStep(raw) {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-3))));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

function sectionsIn(a, b) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return S.sections.filter((s) => s.end > lo && s.start < hi);
}

function bindTimeline() {
  const cv = $("timeline");

  cv.addEventListener("mousedown", (ev) => {
    if (!S.project) return;
    const r = cv.getBoundingClientRect();
    S.drag = { x0: ev.clientX - r.left, x1: ev.clientX - r.left, y: ev.clientY - r.top, moved: false, alt: ev.altKey };
  });

  window.addEventListener("mousemove", (ev) => {
    if (!S.project) return;
    const r = cv.getBoundingClientRect();
    const x = ev.clientX - r.left;
    S.hoverT = (x >= 0 && x <= r.width) ? x2t(x) : null;
    if (S.drag) {
      S.drag.x1 = Math.max(0, Math.min(r.width, x));
      if (Math.abs(S.drag.x1 - S.drag.x0) > 4) S.drag.moved = true;
    }
    draw();
  });

  window.addEventListener("mouseup", () => {
    if (!S.drag) return;
    const d = S.drag;
    S.drag = null;
    const t0 = x2t(d.x0), t1 = x2t(d.x1);
    if (!d.moved) {
      // simple click: toggle the block under the cursor if on the section row,
      // otherwise seek the player.
      if (d.y >= TL.secTop && d.y <= TL.secTop + TL.secH) {
        const hit = S.sections.find((s) => t0 >= s.start && t0 <= s.end);
        if (hit) toggleSection(hit.id, !S.selected.has(hit.id));
      } else {
        $("player").currentTime = Math.max(0, Math.min(S.duration, t0));
      }
    } else {
      const hit = sectionsIn(t0, t1);
      const on = !d.alt;
      setSelection(hit.map((s) => s.id), on);
    }
    draw();
  });

  cv.addEventListener("wheel", (ev) => {
    if (!S.project) return;
    ev.preventDefault();
    const r = cv.getBoundingClientRect();
    const anchor = x2t(ev.clientX - r.left);
    if (ev.ctrlKey || ev.metaKey) {
      const factor = ev.deltaY > 0 ? 1.25 : 0.8;
      let span = Math.min(S.duration, Math.max(S.duration / 400, S.view.span * factor));
      const frac = (anchor - S.view.start) / S.view.span;
      S.view.start = clampStart(anchor - frac * span, span);
      S.view.span = span;
    } else {
      const delta = (ev.deltaY + ev.deltaX) * (S.view.span / r.width);
      S.view.start = clampStart(S.view.start + delta, S.view.span);
    }
    draw();
  }, { passive: false });

  cv.addEventListener("mouseleave", () => { S.hoverT = null; draw(); });
}

function clampStart(start, span) {
  return Math.max(0, Math.min(Math.max(0, S.duration - span), start));
}

function zoomBy(factor) {
  const center = S.view.start + S.view.span / 2;
  const span = Math.min(S.duration, Math.max(S.duration / 400, S.view.span * factor));
  S.view.span = span;
  S.view.start = clampStart(center - span / 2, span);
  draw();
}

/* ------------------------------------------------------------ cut preview */

function bindPlayer() {
  const p = $("player");
  p.addEventListener("timeupdate", () => {
    if ($("cutPreview").checked && !p.paused) {
      const t = p.currentTime;
      const hit = deletions().find(([s, e]) => t >= s - 0.02 && t < e - 0.05);
      if (hit) {
        p.currentTime = Math.min(S.duration, hit[1] + 0.02);
        $("playInfo").textContent = `skipped ${fmtTime(hit[0], false)} → ${fmtTime(hit[1], false)}`;
      }
    }
    draw();
  });
  p.addEventListener("seeked", draw);
  p.addEventListener("loadedmetadata", () => {
    if (!S.duration && p.duration) { S.duration = p.duration; S.view.span = S.duration; draw(); }
    // A container can demux while the video track stays undecodable (HEVC
    // without a hardware decoder). Give it a moment, then check for frames.
    setTimeout(() => { if (!p.videoWidth && !p.error) maybeRequestProxy(); }, 1500);
  });
  p.addEventListener("error", () => maybeRequestProxy());
  setInterval(() => { if (!p.paused) draw(); }, 250);
}

/* --------------------------------------------------------------- assets */

async function loadWaveform() {
  try {
    const data = await api("/api/waveform", { method: "POST", body: JSON.stringify({ buckets: 2400 }) });
    S.peaks = data.peaks || [];
    draw();
  } catch (e) { /* waveform is cosmetic */ }
}

async function loadThumbs() {
  try {
    const data = await api("/api/thumbnails", { method: "POST", body: JSON.stringify({ count: 60 }) });
    S.thumbs = data;
    S.thumbImgs = [];
    for (let i = 0; i < data.count; i++) {
      const img = new Image();
      img.src = `/api/thumbnail/thumb_${String(i + 1).padStart(4, "0")}.jpg`;
      img.onload = draw;
      S.thumbImgs.push(img);
    }
    draw();
  } catch (e) { /* filmstrip is cosmetic */ }
}

/* ----------------------------------------------------------------- export */

function updateTally() {
  const dels = deletions();
  const removed = dels.reduce((a, [s, e]) => a + (e - s), 0);
  $("tSrc").textContent = fmtTime(S.duration, false);
  $("tCut").textContent = fmtTime(removed, false);
  $("tOut").textContent = fmtTime(Math.max(0, S.duration - removed), false);
  const kept = S.sections.length - S.selected.size;
  const warn = [];
  if (kept > 200) warn.push("Large number of kept segments; consider selecting fewer sections.");
  if (S.selected.size && S.duration - removed < 0.5) warn.push("Selection removes nearly the whole video.");
  $("planWarn").textContent = warn.join(" ");
  $("exportBtn").disabled = S.selected.size === 0 || !S.project;
}

async function doExport() {
  if (!S.project) return;
  const dels = deletions();
  if (!dels.length) return alert("Select at least one section to delete.");
  const btn = $("exportBtn");
  btn.disabled = true;
  btn.textContent = "Starting…";
  $("jobError").hidden = true;
  $("exportInfo").textContent = "";
  try {
    const job = await api("/api/export", {
      method: "POST",
      body: JSON.stringify({ deletions: dels, output: $("xOutput").value.trim(), opts: collectOpts() }),
    });
    S.job = job;
    $("progWrap").hidden = false;
    $("exportInfo").textContent =
      `Job ${job.id} · ${job.kind} · ${job.segments} kept segments → ${job.output}`;
    pollJob(job.id);
  } catch (e) {
    $("jobError").hidden = false;
    $("jobError").textContent = e.message;
    btn.disabled = false;
    btn.textContent = "Export clean cut";
  }
}

function pollJob(id) {
  clearInterval(S.jobTimer);
  S.jobTimer = setInterval(async () => {
    let job;
    try { job = await api(`/api/job/${id}`); }
    catch (e) { clearInterval(S.jobTimer); return; }
    $("progBar").style.width = `${job.progress}%`;
    $("progPct").textContent = `${job.progress.toFixed(1)}%`;
    $("progMeta").textContent =
      `${job.state} · ${fmtTime(job.elapsed, false)} elapsed` +
      (job.speed ? ` · ${job.speed}` : "") +
      (job.eta ? ` · ETA ${fmtTime(job.eta, false)}` : "") +
      (job.note ? ` · ${job.note}` : "");
    if (job.state === "done") {
      clearInterval(S.jobTimer);
      $("exportBtn").disabled = false;
      $("exportBtn").textContent = "Export clean cut";
      $("exportInfo").innerHTML =
        `✅ Done in ${fmtTime(job.elapsed, false)} → <b>${escapeHtml(job.output)}</b> (${fmtBytes(job.size)})`;
    } else if (job.state === "error") {
      clearInterval(S.jobTimer);
      $("exportBtn").disabled = false;
      $("exportBtn").textContent = "Export clean cut";
      $("jobError").hidden = false;
      $("jobError").textContent = `ffmpeg failed:\n${job.error}\n\ncommand:\n${(job.command || []).join(" ")}`;
    }
  }, 600);
}

/* ------------------------------------------------------------------- boot */

function bindUI() {
  $("openBtn").onclick = () => openPath($("pathInput").value.trim());
  $("demoBtn").onclick = async () => {
    $("fileMeta").textContent = "opening demo…";
    try { onProjectOpen(await api("/api/demo", { method: "POST", body: "{}" })); }
    catch (e) { $("fileMeta").textContent = ""; alert(e.message); }
  };
  $("pathInput").addEventListener("keydown", (e) => { if (e.key === "Enter") openPath(e.target.value.trim()); });
  // The file-browser modal is optional markup: if it is absent, only browsing
  // breaks. Never let a missing element abort the rest of the wiring.
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
    try { onProjectOpen(await api("/api/upload", { method: "POST", body: fd })); }
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
      // keep the raw text so /api/detect can re-parse with the same code path
      S.subsText = await f.text();
      $("dSubPath").value = "";
      $("subInfo").textContent = `${data.count} cues loaded (${f.name})`;
      $("dCues").checked = true;
    } catch (err) { alert(err.message); }
  };

  $("detectBtn").onclick = runDetect;

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

  $("selVisible").onclick = () => setSelection(visibleSections().map((s) => s.id), true);
  $("selNone").onclick = () => setSelection([...S.selected], false);
  $("selInvert").onclick = () => {
    for (const s of visibleSections()) {
      if (S.selected.has(s.id)) S.selected.delete(s.id);
      else S.selected.add(s.id);
    }
    renderList(); updateTally(); draw();
  };
  $("selAllSilence").onclick = () =>
    setSelection(S.sections.filter((s) => s.kind === "silence").map((s) => s.id), true);
  $("selAllCaptions").onclick = () =>
    setSelection(S.sections.filter((s) => s.kind === "caption").map((s) => s.id), true);

  $("zoomIn").onclick = () => zoomBy(0.6);
  $("zoomOut").onclick = () => zoomBy(1.6);
  $("zoomFit").onclick = () => { S.view = { start: 0, span: S.duration }; draw(); };

  $("xMode").onchange = syncQualityRows;
  $("xQuality").onchange = syncQualityRows;
  $("resetOpts").onclick = () => { if (S.project) { applyProfile(S.project.profile); defaultOutput(); } };
  $("exportBtn").onclick = doExport;

  window.addEventListener("resize", draw);
  bindTimeline();
  bindPlayer();
}

(async function boot() {
  bindUI();
  syncQualityRows();
  await loadEnv();
  try {
    // The project is held server-side. Restore it after a browser refresh.
    onProjectOpen(await api("/api/project"));
  } catch (_) {
    // First launch: no source has been opened yet.
  }
  draw();
})();
