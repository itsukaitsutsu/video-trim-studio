/* Clip panel: Transform / Crop / Audio / Fades / Keyframes for the selected
 * timeline clip. Loaded after timeline.js; refresh() and setPlayhead() call
 * ClipRefresh(), and the playback loop calls ClipTick(). Plain JS, no build. */
"use strict";

let CLIP_BOUND = false;

// The panel edits the selected video clip, or - when the selection is a sound
// on an A lane - that audio item (its transform controls simply do nothing).
function clipSelectedClip() {
  if (!S.project || !S.tl) return null;
  for (const id of S.sel) {
    const c = (S.tl.clips || []).find((x) => x.id === id);
    if (c) return c;
  }
  for (const id of S.sel) {
    const a = (S.tl.auds || []).find((x) => x.id === id);
    if (a) return a;
  }
  return null;
}

function clipIsAudioItem(clip) { return !!clip && TLM.isAudioItem(clip); }

function clipEnsureFx(clip) {
  if (!clip.fx || typeof clip.fx !== "object") clip.fx = TLM.defaultFx();
  if (!Array.isArray(clip.kf)) clip.kf = [];
  return clip;
}

// Live-apply while dragging (no history spam); commit once on release.
function clipBindPair(rangeId, numId, get, set, fmt) {
  const r = $(rangeId), n = $(numId);
  if (!r && !n) return;
  const show = (v) => (fmt ? fmt(v) : v);
  const apply = (raw, commit) => {
    const clip = clipSelectedClip();
    if (!clip) return;
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    clipEnsureFx(clip);
    set(clip.fx, v);
    clip.fx = TLM.cleanFx(clip.fx);
    if (commit) { commitTL(); refresh(); }
    else { draw(); syncPreview(false); }
  };
  if (r) {
    r.addEventListener("input", () => { apply(r.value, false); if (n && document.activeElement !== n) n.value = show(Number(r.value)); });
    r.addEventListener("change", () => { apply(r.value, true); });
  }
  if (n) {
    n.addEventListener("input", () => { apply(n.value, false); if (r) r.value = n.value; });
    n.addEventListener("change", () => { apply(n.value, true); ClipRefresh(); });
  }
}

function clipBindCheck(id, get, set) {
  const el = $(id);
  if (!el) return;
  el.addEventListener("change", () => {
    const clip = clipSelectedClip();
    if (!clip) return;
    clipEnsureFx(clip);
    set(clip.fx, el.checked);
    clip.fx = TLM.cleanFx(clip.fx);
    commitTL();
    refresh();
  });
}

function clipSetPair(rangeId, numId, value) {
  const r = $(rangeId), n = $(numId);
  if (r && document.activeElement !== r) r.value = value;
  if (n && document.activeElement !== n) n.value = value;
}

