/* Silent B1 overlays use timeline time; source audio remains on V1. */
const BROLL = { assets: new Map(), selected: null, signature: "", project: null, loading: false };

function brollMessage(message) { $("brollInfo").textContent = message; }
function brollClip() { return (S.tl.broll || []).find(c => c.id === BROLL.selected); }

async function loadBrollAssets() {
  const project = S.project;
  if (!project || BROLL.loading) return;
  BROLL.loading = true;
  try {
    const data = await api("/api/broll");
    if (S.project !== project) return;
    BROLL.assets = new Map(data.assets.map(a => [a.id, a]));
    BROLL.signature = "";
    renderBroll();
    syncBrollPreview(true);
    if (data.assets.some(a => !a.ready && !["error", "failed"].includes(a.preview?.state))) {
      setTimeout(() => { if (S.project === project) loadBrollAssets(); }, 1500);
    }
  } catch (e) { brollMessage(e.message); }
  finally {
    BROLL.loading = false;
    if (S.project !== project) loadBrollAssets();
  }
}

function renderBroll() {
  if (BROLL.project !== S.project) {
    BROLL.project = S.project;
    BROLL.selected = null; BROLL.assets.clear(); BROLL.signature = "";
    loadBrollAssets();
  }
  const clips = S.tl.broll || [];
  const signature = JSON.stringify([clips, BROLL.selected, [...BROLL.assets.values()].map(a => [a.id,a.ready])]);
  if (signature === BROLL.signature) return;
  BROLL.signature = signature;
  const list = $("brollList"); list.replaceChildren();
  for (const clip of clips) {
    const asset = BROLL.assets.get(clip.asset_id);
    const button = document.createElement("button");
    button.className = `ghost block broll-item ${clip.id === BROLL.selected ? "selected" : ""}`;
    button.textContent = `${asset?.name || "B-roll clip"} · ${clip.start.toFixed(2)}–${clip.end.toFixed(2)}s${asset && !asset.ready ? " · preparing preview" : ""}`;
    button.onclick = () => selectBroll(clip.id);
    list.appendChild(button);
  }
  $("brollEmpty").hidden = !!clips.length;
  const clip = brollClip();
  $("brollEditor").hidden = !clip;
  if (clip) {
    $("brStart").value = clip.start;
    $("brIn").value = clip.in;
    $("brDuration").value = Math.round((clip.end - clip.start) * 1000) / 1000;
    $("brFit").value = clip.fit;
  }
}

function selectBroll(id) {
  BROLL.selected = id; S.sel = new Set(); syncCapSel(); pausePlayback();
  const clip = brollClip();
  if (clip) setPlayhead(clip.start);
  renderBroll(); draw();
}

function validateBrollClip(clip, others) {
  const asset = BROLL.assets.get(clip.asset_id);
  if (![clip.start,clip.end,clip.in].every(Number.isFinite) || clip.start < 0 || clip.in < 0 || clip.end - clip.start < .049)
    throw new Error("Use nonnegative times and a duration of at least 0.05 seconds.");
  if (!asset || clip.in + clip.end - clip.start > asset.duration + .02)
    throw new Error("The trim extends beyond the uploaded clip.");
  if (clip.end > timelineEnd() + .001) throw new Error("B-roll must fit inside the main timeline.");
  if (others.some(c => c.id !== clip.id && clip.start < c.end - .001 && clip.end > c.start + .001))
    throw new Error("B1 clips cannot overlap. Move or trim this clip first.");
}

function drawBroll(ctx, width) {
  ctx.fillStyle = "#181527"; ctx.fillRect(0, TL.bTop, width, TL.bH);
  for (const c of S.tl.broll || []) {
    const x = t2x(c.start), w = Math.max(2, t2x(c.end) - x);
    ctx.save(); ctx.beginPath(); ctx.rect(x, TL.bTop + 2, w, TL.bH - 4); ctx.clip();
    ctx.fillStyle = c.id === BROLL.selected ? "#9870e8" : "#624b96";
    ctx.fillRect(x, TL.bTop + 2, w, TL.bH - 4);
    ctx.fillStyle = "#eee6ff"; ctx.font = "10px sans-serif";
    ctx.fillText(BROLL.assets.get(c.asset_id)?.name || "B-roll", x + 6, TL.bTop + 17);
    ctx.fillRect(x, TL.bTop + 2, 2, TL.bH - 4); ctx.fillRect(x + w - 2, TL.bTop + 2, 2, TL.bH - 4);
    ctx.restore();
  }
}

