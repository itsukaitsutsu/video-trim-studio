/* Media bin (the Project panel's media card).
 *
 * Premiere-style: files are referenced in place, so importing a 40 GB master
 * costs nothing. Only browser uploads are copied into the work folder.
 * Drag a tile onto the timeline to drop it on a track; double-click to add it
 * at the playhead (it lands on the lowest free lane, i.e. on top of whatever
 * is already there - the B-roll gesture).
 *
 * Loaded after timeline-model.js and before stage.js / timeline.js.
 */
"use strict";

const MEDIA = {
  assets: new Map(),        // id -> asset record from /api/bin
  peaks: new Map(),         // id -> waveform peaks (lazy)
  pending: new Map(),       // id -> true while a waveform is loading
  main: TLM.MAIN_SRC,
  filter: "",
  busy: false,
};

const MEDIA_KIND_ICON = { video: "🎬", audio: "🎵", image: "🖼" };

function mediaGet(id) { return MEDIA.assets.get(id) || null; }
function mediaName(id) { return (MEDIA.assets.get(id) || {}).name || id || "media"; }
function mediaUrl(id) { return `/api/bin/${encodeURIComponent(id)}/stream`; }
function mediaThumb(id) { return `/api/bin/${encodeURIComponent(id)}/thumb`; }
function mediaHasAudio(id) { return !!(MEDIA.assets.get(id) || {}).has_audio; }
function mediaDuration(id) { return Number((MEDIA.assets.get(id) || {}).duration) || 0; }

/* A clip/audio item may outlive the asset (the file was moved, or the server
 * restarted without it). Report it instead of failing silently. */
function mediaMissing() {
  const used = new Set();
  for (const c of (S.tl.clips || [])) used.add(c.src || TLM.MAIN_SRC);
  for (const a of (S.tl.auds || [])) used.add(a.src || TLM.MAIN_SRC);
  return [...used].filter((id) => id !== TLM.MAIN_SRC && !MEDIA.assets.has(id));
}

function mediaMessage(text, isError) {
  const el = $("mediaInfo");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("error", !!isError);
}

/* ------------------------------------------------------------- transport */

async function mediaLoad() {
  if (!S.project || MEDIA.busy) return;
  MEDIA.busy = true;
  try {
    const data = await api("/api/bin");
    MEDIA.assets = new Map((data.assets || []).map((a) => [a.id, a]));
    MEDIA.main = data.main || TLM.MAIN_SRC;
    mediaRender();
    // Poll while any asset is still building its browser preview.
    if ([...MEDIA.assets.values()].some((a) => !a.ready && a.preview &&
        ["building", "queued"].includes(a.preview.state))) {
      setTimeout(() => { if (S.project) mediaLoad(); }, 1200);
    }
    if (typeof draw === "function" && S.project) draw();
  } catch (e) {
    mediaMessage(e.message || String(e), true);
  } finally {
    MEDIA.busy = false;
  }
}

function mediaAdoptAssets(list) {
  const before = MEDIA.assets.size;
  for (const a of list || []) MEDIA.assets.set(a.id, a);
  mediaRender();
  return MEDIA.assets.size - before;
}

/* --------------------------------------------------------------- rendering */

function mediaRender() {
  const list = $("mediaList");
  if (!list) return;
  const q = (MEDIA.filter || "").trim().toLowerCase();
  const items = [...MEDIA.assets.values()].filter((a) =>
    !q || (a.name || "").toLowerCase().includes(q) || (a.kind || "").includes(q));
  list.textContent = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "dim small media-empty";
    empty.textContent = MEDIA.assets.size
      ? "No media matches that search."
      : "Import media to build a multi-track edit: video, audio or stills.";
    list.appendChild(empty);
  }
  for (const a of items) {
    list.appendChild(mediaTile(a));
  }
  const count = $("mediaCount");
  if (count) {
    const miss = mediaMissing();
    count.textContent = miss.length
      ? `${MEDIA.assets.size} item${MEDIA.assets.size === 1 ? "" : "s"} · ${miss.length} missing`
      : `${MEDIA.assets.size} item${MEDIA.assets.size === 1 ? "" : "s"}`;
  }
  const hit = $("mediaEmpty");
  if (hit) hit.hidden = !!MEDIA.assets.size;
}

