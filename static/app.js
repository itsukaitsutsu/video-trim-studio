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

const PREVIEW_ZOOM_LEVELS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];
const PREVIEW_VIEW = {
  zoom: 1, panX: 0, panY: 0, baseW: 0, baseH: 0,
  viewW: 0, viewH: 0, viewportHeight: null, initialized: false, drag: null,
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

const WORKSPACE_STORAGE_KEY = "video-trim-studio.workspace.v1";
const DEFAULT_WORKSPACE_LAYOUT = {
  main: ["video", "timeline", "list"],
  side: ["detect", "caption", "export-settings", "export"],
};

function workspacePanelMap(root) {
  return new Map([...root.querySelectorAll("[data-workspace-panel]")]
    .map((panel) => [panel.dataset.workspacePanel, panel]));
}

function clampWorkspaceSize(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clearWorkspacePanelSize(panel) {
  panel.style.width = "";
  panel.style.height = "";
  panel.style.marginLeft = "";
  panel.style.marginTop = "";
  panel.style.alignSelf = "";
  panel.style.flex = "";
  panel.classList.remove("workspace-panel-resized");
}

function applyWorkspacePanelSize(panel, size) {
  if (!size || typeof size !== "object") {
    clearWorkspacePanelSize(panel);
    return;
  }
  const parentWidth = panel.parentElement?.clientWidth || Number(size.width) || 320;
  const minWidth = Math.min(180, parentWidth);
  let marginLeft = Number(size.marginLeft);
  if (!Number.isFinite(marginLeft)) marginLeft = 0;
  marginLeft = clampWorkspaceSize(marginLeft, 0, Math.max(0, parentWidth - minWidth));
  let width = Number(size.width);
  if (!Number.isFinite(width)) width = parentWidth - marginLeft;
  width = clampWorkspaceSize(width, minWidth, Math.max(minWidth, parentWidth - marginLeft));

  const minHeight = 120;
  const maxHeight = Math.max(minHeight, window.innerHeight * 0.85);
  let height = Number(size.height);
  if (!Number.isFinite(height)) height = panel.getBoundingClientRect().height;
  height = clampWorkspaceSize(height, minHeight, maxHeight);
  let marginTop = Number(size.marginTop);
  if (!Number.isFinite(marginTop)) marginTop = 0;
  marginTop = clampWorkspaceSize(marginTop, 0, maxHeight);

  panel.style.width = `${width}px`;
  panel.style.height = `${height}px`;
  panel.style.marginLeft = `${marginLeft}px`;
  panel.style.marginTop = `${marginTop}px`;
  panel.style.alignSelf = "flex-start";
  panel.style.flex = "0 0 auto";
  panel.classList.add("workspace-panel-resized");
}

function applyTimelinePanelSize(panel, size) {
  clearWorkspacePanelSize(panel);
  if (!size || typeof size !== "object") return;
  const parentWidth = panel.parentElement?.clientWidth || Number(size.width) || 320;
  const minWidth = Math.min(180, parentWidth);
  const width = Number(size.width);
  const minHeight = 120;
  const maxHeight = Math.max(minHeight, window.innerHeight * 0.85);
  const height = Number(size.height);
  const marginTop = Number(size.marginTop);
  if (![width, height, marginTop].some(Number.isFinite)) return;
  if (Number.isFinite(width)) {
    panel.style.width = `${clampWorkspaceSize(width, minWidth, Math.max(minWidth, parentWidth))}px`;
  }
  if (Number.isFinite(height)) panel.style.height = `${clampWorkspaceSize(height, minHeight, maxHeight)}px`;
  if (Number.isFinite(marginTop)) panel.style.marginTop = `${clampWorkspaceSize(marginTop, 0, maxHeight)}px`;
  panel.style.alignSelf = "stretch";
  panel.style.flex = "0 0 auto";
  panel.classList.add("workspace-panel-resized");
}

function applyTimelineViewportHeight(height) {
  const viewport = $("timelineViewport");
  if (!viewport) return;
  const savedHeight = Number(height);
  if (!Number.isFinite(savedHeight) || savedHeight <= 0) {
    viewport.style.height = "";
    viewport.scrollTop = 0;
    viewport.scrollLeft = 0;
    return;
  }
  const minHeight = 80;
  const maxHeight = Math.max(minHeight, window.innerHeight * 0.85);
  viewport.style.height = `${clampWorkspaceSize(savedHeight, minHeight, maxHeight)}px`;
}

function applyPreviewViewportHeight(height) {
  const viewport = $("previewViewport");
  if (!viewport) return;
  const savedHeight = Number(height);
  if (!Number.isFinite(savedHeight) || savedHeight <= 0) {
    PREVIEW_VIEW.viewportHeight = null;
    viewport.style.height = "";
    return;
  }
  const minHeight = 160;
  const maxHeight = Math.max(minHeight, window.innerHeight * 0.85);
  PREVIEW_VIEW.viewportHeight = clampWorkspaceSize(savedHeight, minHeight, maxHeight);
  viewport.style.height = `${PREVIEW_VIEW.viewportHeight}px`;
}

function bindTimelineViewportResize() {
  const handle = $("timelineViewportResize");
  const viewport = $("timelineViewport");
  if (!handle || !viewport) return;
  let active = null;

  const finish = (event) => {
    if (!active || event.pointerId !== active.pointerId) return;
    const state = active;
    active = null;
    handle.classList.remove("resizing");
    try { handle.releasePointerCapture(event.pointerId); } catch (_) { /* capture may already be lost */ }
    document.body.style.cursor = state.bodyCursor;
    document.body.style.userSelect = state.bodyUserSelect;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    saveWorkspaceLayout();
    window.dispatchEvent(new Event("resize"));
  };

  const move = (event) => {
    if (!active || event.pointerId !== active.pointerId) return;
    const minHeight = 80;
    const maxHeight = Math.max(minHeight, window.innerHeight * 0.85);
    viewport.style.height = `${clampWorkspaceSize(active.height + event.clientY - active.y, minHeight, maxHeight)}px`;
    window.dispatchEvent(new Event("resize"));
  };

  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    active = {
      pointerId: event.pointerId, y: event.clientY,
      height: viewport.getBoundingClientRect().height,
      bodyCursor: document.body.style.cursor,
      bodyUserSelect: document.body.style.userSelect,
    };
    handle.classList.add("resizing");
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    try { handle.setPointerCapture(event.pointerId); } catch (_) { /* window listeners still handle mouse input */ }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  });
}

