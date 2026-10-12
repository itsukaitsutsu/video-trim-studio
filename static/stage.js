/* Program monitor: composite every video track under the playhead.
 *
 * The old preview drove a single <video> and showed only the topmost clip, so
 * overlapping tracks (B-roll, picture-in-picture) were invisible and the
 * playhead fought the element's own clock. This module keeps one layer per
 * visible clip, stacks them in track order (V1 bottom, Vn top) and mirrors
 * each clip's transform / crop / fit / opacity / fades with CSS that matches
 * what vts/edl.py builds for the export.
 *
 * Master clock: the timeline playhead S.T is authoritative and is advanced by
 * the wall clock in pvTick(). Layers are nudged onto it whenever they drift,
 * so a stalled or slow element can never drag the playhead backwards - which
 * is what used to make the preview jump and desynchronise.
 *
 * Audio is not flattened either: each layer's <video> keeps its own volume
 * (fades included) and unlinked sounds get their own <audio>, so the browser
 * mixes them the way amix does on export.
 */
"use strict";

const STAGE = {
  box: null,             // #stageLayers
  layers: new Map(),     // clip id -> layer record
  free: [],              // idle layer elements, reused to avoid re-decoding
  audios: new Map(),     // audio item id -> <audio>
  freeAudios: [],
  syncing: false,
};

// A layer is hard-seeked once it drifts further than this. Small enough that
// the eye never notices, large enough that we are not seeking every frame.
const STAGE_DRIFT_PLAY = 0.09;
const STAGE_DRIFT_PAUSE = 0.008;

function stageContainer() {
  if (STAGE.box && STAGE.box.isConnected) return STAGE.box;
  const stage = $("previewStage");
  if (!stage) return null;
  let box = $("stageLayers");
  if (!box) {
    box = document.createElement("div");
    box.id = "stageLayers";
    // Below #gapShade (z 1) and #capOverlay (z 2), above the stage background.
    box.className = "stage-layers";
    const shade = $("gapShade");
    stage.insertBefore(box, shade || stage.firstChild);
  }
  STAGE.box = box;
  return box;
}

function stageMakeLayer(kind) {
  const layer = document.createElement("div");
  layer.className = "fx-layer";
  const box = document.createElement("div");
  box.className = "fx-box";
  const media = document.createElement(kind === "image" ? "img" : "video");
  media.className = "fx-media";
  if (kind !== "image") {
    media.preload = "auto";
    media.playsInline = true;
    media.disableRemotePlayback = true;
    // Never let one layer's "ended" stop the master playback clock.
    media.addEventListener("ended", () => {});
    media.addEventListener("error", () => { layer.dataset.error = "1"; });
  } else {
    media.addEventListener("error", () => { layer.dataset.error = "1"; });
  }
  box.appendChild(media);
  layer.appendChild(box);
  return { layer, box, media, kind, src: "", asset: "" };
}

function stageAcquire(clip, kind) {
  let rec = STAGE.layers.get(clip.id);
  if (rec && rec.kind === kind) return rec;
  if (rec) stageRelease(clip.id);
  // Prefer an idle layer that already holds the asset this clip needs: it is
  // decoded and buffered, so swapping clips costs a seek, not a reload.
  const want = mediaUrl(clip.src || TLM.MAIN_SRC);
  let idle = STAGE.free.findIndex((f) => f.kind === kind && f.src === want);
  if (idle < 0) idle = STAGE.free.findIndex((f) => f.kind === kind);
  if (idle >= 0) rec = STAGE.free.splice(idle, 1)[0];
  else rec = stageMakeLayer(kind);
  rec.error = false;
  delete rec.layer.dataset.error;
  STAGE.layers.set(clip.id, rec);
  return rec;
}