function syncBrollPreview(force = false) {
  const player = $("brollPlayer");
  const t = playheadTime();
  const clip = (S.tl.broll || []).find(c => c.start <= t && t < c.end);
  const asset = clip && BROLL.assets.get(clip.asset_id);
  if (!clip || !asset?.ready) {
    player.hidden = true; player.pause(); return;
  }
  const rect = videoContentRect();
  Object.assign(player.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px`, objectFit: clip.fit });
  player.hidden = false;
  if (player.dataset.asset !== asset.id) {
    player.src = asset.url; player.dataset.asset = asset.id; force = true;
  }
  const want = clip.in + t - clip.start;
  if (force || Math.abs(player.currentTime - want) > .15) {
    try { player.currentTime = want; } catch (_) { /* metadata pending */ }
  }
  if (PV.playing && player.paused) player.play().catch(() => {});
  else if (!PV.playing && !player.paused) player.pause();
}

$("brollUpload").addEventListener("change", async e => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!S.project) return brollMessage("Open a main video first.");
  const project = S.project;
  $("brollUpload").disabled = true;
  try {
    let at = playheadTime();
    for (const file of files) {
      brollMessage(`Uploading ${file.name}…`);
      const body = new FormData(); body.append("file", file);
      const asset = await api("/api/broll", { method: "POST", body });
      if (S.project !== project) throw new Error("Main video changed during upload.");
      BROLL.assets.set(asset.id, asset);
      const others = S.tl.broll || [];
      // Find the first gap at or after the playhead; don't silently overwrite.
      for (const c of [...others].sort((a,b) => a.start-b.start)) {
        if (c.end <= at) continue;
        if (c.start > at + .05) break;
        at = c.end;
      }
      const next = Math.min(timelineEnd(), ...others.filter(c => c.start > at).map(c => c.start));
      const duration = Math.min(asset.duration, next - at);
      if (duration < .05) throw new Error("No room at this position. Move the playhead into an empty B1 range and upload again.");
      const clip = { id: TLM.newId("b"), asset_id: asset.id, start: Math.round(at*1000)/1000, end: Math.round((at+duration)*1000)/1000, in: 0, fit: "cover" };
      validateBrollClip(clip, others);
      BROLL.selected = clip.id;
      setTL({ ...S.tl, broll: [...others, clip].sort((a,b) => a.start-b.start) });
      at = clip.end;
    }
    brollMessage("B-roll added. Drag B1 to move/trim, or edit exact times below. Original audio is preserved.");
    loadBrollAssets();
  } catch (e) { brollMessage(e.message); }
  finally { $("brollUpload").disabled = false; }
});

$("brollEditor").addEventListener("submit", e => {
  e.preventDefault();
  const old = brollClip(); if (!old) return;
  const clip = { ...old, start: Number($("brStart").value), in: Number($("brIn").value), fit: $("brFit").value };
  clip.end = Math.round((clip.start + Number($("brDuration").value))*1000)/1000;
  try {
    validateBrollClip(clip, S.tl.broll);
    setTL({ ...S.tl, broll: S.tl.broll.map(c => c.id === clip.id ? clip : c).sort((a,b) => a.start-b.start) });
    brollMessage("B-roll updated.");
  } catch (e) { brollMessage(e.message); }
});
$("brRemove").onclick = () => {
  setTL({ ...S.tl, broll: (S.tl.broll || []).filter(c => c.id !== BROLL.selected) });
  BROLL.selected = null; renderBroll();
};
$("brollPlayer").addEventListener("loadedmetadata", () => syncBrollPreview(true));
$("brollPlayer").addEventListener("error", () => brollMessage("B-roll preview could not play. Try an H.264 MP4; export still uses the original upload."));
window.addEventListener("resize", () => syncBrollPreview());

// Separate B1 gesture handling keeps overlay selection independent of V1/T lanes.
$("timeline").addEventListener("mousedown", e => {
  const rect = $("timeline").getBoundingClientRect(), y = e.clientY - rect.top;
  if (y < TL.bTop || y >= TL.bTop + TL.bH || !S.project || e.button !== 0) return;
  e.stopImmediatePropagation(); e.preventDefault();
  const x = e.clientX - rect.left;
  const hit = (S.tl.broll || []).find(c => t2x(c.start) <= x && x < t2x(c.end));
  if (!hit) { pausePlayback(); setPlayhead(x2t(x)); return; }
  selectBroll(hit.id);
  const edge = edgeAt(hit, x), base = TLM.clone(S.tl);
  let candidate = hit;
  const move = ev => {
    const delta = (ev.clientX - e.clientX) / pxPerSec();
    candidate = { ...hit };
    if (edge === "l") {
      const shift = Math.max(-hit.in, -hit.start, Math.min(delta, hit.end - hit.start - .05));
      candidate.start += shift; candidate.in += shift;
    } else if (edge === "r") candidate.end = Math.max(hit.start + .05, hit.end + delta);
    else { const shift = Math.max(-hit.start, delta); candidate.start += shift; candidate.end += shift; }
    for (const key of ["start","end","in"]) candidate[key] = Math.round(candidate[key]*1000)/1000;
    try {
      validateBrollClip(candidate, base.broll);
      S.tl = { ...base, broll: base.broll.map(c => c.id === hit.id ? candidate : c).sort((a,b) => a.start-b.start) };
      draw(); syncBrollPreview(true);
    } catch (_) { /* keep last valid placement */ }
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    commitTL(); refresh(true);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}, true);