function bindPreviewViewportResize() {
  const handle = $("previewViewportResize");
  const viewport = $("previewViewport");
  if (!handle || !viewport) return;
  let active = null;

  const finish = (event) => {
    if (!active || event.pointerId !== active.pointerId) return;
    const state = active;
    active = null;
    handle.classList.remove("resizing");
    try { handle.releasePointerCapture(event.pointerId); } catch (_) { /* capture may already be lost */ }
    document.body.style.cursor = state.bodyCursor;
    document.body.style.userSelect = state.bodyUserSelect;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    saveWorkspaceLayout();
    window.dispatchEvent(new Event("resize"));
  };

  const move = (event) => {
    if (!active || event.pointerId !== active.pointerId) return;
    const minHeight = 160;
    const maxHeight = Math.max(minHeight, window.innerHeight * 0.85);
    PREVIEW_VIEW.viewportHeight = clampWorkspaceSize(
      active.height + event.clientY - active.y, minHeight, maxHeight);
    viewport.style.height = `${PREVIEW_VIEW.viewportHeight}px`;
    layoutPreviewZoom();
  };

  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    active = {
      pointerId: event.pointerId, y: event.clientY,
      height: viewport.getBoundingClientRect().height,
      bodyCursor: document.body.style.cursor,
      bodyUserSelect: document.body.style.userSelect,
    };
    PREVIEW_VIEW.viewportHeight = active.height;
    handle.classList.add("resizing");
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    try { handle.setPointerCapture(event.pointerId); } catch (_) { /* window listeners still handle mouse input */ }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  });
}

function workspaceGridMetrics(root) {
  const computed = getComputedStyle(root);
  const paddingLeft = parseFloat(computed.paddingLeft) || 0;
  const paddingRight = parseFloat(computed.paddingRight) || 0;
  const gap = parseFloat(computed.columnGap) || 0;
  const contentLeft = root.getBoundingClientRect().left + paddingLeft;
  const trackWidth = Math.max(0, root.clientWidth - paddingLeft - paddingRight - gap);
  return { contentLeft, trackWidth, gap };
}

function setWorkspaceSideWidth(root, requestedWidth) {
  const { trackWidth } = workspaceGridMetrics(root);
  const minMain = Math.min(320, trackWidth);
  const minSide = Math.min(220, Math.max(0, trackWidth - minMain));
  const maxSide = Math.max(minSide, trackWidth - minMain);
  const width = clampWorkspaceSize(requestedWidth, minSide, maxSide);
  root.style.setProperty("--workspace-side-width", `${width}px`);
  return width;
}

function workspaceColumnsAreSideBySide(root) {
  if (window.matchMedia && window.matchMedia("(max-width: 1080px)").matches) return false;
  const mainColumn = root.querySelector('[data-workspace-column="main"]');
  const sideColumn = root.querySelector('[data-workspace-column="side"]');
  if (!mainColumn || !sideColumn) return false;
  const mainRect = mainColumn.getBoundingClientRect();
  const sideRect = sideColumn.getBoundingClientRect();
  return mainRect.width > 0 && sideRect.width > 0 &&
    Math.abs(mainRect.top - sideRect.top) < 2 && sideRect.left >= mainRect.right - 2;
}

function clearWorkspacePanelWidthOverrides(root) {
  for (const panel of root.querySelectorAll("[data-workspace-panel]")) {
    panel.style.width = "";
    panel.style.marginLeft = "";
    panel.style.alignSelf = "";
    panel.style.flex = "";
    if (!panel.style.height && !panel.style.marginTop)
      panel.classList.remove("workspace-panel-resized");
  }
}

function isSharedWorkspaceEdge(root, panel, edge) {
  const columnId = panel.parentElement?.dataset.workspaceColumn;
  return workspaceColumnsAreSideBySide(root) &&
    ((edge === "right" && columnId === "main") || (edge === "left" && columnId === "side"));
}

function refreshWorkspaceResizeHandleTitles(root) {
  for (const handle of root.querySelectorAll(".workspace-resize-handle")) {
    const panel = handle.closest("[data-workspace-panel]");
    if (!panel) continue;
    const edge = handle.dataset.resizeEdge;
    handle.title = isSharedWorkspaceEdge(root, panel, edge)
      ? "Drag to resize both workspace columns"
      : `Drag the ${edge} edge to resize this panel`;
  }
}

function applyWorkspaceLayout(layout) {
  const root = $("workspace");
  if (!root) return;
  const panels = workspacePanelMap(root);
  const columns = {
    main: root.querySelector('[data-workspace-column="main"]'),
    side: root.querySelector('[data-workspace-column="side"]'),
  };
  const ordered = { main: [], side: [] };
  const used = new Set();

  for (const column of ["main", "side"]) {
    const ids = layout && Array.isArray(layout[column]) ? layout[column] : [];
    for (const id of ids) {
      if (panels.has(id) && !used.has(id)) {
        ordered[column].push(id);
        used.add(id);
      }
    }
  }
  for (const [id, panel] of panels) {
    if (used.has(id)) continue;
    const column = panel.dataset.defaultColumn === "side" ? "side" : "main";
    ordered[column].push(id);
  }

  for (const column of ["main", "side"]) {
    if (!columns[column]) continue;
    for (const id of ordered[column]) columns[column].appendChild(panels.get(id));
  }
  const savedSideWidth = Number(layout?.columnWidths?.side);
  if (Number.isFinite(savedSideWidth)) setWorkspaceSideWidth(root, savedSideWidth);
  else root.style.removeProperty("--workspace-side-width");

  for (const [id, panel] of panels) {
    const size = layout?.sizes?.[id];
    if (id === "timeline") {
      // Panel width/height sizing remains separate from the Timeline viewport's
      // inner height control.
      applyTimelinePanelSize(panel, size);
    } else {
      applyWorkspacePanelSize(panel, size);
    }
  }
  applyTimelineViewportHeight(layout?.timelineViewportHeight);
  applyPreviewViewportHeight(layout?.previewViewportHeight);
}

function readWorkspaceLayout() {
  try { return JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY) || "null"); }
  catch (_) { return null; }
}

function saveWorkspaceLayout() {
  const root = $("workspace");
  if (!root) return;
  const layout = {};
  for (const column of ["main", "side"]) {
    const host = root.querySelector(`[data-workspace-column="${column}"]`);
    layout[column] = host
      ? [...host.children].filter((panel) => panel.hasAttribute("data-workspace-panel"))
        .map((panel) => panel.dataset.workspacePanel)
      : [];
  }
  layout.sizes = {};
  for (const [id, panel] of workspacePanelMap(root)) {
    const size = {};
    const properties = id === "timeline"
      ? ["width", "height", "marginTop"] : ["width", "height", "marginLeft", "marginTop"];
    for (const property of properties) {
      const value = parseFloat(panel.style[property]);
      if (Number.isFinite(value)) size[property] = value;
    }
    if (Object.keys(size).length) layout.sizes[id] = size;
  }
  const sideWidth = parseFloat(getComputedStyle(root).getPropertyValue("--workspace-side-width"));
  if (Number.isFinite(sideWidth)) layout.columnWidths = { side: sideWidth };
  if (Number.isFinite(PREVIEW_VIEW.viewportHeight))
    layout.previewViewportHeight = PREVIEW_VIEW.viewportHeight;
  const timelineViewportHeight = parseFloat($("timelineViewport")?.style.height || "");
  if (Number.isFinite(timelineViewportHeight)) layout.timelineViewportHeight = timelineViewportHeight;
  try { localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(layout)); }
  catch (_) { /* Keep the current arrangement for this page if storage is unavailable. */ }
}

