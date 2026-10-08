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
  resetCaptionCard();
  $("detectInfo").textContent = "";
  $("exportBtn").disabled = true;
  // These FFmpeg scans compete for CPU and disk with a required proxy build.
  // Defer cosmetic timeline assets until the browser-friendly copy is ready.
  timelineAssetsPending = S.preview.mode === "proxy" && !S.preview.ready;
  if (!timelineAssetsPending) loadTimelineAssets();
}

/* --------------------------------------------- browser preview (playability) */

let previewTimer = null;
let previewFallbackTried = false;
let timelineAssetsPending = false;
let checklistDrag = null;
let suppressChecklistClick = false;
let suppressChecklistSelection = false;

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

function layoutCapOverlay() {
  const overlay = $("capOverlay");
  if (!overlay) return;
  const armed = ["burn", "both"].includes($("xCaptions").value) && !!S.project;
  overlay.hidden = !armed;
  if (!armed) return;
  if ($("capBoxText").dataset.raw === undefined) $("capBoxText").dataset.raw =
    captionTextAt($("player").currentTime || 0);
  const r = videoContentRect();
  overlay.style.left = `${r.x}px`;
  overlay.style.top = `${r.y}px`;
  overlay.style.width = `${r.w}px`;
  overlay.style.height = `${r.h}px`;
  const box = $("capBox");
  box.style.left = `${CAPPOS.x * 100}%`;
  box.style.top = `${CAPPOS.y * 100}%`;
  const fontPx = Math.max(10, r.h * CAPPOS.size / 100);
  box.style.fontSize = `${fontPx}px`;
  box.style.width = `${Math.max(0.08, CAPPOS.box_w) * r.w}px`;
  box.style.textAlign = CAPPOS.align === "justify" ? "left" : CAPPOS.align;
  const maxChars = Math.floor((CAPPOS.box_w * r.w) / (fontPx * CHAR_FACTOR));
  renderCaptionLines(
    wrapText($("capBoxText").dataset.raw || "Caption preview", maxChars));
  $("capPosInfo").textContent =
    `x ${Math.round(CAPPOS.x * 100)}% \u00b7 y ${Math.round(CAPPOS.y * 100)}%` +
    ` \u00b7 w ${Math.round(CAPPOS.box_w * 100)}% \u00b7 ${CAPPOS.align}`;
}

function renderCaptionLines(lines) {
  // CSS text-align:justify is unreliable here (our lines end in forced
  // breaks), so justify is rendered the same way the burn does it: words
  // placed across the full box width, last line left-aligned.
  const container = $("capBoxText");
  if (CAPPOS.align === "justify" && lines.length > 1) {
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
    b.classList.toggle("on", b.dataset.align === CAPPOS.align));
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
      const move = (e) => {
        const r = overlay.getBoundingClientRect();
        if (!r.width) return;
        const cx = CAPPOS.x * r.width;
        const half = Math.abs((e.clientX - r.left) - cx);
        CAPPOS.box_w = Math.min(0.98, Math.max(0.12, (2 * half) / r.width));
        layoutCapOverlay();
      };
      const up = (e) => {
        handle.releasePointerCapture?.(e.pointerId);
        handle.classList.remove("active");
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
      CAPPOS.x = nx; CAPPOS.y = ny;
      box.style.left = `${nx * 100}%`;
      box.style.top = `${ny * 100}%`;
      $("capPosInfo").textContent =
        `x ${Math.round(nx * 100)}% \u00b7 y ${Math.round(ny * 100)}%`;
    };
    const up = (e) => {
      box.releasePointerCapture?.(e.pointerId);
      box.classList.remove("dragging");
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
    CAPPOS.size = Number($("capFontSize").value) || CAPPOS_DEFAULT.size;
    layoutCapOverlay();
  });
  $("capPosReset").onclick = () => {
    Object.assign(CAPPOS, CAPPOS_DEFAULT);
    $("capFontSize").value = String(CAPPOS_DEFAULT.size);
    syncAlignButtons();
    layoutCapOverlay();
  };
  document.querySelectorAll(".capAlign").forEach((b) => {
    b.addEventListener("click", () => {
      CAPPOS.align = b.dataset.align;
      syncAlignButtons();
      layoutCapOverlay();
    });
  });
  bindCaptionResize();
  $("player").addEventListener("timeupdate", () => {
    if ($("capOverlay").hidden) return;
    $("capBoxText").dataset.raw = captionTextAt($("player").currentTime);
    layoutCapOverlay();
  });
  $("player").addEventListener("loadedmetadata", layoutCapOverlay);
  window.addEventListener("resize", layoutCapOverlay);
}