function ClipRefresh() {
  if (!CLIP_BOUND) return;
  // The Inspector owns the panel chrome, the effect chain and the text side.
  if (typeof InspectorRefreshClip === "function") InspectorRefreshClip();
  const clip = clipSelectedClip();
  const empty = $("toolEmpty"), body = $("toolBody");
  if (!empty || !body) return;
  if (!clip) {
    empty.hidden = false;
    body.hidden = true;
    const anySel = S.sel && S.sel.size > 0;
    empty.textContent = anySel
      ? "That selection is a caption — select a video clip (V1…) to edit picture and sound."
      : "Select a video clip on the timeline to edit it.";
    return;
  }
  empty.hidden = true;
  body.hidden = false;
  clipEnsureFx(clip);
  const isAud = clipIsAudioItem(clip);
  const fx = TLM.cleanFx(clip.fx);
  const len = clip.end - clip.start;
  $("toolClipName").textContent = clip.text ? `“${clip.text}”`
    : clip.name || mediaName(clip.src) || `clip ${clip.id.slice(0, 6)}`;
  $("toolClipMeta").textContent =
    `${isAud ? `A${TLM.atrackOf(clip) + 1}` : `V${TLM.trackOf(clip) + 1}`} · ` +
    `${fmtTime(clip.start, false)}–${fmtTime(clip.end, false)} ` +
    `(${fmtTime(len, false)}) · src ${fmtTime(clip.in, false)}` +
    (isAud ? " · audio only" : "");
  $("txTrack").textContent = isAud ? `A${TLM.atrackOf(clip) + 1}` : `V${TLM.trackOf(clip) + 1}`;

  const srcEl = $("txSource");
  if (srcEl) {
    const asset = MEDIA.assets.get(clip.src || TLM.MAIN_SRC);
    srcEl.textContent = asset
      ? `${asset.name} · ${asset.kind}${asset.width ? ` · ${asset.width}×${asset.height}` : ""}` +
        (asset.id === TLM.MAIN_SRC ? " (main)" : "")
      : (clip.src || TLM.MAIN_SRC);
  }
  if ($("txFit")) $("txFit").value = fx.fit || "fill";
  // Linked sound: offer to hand it to its own lane, or put it back.
  const unlink = $("txUnlinkAudio");
  if (unlink) {
    if (isAud && clip.from) {
      unlink.textContent = "Relink audio";
      unlink.title = "Put this sound back on the picture it came from";
      unlink.disabled = false;
    } else if (isAud) {
      unlink.textContent = "Remove";
      unlink.title = "Remove this audio item";
      unlink.disabled = false;
    } else if (clip.audio === false) {
      unlink.textContent = "Relink audio";
      unlink.title = "Put the sound back on the picture (drops the A-lane item)";
      unlink.disabled = false;
    } else {
      unlink.textContent = "Unlink audio";
      unlink.title = "Move this clip's sound onto its own A lane";
      unlink.disabled = !mediaHasAudio(clip.src || TLM.MAIN_SRC);
    }
  }
  const lane = $("txAudioLane");
  if (lane) {
    if (!isAud && clip.audio !== false) {
      const linked = TLM.linkedAudioOf(S.tl, clip.id);
      lane.textContent = linked ? `unlinked → A${TLM.atrackOf(linked) + 1}` : `linked on A${TLM.trackOf(clip) + 1}`;
    } else if (isAud && clip.from) {
      lane.textContent = "from a video clip";
    } else {
      lane.textContent = "";
    }
  }
  clipSetPair("txX", "txXn", fx.x);
  clipSetPair("txY", "txYn", fx.y);
  clipSetPair("txS", "txSn", fx.scale);
  clipSetPair("txO", "txOn", fx.opacity);
  clipSetPair(null, "tcL", fx.crop_l);
  clipSetPair(null, "tcT", fx.crop_t);
  clipSetPair(null, "tcR", fx.crop_r);
  clipSetPair(null, "tcB", fx.crop_b);
  clipSetPair("taV", "taVn", fx.volume);
  if ($("taMute") && document.activeElement !== $("taMute")) $("taMute").checked = !!fx.mute;
  clipSetPair(null, "taFi", fx.fade_in);
  clipSetPair(null, "taFo", fx.fade_out);
  clipSetPair(null, "tvFi", fx.vfade_in);
  clipSetPair(null, "tvFo", fx.vfade_out);
  clipRenderKf(clip);
  ClipTick();
}

function clipRenderKf(clip) {
  const list = $("tkList"), count = $("tkCount");
  if (!list) return;
  const kfs = TLM.cleanKf(clip.kf, clip.end - clip.start);
  if (count) count.textContent = kfs.length ? `(${kfs.length})` : "";
  if (!kfs.length) {
    list.innerHTML = `<div class="dim small">No keyframes — the Transform values above apply to the whole clip.</div>`;
    return;
  }
  list.innerHTML = kfs.map((k, i) =>
    `<div class="kf-row" data-i="${i}">` +
    `<button class="mini kf-goto" data-i="${i}" title="Move the playhead here">◆ ${k.t.toFixed(2)}s</button>` +
    `<label title="X %">x<input data-k="x" data-i="${i}" type="number" step="1" value="${k.x}"></label>` +
    `<label title="Y %">y<input data-k="y" data-i="${i}" type="number" step="1" value="${k.y}"></label>` +
    `<label title="Scale %">s<input data-k="scale" data-i="${i}" type="number" step="1" value="${k.scale}"></label>` +
    `<label title="Opacity %">o<input data-k="opacity" data-i="${i}" type="number" step="1" value="${k.opacity}"></label>` +
    `<button class="mini kf-del" data-i="${i}" title="Delete this keyframe">×</button>` +
    `</div>`
  ).join("");
}