function clearWorkspaceDropMarkers(root) {
  root.querySelectorAll(".workspace-drop-before, .workspace-drop-after")
    .forEach((panel) => panel.classList.remove("workspace-drop-before", "workspace-drop-after"));
  root.querySelectorAll(".workspace-drop-active")
    .forEach((column) => column.classList.remove("workspace-drop-active"));
}

function addWorkspaceResizeHandles(root) {
  for (const panel of root.querySelectorAll("[data-workspace-panel]")) {
    const edges = panel.dataset.workspacePanel === "timeline"
      ? ["right", "top", "bottom"] : ["left", "right", "top", "bottom"];
    for (const edge of edges) {
      if (panel.querySelector(`:scope > [data-resize-edge="${edge}"]`)) continue;
      const handle = document.createElement("div");
      handle.className = `workspace-resize-handle resize-${edge}`;
      handle.dataset.resizeEdge = edge;
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-orientation", edge === "left" || edge === "right" ? "vertical" : "horizontal");
      panel.appendChild(handle);
    }
  }
  refreshWorkspaceResizeHandleTitles(root);
}

function bindWorkspaceResize(root) {
  let active = null;

  const finish = (event) => {
    if (!active || event.pointerId !== active.pointerId) return;
    const state = active;
    active = null;
    state.handle.classList.remove("resizing");
    try { state.handle.releasePointerCapture(event.pointerId); } catch (_) { /* capture may already be lost */ }
    document.body.style.cursor = state.bodyCursor;
    document.body.style.userSelect = state.bodyUserSelect;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    saveWorkspaceLayout();
    window.dispatchEvent(new Event("resize"));
  };

  const move = (event) => {
    if (!active || event.pointerId !== active.pointerId) return;
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    if (active.resizeColumns) {
      const metrics = workspaceGridMetrics(root);
      const dividerX = event.clientX - (active.edge === "left" ? metrics.gap : 0);
      const mainWidth = dividerX - metrics.contentLeft;
      setWorkspaceSideWidth(root, metrics.trackWidth - mainWidth);
      clearWorkspacePanelWidthOverrides(root);
      window.dispatchEvent(new Event("resize"));
      return;
    }
    const parentWidth = active.parent.clientWidth;
    const minWidth = Math.min(180, parentWidth);
    const minHeight = 120;
    const maxHeight = Math.max(minHeight, window.innerHeight * 0.85);
    let width = active.width;
    let height = active.height;
    let marginLeft = active.marginLeft;
    let marginTop = active.marginTop;

    if (active.edge === "right") {
      width = clampWorkspaceSize(active.width + dx, minWidth,
        Math.max(minWidth, parentWidth - marginLeft));
    } else if (active.edge === "left") {
      marginLeft = clampWorkspaceSize(active.marginLeft + dx, 0,
        Math.max(0, parentWidth - minWidth));
      width = clampWorkspaceSize(active.width - dx, minWidth,
        Math.max(minWidth, parentWidth - marginLeft));
    } else if (active.edge === "bottom") {
      height = clampWorkspaceSize(active.height + dy, minHeight, maxHeight);
    } else if (active.edge === "top") {
      height = clampWorkspaceSize(active.height - dy, minHeight, maxHeight);
      marginTop = clampWorkspaceSize(active.marginTop + active.height - height, 0, maxHeight);
    }

    if (active.panel.dataset.workspacePanel === "timeline") {
      if (active.edge === "right") {
        active.panel.style.width = `${width}px`;
      } else {
        active.panel.style.height = `${height}px`;
        active.panel.style.marginTop = `${marginTop}px`;
      }
      active.panel.style.alignSelf = "stretch";
      active.panel.style.flex = "0 0 auto";
    } else {
      active.panel.style.width = `${width}px`;
      active.panel.style.height = `${height}px`;
      active.panel.style.marginLeft = `${marginLeft}px`;
      active.panel.style.marginTop = `${marginTop}px`;
      active.panel.style.alignSelf = "flex-start";
      active.panel.style.flex = "0 0 auto";
    }
    active.panel.classList.add("workspace-panel-resized");
    window.dispatchEvent(new Event("resize"));
  };

  root.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest(".workspace-resize-handle");
    if (!handle) return;
    const panel = handle.closest("[data-workspace-panel]");
    if (!panel || !panel.parentElement) return;
    const edge = handle.dataset.resizeEdge;
    const resizeColumns = isSharedWorkspaceEdge(root, panel, edge);
    event.preventDefault();
    event.stopPropagation();
    const computed = getComputedStyle(panel);
    active = {
      handle, panel, parent: panel.parentElement, edge, resizeColumns,
      pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      width: panel.getBoundingClientRect().width,
      height: panel.getBoundingClientRect().height,
      marginLeft: parseFloat(computed.marginLeft) || 0,
      marginTop: parseFloat(computed.marginTop) || 0,
      bodyCursor: document.body.style.cursor,
      bodyUserSelect: document.body.style.userSelect,
    };
    handle.classList.add("resizing");
    document.body.style.cursor = active.edge === "left" || active.edge === "right" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    try { handle.setPointerCapture(event.pointerId); } catch (_) { /* window listeners still handle mouse input */ }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  });
}

function bindWorkspaceDocking() {
  const root = $("workspace");
  if (!root) return;
  applyWorkspaceLayout(readWorkspaceLayout());
  addWorkspaceResizeHandles(root);
  bindWorkspaceResize(root);
  bindTimelineViewportResize();
  bindPreviewViewportResize();
  window.addEventListener("resize", () => {
    const sideWidth = parseFloat(getComputedStyle(root).getPropertyValue("--workspace-side-width"));
    if (workspaceColumnsAreSideBySide(root) && Number.isFinite(sideWidth))
      setWorkspaceSideWidth(root, sideWidth);
    refreshWorkspaceResizeHandleTitles(root);
  });
  let draggedPanel = null;

  root.addEventListener("dragstart", (event) => {
    const handle = event.target.closest(".workspace-drag-handle");
    const panel = handle && handle.closest("[data-workspace-panel]");
    if (!panel || !event.dataTransfer) return;
    draggedPanel = panel;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", panel.dataset.workspacePanel);
    panel.classList.add("workspace-dragging");
  });

  root.addEventListener("dragover", (event) => {
    if (!draggedPanel) return;
    const column = event.target.closest("[data-workspace-column]");
    if (!column) return;
    event.preventDefault();
    clearWorkspaceDropMarkers(root);
    const target = event.target.closest("[data-workspace-panel]");
    if (target && target !== draggedPanel && target.parentElement === column) {
      const before = event.clientY < target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2;
      target.classList.add(before ? "workspace-drop-before" : "workspace-drop-after");
    } else if (target !== draggedPanel) {
      column.classList.add("workspace-drop-active");
    }
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });

  root.addEventListener("drop", (event) => {
    if (!draggedPanel) return;
    const column = event.target.closest("[data-workspace-column]");
    if (!column) return;
    event.preventDefault();
    const previousColumn = draggedPanel.parentElement;
    const target = event.target.closest("[data-workspace-panel]");
    if (target && target !== draggedPanel && target.parentElement === column) {
      const rect = target.getBoundingClientRect();
      const after = event.clientY >= rect.top + rect.height / 2;
      column.insertBefore(draggedPanel, after ? target.nextSibling : target);
    } else if (target !== draggedPanel) {
      column.appendChild(draggedPanel);
    }
    if (previousColumn !== column) {
      draggedPanel.style.width = "";
      draggedPanel.style.marginLeft = "";
      draggedPanel.style.alignSelf = "";
      draggedPanel.style.flex = "";
      if (!draggedPanel.style.height && !draggedPanel.style.marginTop) {
        draggedPanel.classList.remove("workspace-panel-resized");
      }
    }
    draggedPanel.classList.remove("workspace-dragging");
    draggedPanel = null;
    clearWorkspaceDropMarkers(root);
    saveWorkspaceLayout();
    window.dispatchEvent(new Event("resize"));
  });

  root.addEventListener("dragend", () => {
    if (draggedPanel) draggedPanel.classList.remove("workspace-dragging");
    draggedPanel = null;
    clearWorkspaceDropMarkers(root);
  });

  const reset = $("workspaceReset");
  if (reset) reset.onclick = () => {
    applyWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT);
    saveWorkspaceLayout();
    window.dispatchEvent(new Event("resize"));
  };
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
  resetPreviewZoom();
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