/* ------------------------------------------------------------ auto-caption */

const CAP = { job: null, timer: null, poll: 700, editorSig: null };
// Caption burn position: normalised centre of the box on the frame.
const CAPPOS_DEFAULT = { x: 0.5, y: 0.88, size: 5.5, align: "center", box_w: 0.7 };
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
  $("capBtn").disabled = !st.available;
  $("capBtn").textContent = st.available
    ? "Transcribe to captions" : "Auto-caption unavailable";
  if (st.available) {
    $("capNote").textContent =
      `faster-whisper ${st.version}` +
      (st.cuda_devices ? ` · ${st.cuda_devices} CUDA device(s) detected` : " · CPU only (no CUDA device)");
  }
}

function stopCaptionPolling() {
  if (CAP.timer) { clearInterval(CAP.timer); CAP.timer = null; }
}

function captionOptions() {
  return {
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

function startCaptionEdit(section, tr) {
  if (section.kind !== "caption" || tr.querySelector(".txt input")) return;
  const cell = tr.querySelector(".txt");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "txt-edit";
  input.value = section.text || "";
  cell.textContent = "";
  cell.appendChild(input);
  input.focus();
  input.select();
  // Bring the cue being edited on screen: seek into it (only when the
  // playhead is currently outside it, so editing mid-cue never jumps).
  const player = $("player");
  const now = player.currentTime || 0;
  if (now < section.start || now >= section.end) {
    player.currentTime = seekIntoCue(section.start, section.end);
  }
  // Live-sync the preview box with what is typed here, so the list edit and
  // the caption preview stay in step (wrapping/position visible while typing).
  const syncPreview = () => {
    const t = player.currentTime || 0;
    if (t >= section.start && t < section.end && !$("capOverlay").hidden) {
      $("capBoxText").dataset.raw = input.value;
      layoutCapOverlay();
    }
  };
  input.addEventListener("input", syncPreview);
  syncPreview();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const value = input.value.replace(/\s+/g, " ").trim();
    if (commit && value !== (section.text || "")) commitCaptionEdit(section, value);
    else renderList();                 // redraw restores the plain cell
  };
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") finish(true);
    else if (ev.key === "Escape") finish(false);
  });
  input.addEventListener("click", (ev) => ev.stopPropagation());
  input.addEventListener("blur", () => finish(true));
}

