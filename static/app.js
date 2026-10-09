/* Video Trim Studio - frontend. No build step, no CDN, plain JS. */
"use strict";

const $ = (id) => document.getElementById(id);

const S = {
  env: null,
  project: null,
  preview: null,
  tl: { clips: [], caps: [], lanes: 1 },   // edit list of the one video, timeline seconds
  sel: new Set(),                           // selected clip / caption ids
  T: 0,                                     // playhead on the timeline (seconds)
  clip: null,                               // clipboard
  undo: [], redo: [], lastJSON: "",         // history of committed timelines
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
  capSel: null,                             // active caption id (position tools + overlay edit it)
  // Read-only views for the caption overlay code.
  get sections() {
    return this.tl.clips.map((c) => ({ id: c.id, kind: c.kind || "other", start: c.start,
      end: c.end, dur: c.end - c.start, text: c.text || "" }));
  },
  get capCues() { return this.tl.caps; },
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
  fillCaptionCard(S.env.caption);
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
    await onProjectOpen(data);
  } catch (e) {
    $("fileMeta").textContent = "";
    alert(`Could not open:\n${e.message}`);
  }
}

async function restoreLastProject() {
  let saved;
  try { saved = await api("/api/last-project"); }
  catch (_) { return; }
  if (!saved.path) return;

  $("pathInput").value = saved.path;
  $("fileMeta").textContent = "Reopening the last video…";
  try {
    await onProjectOpen(await api("/api/open", {
      method: "POST", body: JSON.stringify({ path: saved.path }),
    }));
  } catch (e) {
    $("fileMeta").textContent = `Couldn't reopen the last video: ${e.message}. Check the path or use Browse to open another.`;
  }
}

/* --------------------------------------------- browser preview (playability) */

let previewTimer = null;
let previewFallbackTried = false;
let timelineAssetsPending = false;

function setPreviewInfo(text) {
  const el = $("previewInfo");
  el.hidden = false;
  el.textContent = text;
}

function hidePreviewInfo() { $("previewInfo").hidden = true; }