function clampPreviewPan(value, viewSize, stageSize, zoom) {
  const spare = viewSize - stageSize * zoom;
  return Math.max(Math.min(0, spare), Math.min(Math.max(0, spare), value));
}

function paintPreviewZoom() {
  const viewport = $("previewViewport"), stage = $("previewStage");
  if (!viewport || !stage) return;
  const z = PREVIEW_VIEW.zoom;
  stage.style.transform = `matrix(${z}, 0, 0, ${z}, ${PREVIEW_VIEW.panX}, ${PREVIEW_VIEW.panY})`;
  viewport.classList.toggle("is-zoomed", z > 1.001);
  const canPan = PREVIEW_VIEW.baseW * z > PREVIEW_VIEW.viewW + 1 ||
    PREVIEW_VIEW.baseH * z > PREVIEW_VIEW.viewH + 1;
  viewport.classList.toggle("pan-available", canPan);
  $("videoZoomLevel").textContent = `${Math.round(z * 100)}%`;
  $("videoZoomOut").disabled = z <= PREVIEW_ZOOM_LEVELS[0] + 1e-3;
  $("videoZoomIn").disabled = z >= PREVIEW_ZOOM_LEVELS[PREVIEW_ZOOM_LEVELS.length - 1] - 1e-3;
}

function layoutPreviewZoom() {
  const viewport = $("previewViewport"), stage = $("previewStage"), video = $("player");
  if (!viewport || !stage || !video) return;
  const viewBox = viewport.getBoundingClientRect();
  const viewW = viewport.clientWidth || viewBox.width;
  if (!viewW) return;
  const sourceW = video.videoWidth || 16, sourceH = video.videoHeight || 9;
  const maxH = Math.max(120, window.innerHeight * 0.46);
  const fitScale = Math.min(viewW / sourceW, maxH / sourceH);
  const baseW = Math.max(1, sourceW * fitScale);
  const baseH = Math.max(1, sourceH * fitScale);

  let focusX = 0.5, focusY = 0.5;
  if (PREVIEW_VIEW.initialized && PREVIEW_VIEW.baseW && PREVIEW_VIEW.baseH) {
    focusX = ((PREVIEW_VIEW.viewW / 2 - PREVIEW_VIEW.panX) /
      PREVIEW_VIEW.zoom) / PREVIEW_VIEW.baseW;
    focusY = ((PREVIEW_VIEW.viewH / 2 - PREVIEW_VIEW.panY) /
      PREVIEW_VIEW.zoom) / PREVIEW_VIEW.baseH;
    focusX = Math.max(0, Math.min(1, focusX));
    focusY = Math.max(0, Math.min(1, focusY));
  }

  PREVIEW_VIEW.baseW = baseW;
  PREVIEW_VIEW.baseH = baseH;
  video.style.width = "100%";
  video.style.height = "100%";
  stage.style.width = `${baseW}px`;
  stage.style.height = `${baseH}px`;
  if (Number.isFinite(PREVIEW_VIEW.viewportHeight)) {
    const minHeight = 160;
    const maxHeight = Math.max(minHeight, window.innerHeight * 0.85);
    PREVIEW_VIEW.viewportHeight = clampWorkspaceSize(
      PREVIEW_VIEW.viewportHeight, minHeight, maxHeight);
    viewport.style.height = `${PREVIEW_VIEW.viewportHeight}px`;
  } else {
    viewport.style.height = `${baseH}px`;
  }
  const nextViewW = viewport.clientWidth || viewW;
  const nextViewH = viewport.clientHeight || baseH;
  PREVIEW_VIEW.viewW = nextViewW;
  PREVIEW_VIEW.viewH = nextViewH;
  PREVIEW_VIEW.panX = nextViewW / 2 - focusX * baseW * PREVIEW_VIEW.zoom;
  PREVIEW_VIEW.panY = nextViewH / 2 - focusY * baseH * PREVIEW_VIEW.zoom;
  PREVIEW_VIEW.panX = clampPreviewPan(PREVIEW_VIEW.panX, nextViewW, baseW, PREVIEW_VIEW.zoom);
  PREVIEW_VIEW.panY = clampPreviewPan(PREVIEW_VIEW.panY, nextViewH, baseH, PREVIEW_VIEW.zoom);
  PREVIEW_VIEW.initialized = true;
  paintPreviewZoom();
  layoutCapOverlay();
}

// Wheel zoom supplies a viewport-local anchor so the point under the pointer
// stays fixed, like Timeline zoom; buttons default to the viewport centre.
function setPreviewZoom(zoom, anchorX = null, anchorY = null) {
  const viewport = $("previewViewport");
  if (!viewport) return;
  const oldZoom = PREVIEW_VIEW.zoom;
  const x = Number.isFinite(anchorX)
    ? clampWorkspaceSize(anchorX, 0, PREVIEW_VIEW.viewW) : PREVIEW_VIEW.viewW / 2;
  const y = Number.isFinite(anchorY)
    ? clampWorkspaceSize(anchorY, 0, PREVIEW_VIEW.viewH) : PREVIEW_VIEW.viewH / 2;
  const focusX = (x - PREVIEW_VIEW.panX) / oldZoom;
  const focusY = (y - PREVIEW_VIEW.panY) / oldZoom;
  PREVIEW_VIEW.zoom = zoom;
  PREVIEW_VIEW.panX = x - focusX * zoom;
  PREVIEW_VIEW.panY = y - focusY * zoom;
  PREVIEW_VIEW.panX = clampPreviewPan(PREVIEW_VIEW.panX, PREVIEW_VIEW.viewW, PREVIEW_VIEW.baseW, zoom);
  PREVIEW_VIEW.panY = clampPreviewPan(PREVIEW_VIEW.panY, PREVIEW_VIEW.viewH, PREVIEW_VIEW.baseH, zoom);
  paintPreviewZoom();
}