async function commitCaptionEdit(section, newText) {
  section.text = newText;
  renderList();
  const path = ($("dSubPath").value || "").trim();
  if (!path) {
    // Uploaded subtitle text has no file on disk, so the edit cannot persist.
    $("subInfo").textContent =
      "edit kept in memory only — set a subtitle file path to save edits";
    return;
  }
  try {
    const res = await api("/api/subtitles/edit", {
      method: "POST",
      body: JSON.stringify({ path, start: section.start, end: section.end, text: newText }),
    });
    const name = res.path.split(/[\\/]/).pop();
    $("subInfo").textContent =
      `saved to ${name} (${res.updated} cue${res.updated === 1 ? "" : "s"} updated)`;
    // The file on disk is now newer than any cached copy: force detection to
    // re-read it, and keep the caption card's editor on the same page.
    S.subsText = null;
    if (CAP.job && CAP.job.outputs && CAP.job.outputs.srt === path) {
      CAP.job.cues = (CAP.job.cues || []).map((c) =>
        (c.start < section.end - 1e-6 && c.end > section.start + 1e-6)
          ? { ...c, text: newText } : c);
      CAP.job.cues_text = null;
      CAP.editorSig = null;
    }
  } catch (e) {
    $("subInfo").textContent = `edit not saved: ${e.message}`;
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
      `<td class="check-cell" title="Hold and drag to select or clear several sections"><input type="checkbox" ${S.selected.has(s.id) ? "checked" : ""}></td>` +
      `<td class="tc">${fmtTime(s.start)}</td>` +
      `<td class="tc">${fmtTime(s.end)}</td>` +
      `<td class="tc">${s.dur.toFixed(2)}s</td>` +
      `<td><span class="badge ${s.kind}">${s.kind}</span></td>` +
      `<td class="txt">${escapeHtml(s.text || (s.kind === "silence" ? "— silence —" : "— uncaptioned audio —"))}</td>`;
    tr.querySelector("input").onclick = (ev) => {
      ev.stopPropagation();
      toggleSection(s.id, ev.target.checked);
    };
    tr.addEventListener("click", (ev) => {
      if (ev.target.closest(".check-cell")) return;     // checkbox has its own handler
      if (tr.querySelector(".txt input")) return;       // editing: never seek
      // Clicking the caption text IS the edit affordance (double-click works
      // too). It deliberately does not seek, so typing can start at once.
      if (s.kind === "caption" && ev.target.closest("td.txt")) {
        startCaptionEdit(s, tr);
        return;
      }
      const player = $("player");
      // Seek INTO the cue so the preview shows the frame where this caption
      // is visible (not the one before it). no focus(): no page jump.
      player.currentTime = Math.max(0, seekIntoCue(s.start, s.end));
      draw();
    });
    tr.addEventListener("dblclick", () => {
      if (s.kind === "caption") startCaptionEdit(s, tr);
    });
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

function setChecklistRow(tr, on) {
  const id = Number(tr.dataset.id);
  if (!Number.isInteger(id)) return false;
  const changed = S.selected.has(id) !== on;
  if (on) S.selected.add(id); else S.selected.delete(id);
  tr.classList.toggle("sel", on);
  const checkbox = tr.querySelector('input[type="checkbox"]');
  if (checkbox) checkbox.checked = on;
  return changed;
}

function bindChecklistDrag() {
  const tbody = $("secTable").querySelector("tbody");

  tbody.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || ev.isPrimary === false) return;
    const input = ev.target.closest('input[type="checkbox"]');
    const cell = ev.target.closest("td");
    if (!input && (!cell || cell.cellIndex !== 0)) return;
    const tr = (input || cell).closest("tr[data-id]");
    if (!tr) return;

    // We paint the checkbox states ourselves; prevent native text selection and
    // a second toggle when the browser emits click on pointer-up.
    ev.preventDefault();
    ev.stopPropagation();
    const id = Number(tr.dataset.id);
    const on = !S.selected.has(id);
    checklistDrag = { pointerId: ev.pointerId, on, lastId: id };
    suppressChecklistClick = true;
    suppressChecklistSelection = on;
    if (setChecklistRow(tr, on)) { updateTally(); draw(); }
  });

  window.addEventListener("pointermove", (ev) => {
    const drag = checklistDrag;
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const target = document.elementFromPoint(ev.clientX, ev.clientY);
    const tr = target && target.closest("#secTable tbody tr[data-id]");
    if (!tr || !tbody.contains(tr)) return;
    const id = Number(tr.dataset.id);
    if (id === drag.lastId) return;
    drag.lastId = id;
    if (setChecklistRow(tr, drag.on)) { updateTally(); draw(); }
  });

  const finishDrag = (ev) => {
    if (!checklistDrag || ev.pointerId !== checklistDrag.pointerId) return;
    checklistDrag = null;
    // A click (if any) follows pointerup in the same event cycle. If the user
    // dragged off the list and no click follows, clear suppression next turn.
    setTimeout(() => { suppressChecklistClick = false; }, 0);
  };
  window.addEventListener("pointerup", finishDrag);
  window.addEventListener("pointercancel", finishDrag);

  document.addEventListener("click", (ev) => {
    if (!suppressChecklistClick) return;
    const tr = ev.target.closest?.("#secTable tbody tr[data-id]");
    if (!tr) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    if (setChecklistRow(tr, suppressChecklistSelection)) { updateTally(); draw(); }
    suppressChecklistClick = false;
  }, true);
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
  document.addEventListener("keydown", (ev) => {
    if (ev.code !== "Space" || ev.repeat || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const target = ev.target;
    const tag = target && target.tagName;
    const type = target && target.type;
    // Leave Space available for typing, native checkbox/radio toggles, and
    // focused buttons. Everywhere else it acts like a video player shortcut.
    if (target && (target.isContentEditable || tag === "TEXTAREA" || tag === "SELECT" ||
        (tag === "INPUT" && !["checkbox", "radio", "button", "submit", "reset"].includes(type)) ||
        target.matches?.("input[type=checkbox], input[type=radio]") ||
        target.closest?.("button, [role=button]"))) return;
    if (!p.hasAttribute("src")) return;
    ev.preventDefault();
    if (p.paused) {
      const playPromise = p.play();
      if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
    } else {
      p.pause();
    }
  });

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

function loadTimelineAssets() {
  timelineAssetsPending = false;
  loadWaveform();
  loadThumbs();
}


/* ------------------------------------------------- export caption status */

function updateCaptionExportInfo() {
  const el = $("xCapInfo");
  if (!el) return;
  const mode = $("xCaptions").value;
  const path = ($("dSubPath").value || "").trim();
  $("capStyleRow").hidden = !(mode === "burn" || mode === "both");
  layoutCapOverlay();
  if (mode === "none") { el.textContent = ""; return; }
  if (!path) {
    el.textContent = "no subtitle file set — pick one in the Detect card " +
      "(or run Auto-caption) before exporting";
    return;
  }
  const bits = [`source: ${path}`];
  if (mode === "burn" || mode === "both")
    bits.push("burning re-encodes, even in stream-copy mode");
  bits.push("cues are shifted to match the cuts");
  el.textContent = bits.join(" · ");
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
      body: JSON.stringify({
        deletions: dels,
        output: $("xOutput").value.trim(),
        opts: collectOpts(),
        subtitles_path: $("dSubPath").value.trim() || null,
        caption_mode: $("xCaptions").value,
        caption_style: ["burn", "both"].includes($("xCaptions").value)
          ? { x: CAPPOS.x, y: CAPPOS.y, size_pct: CAPPOS.size,
              align: CAPPOS.align, box_w: CAPPOS.box_w } : {},
      }),
    });
    S.job = job;
    $("progWrap").hidden = false;
    const cap = job.captions
      ? ` · captions: ${job.captions.cues_out}/${job.captions.cues_in} cues` +
        (job.captions.mode === "burn" || job.captions.mode === "both" ? " burned in" : "") +
        (job.captions.positioned ? " at your preview position" : "") +
        ` → ${job.captions.srt.split(/[\\/]/).pop()}`
      : "";
    $("exportInfo").textContent =
      (job.note ? `⚠ ${job.note} ` : "") +
      `Job ${job.id} · ${job.kind} · ${job.segments} kept segments → ${job.output}` + cap;
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

function bindUI() {
  $("openBtn").onclick = () => openPath($("pathInput").value.trim());
  $("demoBtn").onclick = async () => {
    $("fileMeta").textContent = "opening demo…";
    try { onProjectOpen(await api("/api/demo", { method: "POST", body: "{}" })); }
    catch (e) { $("fileMeta").textContent = ""; alert(e.message); }
  };
  $("speechDemoBtn").onclick = async () => {
    $("fileMeta").textContent = "opening speech demo…";
    try { onProjectOpen(await api("/api/demo/speech", { method: "POST", body: "{}" })); }
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
      // The server kept a copy in work/: that file is the source of truth, so
      // inline edits can save back into it (imported captions are editable).
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
  bindChecklistDrag();
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