function clipAddKeyframe() {
  const clip = clipSelectedClip();
  if (!clip) return;
  clipEnsureFx(clip);
  const len = clip.end - clip.start;
  const rel = Math.round((playheadTime() - clip.start) * 1000) / 1000;
  if (rel < -0.001 || rel > len + 0.001) {
    status("Move the playhead onto the selected clip first.");
    return;
  }
  const t = Math.max(0, Math.min(len, rel));
  const cur = TLM.evalFxAt(clip, playheadTime());
  const kfs = TLM.cleanKf(clip.kf, len).filter((k) => Math.abs(k.t - t) > 0.001);
  kfs.push({ t, x: cur.x, y: cur.y, scale: cur.scale, opacity: cur.opacity });
  clip.kf = TLM.cleanKf(kfs, len);
  commitTL();
  refresh();
  status(`Keyframe ◆ at ${t.toFixed(2)}s in the clip.`);
}

function ClipTick() {
  if (!CLIP_BOUND) return;
  const info = $("tkInfo");
  const clip = clipSelectedClip();
  if (!info || !clip) return;
  const rel = playheadTime() - clip.start;
  const on = rel >= 0 && rel <= clip.end - clip.start;
  const kfs = TLM.cleanKf(clip.kf, clip.end - clip.start);
  const near = kfs.find((k) => Math.abs(k.t - rel) < 0.06);
  info.textContent = on
    ? (near ? `Playhead ◆ ${near.t.toFixed(2)}s (on a keyframe)` : `Playhead ${rel.toFixed(2)}s in the clip`)
    : "Playhead is outside this clip";
}

function clipResetGroup(keys) {
  const clip = clipSelectedClip();
  if (!clip) return;
  clipEnsureFx(clip);
  const d = TLM.defaultFx();
  for (const k of keys) clip.fx[k] = d[k];
  commitTL();
  refresh();
}

