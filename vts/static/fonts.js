/* Font discovery is explicit; no operating-system installation is attempted. */
(() => {
  const select = $("capFontFamily");
  const note = $("fontInfo");
  const css = document.createElement("style");
  document.head.appendChild(css);
  let deviceFonts = [];
  let busy = false;

  async function reloadFonts(refresh = false) {
    const { fonts } = await api(`/api/fonts?refresh=${refresh}`);
    // @font-face is lazy: only the selected family/weight downloads.
    css.textContent = fonts.map(f => `@font-face {font-family:${JSON.stringify(f.family)};src:url("/api/fonts/${f.id}");font-weight:${f.weight};font-style:${f.italic ? "italic" : "normal"};font-display:swap;}`).join("\n");
    const current = select.value;
    const families = [...new Set([...fonts.map(f => f.family), ...deviceFonts.map(f => f.family), ...[...select.options].map(o => o.value)])].sort((a,b) => a.localeCompare(b));
    select.replaceChildren(...families.map(f => new Option(f, f)));
    select.value = current;
    note.textContent = `${new Set(fonts.map(f => f.family)).size} installed/imported families available. Imports are saved in this app, not installed into your OS.`;
    layoutCapOverlay();
  }

  async function upload(file) {
    const body = new FormData(); body.append("file", file);
    return api("/api/fonts", { method: "POST", body });
  }

  $("fontImport").addEventListener("change", async e => {
    if (busy) return;
    const files = [...e.target.files];
    if (!files.length) return;
    busy = true; note.textContent = "Importing fonts…";
    try {
      let imported;
      for (const file of files) imported = await upload(file);
      await reloadFonts();
      applyCaptionStylePatch({ font: imported.family });
      if (captionStyleEditTouchesTimeline()) commitCaptions();
      layoutCapOverlay();
    } catch (e) { note.textContent = `Font import failed: ${e.message}`; }
    finally { busy = false; $("fontImport").value = ""; }
  });
  $("fontRefresh").addEventListener("click", () => reloadFonts(true).catch(e => { note.textContent = e.message; }));

  $("fontDevice").addEventListener("click", async () => {
    if (!window.queryLocalFonts) {
      note.textContent = "Device font access requires Chrome/Edge on localhost or HTTPS. Use Import fonts instead. Fonts installed on the server are already listed.";
      return;
    }
    try {
      deviceFonts = await window.queryLocalFonts();
      await reloadFonts();
      note.textContent = `Found ${new Set(deviceFonts.map(f => f.family)).size} device families. Selecting one imports its faces for export. Use only fonts you have permission to use.`;
    } catch (e) { note.textContent = `Device font access was not granted (${e.message}). You can still import .ttf/.otf files.`; }
  });

  select.addEventListener("change", async () => {
    const family = select.value;
    const faces = deviceFonts.filter(f => f.family === family);
    if (!faces.length || busy) return;
    busy = true;
    try {
      note.textContent = "Importing device font for preview and export…";
      for (const face of faces) {
        const blob = await face.blob();
        const signature = new TextDecoder().decode(await blob.slice(0, 4).arrayBuffer());
        await upload(new File([blob], `device.${signature === "OTTO" ? "otf" : "ttf"}`));
      }
      deviceFonts = deviceFonts.filter(f => f.family !== family);
      await reloadFonts();
    } catch (e) { note.textContent = `Could not import device font: ${e.message}. Import a .ttf/.otf manually before export.`; }
    finally { busy = false; }
  });
  document.fonts.addEventListener("loadingdone", () => layoutCapOverlay());
  reloadFonts().catch(e => { note.textContent = `Font discovery failed: ${e.message}`; });
})();