function mediaTile(a) {
  const tile = document.createElement("div");
  tile.className = `media-tile${a.main ? " is-main" : ""}`;
  tile.draggable = true;
  tile.dataset.asset = a.id;
  tile.title = `${a.name}\n${a.kind} · ${a.width && a.height ? `${a.width}×${a.height} · ` : ""}`
    + `${a.kind === "image" ? "still" : fmtTime(a.duration, false)}`
    + `${a.has_audio ? " · has sound" : ""}\n`
    + "Drag onto the timeline, or double-click to add at the playhead.";

  const thumb = document.createElement("div");
  thumb.className = "media-thumb";
  if (a.kind === "audio") {
    thumb.textContent = "🎵";
    thumb.classList.add("media-thumb-audio");
  } else {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    img.src = mediaThumb(a.id);
    img.addEventListener("error", () => { thumb.textContent = MEDIA_KIND_ICON[a.kind] || "🎬"; });
    thumb.appendChild(img);
  }
  tile.appendChild(thumb);

  const meta = document.createElement("div");
  meta.className = "media-meta";
  const name = document.createElement("b");
  name.className = "media-name";
  name.textContent = a.name || "media";
  meta.appendChild(name);

  const sub = document.createElement("span");
  sub.className = "media-sub dim small";
  const bits = [];
  bits.push(a.kind === "image" ? "still" : fmtTime(a.duration, false));
  if (a.width && a.height) bits.push(`${a.width}×${a.height}`);
  if (a.has_audio) bits.push("🔊");
  if (!a.ready && a.preview && a.preview.state === "building") bits.push("preparing…");
  if (a.main) bits.push("main");
  sub.textContent = bits.join(" · ");
  meta.appendChild(sub);
  tile.appendChild(meta);

  const badge = document.createElement("span");
  badge.className = "media-kind";
  badge.textContent = MEDIA_KIND_ICON[a.kind] || "🎬";
  tile.appendChild(badge);

  tile.addEventListener("dragstart", (ev) => {
    if (!S.project) { ev.preventDefault(); return; }
    ev.dataTransfer.effectAllowed = "copy";
    ev.dataTransfer.setData("text/vts-asset", a.id);
    ev.dataTransfer.setData("text/plain", a.name || "");
    tile.classList.add("dragging");
    if (typeof setDropHint === "function") setDropHint(true);
  });
  tile.addEventListener("dragend", () => {
    tile.classList.remove("dragging");
    if (typeof setDropHint === "function") setDropHint(false);
  });
  tile.addEventListener("dblclick", () => mediaAddAtPlayhead(a.id));
  tile.addEventListener("click", () => {
    [...($("mediaList")?.children || [])].forEach((n) => n.classList.remove("selected"));
    tile.classList.add("selected");
  });
  return tile;
}

/* ------------------------------------------------------------ importing */

async function mediaImportPaths(paths) {
  if (!paths || !paths.length) return;
  try {
    const data = await api("/api/bin/import", {
      method: "POST", body: JSON.stringify({ paths }),
    });
    mediaAdoptAssets(data.assets);
    const n = (data.added || []).length;
    mediaMessage(n ? `Imported ${n} file${n === 1 ? "" : "s"}. Drag one onto the timeline.`
      : (data.errors && data.errors[0]) || "Nothing was imported.");
    if (data.errors && data.errors.length) mediaMessage(data.errors[0], true);
  } catch (e) {
    mediaMessage(e.message, true);
  }
}

async function mediaUpload(files) {
  if (!files || !files.length) return;
  for (const file of files) {
    mediaMessage(`Uploading ${file.name}…`);
    try {
      const body = new FormData();
      body.append("file", file);
      const data = await api("/api/bin/upload", { method: "POST", body });
      mediaAdoptAssets(data.assets);
      mediaMessage(`Added ${file.name}. Drag it onto the timeline.`);
    } catch (e) {
      mediaMessage(`${file.name}: ${e.message}`, true);
      return;
    }
  }
}

async function mediaRemoveAsset(id) {
  try {
    const data = await api(`/api/bin/${encodeURIComponent(id)}`, { method: "DELETE" });
    MEDIA.assets = new Map((data.assets || []).map((a) => [a.id, a]));
    mediaRender();
    if (typeof draw === "function") draw();
  } catch (e) {
    mediaMessage(e.message, true);
  }
}

/* --------------------------------------------------------------- placing */

// Add at the playhead: video/stills go on the lowest V lane with room (so a
// clip dropped over the main video becomes an overlay), audio on A1.
function mediaAddAtPlayhead(assetId) {
  if (!S.project) return mediaMessage("Open a video first.", true);
  const asset = mediaGet(assetId);
  if (!asset) return;
  const at = playheadTime();
  if (asset.kind === "audio") {
    const item = TLM.makeAudioItem(asset, at, 0);
    setTL({ ...TLM.normalise(S.tl), auds: [...(S.tl.auds || []), item] });
    S.sel = new Set([item.id]);
    refresh(true);
    mediaMessage(`Added ${asset.name} to A1 at ${fmtTime(at, false)}.`);
    return;
  }
  const res = addMediaToTimeline(asset, at, -1);
  if (res) {
    S.sel = new Set([res.id]);
    refresh(true);
  }
}