function previewProgressMessage(st) {
  const pct = Math.round((st.progress || 0) * 100);
  const labels = {
    h264_amf: "AMD AMF",
    h264_nvenc: "NVIDIA NVENC",
    h264_qsv: "Intel Quick Sync",
    h264_videotoolbox: "VideoToolbox",
    libx264: "CPU x264",
  };
  const details = [];
  if (st.encoder) details.push(labels[st.encoder] || st.encoder);
  const speed = Number(st.speed);
  if (Number.isFinite(speed) && speed > 0) {
    details.push(`${speed.toFixed(1)}× real time`);
    if (S.duration > 0 && pct < 100) {
      const secondsLeft = S.duration * (1 - (st.progress || 0)) / speed;
      details.push(`about ${fmtTime(secondsLeft, false)} left`);
    }
  }
  return `Building a browser-friendly preview… ${pct}%` +
    (details.length ? ` · ${details.join(" · ")}` : "");
}

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
      if (timelineAssetsPending) loadTimelineAssets();
    } else if (st.state === "error") {
      clearInterval(previewTimer); previewTimer = null;
      setPreviewInfo(`Preview could not be built: ${st.error || "ffmpeg failed"}`);
      if (timelineAssetsPending) loadTimelineAssets();
    } else {
      setPreviewInfo(previewProgressMessage(st));
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


/* ------------------------------ caption position preview (CapCut-style) */

// While a burn is armed, a draggable caption box sits on the preview exactly
// where the burned text will land. Dragging shows snap guides at the frame's
// thirds and centre (like CapCut); on release the position is stored and sent
// with the export, which burns a positioned ASS instead of the plain .srt.

function videoContentRect() {
  // The <video> box can letterbox its picture; return the real frame rect
  // relative to .player-wrap so the overlay maps 1:1 onto the burned video.
  const video = $("player"), wrap = video.parentElement;
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const vb = video.getBoundingClientRect(), wb = wrap.getBoundingClientRect();
  const scale = Math.min(vb.width / vw, vb.height / vh);
  const w = vw * scale, h = vh * scale;
  return { x: vb.left - wb.left + (vb.width - w) / 2,
           y: vb.top - wb.top + (vb.height - h) / 2, w, h };
}

function capActiveCuesAt(t) {
  return S.capCues.filter((c) => c.start <= t && t <= c.end);
}

function capActiveCue() {
  const act = capActiveCuesAt(playheadTime());
  return act.find((c) => c.id === S.capSel) || act[0] || null;
}

// The position tools edit the selected on-screen caption; when no caption is
// on screen they edit the document default (also used for brand-new cues).
function capStyleTarget() {
  const cue = capActiveCue();
  return cue ? cue.style : CAPPOS;
}

function styleCapBoxEl(el, st, r) {
  el.style.left = `${st.x * 100}%`;
  el.style.top = `${st.y * 100}%`;
  el.style.fontSize = `${Math.max(10, r.h * st.size_pct / 100)}px`;
  el.style.width = `${Math.max(0.08, st.box_w) * r.w}px`;
  el.style.textAlign = st.align === "justify" ? "left" : st.align;
}

function layoutCapOverlay() {
  const overlay = $("capOverlay");
  if (!overlay) return;
  const armed = ["burn", "both"].includes($("xCaptions").value) && !!S.project;
  overlay.hidden = !armed;
  if (!armed) return;
  const t = playheadTime();
  if (!S.capCues.length && $("capBoxText").dataset.raw === undefined)
    $("capBoxText").dataset.raw = captionTextAt(t);
  const r = videoContentRect();
  overlay.style.left = `${r.x}px`;
  overlay.style.top = `${r.y}px`;
  overlay.style.width = `${r.w}px`;
  overlay.style.height = `${r.h}px`;

  const active = S.capCues.length ? capActiveCue() : null;
  const st = active ? active.style : CAPPOS;

  // Static siblings: the OTHER captions sharing this frame, each rendered in
  // its own stored style so stacked captions preview exactly as burned.
  overlay.querySelectorAll(".cap-static").forEach((n) => n.remove());
  if (S.capCues.length) {
    for (const c of capActiveCuesAt(t)) {
      if (c === active) continue;
      const d = document.createElement("div");
      d.className = "cap-static";
      styleCapBoxEl(d, c.style, r);
      d.textContent = c.text || "";
      overlay.appendChild(d);
    }
  }

  const box = $("capBox");
  styleCapBoxEl(box, st, r);
  if (active) $("capBoxText").dataset.raw = active.text || "";
  const fontPx = Math.max(10, r.h * st.size_pct / 100);
  const maxChars = Math.floor((st.box_w * r.w) / (fontPx * CHAR_FACTOR));
  renderCaptionLines(
    wrapText($("capBoxText").dataset.raw || "Caption preview", maxChars),
    st.align);
  $("capPosInfo").textContent =
    `x ${Math.round(st.x * 100)}% \u00b7 y ${Math.round(st.y * 100)}%` +
    ` \u00b7 w ${Math.round(st.box_w * 100)}% \u00b7 ${st.align}` +
    (active ? ` \u00b7 "${(active.text || "").slice(0, 16)}"`
            : (S.capCues.length ? " \u00b7 default (no caption on screen)" : ""));
  if (document.activeElement !== $("capFontSize"))
    $("capFontSize").value = String(st.size_pct);
  syncAlignButtons();
}

function renderCaptionLines(lines, align) {
  // CSS text-align:justify is unreliable here (our lines end in forced
  // breaks), so justify is rendered the same way the burn does it: words
  // placed across the full box width, last line left-aligned.
  const container = $("capBoxText");
  if (align === "justify" && lines.length > 1) {
    container.textContent = "";
    lines.forEach((ln, i) => {
      const row = document.createElement("div");
      row.className = "cap-line";
      row.style.justifyContent = i < lines.length - 1 ? "space-between" : "flex-start";
      ln.split(" ").forEach((w) => {
        const sp = document.createElement("span");
        sp.textContent = w;
        row.appendChild(sp);
      });
      container.appendChild(row);
    });
  } else {
    container.textContent = lines.join("\n");
  }
}

function wrapText(text, maxChars) {
  // Greedy word wrap mirroring vts/captionmap.wrap_lines (same CHAR_FACTOR),
  // so the preview breaks lines exactly where the burn will.
  if (!maxChars || maxChars < 4) return [String(text)];
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const cand = cur ? cur + " " + w : w;
    if (cand.length <= maxChars) { cur = cand; continue; }
    if (cur) lines.push(cur);
    let rest = w;
    while (rest.length > maxChars) { lines.push(rest.slice(0, maxChars)); rest = rest.slice(maxChars); }
    cur = rest;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

function captionTextAt(t) {
  const sec = S.sections.find((s) => s.kind === "caption" && s.start <= t && t <= s.end);
  return sec && sec.text ? sec.text : "Caption preview";
}


function syncAlignButtons() {
  document.querySelectorAll(".capAlign").forEach((b) =>
    b.classList.toggle("on", b.dataset.align === capStyleTarget().align));
}

function bindCaptionResize() {
  // Dragging a box edge changes its width around the centre (CapCut-style
  // resize); the text re-wraps because layoutCapOverlay re-runs.
  document.querySelectorAll("#capBox .cap-handle").forEach((handle) => {
    handle.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      handle.setPointerCapture(ev.pointerId);
      handle.classList.add("active");
      const overlay = $("capOverlay");
      const st = capStyleTarget();
      const move = (e) => {
        const r = overlay.getBoundingClientRect();
        if (!r.width) return;
        const cx = st.x * r.width;
        const half = Math.abs((e.clientX - r.left) - cx);
        st.box_w = Math.min(0.98, Math.max(0.12, (2 * half) / r.width));
        layoutCapOverlay();
      };
      const up = (e) => {
        handle.releasePointerCapture?.(e.pointerId);
        handle.classList.remove("active");
        if (st !== CAPPOS) commitCaptions();
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  });
}

function bindCaptionOverlay() {
  const box = $("capBox"), overlay = $("capOverlay");
  const SNAP_PX = 8;
  const SNAP_X = [1 / 3, 0.5, 2 / 3], SNAP_Y = [1 / 3, 0.5, 2 / 3];

  box.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    box.setPointerCapture(ev.pointerId);
    box.classList.add("dragging");
    const st = capStyleTarget();
    const move = (e) => {
      const r = overlay.getBoundingClientRect();
      if (!r.width || !r.height) return;
      let nx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      let ny = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      let sx = null, sy = null;
      for (const v of SNAP_X) if (Math.abs(nx - v) * r.width < SNAP_PX) { sx = v; break; }
      for (const v of SNAP_Y) if (Math.abs(ny - v) * r.height < SNAP_PX) { sy = v; break; }
      $("guideV").hidden = sx === null;
      $("guideH").hidden = sy === null;
      if (sx !== null) { $("guideV").style.left = `${sx * 100}%`; nx = sx; }
      if (sy !== null) { $("guideH").style.top = `${sy * 100}%`; ny = sy; }
      st.x = nx; st.y = ny;
      box.style.left = `${nx * 100}%`;
      box.style.top = `${ny * 100}%`;
      $("capPosInfo").textContent =
        `x ${Math.round(nx * 100)}% \u00b7 y ${Math.round(ny * 100)}%`;
    };
    const up = (e) => {
      box.releasePointerCapture?.(e.pointerId);
      box.classList.remove("dragging");
      if (st !== CAPPOS) commitCaptions();
      $("guideV").hidden = true;
      $("guideH").hidden = true;
      box.removeEventListener("pointermove", move);
      box.removeEventListener("pointerup", up);
      box.removeEventListener("pointercancel", up);
      layoutCapOverlay();
    };
    box.addEventListener("pointermove", move);
    box.addEventListener("pointerup", up);
    box.addEventListener("pointercancel", up);
  });

  $("capFontSize").addEventListener("input", () => {
    capStyleTarget().size_pct =
      Number($("capFontSize").value) || CAPPOS_DEFAULT.size_pct;
    layoutCapOverlay();
  });
  $("capFontSize").addEventListener("change", () => {
    if (capStyleTarget() !== CAPPOS) commitCaptions();
  });
  $("capPosReset").onclick = () => {
    const st = capStyleTarget();
    Object.assign(st, CAPPOS_DEFAULT);
    $("capFontSize").value = String(CAPPOS_DEFAULT.size_pct);
    syncAlignButtons();
    layoutCapOverlay();
    if (st !== CAPPOS) commitCaptions();
  };
  document.querySelectorAll(".capAlign").forEach((b) => {
    b.addEventListener("click", () => {
      const st = capStyleTarget();
      st.align = b.dataset.align;
      syncAlignButtons();
      layoutCapOverlay();
      if (st !== CAPPOS) commitCaptions();
    });
  });
  bindCaptionResize();
  $("capBox").addEventListener("dblclick", (ev) => {
    ev.preventDefault();                       // no word-select/focus side effects
    startOverlayCaptionEdit();
  });
  $("player").addEventListener("timeupdate", () => {
    if ($("capOverlay").hidden || CAP_EDITING) return;
    if (!S.capCues.length)
      $("capBoxText").dataset.raw = captionTextAt(playheadTime());
    layoutCapOverlay();
  });
  $("player").addEventListener("loadedmetadata", layoutCapOverlay);
  window.addEventListener("resize", layoutCapOverlay);
}

/* ------------------------------------------------------------ auto-caption */

const CAP = { job: null, timer: null, poll: 700, editorSig: null,
              fwStatus: null, wcpp: null };
// Caption burn position: normalised centre of the box on the frame.
const CAPPOS_DEFAULT = { x: 0.5, y: 0.88, size_pct: 5.5, align: "center", box_w: 0.7 };
// Must match CHAR_FACTOR in vts/captionmap.py - both sides wrap text with
// it, which is what keeps the preview and the burn in sync.
const CHAR_FACTOR = 0.55;
const CAPPOS = { ...CAPPOS_DEFAULT };

function fillCaptionCard(caption) {
  if (!caption) return;
  const model = $("cModel"), lang = $("cLang"), dev = $("cDevice"), comp = $("cCompute");
  fillSelect(model, caption.models.map((m) => m.name), "medium");
  // Annotate the model list with size + note for the tooltip.
  caption.models.forEach((m, i) => {
    if (model.options[i]) model.options[i].title = `${m.size} — ${m.note}`;
  });
  fillSelect(lang, caption.languages.map((l) => l.code), "auto");
  caption.languages.forEach((l, i) => {
    if (lang.options[i]) lang.options[i].textContent = `${l.code} — ${l.name}`;
  });
  fillSelect(dev, caption.devices, caption.status.default_device || "cpu");
  fillSelect(comp, caption.compute_types, "auto");
  CAP.fwStatus = caption.status;
  CAP.wcpp = caption.whispercpp || null;
  renderWcppPanel();

  const st = caption.status;
  if (!st.available) {
    // Spell out *which* interpreter needs the package: installing it with a
    // different Python (system pip vs the app's .venv) is the usual reason this
    // card still shows the warning.
    $("capUnavailable").hidden = false;
    $("capUnavailable").innerHTML =
      "Auto-caption needs the optional <b>faster-whisper</b> package.<br>" +
      "Install it into the Python this app is running on:" +
      `<br><code class="cmd">${escapeHtml(st.install || "python -m pip install faster-whisper")}</code>` +
      (st.executable ? `<br><span class="small">app interpreter: ${escapeHtml(st.executable)}</span>` : "") +
      "<br>Then press <b>Re-check</b> below (a restart is only needed if the command " +
      "above failed).";
    $("capRecheck").hidden = false;
  } else {
    $("capUnavailable").hidden = true;
    $("capRecheck").hidden = true;
  }
  updateEngineUI();
}

/* --------------------------------------------------- whisper.cpp engine UI */

function engineIsWcpp() {
  return $("cEngine") && $("cEngine").value === "whispercpp";
}

function renderWcppPanel() {
  const w = CAP.wcpp;
  if (!w) return;
  const wModel = $("wModel"), wDl = $("wDlSelect");
  wModel.textContent = "";
  (w.models || []).forEach((m) => {
    const o = document.createElement("option");
    o.value = m.name;
    o.textContent = `${m.name} (${Math.round(m.size_bytes / 1048576)} MB on disk)`;
    wModel.appendChild(o);
  });
  if (!wModel.options.length) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = "no GGML models yet - download one below";
    wModel.appendChild(o);
  }
  wDl.textContent = "";
  (w.catalog || []).filter((c) => !c.present).forEach((c) => {
    const o = document.createElement("option");
    o.value = c.name; o.textContent = `${c.name} (${c.size})`;
    wDl.appendChild(o);
  });
  $("wDlBtn").disabled = !wDl.options.length;
  $("wcppStatus").innerHTML = w.available
    ? `whisper-cli found: <code>${escapeHtml(w.cli_path || "")}</code><br>` +
      `${w.models.length} model(s) in <code>${escapeHtml(w.models_dir || "")}</code>`
    : "<b>whisper-cli not found.</b> Build whisper.cpp (see hint below), then put " +
      "the binary in <code>tools/</code> next to the app, add it to PATH, or set " +
      "<code>VTS_WHISPER_CLI</code> to its full path.";
  $("wcppHint").innerHTML =
    "AMD GPU (RX 6000-series etc.): build with <code>cmake -DGGML_VULKAN=ON</code> " +
    '- Vulkan runs on Windows and Linux. Source: ' +
    '<a href="https://github.com/ggml-org/whisper.cpp" target="_blank" ' +
    'rel="noopener">ggml-org/whisper.cpp</a>';
}