function resetPreviewZoom() {
  PREVIEW_VIEW.zoom = 1;
  PREVIEW_VIEW.panX = 0;
  PREVIEW_VIEW.panY = 0;
  PREVIEW_VIEW.initialized = false;
  layoutPreviewZoom();
}

function stepPreviewZoom(direction, anchorX = null, anchorY = null) {
  let nearest = 0;
  for (let i = 1; i < PREVIEW_ZOOM_LEVELS.length; i++) {
    if (Math.abs(PREVIEW_ZOOM_LEVELS[i] - PREVIEW_VIEW.zoom) <
        Math.abs(PREVIEW_ZOOM_LEVELS[nearest] - PREVIEW_VIEW.zoom)) nearest = i;
  }
  const next = Math.max(0, Math.min(PREVIEW_ZOOM_LEVELS.length - 1, nearest + direction));
  setPreviewZoom(PREVIEW_ZOOM_LEVELS[next], anchorX, anchorY);
}

function bindVideoZoom() {
  const viewport = $("previewViewport");
  const player = $("player");
  $("videoZoomOut").onclick = () => stepPreviewZoom(-1);
  $("videoZoomIn").onclick = () => stepPreviewZoom(1);
  $("videoZoomFit").onclick = () => setPreviewZoom(1);
  viewport.addEventListener("wheel", (event) => {
    if (!event.ctrlKey || !event.deltaY) return;
    event.preventDefault();
    const bounds = viewport.getBoundingClientRect();
    const anchorX = clampWorkspaceSize(
      event.clientX - bounds.left, 0, viewport.clientWidth || bounds.width);
    const anchorY = clampWorkspaceSize(
      event.clientY - bounds.top, 0, viewport.clientHeight || bounds.height);
    stepPreviewZoom(event.deltaY < 0 ? 1 : -1, anchorX, anchorY);
  }, { passive: false });

  player.addEventListener("loadedmetadata", layoutPreviewZoom);
  window.addEventListener("resize", layoutPreviewZoom);
  layoutPreviewZoom();

  viewport.addEventListener("pointerdown", (event) => {
    const hasOverflow = PREVIEW_VIEW.baseW * PREVIEW_VIEW.zoom > PREVIEW_VIEW.viewW + 1 ||
      PREVIEW_VIEW.baseH * PREVIEW_VIEW.zoom > PREVIEW_VIEW.viewH + 1;
    if (!hasOverflow || event.button !== 0 ||
        event.target.closest("#capBox, .cap-handle")) return;
    event.preventDefault();
    PREVIEW_VIEW.drag = {
      pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      panX: PREVIEW_VIEW.panX, panY: PREVIEW_VIEW.panY,
    };
    viewport.classList.add("panning");
    try { viewport.setPointerCapture(event.pointerId); } catch (_) { /* window events still handle mouse input */ }
  });
  viewport.addEventListener("pointermove", (event) => {
    const drag = PREVIEW_VIEW.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    PREVIEW_VIEW.panX = clampPreviewPan(
      drag.panX + event.clientX - drag.x, PREVIEW_VIEW.viewW,
      PREVIEW_VIEW.baseW, PREVIEW_VIEW.zoom);
    PREVIEW_VIEW.panY = clampPreviewPan(
      drag.panY + event.clientY - drag.y, PREVIEW_VIEW.viewH,
      PREVIEW_VIEW.baseH, PREVIEW_VIEW.zoom);
    paintPreviewZoom();
  });
  const finishPan = (event) => {
    const drag = PREVIEW_VIEW.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    PREVIEW_VIEW.drag = null;
    viewport.classList.remove("panning");
    try { viewport.releasePointerCapture(event.pointerId); } catch (_) { /* already released */ }
  };
  viewport.addEventListener("pointerup", finishPan);
  viewport.addEventListener("pointercancel", finishPan);
}

function videoContentRect() {
  // Return the unzoomed frame coordinates inside the transformed preview stage.
  // The caption overlay is a sibling in that stage, so both scale together and
  // the overlay remains aligned with the actual video image at every zoom.
  const video = $("player"), stage = video.parentElement;
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const vb = video.getBoundingClientRect(), sb = stage.getBoundingClientRect();
  const zoom = Math.max(0.01, PREVIEW_VIEW.zoom || 1);
  const boxW = vb.width / zoom, boxH = vb.height / zoom;
  const scale = Math.min(boxW / vw, boxH / vh);
  const w = vw * scale, h = vh * scale;
  return { x: (vb.left - sb.left) / zoom + (boxW - w) / 2,
           y: (vb.top - sb.top) / zoom + (boxH - h) / 2, w, h };
}

function capActiveCuesAt(t) {
  return S.capCues.filter((c) => c.start <= t && t <= c.end);
}

function capActiveCue() {
  const act = capActiveCuesAt(playheadTime());
  return act.find((c) => c.id === S.capSel) || act[0] || null;
}

function ensureCueCaptionStyle(cue) {
  if (!cue.style || typeof cue.style !== "object") cue.style = { ...CAPPOS };
  return cue.style;
}

function capApplyToAll() {
  return !!$("capApplyAll")?.checked;
}

// Get the active cue's style (or the document default when the playhead is
// between cues). Actual edits go through applyCaptionStylePatch so Apply to all
// updates every timeline caption, on every track, not just this preview cue.
function capStyleTarget() {
  const cue = capActiveCue();
  return cue ? ensureCueCaptionStyle(cue) : CAPPOS;
}

function applyCaptionStylePatch(patch, activeCue = capActiveCue()) {
  if (capApplyToAll()) {
    // Use the active caption's complete layout as the shared base, then apply
    // the current change. This keeps position, box width, size and alignment
    // consistent together, and also updates the default for new captions.
    const shared = {
      ...CAPPOS,
      ...(activeCue && activeCue.style && typeof activeCue.style === "object"
        ? activeCue.style : {}),
      ...patch,
    };
    Object.assign(CAPPOS, shared);
    for (const cue of S.capCues) cue.style = { ...shared };
  } else if (activeCue) {
    Object.assign(ensureCueCaptionStyle(activeCue), patch);
  } else {
    Object.assign(CAPPOS, patch);
  }
}

function captionStyleEditTouchesTimeline(activeCue = capActiveCue()) {
  return !!activeCue || (capApplyToAll() && S.capCues.length > 0);
}