function ClipInit() {
  if (CLIP_BOUND || !$("toolBody")) return;
  CLIP_BOUND = true;
  clipBindPair("txX", "txXn", null, (fx, v) => { fx.x = v; });
  clipBindPair("txY", "txYn", null, (fx, v) => { fx.y = v; });
  clipBindPair("txS", "txSn", null, (fx, v) => { fx.scale = v; });
  clipBindPair("txO", "txOn", null, (fx, v) => { fx.opacity = v; });
  clipBindPair(null, "tcL", null, (fx, v) => { fx.crop_l = v; });
  clipBindPair(null, "tcT", null, (fx, v) => { fx.crop_t = v; });
  clipBindPair(null, "tcR", null, (fx, v) => { fx.crop_r = v; });
  clipBindPair(null, "tcB", null, (fx, v) => { fx.crop_b = v; });
  clipBindPair("taV", "taVn", null, (fx, v) => { fx.volume = v; });
  clipBindCheck("taMute", null, (fx, v) => { fx.mute = v; });
  clipBindPair(null, "taFi", null, (fx, v) => { fx.fade_in = v; });
  clipBindPair(null, "taFo", null, (fx, v) => { fx.fade_out = v; });
  clipBindPair(null, "tvFi", null, (fx, v) => { fx.vfade_in = v; });
  clipBindPair(null, "tvFo", null, (fx, v) => { fx.vfade_out = v; });

  $("txTrackDown").onclick = () => {
    const clip = clipSelectedClip();
    if (clip) setTL(TLM.moveItems(S.tl, [clip.id], 0, 0, -1, -1));
  };
  $("txTrackUp").onclick = () => {
    const clip = clipSelectedClip();
    if (clip) setTL(TLM.moveItems(S.tl, [clip.id], 0, 0, 1, 1));
  };
  if ($("txFit")) {
    $("txFit").addEventListener("change", () => {
      const clip = clipSelectedClip();
      if (!clip) return;
      clipEnsureFx(clip);
      clip.fx.fit = $("txFit").value;
      clip.fx = TLM.cleanFx(clip.fx);
      commitTL();
      refresh();
    });
  }
  const preset = (patch) => {
    const clip = clipSelectedClip();
    if (!clip) return;
    clipEnsureFx(clip);
    Object.assign(clip.fx, patch);
    clip.fx = TLM.cleanFx(clip.fx);
    commitTL();
    refresh();
  };
  if ($("txFillFrame")) {
    $("txFillFrame").onclick = () => preset({ scale: 100, x: 0, y: 0, fit: "fill" });
  }
  if ($("txCorner")) {
    $("txCorner").onclick = () => preset({ scale: 35, x: 30, y: 30, fit: "contain", opacity: 100 });
  }
  if ($("txUnlinkAudio")) {
    $("txUnlinkAudio").onclick = () => {
      const clip = clipSelectedClip();
      if (!clip) return;
      if (clipIsAudioItem(clip) && clip.from) {
        // Relink: put the sound back on its picture.
        setTL(TLM.relinkClipAudio(S.tl, clip.from));
        S.sel = new Set([clip.from]);
        syncCapSel();
        refresh(true);
        status("Sound relinked to its clip.");
      } else if (clipIsAudioItem(clip)) {
        setTL(TLM.deleteItems(S.tl, [clip.id], false));
        S.sel = new Set();
        refresh(true);
      } else if (clip.audio === false) {
        setTL(TLM.relinkClipAudio(S.tl, clip.id));
        refresh(true);
        status("Sound relinked to the clip.");
      } else {
        const r = TLM.unlinkClipAudio(S.tl, clip.id);
        setTL(r.tl);
        status(`Sound unlinked — it is now on A${TLM.trackOf(clip) + 1}. Drag it along the lane to slide it.`);
      }
    };
  }
  $("txReset").onclick = () => clipResetGroup(["x", "y", "scale", "opacity"]);
  $("tcReset").onclick = () => clipResetGroup(["crop_l", "crop_t", "crop_r", "crop_b"]);
  $("taReset").onclick = () => clipResetGroup(["volume", "mute", "fade_in", "fade_out"]);
  $("tvReset").onclick = () => clipResetGroup(["vfade_in", "vfade_out"]);
  $("tkAdd").onclick = clipAddKeyframe;
  $("tkClear").onclick = () => {
    const clip = clipSelectedClip();
    if (!clip) return;
    clip.kf = [];
    commitTL();
    refresh();
  };
  $("tkList").addEventListener("click", (ev) => {
    const clip = clipSelectedClip();
    if (!clip) return;
    const btn = ev.target.closest("button");
    if (!btn) return;
    const i = Number(btn.dataset.i);
    const kfs = TLM.cleanKf(clip.kf, clip.end - clip.start);
    if (!(i >= 0 && i < kfs.length)) return;
    if (btn.classList.contains("kf-del")) {
      kfs.splice(i, 1);
      clip.kf = kfs;
      commitTL();
      refresh();
    } else if (btn.classList.contains("kf-goto")) {
      setPlayhead(clip.start + kfs[i].t);
    }
  });
  $("tkList").addEventListener("change", (ev) => {
    const clip = clipSelectedClip();
    const inp = ev.target.closest("input[data-k]");
    if (!clip || !inp) return;
    const i = Number(inp.dataset.i);
    const kfs = TLM.cleanKf(clip.kf, clip.end - clip.start);
    if (!(i >= 0 && i < kfs.length)) return;
    const v = Number(inp.value);
    if (!Number.isFinite(v)) { ClipRefresh(); return; }
    kfs[i][inp.dataset.k] = v;
    clip.kf = TLM.cleanKf(kfs, clip.end - clip.start);
    commitTL();
    refresh();
  });
  ClipRefresh();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", ClipInit);
} else {
  ClipInit();
}