function syncCapButton() {
  const btn = $("capBtn");
  if (engineIsWcpp()) {
    const w = CAP.wcpp || {};
    const ok = !!w.available && (w.models || []).length > 0;
    btn.disabled = !ok;
    btn.textContent = ok ? "Transcribe with whisper.cpp"
      : (!w.available ? "whisper-cli not found" : "download a GGML model first");
  } else {
    const st = CAP.fwStatus || { available: false };
    btn.disabled = !st.available;
    btn.textContent = st.available ? "Transcribe to captions" : "Auto-caption unavailable";
  }
}

function updateEngineUI() {
  const wcpp = engineIsWcpp();
  $("wcppPanel").hidden = !wcpp;
  ["rowFwModel", "rowFwDevice", "rowFwCompute"].forEach((id) => { $(id).hidden = wcpp; });
  $("fwOnlyChecks").hidden = wcpp;
  syncCapButton();
  $("capNote").textContent = wcpp
    ? "whisper.cpp engine - uses the Vulkan GPU backend when the binary is built with it"
    : (CAP.fwStatus && CAP.fwStatus.available
        ? `faster-whisper ${CAP.fwStatus.version}` +
          (CAP.fwStatus.cuda_devices ? ` · ${CAP.fwStatus.cuda_devices} CUDA device(s) detected`
                                     : " · CPU only (no CUDA device)")
        : "");
}

