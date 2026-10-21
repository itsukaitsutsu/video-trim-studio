/* Inspector panel: one panel for the selected clip and the selected caption.
 *
 * Left-of-the-divider (Clip) carries the old Clip panel split into three
 * modes - Video, Audio, Effect - and right-of-the-divider (Text) carries the
 * caption sections from kconcat: Content, Typography, Text animation, Filler
 * words, Stroke, Layout, Position.
 *
 * clip.js still owns the transform/audio field bindings (same ids, same
 * behaviour); app.js still owns the caption style bindings. This file adds
 * the panel chrome, the derived effect chain, the caption content editor and
 * the filler-word scanner. Plain JS, no build.
 */
"use strict";

const INSP = {
  scope: "clip",         // "clip" | "text"
  mode: "video",         // "video" | "audio" | "effect"
  lastKind: "",          // selection kind seen last (auto-scope)
  lastClipId: "",        // clip the clip-side panes were last built for
  fillerSig: "",         // memo for the (expensive) filler scan
  autoScope: true,       // switch to Text when a caption is picked, Clip for a clip
  textSig: "",           // memo for the caption header/content/filler list
  fillerSel: new Set(),  // selected filler words ("anu", "apa ya", ...)
  inited: false,
};

const INSP_FILLERS = {
  strong: ["eee", "ee", "ehm", "eh", "emm", "um", "uh", "erm", "hmm", "uhm", "mmm"],
  weak: ["anu", "ano", "kayak", "gitu", "terus", "apa ya"],
};

/* ------------------------------------------------------------------ chrome */