function styleCapBoxEl(el, st, r) {
  el.style.left = `${st.x * 100}%`;
  el.style.top = `${st.y * 100}%`;
  el.style.fontSize = `${Math.max(10, r.h * st.size_pct / 100)}px`;
  el.style.width = `${Math.max(0.08, st.box_w) * r.w}px`;
  el.style.textAlign = st.align === "justify" ? "left" : st.align;
  el.style.fontFamily = `\"${String(st.font || "Arial").replace(/[\"\\\\]/g, "") || "Arial"}\", Arial, sans-serif`;
  el.style.fontWeight = st.bold === false ? "400" : "700";
  el.style.fontStyle = st.italic ? "italic" : "normal";
  el.style.textDecoration = `${st.underline ? "underline " : ""}${st.strike ? "line-through" : ""}`.trim() || "none";
  el.style.letterSpacing = `${Number(st.tracking) || 0}em`;
  if (Number(st.box_h) > 0) {
    el.style.height = `${Number(st.box_h) * r.h}px`; el.style.display = "flex"; el.style.alignItems = "center";
  } else { el.style.height = "auto"; el.style.display = "block"; }
  el.style.lineHeight = String(Math.min(3, Math.max(0.7, Number(st.leading) || 1.25)));
  const rgba = (hex, opacity) => {
    const h = /^#[0-9a-f]{6}$/i.test(hex || "") ? hex : "#000000";
    return `rgba(${parseInt(h.slice(1,3),16)},${parseInt(h.slice(3,5),16)},${parseInt(h.slice(5,7),16)},${Math.min(100,Math.max(0,Number(opacity)||0))/100})`;
  };
  const sourceH = $("player")?.videoHeight || 1080;
  const scale = r.h / sourceH;
  el.style.color = rgba(st.fill || "#ffffff", st.fill_opacity ?? 100);
  el.style.webkitTextStroke = `${Math.max(0, Number(st.stroke_width) || 0) * scale}px ${rgba(st.stroke || "#000000", st.stroke_opacity ?? 100)}`;
  el.style.setProperty("--cap-bg", rgba(st.background || "#000000", st.background_opacity ?? 0));
  const angle = (Number(st.shadow_angle) || 0) * Math.PI / 180;
  const dist = Math.max(0, Number(st.shadow_distance) || 0) * scale;
  const spread = Math.max(0, Number(st.shadow_size) || 0) * scale;
  const blur = Math.max(0, Number(st.shadow_blur) || 0) * scale;
  const shadow = rgba(st.shadow || "#000000", st.shadow_opacity ?? 0);
  const shadows = [`${Math.cos(angle)*dist}px ${Math.sin(angle)*dist}px ${blur}px ${shadow}`];
  if (spread > 0) for (let deg = 0; deg < 360; deg += 45) {
    const a = deg * Math.PI / 180;
    shadows.push(`${Math.cos(angle)*dist + Math.cos(a)*spread}px ${Math.sin(angle)*dist + Math.sin(a)*spread}px ${blur}px ${shadow}`);
  }
  el.style.textShadow = shadows.join(", ");
}

function layoutCapOverlay() {
  const overlay = $("capOverlay");
  if (!overlay) return;
  const armed = (["burn", "both"].includes($("xCaptions").value) || $("cBurn")?.checked) && !!S.project;
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
  const st = active ? ensureCueCaptionStyle(active) : CAPPOS;

  // Static siblings: the OTHER captions sharing this frame, each rendered in
  // its own stored style so stacked captions preview exactly as burned.
  overlay.querySelectorAll(".cap-static").forEach((n) => n.remove());
  if (S.capCues.length) {
    for (const c of capActiveCuesAt(t)) {
      if (c === active) continue;
      const d = document.createElement("div");
      d.className = "cap-static";
      const cueStyle = ensureCueCaptionStyle(c);
      styleCapBoxEl(d, cueStyle, r);
      const cueFontPx = Math.max(10, r.h * cueStyle.size_pct / 100);
      const cueMaxChars = Math.floor((cueStyle.box_w * r.w) /
        Math.max(1, cueFontPx * (CHAR_FACTOR + (Number(cueStyle.tracking) || 0))));
      for (const lineText of wrapText(c.text || "", cueMaxChars)) {
        const row = document.createElement("div"); row.className = "cap-line";
        row.style.textAlign = cueStyle.align === "justify" ? "left" : cueStyle.align;
        const label = document.createElement("span"); label.className = "cap-line-label";
        label.textContent = lineText; row.appendChild(label); d.appendChild(row);
      }
      overlay.appendChild(d);
    }
  }

  const box = $("capBox");
  styleCapBoxEl(box, st, r);
  if (active) $("capBoxText").dataset.raw = active.text || "";
  const fontPx = Math.max(10, r.h * st.size_pct / 100);
  const maxChars = Math.floor((st.box_w * r.w) / Math.max(1, fontPx * (CHAR_FACTOR + (Number(st.tracking) || 0))));
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
  const styleControlValues = {
    capFontFamily: st.font || "Arial", capTracking: st.tracking ?? 0,
    capLineSpacing: st.leading ?? 1.25, capBold: st.bold !== false,
    capItalic: !!st.italic, capUnderline: !!st.underline, capStrike: !!st.strike,
    capFill: st.fill || "#ffffff", capFillEnabled: Number(st.fill_opacity ?? 100) > 0,
    capFillOpacity: st.fill_opacity ?? 100, capStroke: st.stroke || "#000000",
    capStrokeEnabled: Number(st.stroke_opacity ?? 100) > 0 && Number(st.stroke_width ?? 2) > 0,
    capStrokeWidth: st.stroke_width ?? 2, capStrokeOpacity: st.stroke_opacity ?? 100,
    capStrokePosition: st.stroke_position || "outer", capBackground: st.background || "#000000",
    capBackgroundEnabled: Number(st.background_opacity || 0) > 0,
    capBackgroundOpacity: st.background_opacity ?? 72, capShadow: st.shadow || "#000000",
    capShadowEnabled: Number(st.shadow_opacity || 0) > 0, capShadowOpacity: st.shadow_opacity ?? 75,
    capShadowAngle: st.shadow_angle ?? 135, capShadowDistance: st.shadow_distance ?? 3,
    capShadowSize: st.shadow_size ?? 6, capShadowBlur: st.shadow_blur ?? 12,
    capX: Math.round((st.x ?? .5) * 100), capY: Math.round((st.y ?? .92) * 100),
    capWidth: Math.round((st.box_w ?? .88) * 100), capHeight: Math.round((st.box_h ?? 0) * 100),
  };
  for (const [id, value] of Object.entries(styleControlValues)) {
    const input = $(id);
    if (input && document.activeElement !== input) {
      if (input.type === "checkbox") input.checked = !!value;
      else input.value = String(value);
    }
  }
  if ($("capFontSizeValue")) $("capFontSizeValue").textContent = String(Math.round(1080 * (st.size_pct || 4.5) / 100));
  if ($("capFillOpacityValue")) $("capFillOpacityValue").textContent = String(st.fill_opacity ?? 100);
  if ($("capBackgroundOpacityValue")) $("capBackgroundOpacityValue").textContent = String(st.background_opacity ?? 72);
  if ($("capShadowOpacityValue")) $("capShadowOpacityValue").textContent = String(st.shadow_opacity ?? 75);
  if ($("capShadowAngleValue")) $("capShadowAngleValue").textContent = `${st.shadow_angle ?? 135}°`;
  if ($("capShadowDistanceValue")) $("capShadowDistanceValue").textContent = String(st.shadow_distance ?? 3);
  if ($("capShadowSizeValue")) $("capShadowSizeValue").textContent = String(st.shadow_size ?? 6);
  if ($("capShadowBlurValue")) $("capShadowBlurValue").textContent = String(st.shadow_blur ?? 12);
  document.querySelectorAll(".capZone").forEach((b) => b.classList.toggle("on",
    Math.abs(Number(b.dataset.x) - (st.x ?? .5)) < .06 && Math.abs(Number(b.dataset.y) - (st.y ?? .92)) < .06));
  const fs = st.bold !== false && st.italic ? "bold-italic" : st.bold !== false ? "bold" : st.italic ? "italic" : "regular";
  if ($("capFontStyle") && document.activeElement !== $("capFontStyle")) $("capFontStyle").value = fs;
  syncAlignButtons();
}