async function downloadWcppModel() {
  const name = $("wDlSelect").value;
  if (!name) return;
  const btn = $("wDlBtn");
  btn.disabled = true; btn.textContent = "Starting…";
  $("wDlProg").hidden = false;
  $("wDlBar").style.width = "0%";
  $("wDlPct").textContent = "0%";
  $("wDlNote").textContent = "";
  let job;
  try {
    job = await api("/api/whispercpp/download", {
      method: "POST", body: JSON.stringify({ model: name }),
    });
  } catch (e) {
    btn.disabled = false; btn.textContent = "Download";
    $("wDlNote").textContent = e.message;
    return;
  }
  const timer = setInterval(async () => {
    try {
      const j = await api(`/api/caption/${job.id}`);
      $("wDlBar").style.width = `${j.progress || 0}%`;
      $("wDlPct").textContent = `${Math.floor(j.progress || 0)}%`;
      $("wDlNote").textContent = j.note || "";
      if (j.state !== "running") {
        clearInterval(timer);
        btn.disabled = false; btn.textContent = "Download";
        $("wDlNote").textContent =
          j.state === "done" ? (j.note || "done") : (j.error || j.note || j.state);
        CAP.wcpp = await api("/api/whispercpp/status");
        renderWcppPanel();
        syncCapButton();
      }
    } catch (e) {
      clearInterval(timer);
      btn.disabled = false; btn.textContent = "Download";
      $("wDlNote").textContent = e.message;
    }
  }, CAP.poll);
}