function stageRelease(id) {
  const rec = STAGE.layers.get(id);
  if (!rec) return;
  STAGE.layers.delete(id);
  try { rec.media.pause(); } catch (_) { /* not a media element */ }
  rec.layer.remove();
  // Keep rec.src: an idle layer that already holds this asset is reused as-is
  // (see stageAcquire) and re-assigning .src would reload the file from
  // scratch, which is what made the monitor flash blank at every clip change.
  rec.asset = "";
  if (STAGE.free.length < 8) STAGE.free.push(rec);
}

function stageAcquireAudio() {
  const idle = STAGE.freeAudios.pop();
  if (idle) return idle;
  const el = document.createElement("audio");
  el.preload = "auto";
  el.className = "fx-audio";
  return el;
}

function stageReleaseAudio(id) {
  const el = STAGE.audios.get(id);
  if (!el) return;
  STAGE.audios.delete(id);
  try { el.pause(); } catch (_) { /* nothing playing */ }
  el.remove();
  if (STAGE.freeAudios.length < 8) STAGE.freeAudios.push(el);
}

/* ---------------------------------------------------------------- geometry */

// Mirror of vts/fx.py: the layer's box is the frame scaled by `scale`, and the
// media inside it is enlarged/offset so the crop window lines up with the
// region ffmpeg cuts out of the source.
function stageLayout(rec, fx) {
  const s = Math.max(0.01, (Number(fx.scale) || 100) / 100);
  const boxW = 100 * s, boxH = 100 * s;
  rec.box.style.width = `${boxW.toFixed(4)}%`;
  rec.box.style.height = `${boxH.toFixed(4)}%`;
  rec.box.style.left = `${((100 - boxW) / 2).toFixed(4)}%`;
  rec.box.style.top = `${((100 - boxH) / 2).toFixed(4)}%`;

  const cl = Math.min(45, Math.max(0, Number(fx.crop_l) || 0)) / 100;
  const cr = Math.min(45, Math.max(0, Number(fx.crop_r) || 0)) / 100;
  const ct = Math.min(45, Math.max(0, Number(fx.crop_t) || 0)) / 100;
  const cb = Math.min(45, Math.max(0, Number(fx.crop_b) || 0)) / 100;
  const fw = Math.max(0.1, 1 - cl - cr);
  const fh = Math.max(0.1, 1 - ct - cb);
  rec.media.style.width = `${(100 / fw).toFixed(4)}%`;
  rec.media.style.height = `${(100 / fh).toFixed(4)}%`;
  rec.media.style.left = `${(-100 * cl / fw).toFixed(4)}%`;
  rec.media.style.top = `${(-100 * ct / fh).toFixed(4)}%`;
  rec.media.style.objectFit = fx.fit === "contain" ? "contain" : fx.fit === "cover" ? "cover" : "fill";
}

function stageDriveMedia(el, want, playing, force) {
  if (el.tagName !== "VIDEO" && el.tagName !== "AUDIO") return;
  const drift = Math.abs((el.currentTime || 0) - want);
  const tol = playing ? STAGE_DRIFT_PLAY : STAGE_DRIFT_PAUSE;
  if (force || drift > tol) {
    if (el.readyState >= 1 || el.seekable === undefined) {
      try { el.currentTime = want; } catch (_) { /* metadata not loaded yet */ }
    }
  }
  if (playing) {
    if (el.paused && el.readyState >= 2) {
      const pr = el.play();
      if (pr && pr.catch) pr.catch(() => {});
    }
  } else if (!el.paused) {
    el.pause();
  }
}

function stageVolume(fx, env) {
  if (fx.mute) return 0;
  return Math.max(0, Math.min(1, (Number(fx.volume) || 0) / 100 * env));
}

/* ------------------------------------------------------------------- sync */

/**
 * Draw the composite at timeline time `t`.
 * Called from syncPreview() on every playhead change and on every animation
 * frame while playing.
 */