function renderCaptionLines(lines, align) {
  const container = $("capBoxText");
  container.replaceChildren();
  for (const line of lines) {
    const row = document.createElement("div");
    row.className = "cap-line";
    row.style.textAlign = align === "justify" ? "left" : align;
    const label = document.createElement("span");
    label.className = "cap-line-label";
    label.textContent = line;
    row.appendChild(label);
    container.appendChild(row);
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
  const st = capStyleTarget();
  const align = st.align || "center";
  document.querySelectorAll(".capAlign").forEach((b) => b.classList.toggle("on", b.dataset.align === align));
  for (const [id, key] of [["capBold", "bold"], ["capItalic", "italic"], ["capUnderline", "underline"], ["capStrike", "strike"]])
    $(id)?.classList.toggle("on", !!st[key]);
}

function toggleCaptionFlag(key) {
  const cue = capActiveCue(), commit = captionStyleEditTouchesTimeline(cue);
  const st = cue ? ensureCueCaptionStyle(cue) : CAPPOS;
  applyCaptionStylePatch({ [key]: !st[key] }, cue);
  layoutCapOverlay(); syncAlignButtons();
  if (commit) commitCaptions();
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
      const targetCue = capActiveCue();
      const st = targetCue ? ensureCueCaptionStyle(targetCue) : CAPPOS;
      const commitOnFinish = captionStyleEditTouchesTimeline(targetCue);
      const move = (e) => {
        const r = overlay.getBoundingClientRect();
        if (!r.width) return;
        const cx = st.x * r.width;
        const half = Math.abs((e.clientX - r.left) - cx);
        applyCaptionStylePatch({ box_w: Math.min(0.98, Math.max(0.12, (2 * half) / r.width)) }, targetCue);
        layoutCapOverlay();
      };
      const up = (e) => {
        handle.releasePointerCapture?.(e.pointerId);
        handle.classList.remove("active");
        if (commitOnFinish) commitCaptions();
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
    const targetCue = capActiveCue();
    const commitOnFinish = captionStyleEditTouchesTimeline(targetCue);
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
      applyCaptionStylePatch({ x: nx, y: ny }, targetCue);
      layoutCapOverlay(); // repositions the other simultaneous caption previews too
    };
    const up = (e) => {
      box.releasePointerCapture?.(e.pointerId);
      box.classList.remove("dragging");
      if (commitOnFinish) commitCaptions();
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
    const targetCue = capActiveCue();
    applyCaptionStylePatch({
      size_pct: Number($("capFontSize").value) || CAPPOS_DEFAULT.size_pct,
    }, targetCue);
    layoutCapOverlay();
  });
  $("capFontSize").addEventListener("change", () => {
    if (captionStyleEditTouchesTimeline()) commitCaptions();
  });
  $("capPosReset").onclick = () => {
    const targetCue = capActiveCue();
    const commit = captionStyleEditTouchesTimeline(targetCue);
    applyCaptionStylePatch({ ...CAPPOS_DEFAULT }, targetCue);
    $("capFontSize").value = String(CAPPOS_DEFAULT.size_pct);
    syncAlignButtons();
    layoutCapOverlay();
    if (commit) commitCaptions();
  };
  document.querySelectorAll(".capAlign").forEach((b) => {
    b.addEventListener("click", () => {
      const targetCue = capActiveCue();
      const commit = captionStyleEditTouchesTimeline(targetCue);
      applyCaptionStylePatch({ align: b.dataset.align }, targetCue);
      syncAlignButtons();
      layoutCapOverlay();
      if (commit) commitCaptions();
    });
  });
  const styleInputs = {
    capFontFamily: ["font", "text"], capTracking: ["tracking", "number"],
    capLineSpacing: ["leading", "number"], capFill: ["fill", "text"],
    capFillOpacity: ["fill_opacity", "number"], capStroke: ["stroke", "text"],
    capStrokeWidth: ["stroke_width", "number"], capStrokeOpacity: ["stroke_opacity", "number"],
    capStrokePosition: ["stroke_position", "text"], capBackground: ["background", "text"],
    capBackgroundOpacity: ["background_opacity", "number"], capShadow: ["shadow", "text"],
    capShadowOpacity: ["shadow_opacity", "number"], capShadowAngle: ["shadow_angle", "number"],
    capShadowDistance: ["shadow_distance", "number"], capShadowSize: ["shadow_size", "number"],
    capShadowBlur: ["shadow_blur", "number"], capX: ["x", "percent"], capY: ["y", "percent"],
    capWidth: ["box_w", "percent"], capHeight: ["box_h", "percent"],
  };
  for (const [id, [key, type]] of Object.entries(styleInputs)) {
    const input = $(id); if (!input) continue;
    const update = () => {
      const cue = capActiveCue();
      const value = type === "number" ? Number(input.value) : type === "percent" ? Number(input.value) / 100 : input.value;
      applyCaptionStylePatch({ [key]: value }, cue);
      layoutCapOverlay();
    };
    input.addEventListener("input", update);
    input.addEventListener("change", () => { if (captionStyleEditTouchesTimeline()) commitCaptions(); });
  }
  const toggleOpacity = (id, key) => $(id)?.addEventListener("change", () => {
    const cue = capActiveCue(), st = cue ? ensureCueCaptionStyle(cue) : CAPPOS;
    const val = $(id).checked ? (Number(st[key] || 0) || 100) : 0;
    const commit = captionStyleEditTouchesTimeline(cue);
    applyCaptionStylePatch({ [key]: val }, cue); layoutCapOverlay();
    if (commit) commitCaptions();
  });
  toggleOpacity("capFillEnabled", "fill_opacity");
  toggleOpacity("capStrokeEnabled", "stroke_opacity");
  toggleOpacity("capBackgroundEnabled", "background_opacity");
  toggleOpacity("capShadowEnabled", "shadow_opacity");
  $("capFontStyle")?.addEventListener("change", () => {
    const v = $("capFontStyle").value, cue = capActiveCue();
    const commit = captionStyleEditTouchesTimeline(cue);
    applyCaptionStylePatch({ bold: v === "bold" || v === "bold-italic", italic: v === "italic" || v === "bold-italic" }, cue);
    layoutCapOverlay(); if (commit) commitCaptions();
  });
  $("capBold")?.addEventListener("click", () => toggleCaptionFlag("bold"));
  $("capItalic")?.addEventListener("click", () => toggleCaptionFlag("italic"));
  $("capUnderline")?.addEventListener("click", () => toggleCaptionFlag("underline"));
  $("capStrike")?.addEventListener("click", () => toggleCaptionFlag("strike"));
  document.querySelectorAll(".capZone").forEach((b) => b.addEventListener("click", () => {
    const cue = capActiveCue(), commit = captionStyleEditTouchesTimeline(cue);
    applyCaptionStylePatch({ x: Number(b.dataset.x), y: Number(b.dataset.y) }, cue);
    layoutCapOverlay(); if (commit) commitCaptions();
  }));
  $("cBurn")?.addEventListener("change", layoutCapOverlay);
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
const TRANSLATION_MODEL_PRIORITY = [
  "medium", "large-v3", "small", "base", "tiny", "large-v2", "large-v1",
];

function isTranslationUnsupportedModel(model) {
  return ["turbo", "large-v3-turbo"].includes(String(model || "").toLowerCase());
}

function translationFallbackModel(select) {
  if (!select) return "";
  const options = [...select.options].map((o) => o.value).filter(Boolean);
  for (const name of TRANSLATION_MODEL_PRIORITY) {
    if (options.includes(name)) return name;
  }
  return options.find((name) => !isTranslationUnsupportedModel(name)) || "";
}

function translationModelReady() {
  if (!$("cTranslate").checked) return true;
  const select = engineIsWcpp() ? $("wModel") : $("cModel");
  return !!select.value && !isTranslationUnsupportedModel(select.value);
}

// Caption burn position: normalised centre of the box on the frame.
const CAPPOS_DEFAULT = { x: 0.5, y: 0.92, size_pct: 4.5, align: "center", box_w: 0.88,
  anchor: "bottom", margin: 0.08,
  font: "Lucida Console", tracking: 0, leading: 1.25, bold: false, italic: false,
  underline: false, strike: false, fill: "#ffffff", fill_opacity: 100,
  stroke: "#000000", stroke_width: 1, stroke_opacity: 0, stroke_position: "outer",
  background: "#000000", background_opacity: 0,
  shadow: "#000000", shadow_opacity: 100, shadow_angle: 135,
  shadow_distance: 3, shadow_size: 6, shadow_blur: 12, box_h: 0 };
// Must match CHAR_FACTOR in vts/captionmap.py - both sides wrap text with
// it, which is what keeps the preview and the burn in sync.
const CHAR_FACTOR = 0.55;
const CAPPOS = { ...CAPPOS_DEFAULT };

function fillCaptionCard(caption) {
  if (!caption) return;
  const model = $("cModel"), lang = $("cLang"), dev = $("cDevice"), comp = $("cCompute");
  fillSelect(model, caption.models.map((m) => m.name), "medium");
  // Turbo is multilingual for transcription, but its training omitted the
  // speech-to-English translation task. Make that limitation visible in the
  // model list as well as the tooltip.
  caption.models.forEach((m, i) => {
    if (!model.options[i]) return;
    const turbo = isTranslationUnsupportedModel(m.name);
    model.options[i].textContent = m.name + (turbo ? " — transcription only" : "");
    model.options[i].title = `${m.size} — ${m.note}`;
  });
  // These controls can be re-filled after Re-check, so assign (rather than
  // add) handlers to avoid duplicate events.
  $("cTranslate").onchange = () => { updateTranslationUI(); syncCapButton(); };
  model.onchange = () => { updateTranslationUI(); syncCapButton(); };
  $("wModel").onchange = () => { updateTranslationUI(); syncCapButton(); };
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

function updateTranslationUI() {
  const hint = $("translateHint");
  if (!hint || !$("cTranslate")) return;
  if (!$("cTranslate").checked) {
    hint.textContent = "Translates non-English speech into English; English speech stays English. Turbo models are transcription-only, so checking this option will switch to a compatible model when available.";
    return;
  }

  const wcpp = engineIsWcpp();
  const select = wcpp ? $("wModel") : $("cModel");
  let model = select.value;
  let switchedFrom = "";
  if (isTranslationUnsupportedModel(model)) {
    const fallback = translationFallbackModel(select);
    if (fallback) {
      switchedFrom = model;
      select.value = fallback;
      model = fallback;
    }
  }

  if (!model) {
    hint.textContent = wcpp
      ? "No whisper.cpp model is installed. Download a translation-capable model (medium recommended, or large-v3) with Get model, then select it here."
      : "Choose a translation-capable model such as medium or large-v3.";
    return;
  }
  if (isTranslationUnsupportedModel(model)) {
    hint.textContent = wcpp
      ? "Turbo cannot translate. Download a translation-capable model (medium recommended, or large-v3) with Get model, then select it here."
      : "Turbo cannot translate. Choose medium or large-v3 for English translation.";
    return;
  }

  if (switchedFrom) {
    hint.textContent = wcpp
      ? `${switchedFrom} cannot translate; switched to installed ${model}.`
      : `${switchedFrom} cannot translate; switched to ${model}. faster-whisper may download this model the first time.`;
  } else {
    hint.textContent = "For non-English speech, Whisper will output English captions. English speech remains English.";
  }
}

function renderWcppPanel() {
  const w = CAP.wcpp;
  if (!w) return;
  const wModel = $("wModel"), wDl = $("wDlSelect");
  const previousModel = wModel.value;
  wModel.textContent = "";
  (w.models || []).forEach((m) => {
    const o = document.createElement("option");
    o.value = m.name;
    o.textContent = `${m.name}${isTranslationUnsupportedModel(m.name) ? " — transcription only" : ""} (${Math.round(m.size_bytes / 1048576)} MB on disk)`;
    wModel.appendChild(o);
  });
  if (previousModel && [...wModel.options].some((o) => o.value === previousModel))
    wModel.value = previousModel;
  if (!wModel.options.length) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = "no GGML models yet - download one below";
    wModel.appendChild(o);
  }
  wDl.textContent = "";
  (w.catalog || []).filter((c) => !c.present).forEach((c) => {
    const o = document.createElement("option");
    o.value = c.name;
    o.textContent = `${c.name}${isTranslationUnsupportedModel(c.name) ? " — transcription only" : ""} (${c.size})`;
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
  updateTranslationUI();
}

function syncCapButton() {
  const btn = $("capBtn");
  const translationReady = translationModelReady();
  if (engineIsWcpp()) {
    const w = CAP.wcpp || {};
    const hasModel = (w.models || []).length > 0;
    const ok = !!w.available && hasModel && translationReady;
    btn.disabled = !ok;
    btn.textContent = !translationReady ? "download a translation-capable model"
      : (ok ? "Transcribe with whisper.cpp"
        : (!w.available ? "whisper-cli not found" : "download a GGML model first"));
  } else {
    const st = CAP.fwStatus || { available: false };
    const ok = !!st.available && translationReady;
    btn.disabled = !ok;
    btn.textContent = !translationReady ? "choose a translation-capable model"
      : (st.available ? "Transcribe to captions" : "Auto-caption unavailable");
  }
}

function updateEngineUI() {
  const wcpp = engineIsWcpp();
  $("wcppPanel").hidden = !wcpp;
  ["rowFwModel", "rowFwDevice", "rowFwCompute"].forEach((id) => { $(id).hidden = wcpp; });
  $("fwOnlyChecks").hidden = wcpp;
  updateTranslationUI();
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
    caption_style: { ...CAPPOS },
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
  updateTranslationUI();
  syncCapButton();
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
  bindWorkspaceDocking();
  bindVideoZoom();
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