function stopCaptionPolling() {
  if (CAP.timer) { clearInterval(CAP.timer); CAP.timer = null; }
}

function captionOptions() {
  const opts = {
    engine: $("cEngine").value,
    model: $("cModel").value,
    language: $("cLang").value,
    device: $("cDevice").value,
    compute_type: $("cCompute").value,
    translate_to_english: $("cTranslate").checked,
    vad: $("cVad").checked,
    word_timestamps: $("cWords").checked,
    temperature_fallback: $("cTemp").checked,
    normalize_audio: $("cNorm").checked,
    keep_audio: $("cKeep").checked,
    burn: $("cBurn").checked,
    beam_size: Number($("cBeam").value) || 1,
    initial_prompt: $("cPrompt").value.trim() || null,
    output_dir: $("cOutDir").value.trim() || null,
  };
  if (opts.engine === "whispercpp") opts.model = $("wModel").value;
  return opts;
}

function resetCaptionCard() {
  // A new video means the old transcript no longer describes this file.
  stopCaptionPolling();
  CAP.job = null;
  CAP.editorSig = null;
  S.subsText = null;
  $("capEditor").hidden = true;
  $("capProgWrap").hidden = true;
  $("capTail").hidden = true;
  $("capTail").textContent = "";
  $("capCancel").hidden = true;
  $("capResult").hidden = true;
  $("capError").hidden = true;
  $("capError").textContent = "";
  const available = !!(S.env && S.env.caption && S.env.caption.status.available);
  $("capNote").textContent = available
    ? "ready — transcription runs locally, nothing is uploaded"
    : "";
  $("capBtn").disabled = !available;
  $("capBtn").textContent = available ? "Transcribe to captions" : "Auto-caption unavailable";
  $("cOutDir").value = "";
}