function inspSetScope(scope) {
  if (scope !== "clip" && scope !== "text") return;
  INSP.scope = scope;
  document.querySelectorAll("#inspScope [data-insp-scope]").forEach((b) => {
    const on = b.dataset.inspScope === scope;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll("[data-insp-pane]").forEach((p) => {
    p.hidden = p.dataset.inspPane !== scope;
  });
  if (scope === "text") InspectorRefreshText(true);
  else InspectorRefreshClip();
}

function inspSetMode(mode) {
  if (!["video", "audio", "effect"].includes(mode)) return;
  INSP.mode = mode;
  document.querySelectorAll("#inspClipMode [data-insp-mode]").forEach((b) => {
    const on = b.dataset.inspMode === mode;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll("[data-insp-tab]").forEach((p) => {
    p.hidden = p.dataset.inspTab !== mode;
  });
  if (mode === "effect") InspectorEffectsRefresh();
}

// Selecting a caption flips the panel to Text and selecting a clip flips it
// back - the same reflex an editor has, and what kconcat's inspector does.
function inspAutoScope() {
  if (!INSP.autoScope) return;
  const clip = typeof clipSelectedClip === "function" ? clipSelectedClip() : null;
  const cap = S.capSel && (S.capCues || []).some((c) => c.id === S.capSel) ? S.capSel : null;
  const kind = cap && (!clip || !S.sel.has(clip.id)) ? "text" : clip ? "clip" : "";
  if (!kind || kind === INSP.lastKind) return;
  INSP.lastKind = kind;
  inspSetScope(kind);
}

/* --------------------------------------------------------------- clip side */

function InspClipMeta() {
  const el = $("inspScopeMeta");
  if (!el) return;
  const clip = typeof clipSelectedClip === "function" ? clipSelectedClip() : null;
  if (!clip) { el.textContent = ""; return; }
  const track = TLM.isAudioItem(clip) ? `A${TLM.atrackOf(clip) + 1}` : `V${TLM.trackOf(clip) + 1}`;
  el.textContent = `${track} · ${fmtTime(clip.start, false)}–${fmtTime(clip.end, false)}`;
  el.title = "Selected clip";
}

// Every non-default effect value, in the order the export graph applies it.
// `keys` is what the ✕ resets; a row exists only while it changes the picture
// or the sound.
function InspEffectRows(fx, clip) {
  const rows = [];
  const anyCrop = ["crop_l", "crop_t", "crop_r", "crop_b"].some((k) => Number(fx[k]) > 0.001);
  if (anyCrop) {
    rows.push({ ico: "▣", name: "Crop",
      val: `L${fx.crop_l} T${fx.crop_t} R${fx.crop_r} B${fx.crop_b}`,
      keys: ["crop_l", "crop_t", "crop_r", "crop_b"] });
  }
  if (fx.fit !== "fill") {
    rows.push({ ico: "⬚", name: "Fit", val: fx.fit, keys: ["fit"] });
  }
  if (Number(fx.scale) !== 100) {
    rows.push({ ico: "⤢", name: "Scale", val: `${fx.scale}%`, keys: ["scale"] });
  }
  if (Number(fx.x) || Number(fx.y)) {
    rows.push({ ico: "✥", name: "Position", val: `x ${fx.x}% · y ${fx.y}%`, keys: ["x", "y"] });
  }
  if (Number(fx.opacity) !== 100) {
    rows.push({ ico: "◐", name: "Opacity", val: `${fx.opacity}%`, keys: ["opacity"] });
  }
  if (Number(fx.brightness) || Number(fx.contrast) || Number(fx.saturation)) {
    rows.push({ ico: "☀", name: "Look",
      val: `b ${fx.brightness} · c ${fx.contrast} · s ${fx.saturation}`,
      keys: ["brightness", "contrast", "saturation"] });
  }
  if (Number(fx.vfade_in) || Number(fx.vfade_out)) {
    rows.push({ ico: "◑", name: "Video fade",
      val: `${fx.vfade_in}s in · ${fx.vfade_out}s out`, keys: ["vfade_in", "vfade_out"] });
  }
  if (Number(fx.volume) !== 100) {
    rows.push({ ico: "♪", name: "Volume", val: `${fx.volume}%`, keys: ["volume"] });
  }
  if (fx.mute) rows.push({ ico: "✕", name: "Mute", val: "on", keys: ["mute"] });
  if (Number(fx.fade_in) || Number(fx.fade_out)) {
    rows.push({ ico: "≈", name: "Audio fade",
      val: `${fx.fade_in}s in · ${fx.fade_out}s out`, keys: ["fade_in", "fade_out"] });
  }
  const kfs = Array.isArray(clip && clip.kf) ? clip.kf.length : 0;
  if (kfs) rows.push({ ico: "◆", name: "Keyframes", val: `${kfs} marks`, keys: null });
  return rows;
}

function InspectorEffectsRefresh() {
  const chain = $("effChain");
  const clip = typeof clipSelectedClip === "function" ? clipSelectedClip() : null;
  if (!chain) return;
  if (clip && chain.dataset.clip !== clip.id) {
    chain.dataset.clip = clip.id;
  }
  if (!clip) {
    chain.innerHTML = `<div class="eff-empty">Select a clip to see its effect chain.</div>`;
    if ($("effCount")) $("effCount").textContent = "";
    return;
  }
  const fx = TLM.cleanFx(clip.fx || {});
  const rows = InspEffectRows(fx, clip);
  if ($("effCount")) $("effCount").textContent = rows.length ? `${rows.length} active` : "";
  if (!rows.length) {
    chain.innerHTML = `<div class="eff-empty">Nothing applied — the clip renders as it was cut.</div>`;
    return;
  }
  chain.innerHTML = rows.map((r) => {
    const x = r.keys
      ? `<button type="button" data-eff-reset="${r.keys.join(",")}" title="Remove ${r.name} from the chain">×</button>`
      : `<span></span>`;
    return `<div class="eff-row"><span class="eff-ico">${r.ico}</span>` +
      `<span class="eff-name">${r.name}</span>` +
      `<span class="eff-val">${r.val}</span>${x}</div>`;
  }).join("");
}

const INSP_EFFECTS = [
  { id: "pip", name: "Corner PiP", hint: "35% · bottom right",
    patch: { scale: 35, x: 30, y: 30, fit: "contain" } },
  { id: "punch", name: "Zoom punch", hint: "scale 130%", patch: { scale: 130 } },
  { id: "contain", name: "Letterbox", hint: "fit contain", patch: { fit: "contain" } },
  { id: "cover", name: "Fill the box", hint: "fit cover", patch: { fit: "cover" } },
  { id: "fadein", name: "Fade from black", hint: "video · 0.5 s", patch: { vfade_in: 0.5 } },
  { id: "fadeout", name: "Fade to black", hint: "video · 0.5 s", patch: { vfade_out: 0.5 } },
  { id: "ghost", name: "Half opacity", hint: "50%", patch: { opacity: 50 } },
  { id: "mute", name: "Mute sound", hint: "sound off", patch: { mute: true } },
  { id: "duck", name: "Duck audio", hint: "40%", patch: { volume: 40 } },
  { id: "boost", name: "Boost audio", hint: "150%", patch: { volume: 150 } },
];

function inspApplyFx(patch) {
  const clip = typeof clipSelectedClip === "function" ? clipSelectedClip() : null;
  if (!clip) return;
  if (!clip.fx || typeof clip.fx !== "object") clip.fx = TLM.defaultFx();
  Object.assign(clip.fx, patch);
  clip.fx = TLM.cleanFx(clip.fx);
  commitTL();
  refresh();
}

function InspectorRefreshClip() {
  InspClipMeta();
  InspectorEffectsRefresh();
  const clip = typeof clipSelectedClip === "function" ? clipSelectedClip() : null;
  const fx = clip ? TLM.cleanFx(clip.fx || {}) : TLM.defaultFx();
  for (const [rangeId, numId, key] of [
    ["lookB", "lookBn", "brightness"], ["lookC", "lookCn", "contrast"],
    ["lookS", "lookSn", "saturation"],
  ]) {
    const r = $(rangeId), n = $(numId);
    if (r && document.activeElement !== r) r.value = String(fx[key] ?? 0);
    if (n && document.activeElement !== n) n.value = String(fx[key] ?? 0);
  }
}

/* --------------------------------------------------------------- text side */

function inspCueWords(cue) {
  const raw = Array.isArray(cue.words) ? cue.words : [];
  if (raw.length) {
    return raw.map((w, i) => ({ w: String(w.w ?? ""), s: Number(w.s) || cue.start,
      e: Number(w.e) || cue.end, i, est: false }));
  }
  const words = String(cue.text || "").split(/\s+/).filter(Boolean);
  const n = words.length || 1;
  const slot = Math.max(0.001, (cue.end - cue.start) / n);
  return words.map((w, i) => ({ w, s: cue.start + i * slot, e: cue.start + (i + 1) * slot,
    i, est: true }));
}

function inspWordKey(text) {
  return String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").trim();
}

// Scan every caption for filler words. Two-word fillers ("apa ya") win over
// the single-word match at the same position.
function inspScanFillers() {
  const found = new Map();
  for (const cue of S.capCues || []) {
    const ws = inspCueWords(cue);
    for (let i = 0; i < ws.length; i += 1) {
      const one = inspWordKey(ws[i].w);
      if (!one) continue;
      let hit = "";
      if (i + 1 < ws.length) {
        const two = `${one} ${inspWordKey(ws[i + 1].w)}`;
        if (INSP_FILLERS.weak.includes(two)) hit = two;
      }
      if (!hit && INSP_FILLERS.strong.includes(one)) hit = one;
      if (!hit && INSP_FILLERS.weak.includes(one)) hit = one;
      if (!hit) continue;
      const rec = found.get(hit) || { word: hit, strong: INSP_FILLERS.strong.includes(hit),
        count: 0, first: ws[i].s, cues: new Set(), est: true };
      rec.count += 1;
      rec.cues.add(cue.id);
      rec.first = Math.min(rec.first, ws[i].s);
      rec.est = rec.est && ws[i].est;
      found.set(hit, rec);
    }
  }
  return [...found.values()].sort((a, b) => a.first - b.first || b.count - a.count);
}

function inspRenderFillers(list) {
  const box = $("insFillerList");
  if (!box) return;
  const total = list.reduce((n, r) => n + r.count, 0);
  if ($("insFillerCount")) {
    $("insFillerCount").textContent = total ? `${total} in ${new Set(
      list.flatMap((r) => [...r.cues])).size} captions` : "";
  }
  if (!list.length) {
    box.innerHTML = `<div class="filler-empty">No fillers found. Captions with word timings are scanned; imported text is estimated.</div>`;
    return;
  }
  box.innerHTML = list.map((r) => {
    const on = INSP.fillerSel.has(r.word);
    return `<label class="filler-row${r.strong ? " w-strong" : ""}">` +
      `<input type="checkbox" data-filler="${r.word}"${on ? " checked" : ""}>` +
      `<span class="filler-word">${r.word}</span>` +
      `<span class="filler-count">${r.count}×</span>` +
      `<span class="filler-time">${fmtTime(r.first, false)}</span></label>`;
  }).join("");
}

function InspectorRefreshText(force = false) {
  const cue = typeof capActiveCue === "function" ? capActiveCue() : null;
  const meta = $("inspScopeMeta");
  if (meta && INSP.scope === "text") {
    meta.textContent = cue
      ? `caption · ${fmtTime(cue.start, false)}–${fmtTime(cue.end, false)}`
      : (S.capCues.length ? "no caption at the playhead" : "no captions yet");
  }
  const sig = cue ? `${cue.id}|${cue.start}|${cue.end}|${cue.text}|${(cue.words || []).length}`
    : `none|${S.capCues.length}`;
  if (!force && sig === INSP.textSig) return;
  INSP.textSig = sig;

  const name = $("insCapName"), capMeta = $("insCapMeta");
  if (name) {
    name.textContent = cue
      ? `“${(cue.text || "").slice(0, 42)}${(cue.text || "").length > 42 ? "…" : ""}”`
      : "No caption at the playhead";
    name.title = cue ? cue.text || "" : "";
  }
  if (capMeta) {
    capMeta.textContent = cue
      ? `V${TLM.capTrackOf(cue) + 1} · ${(cue.words || []).length
        ? `${cue.words.length} words` : "no word timing"}`
      : `${S.capCues.length} caption${S.capCues.length === 1 ? "" : "s"} on the timeline`;
  }
  const ta = $("insCapText");
  if (ta && document.activeElement !== ta) {
    ta.value = cue ? cue.text || "" : "";
    ta.disabled = !cue;
    ta.placeholder = cue ? "Type the caption text…" : "Put the playhead on a caption to edit its text";
  }
  if ($("insContentInfo")) $("insContentInfo").textContent = cue
    ? `${(cue.text || "").split(/\s+/).filter(Boolean).length} words · ` +
      `style ${cue.style ? "custom" : "default"}` +
      (cue.word_source ? ` · ${cue.word_source}` : "")
    : "";
  const fSig = `${(S.capCues || []).length}:` +
    (S.capCues || []).reduce((n, c) => n + String(c.text || "").length, 0) + ":" +
    (S.capCues || []).reduce((n, c) => n + ((c.words || []).length), 0);
  if (force || fSig !== INSP.fillerSig) {
    INSP.fillerSig = fSig;
    inspRenderFillers(inspScanFillers());
  }
}

/* ------------------------------------------------------------------- init */

function inspBindPair(rangeId, numId, key) {
  const r = $(rangeId), n = $(numId);
  const apply = (raw, commit) => {
    const clip = typeof clipSelectedClip === "function" ? clipSelectedClip() : null;
    if (!clip) return;
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    inspApplyFx({ [key]: v });
    if (commit) ClipRefresh();
  };
  if (r) {
    r.addEventListener("input", () => {
      const clip = typeof clipSelectedClip === "function" ? clipSelectedClip() : null;
      if (!clip) return;
      if (!clip.fx || typeof clip.fx !== "object") clip.fx = TLM.defaultFx();
      clip.fx[key] = Number(r.value);
      clip.fx = TLM.cleanFx(clip.fx);
      if (n && document.activeElement !== n) n.value = r.value;
      syncPreview(false); draw();
    });
    r.addEventListener("change", () => apply(r.value, true));
  }
  if (n) {
    n.addEventListener("input", () => { if (r) r.value = n.value; });
    n.addEventListener("change", () => { if (r) r.value = n.value; apply(n.value, true); });
  }
}

function InspectorInit() {
  if (INSP.inited || !$("inspScope")) return;
  INSP.inited = true;

  document.querySelectorAll("#inspScope [data-insp-scope]").forEach((b) => {
    b.addEventListener("click", () => inspSetScope(b.dataset.inspScope));
  });
  document.querySelectorAll("#inspClipMode [data-insp-mode]").forEach((b) => {
    b.addEventListener("click", () => inspSetMode(b.dataset.inspMode));
  });

  // Effect library
  const lib = $("effLib");
  if (lib) {
    lib.innerHTML = INSP_EFFECTS.map((e) =>
      `<button type="button" class="eff-card" data-eff="${e.id}">` +
      `<b>${e.name}</b><span>${e.hint}</span></button>`).join("");
    lib.addEventListener("click", (ev) => {
      const card = ev.target.closest("[data-eff]");
      if (!card) return;
      const eff = INSP_EFFECTS.find((e) => e.id === card.dataset.eff);
      if (!eff) return;
      inspApplyFx(eff.patch);
      status(`${eff.name} added to the effect chain.`);
    });
  }
  $("effChain")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-eff-reset]");
    if (!btn) return;
    const keys = btn.dataset.effReset.split(",").filter(Boolean);
    const d = TLM.defaultFx();
    const clip = typeof clipSelectedClip === "function" ? clipSelectedClip() : null;
    if (!clip) return;
    if (!clip.fx || typeof clip.fx !== "object") clip.fx = TLM.defaultFx();
    for (const k of keys) clip.fx[k] = d[k];
    clip.fx = TLM.cleanFx(clip.fx);
    commitTL();
    refresh();
    status("Effect removed from the chain.");
  });
  $("effResetAll")?.addEventListener("click", () => {
    const clip = typeof clipSelectedClip === "function" ? clipSelectedClip() : null;
    if (!clip) return;
    clip.fx = TLM.defaultFx();
    commitTL();
    refresh();
    status("All effects reset — keyframes are untouched.");
  });
  $("lookReset")?.addEventListener("click", () => {
    inspApplyFx({ brightness: 0, contrast: 0, saturation: 0 });
  });
  inspBindPair("lookB", "lookBn", "brightness");
  inspBindPair("lookC", "lookCn", "contrast");
  inspBindPair("lookS", "lookSn", "saturation");

  // Content
  const ta = $("insCapText");
  if (ta) {
    ta.addEventListener("focus", () => {
      const cue = typeof capActiveCue === "function" ? capActiveCue() : null;
      if (cue) ta.dataset.orig = cue.text || "";
    });
    ta.addEventListener("input", () => {
      const cue = typeof capActiveCue === "function" ? capActiveCue() : null;
      if (!cue) return;
      cue.text = ta.value;
      if ($("capBoxText")) $("capBoxText").dataset.raw = ta.value;
      if (typeof layoutCapOverlay === "function") layoutCapOverlay();
    });
    ta.addEventListener("change", () => {
      const cue = typeof capActiveCue === "function" ? capActiveCue() : null;
      if (!cue) return;
      const orig = ta.dataset.orig ?? "";
      cue.text = orig;
      setTL(TLM.setCaptionText(S.tl, cue.id, ta.value));
      status("Caption text updated.");
    });
  }
  $("capAdd")?.addEventListener("click", () => {
    if (typeof addCaptionAtPlayhead === "function") addCaptionAtPlayhead();
  });
  $("insCapDel")?.addEventListener("click", () => {
    const cue = typeof capActiveCue === "function" ? capActiveCue() : null;
    if (!cue) return status("No caption at the playhead.");
    S.capSel = null;
    S.sel = new Set();
    setTL(TLM.deleteItems(S.tl, [cue.id], false));
    status("Caption deleted.");
  });
  $("insCapDup")?.addEventListener("click", () => {
    const cue = typeof capActiveCue === "function" ? capActiveCue() : null;
    if (!cue) return status("No caption at the playhead.");
    const r = TLM.addCaptionOnTrack(S.tl, cue.end, cue.text,
      { ...(cue.style || CAPPOS) }, TLM.capTrackOf(cue));
    S.capSel = r.id;
    S.sel = new Set([r.id]);
    setTL(r.tl);
    status("Caption duplicated.");
  });

  // Text animation
  $("insAnimTry")?.addEventListener("click", () => {
    const cue = typeof capActiveCue === "function" ? capActiveCue() : null;
    if (!cue) return status("No caption at the playhead.");
    setPlayhead(cue.start);
    if (typeof startPlayback === "function") startPlayback();
  });
  $("insAnimReset")?.addEventListener("click", () => {
    const cue = typeof capActiveCue === "function" ? capActiveCue() : null;
    applyCaptionStylePatch({ anim_in: "none", anim_words: "none" }, cue);
    if (captionStyleEditTouchesTimeline(cue)) commitCaptions();
    layoutCapOverlay();
    status("Animation cleared.");
  });

  // Filler words
  $("insFillerList")?.addEventListener("change", (ev) => {
    const box = ev.target.closest("input[data-filler]");
    if (!box) return;
    if (box.checked) INSP.fillerSel.add(box.dataset.filler);
    else INSP.fillerSel.delete(box.dataset.filler);
  });
  $("insFillerAll")?.addEventListener("click", () => {
    inspScanFillers().forEach((r) => INSP.fillerSel.add(r.word));
    inspFillerRefresh();
  });
  $("insFillerNone")?.addEventListener("click", () => {
    INSP.fillerSel.clear();
    inspFillerRefresh();
  });
  $("insFillerRemove")?.addEventListener("click", () => {
    const words = [...INSP.fillerSel];
    if (!words.length) return status("Tick a filler word first.");
    const before = (S.capCues || []).length;
    const r = TLM.removeCaptionFillers(S.tl, words);
    if (!r.removed) return status("Nothing to remove — those words are not in the captions.");
    S.capSel = null;
    INSP.fillerSel.clear();
    setTL(r.tl);
    const after = (S.capCues || []).length;
    status(`Removed ${r.removed} filler word${r.removed === 1 ? "" : "s"} from the captions` +
      (before > after ? ` — ${before - after} caption${before - after === 1 ? "" : "s"} emptied.` : "."));
  });

  InspectorRefreshClip();
  InspectorRefreshText(true);
}

function inspFillerRefresh() {
  INSP.textSig = "";
  InspectorRefreshText(true);
}

/* Called from refresh() (timeline.js) after every edit, load and undo, so the
 * clip-side chain, the look sliders, the caption header and the filler list
 * always describe what is selected right now. */
function InspectorOnRefresh() {
  inspAutoScope();
  const clip = typeof clipSelectedClip === "function" ? clipSelectedClip() : null;
  if (clip) {
    if (INSP.lastClipId !== clip.id) {
      INSP.lastClipId = clip.id;
      const want = TLM.isAudioItem(clip) ? "audio" : (INSP.mode === "audio" ? "video" : INSP.mode);
      if (want !== INSP.mode) inspSetMode(want);
    }
  } else {
    INSP.lastClipId = "";
  }
  if (INSP.scope === "text") InspectorRefreshText();
  else InspectorRefreshClip();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", InspectorInit);
} else {
  InspectorInit();
}