function stageSync(t, playing, force) {
  const box = stageContainer();
  if (!box || !S.project) return;
  if (STAGE.syncing) return;
  STAGE.syncing = true;
  try {
    const stack = TLM.clipStackAt(S.tl, t);
    const live = new Set(stack.map((c) => c.id));
    for (const id of [...STAGE.layers.keys()]) {
      if (!live.has(id)) stageRelease(id);
    }

    stack.forEach((clip) => {
      const asset = MEDIA.assets.get(clip.src || TLM.MAIN_SRC);
      const kind = asset ? asset.kind : "video";
      const rec = stageAcquire(clip, kind === "image" ? "image" : "video");
      if (rec.layer.parentElement !== box) box.appendChild(rec.layer);
      rec.layer.style.zIndex = String(TLM.trackOf(clip));

      const url = mediaUrl(clip.src || TLM.MAIN_SRC);
      if (rec.src !== url) {
        rec.src = url;
        rec.media.src = url;
        force = true;
      }

      const fx = TLM.evalFxAt(clip, t);
      const env = TLM.fadeEnv(clip, t);
      stageLayout(rec, fx);
      rec.layer.style.opacity = String(
        Math.max(0, Math.min(1, (Number(fx.opacity) || 0) / 100 * env.video)).toFixed(4));
      rec.layer.style.transform =
        `translate(${(Number(fx.x) || 0).toFixed(3)}%, ${(Number(fx.y) || 0).toFixed(3)}%)`;
      rec.layer.style.display = "";

      const want = Math.max(0, (Number(clip.in) || 0) + (t - clip.start));
      if (kind !== "image") {
        // A video clip carries its own sound unless the user unlinked it.
        try { rec.media.volume = clip.audio === false ? 0 : stageVolume(fx, env.audio); } catch (_) {}
        rec.media.muted = false;
        stageDriveMedia(rec.media, want, playing, force || rec.force);
        rec.force = false;
      } else {
        try { rec.media.volume = 0; } catch (_) {}
      }
    });

    // Unlinked / standalone audio: their own elements, mixed by the browser.
    const auds = TLM.audioStackAt(S.tl, t);
    const liveA = new Set(auds.map((a) => a.id));
    for (const id of [...STAGE.audios.keys()]) {
      if (!liveA.has(id)) stageReleaseAudio(id);
    }
    for (const item of auds) {
      let el = STAGE.audios.get(item.id);
      const url = mediaUrl(item.src || TLM.MAIN_SRC);
      if (!el) {
        el = stageAcquireAudio();
        el.src = url;
        STAGE.audios.set(item.id, el);
        box.appendChild(el);
        force = true;
      } else if (el.dataset.src !== url) {
        el.src = url;
        el.dataset.src = url;
        force = true;
      }
      const env = TLM.fadeEnv(item, t);
      const fx = TLM.cleanFx(item.fx);
      try { el.volume = stageVolume(fx, env.audio); } catch (_) {}
      const want = Math.max(0, (Number(item.in) || 0) + (t - item.start));
      stageDriveMedia(el, want, playing, force);
    }
  } finally {
    STAGE.syncing = false;
  }
}

/** Drop every layer (new project, or the panel was hidden). */
function stageReset() {
  for (const id of [...STAGE.layers.keys()]) stageRelease(id);
  for (const id of [...STAGE.audios.keys()]) stageReleaseAudio(id);
  if (STAGE.box) STAGE.box.textContent = "";
}

/** The playhead time the front-most ready layer thinks it is at, or null. */
function stageClockReference(t) {
  let best = null;
  const stack = TLM.clipStackAt(S.tl, t).slice().reverse();   // topmost first
  for (const clip of stack) {
    const rec = STAGE.layers.get(clip.id);
    if (!rec || rec.media.tagName !== "VIDEO") continue;
    if (rec.media.paused || rec.media.readyState < 2 || rec.media.seeking) continue;
    const guess = clip.start + ((rec.media.currentTime || 0) - (Number(clip.in) || 0));
    if (!Number.isFinite(guess)) continue;
    if (Math.abs(guess - t) > 0.4) continue;      // too far out: ignore it
    return guess;
  }
  return best;
}

function stageLayerCount() { return STAGE.layers.size; }