async function startCaption() {
  if (!S.project) return alert("Open a video first.");
  $("capEditor").hidden = true;
  CAP.editorSig = null;
  const btn = $("capBtn");
  btn.disabled = true;
  btn.textContent = "Starting…";
  $("capError").hidden = true;
  $("capResult").hidden = true;
  $("capTail").hidden = false;
  $("capTail").textContent = "";
  $("capProgWrap").hidden = false;
  $("capCancel").hidden = false;
  $("capNote").textContent = "preparing…";
  try {
    const job = await api("/api/caption", {
      method: "POST", body: JSON.stringify(captionOptions()),
    });
    renderCaptionJob(job);
    stopCaptionPolling();
    CAP.timer = setInterval(pollCaption, CAP.poll);
  } catch (e) {
    captionFailed(e.message);
  }
}

async function pollCaption() {
  if (!CAP.job) return;
  try {
    renderCaptionJob(await api(`/api/caption/${CAP.job.id}`));
  } catch (e) {
    stopCaptionPolling();
    captionFailed(e.message);
  }
}

function renderCaptionJob(job) {
  CAP.job = job;
  const active = job.state === "running";
  const pct = Math.max(0, Math.min(100, Number(job.progress) || 0));
  $("capBar").style.width = `${pct}%`;
  $("capPct").textContent = `${pct.toFixed(0)}%`;
  const bits = [];
  if (job.stage) bits.push(job.stage);
  if (job.speed) bits.push(`${job.speed.toFixed(1)}x realtime`);
  if (job.eta) bits.push(`ETA ${fmtTime(job.eta, false)}`);
  if (job.elapsed) bits.push(`${fmtTime(job.elapsed, false)} elapsed`);
  $("capMeta").textContent = bits.join(" · ");
  $("capNote").textContent = job.note || "";

  if (job.tail && job.tail.length) {
    $("capTail").innerHTML = job.tail.map((t) =>
      `<span class="line"><b>${escapeHtml(t.t)}</b> ${escapeHtml(t.text)}</span>`).join("");
    $("capTail").scrollTop = $("capTail").scrollHeight;
  }

  if (active) {
    $("capBtn").textContent = "Transcribing…";
    return;
  }

  stopCaptionPolling();
  $("capCancel").hidden = true;
  $("capBtn").disabled = false;
  $("capBtn").textContent = job.state === "manual" ? "Transcribe to captions" : "Transcribe again";
  $("capProgWrap").hidden = job.state !== "done";
  if (job.state === "done" || job.state === "manual") captionDone(job);
  else if (job.state === "cancelled") $("capNote").textContent = "Cancelled.";
  else captionFailed(job.error || "transcription failed");
}