// `track` < 0 means "lowest free lane". Returns { id, track } or null.
function addMediaToTimeline(asset, at, track) {
  const dur = asset.kind === "image"
    ? Math.max(TLM.MIN_LEN, Number($("mediaStillDur")?.value) || 5)
    : Math.max(TLM.MIN_LEN, Number(asset.duration) || TLM.MIN_LEN);
  const want = track >= 0 ? track : TLM.firstFreeTrack(S.tl.clips || [], at, at + dur);
  const opts = { duration: dur, in: 0 };
  // Letterbox a source whose shape does not match the project frame, so a
  // 4:3 or vertical b-roll is not stretched by default.
  opts.fit = mediaDefaultFit(asset);
  const res = TLM.addMedia(S.tl, asset, at, want, opts);
  if (!res || !res.id) return null;
  setTL(res.tl);
  return res;
}

function mediaDefaultFit(asset) {
  const v = (S.project && S.project.info && S.project.info.video) || {};
  const pw = Number(v.width) || 0, ph = Number(v.height) || 0;
  const aw = Number(asset.width) || 0, ah = Number(asset.height) || 0;
  if (!pw || !ph || !aw || !ah) return "contain";
  return Math.abs((aw / ah) - (pw / ph)) < 0.02 ? "fill" : "contain";
}

/* ------------------------------------------------------------- waveforms */

async function mediaPeaks(id, buckets = 1200) {
  if (MEDIA.peaks.has(id)) return MEDIA.peaks.get(id);
  if (MEDIA.pending.has(id)) return null;
  MEDIA.pending.set(id, true);
  try {
    const data = await api(`/api/bin/${encodeURIComponent(id)}/waveform?buckets=${buckets}`);
    const peaks = data.peaks || [];
    MEDIA.peaks.set(id, peaks);
    if (typeof draw === "function" && S.project) draw();
    return peaks;
  } catch (_) {
    return null;
  } finally {
    MEDIA.pending.delete(id);
  }
}

/* ----------------------------------------------------------------- wiring */

function mediaBind() {
  if (!$("mediaList") || MEDIA.bound) return;
  MEDIA.bound = true;

  const pick = $("mediaImportFiles");
  if (pick) {
    pick.addEventListener("change", async (e) => {
      const files = [...e.target.files];
      e.target.value = "";
      if (files.length) await mediaUpload(files);
    });
  }
  const browseBtn = $("mediaBrowse");
  if (browseBtn) {
    browseBtn.addEventListener("click", () => {
      if (!S.project) return mediaMessage("Open a video first.", true);
      if (typeof openBrowserFor === "function") openBrowserFor("import");
    });
  }
  const search = $("mediaSearch");
  if (search) {
    search.addEventListener("input", () => { MEDIA.filter = search.value; mediaRender(); });
  }
  const removeBtn = $("mediaRemove");
  if (removeBtn) {
    removeBtn.addEventListener("click", () => {
      const sel = $("mediaList")?.querySelector(".media-tile.selected");
      const id = sel && sel.dataset.asset;
      if (!id) return mediaMessage("Select a tile first.");
      const asset = mediaGet(id);
      if (asset && asset.main) return mediaMessage("The main video cannot be removed.", true);
      const usedBy = [...(S.tl.clips || []), ...(S.tl.auds || [])]
        .filter((it) => (it.src || TLM.MAIN_SRC) === id).length;
      if (usedBy && !confirm(`${asset ? asset.name : id} is used by ${usedBy} timeline item(s). Remove it anyway?`)) return;
      mediaRemoveAsset(id);
    });
  }

  // Native drag-and-drop: files dropped on the bin are imported.
  const bin = $("mediaBin");
  if (bin) {
    const stop = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
    bin.addEventListener("dragover", (ev) => {
      if (![...(ev.dataTransfer?.types || [])].includes("Files")) return;
      ev.preventDefault();
      bin.classList.add("media-drop");
    });
    bin.addEventListener("dragleave", () => bin.classList.remove("media-drop"));
    bin.addEventListener("drop", async (ev) => {
      stop(ev);
      bin.classList.remove("media-drop");
      const files = [...(ev.dataTransfer?.files || [])];
      if (files.length) await mediaUpload(files);
    });
  }
}

function mediaInit() {
  mediaBind();
  mediaRender();
}