function captionDone(job) {
  const out = job.outputs || {};
  const files = ["srt", "vtt", "json"].filter((k) => out[k]).map((k) => out[k]);
  const unsaved = job.state === "manual" && !job.edited
    ? "<br>(files are written when you press <b>Save captions</b>)" : "";
  $("capOut").innerHTML = files.map((p) => escapeHtml(p)).join("<br>") +
    (out.video ? `<br>burned copy: ${escapeHtml(out.video)}` : "") + unsaved;
  $("capResult").hidden = false;
  maybeRenderEditor(job);
  // Pre-fill the subtitle path either way, so the plain Detect button works too.
  if (out.srt) {
    S.subsText = job.cues_text || null;
    $("dSubPath").value = out.srt;
    $("dCues").checked = true;
    const origin = job.state === "manual" ? "from captions" : "from transcription";
    $("subInfo").textContent = `${job.segment_count || 0} cues ${origin}`;
  updateCaptionExportInfo();
  }
}

function captionFailed(message) {
  stopCaptionPolling();
  $("capBtn").disabled = false;
  $("capBtn").textContent = "Transcribe to captions";
  $("capProgWrap").hidden = true;
  $("capCancel").hidden = true;
  $("capError").hidden = false;
  $("capError").textContent = message;
  $("capNote").textContent = "";
}

async function cancelCaption() {
  if (!CAP.job) return;
  try { renderCaptionJob(await api(`/api/caption/${CAP.job.id}/cancel`, { method: "POST" })); }
  catch (e) { captionFailed(e.message); }
}

async function useCaptions() {
  if (!CAP.job) return;
  if (!$("capEditor").hidden) {
    const ok = await saveCues(true);
    if (!ok) return;
  }
  const out = CAP.job.outputs || {};
  S.subsText = CAP.job.cues_text || null;
  if (out.srt) $("dSubPath").value = out.srt;
  $("dCues").checked = true;
  $("subInfo").textContent = `${CAP.job.segment_count || 0} cues ready for detection`;
  updateCaptionExportInfo();
  await runDetect();
}


/* -------------------------------------------------- caption cue editor */

// Rows are plain DOM inputs; CAP.job.cues is the last copy the server
// confirmed. Rows are only rebuilt when that confirmed copy changes (see the
// signature check), so polling or a save response never clobbers text the
// user is still typing.

function cueRow(cue, idx) {
  return `<tr>
    <td class="num">${idx + 1}</td>
    <td><input type="number" class="cue-start" step="0.1" min="0" value="${cue.start}"></td>
    <td><input type="number" class="cue-end" step="0.1" min="0" value="${cue.end}"></td>
    <td><input type="text" class="cue-text" spellcheck="false" value="${escapeHtml(cue.text || "")}"></td>
    <td><button class="mini cue-del" title="delete this cue">&times;</button></td>
  </tr>`;
}

function renderCueRows(cues) {
  $("capCueBody").innerHTML = cues.map((c, i) => cueRow(c, i)).join("");
  $("capEdCount").textContent = `${cues.length} cue(s)`;
}

function collectCues() {
  return [...$("capCueBody").querySelectorAll("tr")].map((tr, i) => ({
    n: i + 1,
    start: parseFloat(tr.querySelector(".cue-start").value),
    end: parseFloat(tr.querySelector(".cue-end").value),
    text: tr.querySelector(".cue-text").value,
  }));
}

function renumberCues() {
  [...$("capCueBody").querySelectorAll("tr")].forEach((tr, i) => {
    tr.querySelector(".num").textContent = i + 1;
  });
  $("capEdCount").textContent = `${$("capCueBody").children.length} cue(s)`;
}

function maybeRenderEditor(job) {
  const ed = $("capEditor");
  if (!job || (job.state !== "done" && job.state !== "manual") || !Array.isArray(job.cues)) {
    ed.hidden = true;
    return;
  }
  ed.hidden = false;
  const sig = `${job.id}:${job.edited_at || 0}:${job.cues.length}`;
  if (CAP.editorSig === sig) return;   // keep whatever the user is typing
  CAP.editorSig = sig;
  renderCueRows(job.cues);
  $("capSaved").textContent = job.edited
    ? `saved ${job.cues.length} cue(s) at ${new Date(job.edited_at * 1000).toLocaleTimeString()}`
    : (job.state === "manual" ? "not saved yet — press Save captions" : "");
}

function addCueRow() {
  // A fresh cue starts where the last one ends (or at 0) and runs two seconds.
  const valid = collectCues().filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end));
  const start = valid.length ? Math.max(...valid.map((c) => c.end)) : 0;
  $("capCueBody").insertAdjacentHTML(
    "beforeend",
    cueRow({ start: Math.round(start * 1000) / 1000, end: Math.round(start * 1000) / 1000 + 2, text: "" },
           $("capCueBody").children.length));
  renumberCues();
}

function revertCues() {
  if (!CAP.job || !Array.isArray(CAP.job.cues)) return;
  renderCueRows(CAP.job.cues);
  $("capSaved").textContent = "reverted to the last saved version";
}

async function saveCues(silent) {
  if (!CAP.job) return false;
  const cues = collectCues();
  const bad = cues.find((c) =>
    !Number.isFinite(c.start) || !Number.isFinite(c.end) || c.end <= c.start || c.start < 0);
  if (bad) {
    alert(`Cue ${bad.n}: check the times — end must be after start (values are seconds).`);
    return false;
  }
  const btn = $("capSave");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const job = await api(`/api/caption/${CAP.job.id}/cues`, {
      method: "PUT", body: JSON.stringify({ cues }),
    });
    CAP.job = job;
    CAP.editorSig = `${job.id}:${job.edited_at || 0}:${job.cues.length}`;
    renderCueRows(job.cues);           // normalised copy (sorted, trimmed)
    $("capSaved").textContent =
      `saved ${job.cues.length} cue(s) at ${new Date(job.edited_at * 1000).toLocaleTimeString()}`;
    if (job.outputs && job.outputs.srt) {
      S.subsText = job.cues_text || null;
      $("dSubPath").value = job.outputs.srt;
      $("dCues").checked = true;
      $("subInfo").textContent = `${job.segment_count || 0} cues (edited)`;
  updateCaptionExportInfo();
    }
    return true;
  } catch (e) {
    if (!silent) alert("Could not save captions: " + e.message);
    return false;
  } finally {
    btn.disabled = false; btn.textContent = "Save captions";
  }
}

async function newBlankCaptions() {
  if (!S.project) return alert("Open a video first.");
  try {
    const job = await api("/api/caption/manual", { method: "POST", body: "{}" });
    CAP.editorSig = null;
    renderCaptionJob(job);
    addCueRow();                       // one empty row so editing can start at once
  } catch (e) { alert(e.message); }
}

async function openCaptionsFile() {
  if (!S.project) return alert("Open a video first.");
  // The file next to the video is the usual sidecar; ask only when absent.
  let path = S.project.sidecar_subtitles;
  if (!path) path = prompt("Path to the .srt / .vtt file:");
  if (!path) return;
  try {
    const job = await api("/api/caption/manual", {
      method: "POST", body: JSON.stringify({ load: path }),
    });
    CAP.editorSig = null;
    renderCaptionJob(job);
  } catch (e) { alert(e.message); }
}


/* ---------------------------------------- inline caption editing (list) */

// Double-click a caption row in the section list to edit its text in place.
// Enter or leaving the field saves; Escape cancels. The edit is written back
// into the subtitle file (.srt/.vtt) so re-detection and exports keep it.

function seekIntoCue(start, end) {
  // Land just *inside* the cue: seeking exactly to `start` (or before it)
  // shows the previous frame and the caption is not visible in the preview.
  return Math.min(start + 0.05, Math.max(start, end - 0.001));
}

let CAP_EDITING = false;

/* --------------------------------------------------------------- detection */


/* ------------------------------------------------------------ section list */

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ------------------------------------------------------------- timeline UI */




/* ------------------------------------------- caption timeline lane editing */


/* ------------------------------------------------------------ cut preview */

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

function loadTimelineAssets() {
  timelineAssetsPending = false;
  loadWaveform();
  loadThumbs();
}


/* ------------------------------------------------- export caption status */

/* ----------------------------------------------------------------- export */

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
        (job.note ? `⚠ ${escapeHtml(job.note)}<br>` : "") +
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

(async function boot() {
  bindUI();
  syncQualityRows();
  await loadEnv();
  try {
    // The active project survives a browser refresh while the server is running.
    await onProjectOpen(await api("/api/project"));
  } catch (_) {
    // A restart clears the in-memory project. Restore its saved source path.
    await restoreLastProject();
  }
  draw();
})();
