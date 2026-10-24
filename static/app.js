/* Video Trim Studio - frontend. No build step, no CDN, plain JS. */
"use strict";

const $ = (id) => document.getElementById(id);

const S = {
  env: null,
  project: null,
  preview: null,
  tl: { clips: [], auds: [], caps: [], lanes: 1, vtracks: 1, atracks: 1 },
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
  laneHidden: new Set(), laneLocked: new Set(), laneH: {}, audioMuted: new Set(),
  snap: true, magnetic: false, pan: false,
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

// Premiere's Program Monitor zoom goes from 10% to 800% in named steps; we
// keep the same list so the dropdown and the +/- buttons agree.
const PREVIEW_ZOOM_LEVELS = [0.1, 0.125, 0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
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

const WORKSPACE_STORAGE_KEY = "video-trim-studio.workspace.v3";
const WORKSPACE_STORAGE_KEY_V2 = "video-trim-studio.workspace.v2";
const WORKSPACE_STORAGE_KEY_V1 = "video-trim-studio.workspace.v1";
const WORKSPACE_ZONES = ["left", "center", "right", "bottom"];
// Bump when the shipped default arrangement changes; saved layouts older than
// this are migrated once (see applyWorkspaceLayout).
const WORKSPACE_LAYOUT_REV = 3;
// Premiere-style units: project/program are single cards; inspector and the
// Every panel is a real, movable unit now. These five simply *start life*
// grouped inside a host, which is what makes them tabs on a fresh workspace;
// drag one out and it becomes a panel in its own right.
const DEFAULT_UNIT_HOST = {
  clip: "inspector", list: "inspector", export: "inspector", keys: "inspector",
  tl: "timeline",
};
// Panels whose header is already a tab strip in the markup. Grouping a panel
// into one of these just adds a tab; a plain panel (Project, Program Monitor)
// first gets a strip of its own, with a tab for itself.
const TAB_STRIP_UNITS = ["inspector", "timeline"];
// Live copies, rebuilt from WS.host by syncGroupTabs().
let UNIT_TABS = {};
let TAB_UNIT = {};
const TAB_TITLES = {
  clip: "Inspector", export: "Export", tl: "Timeline", list: "Sections",
  keys: "Keyframes",
};
const UNIT_TITLES = {
  project: "Project", program: "Program Monitor",
  inspector: "Inspector", timeline: "Timeline",
  clip: "Inspector", export: "Export", keys: "Keyframes",
  tl: "Timeline 01", list: "Sections",
};
// Where a panel lands when it is dragged out of a group, and the order tabs
// are shown in. Every panel is listed: the five tabbed ones are members of a
// host until the user pulls them out.
// Key order is also the tab order inside a group: Clip, Text, List, Export.
const DEFAULT_UNIT_ZONE = {
  project: "left", program: "center", inspector: "right", timeline: "bottom",
  clip: "right", list: "bottom", export: "right", keys: "right", tl: "bottom",
};
const UNIT_ORDER = Object.keys(DEFAULT_UNIT_ZONE);
const DEFAULT_WORKSPACE_LAYOUT = {
  zones: {
    left: ["project"],
    center: ["program"],
    right: ["inspector"],
    bottom: ["timeline"],
  },
  win: {
    project: true, program: true, inspector: true, timeline: true,
    clip: true, export: true, keys: true,
    tl: true, list: true,
  },
  activeTab: { inspector: "list", timeline: "tl" },
  host: { ...DEFAULT_UNIT_HOST },
  zoneSizes: {},
  sizes: {},
  layoutRev: WORKSPACE_LAYOUT_REV,
};
const WINDOW_MENU = [
  ["project", "Project"],
  ["program", "Program Monitor"],
  "sep",
  ["clip", "Inspector"],
  ["export", "Export"],
  ["keys", "Keyframes"],
  "sep",
  ["tl", "Timeline"],
  ["list", "Sections"],
  "sep",
];
// Live workspace state; zones/sizes refresh from the DOM on save.
let WS = null;

function unitEl(unit) {
  return document.querySelector(`[data-workspace-panel="${unit}"]`);
}

function tabBtn(unit, tab) {
  const root = unitEl(unit);
  return root ? root.querySelector(`[data-wintab="${tab}"]`) : null;
}

function tabPage(unit, tab) {
  const root = unitEl(unit);
  return root ? root.querySelector(`[data-tabpage="${tab}"]`) : null;
}

function unitIsVisible(unit) {
  const el = unitEl(unit);
  return !!el && el.style.display !== "none";
}

function zoneHasVisibleUnit(zone) {
  const host = zoneEl(zone);
  if (!host) return false;
  return [...host.children].some((el) =>
    el.hasAttribute("data-workspace-panel") && el.style.display !== "none");
}

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
  const minWidth = Math.min(48, parentWidth);
  // Restore only the axis that was actually resized: a height-only resize must
  // leave the panel stretched to its column, otherwise its left/right edges
  // would stop being the free column dividers.
  const horizontal = Number.isFinite(Number(size.width)) || Number.isFinite(Number(size.marginLeft));
  const vertical = Number.isFinite(Number(size.height)) || Number.isFinite(Number(size.marginTop));
  if (!horizontal && !vertical) {
    clearWorkspacePanelSize(panel);
    return;
  }
  if (horizontal) {
    let marginLeft = Number(size.marginLeft);
    if (!Number.isFinite(marginLeft)) marginLeft = 0;
    marginLeft = clampWorkspaceSize(marginLeft, 0, Math.max(0, parentWidth - minWidth));
    let width = Number(size.width);
    if (!Number.isFinite(width)) width = parentWidth - marginLeft;
    width = clampWorkspaceSize(width, minWidth, Math.max(minWidth, parentWidth - marginLeft));
    // A wider-than/equal-to-the-column pin is not a real resize (older builds
    // saved the natural full width). Leave those panels stretched so they keep
    // following the column and their side edges stay free column dividers.
    if (marginLeft === 0 && width >= parentWidth - 1) {
      panel.style.width = "";
      panel.style.marginLeft = "";
      panel.style.alignSelf = "";
    } else {
      panel.style.width = `${width}px`;
      panel.style.marginLeft = `${marginLeft}px`;
      panel.style.alignSelf = "flex-start";
    }
  }
  if (vertical) {
    const minHeight = 48;
    const maxHeight = Infinity; // free: user decides, page scrolls
    let height = Number(size.height);
    if (!Number.isFinite(height)) height = panel.getBoundingClientRect().height;
    height = clampWorkspaceSize(height, minHeight, maxHeight);
    let marginTop = Number(size.marginTop);
    if (!Number.isFinite(marginTop)) marginTop = 0;
    marginTop = clampWorkspaceSize(marginTop, 0, maxHeight);
    panel.style.height = `${height}px`;
    panel.style.marginTop = `${marginTop}px`;
    panel.style.flex = "0 0 auto";
  }
  panel.classList.add("workspace-panel-resized");
}

function applyTimelinePanelSize(panel, size) {
  clearWorkspacePanelSize(panel);
  if (!size || typeof size !== "object") return;
  const parentWidth = panel.parentElement?.clientWidth || Number(size.width) || 320;
  const minWidth = Math.min(48, parentWidth);
  const width = Number(size.width);
  const minHeight = 48;
  const maxHeight = Infinity; // free: user decides, page scrolls
  const height = Number(size.height);
  const marginTop = Number(size.marginTop);
  if (![width, height, marginTop].some(Number.isFinite)) return;
  // Same rule as the other units: a pin that is the whole row width is not a
  // real resize, so let the panel stay stretched.
  if (Number.isFinite(width) && width < parentWidth - 1) {
    panel.style.width = `${clampWorkspaceSize(width, minWidth, Math.max(minWidth, parentWidth))}px`;
  }
  if (Number.isFinite(height)) panel.style.height = `${clampWorkspaceSize(height, minHeight, maxHeight)}px`;
  if (Number.isFinite(marginTop)) panel.style.marginTop = `${clampWorkspaceSize(marginTop, 0, maxHeight)}px`;
  panel.style.alignSelf = "stretch";
  panel.style.flex = "0 0 auto";
  panel.classList.add("workspace-panel-resized");
}

function applyTimelineViewportHeight(height) {
  const viewport = $("scroll");
  if (!viewport) return;
  const savedHeight = Number(height);
  if (!Number.isFinite(savedHeight) || savedHeight <= 0) {
    viewport.style.height = "";
    viewport.scrollTop = 0;
    viewport.scrollLeft = 0;
    return;
  }
  const minHeight = 48;
  const maxHeight = Infinity; // free
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
  const minHeight = 48;
  const maxHeight = Infinity; // free
  PREVIEW_VIEW.viewportHeight = clampWorkspaceSize(savedHeight, minHeight, maxHeight);
  viewport.style.height = `${PREVIEW_VIEW.viewportHeight}px`;
}

function bindTimelineViewportResize() {
  const handle = $("tlResizeHandle");
  const viewport = $("scroll");
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
    const minHeight = 48;
    const maxHeight = Infinity; // free
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
    const minHeight = 48;
    const maxHeight = Infinity; // free
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

function zoneEl(zone) {
  return document.querySelector(`[data-workspace-column="${zone}"]`);
}

function zoneResizeLimits(zone) {
  // Free-form: only a tiny floor so a zone can't vanish into an
  // ungrabbable sliver, and a ceiling of nearly the full row width.
  // The user decides the layout; nothing is reserved.
  const el = zoneEl(zone);
  if (!el) return null;
  const MIN = 48;
  if (zone !== "left" && zone !== "right") return null;
  const row = el.parentElement;
  const rowW = row ? row.clientWidth : window.innerWidth;
  return [MIN, Math.max(MIN, rowW - MIN)];
}

function setZoneSize(zone, px) {
  const el = zoneEl(zone);
  if (!el) return;
  if (zone === "bottom") {
    // #workspace is block layout, so a flex-basis on the bottom zone is
    // inert; the zone's height follows the timeline viewport (#scroll).
    // Delegate the drag to the viewport height instead.
    const viewport = $("scroll");
    if (!viewport || !Number.isFinite(px)) return;
    const chrome = Math.max(0, el.getBoundingClientRect().height
      - viewport.getBoundingClientRect().height);
    applyTimelineViewportHeight(px - chrome);
    return;
  }
  const limits = zoneResizeLimits(zone);
  if (!limits) return;
  if (!Number.isFinite(px)) { el.style.flexBasis = ""; return; }
  el.style.flexBasis = `${clampWorkspaceSize(px, limits[0], limits[1])}px`;
}

// A vertical edge that sits on a column boundary *is* a column divider, so it
// drags the split freely (both directions, no maximum width) instead of
// resizing the panel box inside a column whose width it can never exceed.
// The center column has a divider on each side: its left edge drives the left
// column and its right edge drives the right column. Outer edges (the window
// sides) have no column to give space to, so those resize the panel itself.
function columnSplitEdge(panel, edge, zone) {
  if (!panel || !zone || (edge !== "left" && edge !== "right")) return null;
  const zcol = zone.dataset.workspaceColumn;
  let split = null;
  if (zcol === "center") split = edge;
  else if (zcol === "left" && edge === "right") split = "left";
  else if (zcol === "right" && edge === "left") split = "right";
  if (!split) return null;
  // Only while the panel really reaches that boundary; a panel resized by
  // hand sits inside its column and then its edges resize the panel again.
  const pr = panel.getBoundingClientRect();
  const zr = zone.getBoundingClientRect();
  const flush = edge === "left"
    ? pr.left - zr.left <= 2
    : zr.right - pr.right <= 2;
  return flush ? split : null;
}

function refreshWorkspaceResizeHandleTitles(root) {
  // Edges on a column boundary resize the whole column; the rest resize the panel.
  for (const handle of root.querySelectorAll(".workspace-resize-handle")) {
    const edge = handle.dataset.resizeEdge;
    const panel = handle.closest("[data-workspace-panel]");
    const zone = panel?.closest("[data-workspace-column]");
    const split = columnSplitEdge(panel, edge, zone);
    // Name the divider rather than "this edge": the grip can sit on the right
    // side of a panel while it widens the column on its left.
    handle.title = split
      ? `Drag the divider to resize the ${split} column`
      : `Drag the ${edge} edge to resize this panel`;
  }
}

function migrateWorkspaceV1toV2(v1) {
  // One-time upgrade: the old two-column arrangement maps onto the zones.
  if (!v1 || typeof v1 !== "object") return null;
  if (!Array.isArray(v1.main) && !Array.isArray(v1.side)) return null;
  const zones = { left: ["source"], center: [], right: [], bottom: [] };
  for (const id of v1.main || []) {
    if (id === "video") zones.center.push(id);
    else if (id === "timeline" || id === "list") zones.bottom.push(id);
    else zones.left.push(id);
  }
  for (const id of v1.side || []) zones.right.push(id);
  return {
    zones, hidden: [], zoneSizes: {}, sizes: v1.sizes || {},
    timelineViewportHeight: v1.timelineViewportHeight,
    previewViewportHeight: v1.previewViewportHeight,
  };
}

const V2_PANEL_UNIT = {
  source: "project", detect: "project", caption: "project",
  video: "program",
  clip: "inspector", "caption-style": "inspector",
  "export-settings": "inspector", export: "inspector",
  timeline: "timeline", list: "timeline",
};

function migrateWorkspaceV2toV3(v2) {
  // One-time upgrade: the ten flat panels fold into the four tabbed units.
  if (!v2 || typeof v2 !== "object" || !v2.zones || typeof v2.zones !== "object") return null;
  const zones = { left: [], center: [], right: [], bottom: [] };
  const seen = new Set();
  for (const z of WORKSPACE_ZONES) {
    for (const id of (Array.isArray(v2.zones[z]) ? v2.zones[z] : [])) {
      const u = V2_PANEL_UNIT[id];
      if (u && !seen.has(u)) { zones[z].push(u); seen.add(u); }
    }
  }
  for (const u of Object.keys(DEFAULT_UNIT_ZONE)) {
    if (!seen.has(u)) zones[DEFAULT_UNIT_ZONE[u]].push(u);
  }
  const hidden = new Set(Array.isArray(v2.hidden) ? v2.hidden : []);
  const win = {
    project: true, program: true, inspector: true, timeline: true,
    clip: true, text: true, export: true, keys: true,
    tl: true, list: true,
  };
  if (hidden.has("source") && hidden.has("detect") && hidden.has("caption")) win.project = false;
  if (hidden.has("video")) win.program = false;
  if (hidden.has("clip")) win.clip = false;
  if (hidden.has("caption-style")) win.text = false;
  if (hidden.has("export-settings") && hidden.has("export")) win.export = false;
  if (hidden.has("timeline")) win.tl = false;
  if (hidden.has("list")) win.list = false;
  const activeTab = { inspector: "clip", timeline: "tl" };
  for (const unit of Object.keys(UNIT_TABS)) {
    const vis = UNIT_TABS[unit].filter((t) => win[t]);
    if (vis.length) activeTab[unit] = vis[0];
  }
  const out = {
    zones, win, activeTab,
    zoneSizes: (v2.zoneSizes && typeof v2.zoneSizes === "object") ? { ...v2.zoneSizes } : {},
    sizes: {},
    timelineViewportHeight: v2.timelineViewportHeight,
    previewViewportHeight: v2.previewViewportHeight,
    lanes: v2.lanes,
  };
  if (v2.sizes && v2.sizes.timeline) out.sizes.timeline = v2.sizes.timeline;
  return out;
}

function applyWorkspaceLayout(layout) {
  const root = $("workspace");
  if (!root) return;
  const units = workspacePanelMap(root);
  const zones = {};
  for (const z of WORKSPACE_ZONES) zones[z] = root.querySelector(`[data-workspace-column="${z}"]`);
  // Normalize into the live state (never mutate the caller's object).
  WS = {
    zones: JSON.parse(JSON.stringify(DEFAULT_WORKSPACE_LAYOUT.zones)),
    win: { ...DEFAULT_WORKSPACE_LAYOUT.win },
    activeTab: { ...DEFAULT_WORKSPACE_LAYOUT.activeTab },
    zoneSizes: {},
    sizes: {},
    timelineViewportHeight: layout?.timelineViewportHeight,
    previewViewportHeight: layout?.previewViewportHeight,
    lanes: layout?.lanes,
  };
  if (layout?.zoneSizes && typeof layout.zoneSizes === "object") WS.zoneSizes = { ...layout.zoneSizes };
  // Group map: member unit -> host unit. Single level only: a host cannot be
  // a member and a member cannot host.
  const hostMap = {};
  const rawHost = layout?.host && typeof layout.host === "object" ? layout.host : {};
  for (const [m, h] of Object.entries(rawHost)) {
    if (m !== h && DEFAULT_UNIT_ZONE[m] && DEFAULT_UNIT_ZONE[h]) hostMap[m] = h;
  }
  // A layout saved before the tabbed panels became units has no `host` map.
  // Give those panels their default home, unless the saved layout parked them
  // in a zone of their own (i.e. the user had already pulled them out).
  const zoned = new Set(Object.values(layout?.zones || {})
    .flatMap((list) => (Array.isArray(list) ? list : [])));
  for (const [m, h] of Object.entries(DEFAULT_UNIT_HOST)) {
    if (hostMap[m] || zoned.has(m)) continue;
    if (Object.values(hostMap).includes(m) || hostMap[h]) continue;
    hostMap[m] = h;
  }
  for (const [m, h] of Object.entries(hostMap)) {
    if (hostMap[h] || Object.values(hostMap).includes(m)) delete hostMap[m];
  }
  // Workspace rev 2 moved the List panel from the bottom group into the
  // Inspector group. A rev-1 layout that still has List tabbed under the
  // Timeline picks that up once; a List the user pulled out on purpose has no
  // host entry and is left exactly where it is.
  const oldLayout = (Number(layout?.layoutRev) || 1) < 2;
  const listWasTimelineTab = oldLayout && hostMap.list === "timeline";
  if (listWasTimelineTab) hostMap.list = "inspector";
  WS.host = hostMap;
  syncGroupTabs();

  if (layout?.win && typeof layout.win === "object") {
    for (const k of Object.keys(WS.win)) {
      if (typeof layout.win[k] === "boolean") WS.win[k] = layout.win[k];
    }
  }
  if (layout?.activeTab && typeof layout.activeTab === "object") {
    for (const u of Object.keys(WS.activeTab)) {
      if (UNIT_TABS[u] && UNIT_TABS[u].includes(layout.activeTab[u])) {
        WS.activeTab[u] = layout.activeTab[u];
      }
    }
  }
  if (listWasTimelineTab) WS.activeTab.inspector = "list";
  if (layout?.sizes && typeof layout.sizes === "object") WS.sizes = { ...layout.sizes };

  teardownGroups();
  const ordered = { left: [], center: [], right: [], bottom: [] };
  const used = new Set();
  for (const z of WORKSPACE_ZONES) {
    const ids = layout?.zones && Array.isArray(layout.zones[z]) ? layout.zones[z] : [];
    for (const id of ids) {
      if (units.has(id) && !used.has(id)) {
        ordered[z].push(id);
        used.add(id);
      }
    }
  }
  for (const [id, el] of units) {
    if (used.has(id)) continue;
    const z = el.dataset.defaultColumn;
    ordered[WORKSPACE_ZONES.includes(z) ? z : "left"].push(id);
  }
  WS.zones = ordered;
  for (const z of WORKSPACE_ZONES) {
    if (!zones[z]) continue;
    for (const id of ordered[z]) zones[z].appendChild(units.get(id));
  }
  renderGroups();
  // Unit sizes.
  for (const [id, el] of units) {
    if (WS.host[id]) continue;
    const size = WS.sizes[id];
    if (id === "timeline") {
      // Panel width/height sizing remains separate from the Timeline viewport's
      // inner height control.
      applyTimelinePanelSize(el, size);
    } else {
      applyWorkspacePanelSize(el, size);
    }
  }
  // Zone sizes.
  setZoneSize("left", Number(WS.zoneSizes.left));
  setZoneSize("right", Number(WS.zoneSizes.right));
  setZoneSize("bottom", Number(WS.zoneSizes.bottom));
  // Visibility (Window menu + x buttons): whole units, then tab buttons.
  renderWorkspaceVisibility();
  applyTimelineViewportHeight(WS.timelineViewportHeight);
  applyPreviewViewportHeight(WS.previewViewportHeight);
  // Timeline lane lock/eye (timeline.js owns the drawing; the state lives on S).
  const lanes = WS.lanes || {};
  S.laneHidden = new Set(Array.isArray(lanes.hidden) ? lanes.hidden : []);
  S.laneLocked = new Set(Array.isArray(lanes.locked) ? lanes.locked : []);
  S.laneH = lanes.h && typeof lanes.h === "object" ? { ...lanes.h } : {};
  S.audioMuted = new Set(Array.isArray(lanes.muted) ? lanes.muted : []);
  laneLabelsDirty();
}

function renderWorkspaceVisibility() {
  if (!WS) return;
  for (const unit of Object.keys(DEFAULT_UNIT_ZONE)) {
    const el = unitEl(unit);
    if (!el) continue;
    const tabs = UNIT_TABS[unit];
    const vis = tabs ? tabs.filter((t) => WS.win[t]) : [];
    // A shell host (Inspector, Timeline) only exists to hold tabs; once the
    // last one leaves, the empty container goes with it.
    const emptyHost = TAB_STRIP_UNITS.includes(unit) && !vis.length;
    if (!WS.win[unit] || (tabs && !vis.length) || emptyHost) {
      el.style.display = "none";
      continue;
    }
    el.style.display = "";
    if (!tabs) continue;
    for (const t of tabs) {
      const btn = tabBtn(unit, t);
      if (btn) btn.style.display = WS.win[t] ? "" : "none";
    }
    // The active tab must be a visible one that still belongs to this host
    // (it may have been dragged out into a panel of its own).
    if (!vis.includes(WS.activeTab[unit])) WS.activeTab[unit] = vis[0];
    activateTab(unit, WS.activeTab[unit], false);
  }
  refreshWindowMenu();
  refreshZoneCollapse();
}

function refreshZoneCollapse() {
  for (const z of WORKSPACE_ZONES) {
    const host = zoneEl(z);
    if (host) host.classList.toggle("zone-empty", !zoneHasVisibleUnit(z));
  }
}

function afterWorkspaceVisibility() {
  renderWorkspaceVisibility();
  saveWorkspaceLayout();
  // The resize listeners (timeline draw, preview layout, caption overlay)
  // re-measure whatever just became visible.
  window.dispatchEvent(new Event("resize"));
}

function resetWorkspace() {
  applyWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT);
  saveWorkspaceLayout();
  window.dispatchEvent(new Event("resize"));
  status("Workspace reset.");
}

function readWorkspaceLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY) || "null");
    if (saved && typeof saved === "object" && saved.zones && saved.win) return saved;
    const v2 = migrateWorkspaceV2toV3(
      JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY_V2) || "null"));
    if (v2) return v2;
    return migrateWorkspaceV2toV3(migrateWorkspaceV1toV2(
      JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY_V1) || "null")));
  }
  catch (_) { return null; }
}

function saveWorkspaceLayout() {
  const root = $("workspace");
  if (!root || !WS) return;
  for (const z of WORKSPACE_ZONES) {
    const host = root.querySelector(`[data-workspace-column="${z}"]`);
    WS.zones[z] = host
      ? [...host.children].filter((el) => el.hasAttribute("data-workspace-panel"))
        .map((el) => el.dataset.workspacePanel)
      : [];
  }
  WS.sizes = {};
  for (const [id, el] of workspacePanelMap(root)) {
    const size = {};
    const properties = id === "timeline"
      ? ["width", "height", "marginTop"] : ["width", "height", "marginLeft", "marginTop"];
    for (const property of properties) {
      const value = parseFloat(el.style[property]);
      if (Number.isFinite(value)) size[property] = value;
    }
    if (Object.keys(size).length) WS.sizes[id] = size;
  }
  WS.zoneSizes = {};
  for (const z of ["left", "right", "bottom"]) {
    const value = parseFloat(zoneEl(z)?.style.flexBasis || "");
    if (Number.isFinite(value)) WS.zoneSizes[z] = value;
  }
  if (Number.isFinite(PREVIEW_VIEW.viewportHeight))
    WS.previewViewportHeight = PREVIEW_VIEW.viewportHeight;
  else delete WS.previewViewportHeight;
  const timelineViewportHeight = parseFloat($("scroll")?.style.height || "");
  if (Number.isFinite(timelineViewportHeight)) WS.timelineViewportHeight = timelineViewportHeight;
  else delete WS.timelineViewportHeight;
  if ((S.laneHidden && S.laneHidden.size) || (S.laneLocked && S.laneLocked.size) || (S.laneH && Object.keys(S.laneH).length) || (S.audioMuted && S.audioMuted.size)) {
    WS.lanes = {
      hidden: [...(S.laneHidden || [])],
      locked: [...(S.laneLocked || [])],
      h: S.laneH ? { ...S.laneH } : {},
      muted: [...(S.audioMuted || [])],
    };
  } else delete WS.lanes;
  WS.layoutRev = WORKSPACE_LAYOUT_REV;   // this save already has rev-2 defaults
  try { localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(WS)); }
  catch (_) { /* Keep the current arrangement for this page if storage is unavailable. */ }
}

/* ------------------------------------------------------------ groups */

// The unit (top-level, not a member) that contains el.
function topUnitOf(el) {
  let unit = el.closest("[data-workspace-panel]");
  while (unit && WS && WS.host[unit.dataset.workspacePanel]) {
    unit = unit.parentElement.closest("[data-workspace-panel]");
  }
  return unit;
}

function workspaceDropTarget(event, dragged) {
  const hit = event.target.closest("[data-workspace-panel]");
  if (!hit || dragged.contains(hit)) return null;
  const top = topUnitOf(hit);
  if (!top || top === dragged) return null;
  const name = dragged.dataset.workspacePanel;
  const topName = top.dataset.workspacePanel;
  const rect = top.getBoundingClientRect();
  const rel = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
  if (rel < 0.2 || rel > 0.8) return { kind: "edge", top, before: rel < 0.5 };
  if (WS.host[name] === topName || WS.host[topName] === name) return { kind: "none", top };
  return { kind: "merge", top, topName };
}

function makeDynTab(host, key) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("role", "tab");
  btn.setAttribute("aria-selected", "false");
  btn.dataset.wintab = key;
  btn.dataset.dynTab = "1";
  btn.dataset.host = host;
  // Same attributes the hand-written tabs had, so styles and tests that look
  // for [data-tab="clip"] / [data-btab="list"] keep working.
  btn.dataset.tab = key;
  btn.dataset.btab = key;
  btn.draggable = true;
  btn.textContent = UNIT_TITLES[key] || key;
  btn.title = "Drag to move this panel out of the group";
  return btn;
}

function makeDynPage(key) {
  const page = document.createElement("div");
  page.className = "tabpage";
  page.dataset.tabpage = key;
  page.dataset.dynPage = "1";
  page.setAttribute("role", "tabpanel");
  page.setAttribute("aria-label", UNIT_TITLES[key] || key);
  return page;
}

// A plain unit (Project / Program) becomes a group host: its header turns
// into a tab strip (own title tab first) and its body into one tab page.
function ensurePlainGroupStrip(hostEl, host) {
  const head = hostEl.querySelector(":scope > .ws-head");
  const body = hostEl.querySelector(":scope > .ws-body");
  if (!head || !body || head.classList.contains("ws-dyn-head")) return;
  head.classList.add("ws-tabs", "ws-dyn-head");
  head.setAttribute("role", "tablist");
  head.insertBefore(makeDynTab(host, host), head.querySelector(":scope > .ws-head-spacer"));
  const page = makeDynPage(host);
  page.classList.add("active");
  while (body.firstChild) page.appendChild(body.firstChild);
  body.appendChild(page);
}

function syncGroupTabs() {
  UNIT_TABS = {};
  TAB_UNIT = {};
  const members = Object.keys(WS.host || {}).filter((m) => WS.host[m] && WS.host[m] !== m);
  for (const host of UNIT_ORDER) {
    const mine = members
      .filter((m) => WS.host[m] === host)
      .sort((a, b) => UNIT_ORDER.indexOf(a) - UNIT_ORDER.indexOf(b));
    if (!mine.length) continue;
    const selfTab = !TAB_STRIP_UNITS.includes(host);
    UNIT_TABS[host] = selfTab ? [host, ...mine] : mine;
    if (selfTab) TAB_UNIT[host] = host;
    for (const m of mine) TAB_UNIT[m] = host;
  }
}

// Put every grouped unit back into its zone and remove the group chrome, so
// renderGroups() can rebuild from WS.host (or the zones alone).
function teardownGroups() {
  const root = $("workspace");
  if (!root) return;
  for (const page of [...root.querySelectorAll("[data-dyn-page]")]) {
    const body = page.parentElement;
    const hostEl = body.closest("[data-workspace-panel]");
    const column = hostEl ? hostEl.parentElement : null;
    let anchor = hostEl;
    for (const child of [...page.children]) {
      if (child.hasAttribute("data-workspace-panel") && column && anchor) {
        column.insertBefore(child, anchor.nextSibling);
        anchor = child;
      } else {
        body.insertBefore(child, page);
      }
    }
    page.remove();
  }
  for (const btn of root.querySelectorAll("[data-dyn-tab]")) btn.remove();
  for (const head of root.querySelectorAll(".ws-dyn-head")) {
    head.classList.remove("ws-tabs", "ws-dyn-head");
    head.removeAttribute("role");
  }
  for (const el of root.querySelectorAll(".is-member")) el.classList.remove("is-member");
}

// Nest each member unit as a tab page inside its host.
function renderGroups() {
  const root = $("workspace");
  if (!root || !WS) return;
  const byHost = new Map();
  for (const [member, host] of Object.entries(WS.host)) {
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(member);
  }
  for (const [host, members] of byHost) {
    const hostEl = unitEl(host);
    if (!hostEl) continue;
    // Canonical tab order (Clip, Text, List, Export / Timeline, List), not the
    // order the group map happens to be saved in.
    members.sort((a, b) => UNIT_ORDER.indexOf(a) - UNIT_ORDER.indexOf(b));
    if (!TAB_STRIP_UNITS.includes(host)) ensurePlainGroupStrip(hostEl, host);
    const strip = hostEl.querySelector(":scope > .ws-tabs");
    const body = hostEl.querySelector(":scope > .ws-body");
    if (!strip || !body) continue;
    for (const member of members) {
      const memEl = unitEl(member);
      if (!memEl) continue;
      const page = makeDynPage(member);
      body.appendChild(page);
      memEl.classList.add("is-member");
      memEl.classList.remove("workspace-panel-resized");
      for (const prop of ["width", "height", "marginLeft", "marginTop", "flex", "flexBasis", "alignSelf"]) {
        memEl.style[prop] = "";
      }
      page.appendChild(memEl);
      strip.insertBefore(makeDynTab(host, member), strip.querySelector(":scope > .ws-head-spacer"));
    }
  }
}

function commitWorkspaceGroups(message) {
  teardownGroups();
  syncGroupTabs();
  renderGroups();
  addWorkspaceResizeHandles($("workspace"));   // members lose theirs, freed ones get them
  renderWorkspaceVisibility();
  saveWorkspaceLayout();
  window.dispatchEvent(new Event("resize"));
  if (message) status(message);
}

function clearWorkspaceDropMarkers(root) {
  root.querySelectorAll(".workspace-drop-before, .workspace-drop-after, .workspace-drop-merge")
    .forEach((panel) => panel.classList.remove("workspace-drop-before", "workspace-drop-after", "workspace-drop-merge"));
  root.querySelectorAll(".workspace-drop-active")
    .forEach((column) => column.classList.remove("workspace-drop-active"));
}

function addWorkspaceResizeHandles(root) {
  for (const panel of root.querySelectorAll("[data-workspace-panel]")) {
    const isMember = panel.classList.contains("is-member");   // grouped: the host sizes
    const edges = panel.dataset.workspacePanel === "timeline"
      ? ["right", "top", "bottom"] : ["left", "right", "top", "bottom"];
    // Drop leftovers first: a handle belongs only as a direct child of a
    // standalone unit, one per edge. Older layouts (and a panel moved between
    // zones) can leave a second copy inside the body, which would sit on top
    // of the real grip and confuse the hit testing.
    for (const handle of [...panel.querySelectorAll(".workspace-resize-handle")]) {
      if (isMember || handle.parentElement !== panel || !edges.includes(handle.dataset.resizeEdge)) {
        handle.remove();
      }
    }
    if (isMember) continue;
    const seen = new Set();
    for (const handle of [...panel.children]) {
      if (!handle.classList || !handle.classList.contains("workspace-resize-handle")) continue;
      if (seen.has(handle.dataset.resizeEdge)) handle.remove();
      else seen.add(handle.dataset.resizeEdge);
    }
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
    refreshWorkspaceResizeHandleTitles(root);   // titles follow the new geometry
    saveWorkspaceLayout();
    window.dispatchEvent(new Event("resize"));
  };

  const move = (event) => {
    if (!active || event.pointerId !== active.pointerId) return;
    if (active.zoneResize) {
      // The edge facing the center drags the whole column width. Track the
      // pointer delta from where it was grabbed so the column does not jump
      // by the handle's own offset (the grip is a few pixels wide).
      const dx = event.clientX - active.zoneStartX;
      const px = active.zoneResize === "left"
        ? active.zoneStartPx + dx
        : active.zoneStartPx - dx;
      setZoneSize(active.zoneResize, px);
      window.dispatchEvent(new Event("resize"));
      return;
    }
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    const parentWidth = active.parent.clientWidth;
    const minWidth = Math.min(48, parentWidth);
    const minHeight = 48;
    const maxHeight = Infinity; // free: user decides, page scrolls
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

    // Touch only the axis being dragged. A top/bottom drag that also pinned
    // the width would freeze the panel at today's column width, and its
    // left/right edges would stop dragging the column dividers.
    const horizontal = active.edge === "left" || active.edge === "right";
    const isTimeline = active.panel.dataset.workspacePanel === "timeline";
    if (horizontal) {
      active.panel.style.width = `${width}px`;
      if (isTimeline) active.panel.style.alignSelf = "stretch";
      else {
        active.panel.style.marginLeft = `${marginLeft}px`;
        active.panel.style.alignSelf = "flex-start";
      }
    } else {
      active.panel.style.height = `${height}px`;
      active.panel.style.marginTop = `${marginTop}px`;
      if (!isTimeline) active.panel.style.alignSelf = "stretch";
    }
    active.panel.style.flex = "0 0 auto";
    active.panel.classList.add("workspace-panel-resized");
    window.dispatchEvent(new Event("resize"));
  };

  root.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest(".workspace-resize-handle");
    if (!handle) return;
    const panel = handle.closest("[data-workspace-panel]");
    if (!panel || !panel.parentElement) return;
    const edge = handle.dataset.resizeEdge;
    event.preventDefault();
    event.stopPropagation();
    const computed = getComputedStyle(panel);
    active = {
      handle, panel, parent: panel.parentElement, edge,
      pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      width: panel.getBoundingClientRect().width,
      height: panel.getBoundingClientRect().height,
      marginLeft: parseFloat(computed.marginLeft) || 0,
      marginTop: parseFloat(computed.marginTop) || 0,
      bodyCursor: document.body.style.cursor,
      bodyUserSelect: document.body.style.userSelect,
    };
    // Vertical edges on a column boundary drag that split free-form, exactly
    // like the divider handles on the side columns (this includes both edges
    // of the center column, which sit on the left and right dividers).
    const split = columnSplitEdge(panel, edge, panel.closest("[data-workspace-column]"));
    if (split) {
      const zel = zoneEl(split);
      if (zel) {
        active.zoneResize = split;
        active.zoneRect = zel.getBoundingClientRect();
        active.zoneStartPx = active.zoneRect.width;
        active.zoneStartX = event.clientX;
        // Drop any inline horizontal size left over from an older layout so
        // the panel keeps following the column it is being dragged against.
        panel.style.width = "";
        panel.style.marginLeft = "";
        panel.style.alignSelf = "";
        active.width = panel.getBoundingClientRect().width;
      }
    }
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
  bindMenuBar();
  bindUnitTabsAndHide();
  let draggedPanel = null;

  root.addEventListener("dragstart", (event) => {
    const dyn = event.target.closest("[data-dyn-tab]");
    const handle = event.target.closest(".workspace-drag-handle");
    const panel = dyn ? unitEl(dyn.dataset.wintab)
      : (handle && handle.closest("[data-workspace-panel]"));
    if (!panel || !event.dataTransfer) return;
    draggedPanel = panel;
    // Emptied zones reappear as slim targets so there is somewhere to drop a
    // panel that was pulled out of them.
    document.body.classList.add("workspace-drag-active");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", panel.dataset.workspacePanel);
    panel.classList.add("workspace-dragging");
  });

  // Group tabs: click activates; dragging one (above) moves its panel out.
  root.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-dyn-tab]");
    if (!tab) return;
    activateTab(tab.dataset.host, tab.dataset.wintab);
    window.dispatchEvent(new Event("resize"));
  });

  root.addEventListener("dragover", (event) => {
    if (!draggedPanel) return;
    const drop = workspaceDropTarget(event, draggedPanel);
    if (drop) {
      event.preventDefault();
      clearWorkspaceDropMarkers(root);
      if (drop.kind !== "none") {
        drop.top.classList.add(drop.kind === "merge" ? "workspace-drop-merge"
          : (drop.before ? "workspace-drop-before" : "workspace-drop-after"));
      }
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      return;
    }
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
    const dragged = draggedPanel;
    const name = dragged.dataset.workspacePanel;
    const drop = workspaceDropTarget(event, dragged);
    const column = drop ? null : event.target.closest("[data-workspace-column]");
    if (!drop && !column) return;
    event.preventDefault();
    clearWorkspaceDropMarkers(root);
    dragged.classList.remove("workspace-dragging");
    draggedPanel = null;
    document.body.classList.remove("workspace-drag-active");

    if (drop && drop.kind === "merge") {
      // Merging a host (Inspector, Timeline) hands its panels over to the
      // target instead of nesting one tab strip inside another, so groups
      // stay one level deep and the emptied shell simply disappears.
      const hosted = Object.keys(WS.host).filter((m) => WS.host[m] === name);
      if (hosted.length) {
        for (const m of hosted) WS.host[m] = drop.topName;
        commitWorkspaceGroups(
          `${hosted.map((m) => UNIT_TITLES[m] || m).join(", ")} grouped with ${UNIT_TITLES[drop.topName]}.`);
      } else {
        WS.host[name] = drop.topName;
        commitWorkspaceGroups(`${UNIT_TITLES[name] || name} grouped with ${UNIT_TITLES[drop.topName]}.`);
      }
      return;
    }

    // Moving between panels or zones. A grouped panel has to be flattened
    // back into a free-standing element *before* it is placed, otherwise the
    // next rebuild of the groups would pull it back into its old host.
    const wasMember = !!WS.host[name];
    if (wasMember) {
      delete WS.host[name];
      commitWorkspaceGroups(`${UNIT_TITLES[name] || name} moved out of its group.`);
    }
    const previousColumn = dragged.parentElement;
    if (drop && drop.kind === "edge") {
      drop.top.parentElement.insertBefore(dragged, drop.before ? drop.top : drop.top.nextSibling);
    } else if (column) {
      const target = event.target.closest("[data-workspace-panel]");
      if (target && target !== dragged && target.parentElement === column) {
        const rect = target.getBoundingClientRect();
        column.insertBefore(dragged,
          event.clientY >= rect.top + rect.height / 2 ? target.nextSibling : target);
      } else if (target !== dragged) {
        column.appendChild(dragged);
      }
    }
    if (previousColumn !== column && column) {
      dragged.style.width = "";
      dragged.style.marginLeft = "";
      dragged.style.alignSelf = "";
      dragged.style.flex = "";
      if (!dragged.style.height && !dragged.style.marginTop) {
        dragged.classList.remove("workspace-panel-resized");
      }
    }
    renderWorkspaceVisibility();
    saveWorkspaceLayout();
    window.dispatchEvent(new Event("resize"));
  });

  root.addEventListener("dragend", () => {
    if (draggedPanel) draggedPanel.classList.remove("workspace-dragging");
    draggedPanel = null;
    document.body.classList.remove("workspace-drag-active");
    clearWorkspaceDropMarkers(root);
  });

  const reset = $("workspaceReset");
  if (reset) reset.onclick = () => resetWorkspace();
}

/* ------------------------------------------------------------ menu bar */

function clickBtn(id) {
  const el = $(id);
  if (el && !el.disabled) el.click();
}

function ensureUnitVisible(unit) {
  const el = unitEl(unit);
  if (!el || !WS) return el;
  const tabs = UNIT_TABS[unit];
  if (!tabs) {
    if (!WS.win[unit]) toggleWin(unit);
  } else {
    const anyTab = tabs.some((t) => WS.win[t]);
    if (!WS.win[unit] || !anyTab) {
      WS.win[unit] = true;
      if (!anyTab) WS.win[WS.activeTab[unit] || tabs[0]] = true;
      afterWorkspaceVisibility();
    }
  }
  return el;
}

function flashEl(el) {
  if (!el) return;
  try { el.scrollIntoView({ block: "nearest" }); } catch (_) { /* older browsers */ }
  el.classList.add("panel-flash");
  setTimeout(() => el.classList.remove("panel-flash"), 1200);
}

function flashUnit(unit) {
  flashEl(ensureUnitVisible(unit));
}

function revealTab(tab) {
  const unit = TAB_UNIT[tab];
  if (!unit || !WS) return;
  WS.win[tab] = true;
  WS.win[unit] = true;
  WS.activeTab[unit] = tab;
  afterWorkspaceVisibility();
  flashUnit(unit);
}

function muteSelectedClips() {
  if (!S.project || !S.tl) return;
  const sel = new Set(selectedIds());
  const picked = S.tl.clips.filter((c) => sel.has(c.id));
  const clips = picked.filter((c) => !itemLocked(c));
  if (!clips.length) return status(picked.length ? "That lane is locked." : "Select a video clip first.");
  const to = !(clips[0].fx && clips[0].fx.mute);
  for (const c of clips) {
    if (!c.fx || typeof c.fx !== "object") c.fx = TLM.defaultFx();
    if (!Array.isArray(c.kf)) c.kf = [];
    c.fx.mute = to;
  }
  commitTL();
  refresh();
  status((to ? `Muted ${clips.length} clip(s).` : `Unmuted ${clips.length} clip(s).`) +
    (clips.length < picked.length ? " A locked lane was skipped." : ""));
}

const MENU_ACTS = {
  "file-open": () => { flashUnit("project"); const p = $("pathInput"); if (p) { p.focus(); p.select(); } },
  "file-browse": () => clickBtn("browseBtn"),
  "file-upload": () => { const u = $("uploadInput"); if (u) u.click(); },
  "file-demo": () => clickBtn("demoBtn"),
  "file-speech": () => clickBtn("speechDemoBtn"),
  "edit-undo": () => clickBtn("btnUndo"),
  "edit-redo": () => clickBtn("btnRedo"),
  "edit-copy": () => { if (typeof copySel === "function") copySel(); },
  "edit-cut": () => { if (typeof cutSel === "function") cutSel(); },
  "edit-paste": () => { if (typeof pasteSel === "function") pasteSel(false); },
  "edit-split": () => clickBtn("btnSplit"),
  "edit-delete": () => clickBtn("btnTrash"),
  "edit-ripple": () => { if (typeof deleteSel === "function") deleteSel(true); },
  "clip-up": () => clickBtn("txTrackUp"),
  "clip-down": () => clickBtn("txTrackDown"),
  "clip-mute": () => muteSelectedClips(),
  "tl-zoom-in": () => clickBtn("btnZin"),
  "tl-zoom-out": () => clickBtn("btnZout"),
  "tl-zoom-fit": () => clickBtn("btnFit"),
  "tl-snap": () => clickBtn("btnSnap"),
  "cap-add": () => clickBtn("btnAddCap"),
  "cap-auto": () => { ensureUnitVisible("project"); flashEl(document.querySelector('[data-project-card="caption"]')); const b = $("capBtn"); if (b) b.focus(); },
  "exp-go": () => {
    revealTab("export");
    if ($("exportBtn") && !$("exportBtn").disabled) clickBtn("exportBtn");
    else status("Open a video and build a timeline first.");
  },
  "help-keys": () => status("V/R/T/H/Z/M tools · Space play · ←/→ frame · Del delete · Ctrl+K split · Ctrl+Z/X/C/V undo/cut/copy/paste · Esc select"),
};

function buildWindowMenu() {
  const drop = $("windowDrop");
  if (!drop) return;
  drop.innerHTML = "";
  for (const entry of WINDOW_MENU) {
    if (entry === "sep") {
      drop.appendChild(document.createElement("hr"));
      continue;
    }
    const [id, label] = entry;
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.win = id;
    const tick = document.createElement("span");
    tick.className = "tick";
    tick.textContent = "\u2713";
    const name = document.createElement("span");
    name.textContent = label;
    b.appendChild(tick);
    b.appendChild(name);
    b.addEventListener("click", () => toggleWin(id));
    drop.appendChild(b);
  }
  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Reset workspace";
  reset.addEventListener("click", () => resetWorkspace());
  drop.appendChild(reset);
  refreshWindowMenu();
}

function winEffectiveVisible(kind) {
  if (!WS || !WS.win) return false;
  const unit = TAB_UNIT[kind];
  if (unit) return !!WS.win[kind] && !!WS.win[unit];
  return !!WS.win[kind];
}

function refreshWindowMenu() {
  document.querySelectorAll("#windowDrop [data-win]").forEach((b) => {
    const tick = b.querySelector(".tick");
    if (tick) tick.textContent = winEffectiveVisible(b.dataset.win) ? "\u2713" : "";
  });
}

function toggleWin(kind) {
  if (!WS || typeof WS.win[kind] !== "boolean") return;
  const unit = TAB_UNIT[kind];
  if (unit) {
    if (winEffectiveVisible(kind)) WS.win[kind] = false; // hide just this tab
    else {
      // Showing a tab shows its unit and activates the tab.
      WS.win[kind] = true;
      WS.win[unit] = true;
      WS.activeTab[unit] = kind;
    }
  } else {
    WS.win[kind] = !WS.win[kind];
  }
  afterWorkspaceVisibility();
  status(`${TAB_TITLES[kind] || UNIT_TITLES[kind] || kind} ${winEffectiveVisible(kind) ? "shown" : "hidden"}.`);
}

function hideUnit(unit) {
  if (!WS || typeof WS.win[unit] !== "boolean") return;
  WS.win[unit] = false;
  afterWorkspaceVisibility();
  status(`${UNIT_TITLES[unit] || unit} hidden.`);
}

function activateTab(unit, tab, save = true) {
  const tabs = UNIT_TABS[unit];
  if (!tabs || !tabs.includes(tab) || !WS) return;
  WS.activeTab[unit] = tab;
  for (const t of tabs) {
    const on = t === tab;
    const btn = tabBtn(unit, t);
    if (btn) {
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }
    const page = tabPage(unit, t);
    if (page) page.classList.toggle("active", on);
  }
  if (save) saveWorkspaceLayout();
}

function bindUnitTabsAndHide() {
  for (const unit of Object.keys(UNIT_TABS)) {
    for (const t of UNIT_TABS[unit]) {
      const btn = tabBtn(unit, t);
      if (btn && !btn.dataset.dynTab) btn.addEventListener("click", () => {
        activateTab(unit, t);
        window.dispatchEvent(new Event("resize"));
      });
    }
  }
  // The x on a unit header hides the whole unit; tabs toggle individually
  // from the Window menu, which also brings hidden units back.
  document.querySelectorAll("[data-hide-unit]").forEach((btn) => {
    btn.addEventListener("click", () => hideUnit(btn.dataset.hideUnit));
  });
}

function bindMenuBar() {
  buildWindowMenu();
  document.querySelectorAll("#menubar .menu > button").forEach((b) => {
    b.addEventListener("click", (ev) => {
      const menu = b.parentElement;
      const was = menu.classList.contains("open");
      document.querySelectorAll("#menubar .menu").forEach((m) => m.classList.remove("open"));
      if (!was) menu.classList.add("open");
      ev.stopPropagation();
    });
  });
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest("#menubar .menu")) {
      document.querySelectorAll("#menubar .menu").forEach((m) => m.classList.remove("open"));
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") document.querySelectorAll("#menubar .menu").forEach((m) => m.classList.remove("open"));
  });
  document.querySelectorAll("#menubar [data-act]").forEach((el) => {
    el.addEventListener("click", () => {
      document.querySelectorAll("#menubar .menu").forEach((m) => m.classList.remove("open"));
      const fn = MENU_ACTS[el.dataset.act];
      if (fn) fn();
    });
  });
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

// "open" picks the project's main video, "import" adds files to the media bin.
let BROWSE_MODE = "open";
const MEDIA_IMPORT_RE = /\.(mp4|mov|m4v|mkv|webm|avi|ts|mts|m2ts|mpg|mpeg|flv|wmv|3gp|vob|mp3|wav|flac|aac|m4a|ogg|oga|opus|aiff|aif|wma|mka|ac3|dts|caf|amr|png|jpe?g|bmp|gif|webp|avif|tiff?|ppm|pgm|pnm|tga|jp2)$/i;

function openBrowserFor(mode) {
  BROWSE_MODE = mode === "import" ? "import" : "open";
  const modal = $("browserModal");
  if (!modal) return;
  modal.hidden = false;
  const title = modal.querySelector("strong");
  if (title) title.textContent = BROWSE_MODE === "import" ? "Add media to the bin" : "Choose a file";
  browseTo("").catch((e) => alert(e.message));
}

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
    const isImage = /\.(png|jpe?g|bmp|gif|webp|avif|tiff?|ppm|pgm|pnm|tga|jp2)$/i.test(f.name);
    const isMedia = MEDIA_IMPORT_RE.test(f.name);
    const icon = isVideo ? "🎬" : isImage ? "🖼" : isMedia ? "🎵" : "📄";
    add(`${icon} ${f.name}`, () => {
      if (BROWSE_MODE === "import" && isMedia) {
        $("browserModal").hidden = true;
        if (typeof mediaImportPaths === "function") mediaImportPaths([f.path]);
        return;
      }
      if (isVideo) { $("pathInput").value = f.path; $("browserModal").hidden = true; openPath(f.path); }
      else if (isImage) {
        // A still is bin material, not a project source. Say so instead of
        // putting a path in the box that the server will only reject.
        $("browserModal").hidden = true;
        if (S.project) {
          if (typeof mediaImportPaths === "function") mediaImportPaths([f.path]);
        } else {
          status(`${f.name} is a still image — open a video first, then add it from the Media bin.`);
        }
      }
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
  // Fullscreen is a real monitor: let the frame use the whole screen.
  const maxH = document.fullscreenElement
    ? Math.max(120, window.innerHeight)
    : Math.max(120, window.innerHeight * 0.46);
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
    const minHeight = 48;
    const maxHeight = Infinity; // free
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
  // Stored cues may contain only a partial style (older projects/imports).
  cue.style = { ...CAPPOS, ...cue.style };
  return cue.style;
}

const CAP_APPLY_STORE = "vts.captionApplyAll";

function capApplyToAll() {
  return !!$("capApplyAll")?.checked;
}

// The switch lives twice - at the top of the Text pane and in the Timeline
// toolbar beside + caption - and both places mirror the one checkbox.
function syncCapApplyUI() {
  const on = capApplyToAll();
  const btn = $("btnApplyAll");
  if (btn) {
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on
      ? "Every style edit lands on every caption, on every lane - click to edit only the caption at the playhead"
      : "Style edits change only the caption at the playhead - click to apply them to every caption, on every lane";
  }
  const badge = $("capApplyScope");
  if (badge) {
    const caps = S.capCues || [];
    const lanes = caps.length ? new Set(caps.map((c) => TLM.capTrackOf(c))).size : 0;
    badge.textContent = !caps.length ? "no captions yet"
      : on ? `all ${caps.length} caption${caps.length === 1 ? "" : "s"} · ${lanes} lane${lanes === 1 ? "" : "s"}`
        : "this caption only";
  }
}

function setCapApplyAll(on, announce = false) {
  const box = $("capApplyAll");
  if (!box) return;
  box.checked = !!on;
  try { localStorage.setItem(CAP_APPLY_STORE, on ? "1" : "0"); } catch (_) { /* private mode */ }
  syncCapApplyUI();
  if (announce) {
    status(on
      ? "Style edits now apply to every caption, on every lane."
      : "Style edits now change only the caption at the playhead.");
  }
}

function bindCapApplyAll() {
  const box = $("capApplyAll");
  try {
    const stored = localStorage.getItem(CAP_APPLY_STORE);
    if (stored !== null && box) box.checked = stored === "1";
  } catch (_) { /* private mode: keep the markup default (on) */ }
  box?.addEventListener("change", () => setCapApplyAll(capApplyToAll(), true));
  $("btnApplyAll")?.addEventListener("click", () => setCapApplyAll(!capApplyToAll(), true));
  syncCapApplyUI();
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
  el.style.textDecoration = "none";  // each text layer owns its decorations
  el.style.letterSpacing = `${Number(st.tracking) || 0}em`;
  if (Number(st.box_h) > 0) {
    el.style.height = `${Number(st.box_h) * r.h}px`; el.style.display = "flex"; el.style.alignItems = "center";
  } else { el.style.height = "auto"; el.style.display = "block"; }
  el.style.lineHeight = String(Math.min(3, Math.max(0.7, Number(st.leading) || 1.25)));
  const rgba = (hex, opacity) => {
    const h = /^#[0-9a-f]{6}$/i.test(hex || "") ? hex : "#000000";
    return `rgba(${parseInt(h.slice(1,3),16)},${parseInt(h.slice(3,5),16)},${parseInt(h.slice(5,7),16)},${Math.min(100,Math.max(0,Number(opacity)||0))/100})`;
  };
  // Appearance distances are design pixels at 1080p, like ASS export.
  const scale = r.h / 1080;
  el.style.color = rgba(st.fill || "#ffffff", st.fill_opacity ?? 100);
  el.style.webkitTextStroke = `${Math.max(0, Number(st.stroke_width) || 0) * scale}px ${rgba(st.stroke || "#000000", st.stroke_opacity ?? 100)}`;
  el.style.setProperty("--cap-bg", rgba(st.background || "#000000", st.background_opacity ?? 0));
  // Shadow is a separate, single filled glyph silhouette (not offset copies).
  el.style.textShadow = "none";
}

function syncCaptionShadow(box, text, st, frame) {
  box.querySelector(":scope > .cap-shadow")?.remove();
  text.style.textDecoration = `${st.underline ? "underline " : ""}${st.strike ? "line-through" : ""}`.trim() || "none";
  const opacity = st.shadow_enabled === false ? 0 : Math.min(100, Math.max(0, Number(st.shadow_opacity ?? 100)));
  if (!opacity || (box.id === "capBox" && CAP_EDITING)) return;
  const scale = frame.h / 1080;
  const spread = Math.max(0, Number(st.shadow_size) || 0) * scale;
  const blur = Math.max(0, Number(st.shadow_blur) || 0) * scale;
  const distance = Math.max(0, Number(st.shadow_distance) || 0) * scale;
  const angle = (Number(st.shadow_angle) || 0) * Math.PI / 180;
  const colour = /^#[0-9a-f]{6}$/i.test(st.shadow || "") ? st.shadow : "#000000";
  const shadow = text.cloneNode(true);
  shadow.removeAttribute("id");
  shadow.removeAttribute("data-raw");
  shadow.className = "cap-shadow";
  shadow.setAttribute("aria-hidden", "true");
  // Word animation colours the spans; the silhouette must stay one colour.
  shadow.querySelectorAll(".cap-word").forEach((w) => { w.style.color = "inherit"; });
  // Stroke is centred on the glyph edge: 2 * spread grows the silhouette by
  // exactly spread pixels. Identical opaque fill/stroke make ONE solid mask.
  // Blur the merged mask, then apply opacity once to the entire layer.
  Object.assign(shadow.style, {
    position: "absolute", left: `${text.offsetLeft}px`, top: `${text.offsetTop}px`,
    width: `${text.offsetWidth}px`, color: colour,
    webkitTextStroke: `${2 * spread}px ${colour}`, paintOrder: "stroke fill",
    textShadow: "none", filter: blur > 0 ? `blur(${blur}px)` : "none",
    opacity: String(opacity / 100),
    transform: `translate(${Math.cos(angle) * distance}px, ${Math.sin(angle) * distance}px)`,
  });
  shadow.style.setProperty("--cap-bg", "transparent");
  box.prepend(shadow);
}

function layoutCapOverlay() {
  const overlay = $("capOverlay");
  if (!overlay) return;
  const armed = (["burn", "both"].includes($("xCaptions").value) || $("cBurn")?.checked) && !!S.project;
  overlay.hidden = !armed;
  // Keep the Text panel controls synchronized even when burn preview is disabled.
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
      const text = document.createElement("div"); text.className = "cap-text";
      d.appendChild(text);
      for (const lineText of wrapText(c.text || "", cueMaxChars)) {
        const row = document.createElement("div"); row.className = "cap-line";
        row.style.textAlign = cueStyle.align === "justify" ? "left" : cueStyle.align;
        const label = document.createElement("span"); label.className = "cap-line-label";
        label.textContent = lineText; row.appendChild(label); text.appendChild(row);
      }
      overlay.appendChild(d);
      syncCaptionShadow(d, text, cueStyle, r);
    }
  }

  syncCapApplyUI();

  const box = $("capBox");
  box.hidden = !!S.capCues.length && !active;
  styleCapBoxEl(box, st, r);
  if (active) $("capBoxText").dataset.raw = active.text || "";
  const fontPx = Math.max(10, r.h * st.size_pct / 100);
  const maxChars = Math.floor((st.box_w * r.w) / Math.max(1, fontPx * (CHAR_FACTOR + (Number(st.tracking) || 0))));
  const rich = active ? capRenderAnimated(active, st, t, maxChars) : false;
  if (!rich) {
    renderCaptionLines(
      wrapText($("capBoxText").dataset.raw || "Caption preview", maxChars),
      st.align);
  }
  syncCaptionShadow(box, $("capBoxText"), st, r);
  capApplyEntryAnim(box, active, st, t, r);
  $("capPosInfo").textContent =
    `x ${Math.round(st.x * 100)}% \u00b7 y ${Math.round(st.y * 100)}%` +
    ` \u00b7 w ${Math.round(st.box_w * 100)}% \u00b7 ${st.align}` +
    (active ? ` \u00b7 "${(active.text || "").slice(0, 16)}"`
            : (S.capCues.length ? " \u00b7 default (no caption on screen)" : ""));
  if (document.activeElement !== $("capFontSize"))
    $("capFontSize").value = String(st.size_pct);
  if (![...$("capFontFamily").options].some(o => o.value === st.font)) {
    $("capFontFamily").add(new Option(st.font || "Arial", st.font || "Arial"));
  }
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
    capShadowEnabled: st.shadow_enabled ?? (Number(st.shadow_opacity ?? 100) > 0), capShadowOpacity: st.shadow_opacity ?? 75,
    capShadowAngle: st.shadow_angle ?? 135, capShadowDistance: st.shadow_distance ?? 3,
    capShadowSize: st.shadow_size ?? 6, capShadowBlur: st.shadow_blur ?? 12,
    capX: Math.round((st.x ?? .5) * 100), capY: Math.round((st.y ?? .92) * 100),
    capWidth: Math.round((st.box_w ?? .88) * 100), capHeight: Math.round((st.box_h ?? 0) * 100),
    insAnimIn: st.anim_in || "none", insAnimMs: st.anim_ms ?? 400,
    insAnimWords: st.anim_words || "none", insAnimStagger: st.anim_stagger ?? 120,
    insAnimPop: st.anim_pop ?? 130, insHighlight: st.highlight || "#ffd400",
    insHlMark: st.hl_mark || "color", insHlSpan: st.hl_span || "word",
    insHlBg: st.hl_bg || "#101418", insHlBgOpacity: st.hl_bg_opacity ?? 85,
    insHlPad: st.hl_pad ?? 12, insHlRadius: st.hl_radius ?? 22,
  };
  for (const [id, value] of Object.entries(styleControlValues)) {
    const input = $(id);
    if (input && document.activeElement !== input) {
      if (input.type === "checkbox") input.checked = !!value;
      else input.value = String(value);
    }
  }
  window.capFontPicker?.sync();
  if ($("capFontSizeValue")) $("capFontSizeValue").textContent = String(Math.round(1080 * (st.size_pct || 4.5) / 100));
  if ($("capFillOpacityValue")) $("capFillOpacityValue").textContent = String(st.fill_opacity ?? 100);
  if ($("capBackgroundOpacityValue")) $("capBackgroundOpacityValue").textContent = String(st.background_opacity ?? 72);
  if ($("capShadowOpacityValue")) $("capShadowOpacityValue").textContent = String(st.shadow_opacity ?? 75);
  if ($("capShadowAngleValue")) $("capShadowAngleValue").textContent = `${st.shadow_angle ?? 135}°`;
  if ($("capShadowDistanceValue")) $("capShadowDistanceValue").textContent = String(st.shadow_distance ?? 3);
  if ($("capShadowSizeValue")) $("capShadowSizeValue").textContent = String(st.shadow_size ?? 6);
  if ($("capShadowBlurValue")) $("capShadowBlurValue").textContent = String(st.shadow_blur ?? 12);
  if ($("insHlBgOpacityValue")) $("insHlBgOpacityValue").textContent = String(Math.round(st.hl_bg_opacity ?? 85));
  if ($("insHlPadValue")) $("insHlPadValue").textContent = String(Math.round(st.hl_pad ?? 12));
  if ($("insHlRadiusValue")) $("insHlRadiusValue").textContent = String(Math.round(st.hl_radius ?? 22));
  document.querySelectorAll(".capZone").forEach((b) => b.classList.toggle("on",
    Math.abs(Number(b.dataset.x) - (st.x ?? .5)) < .06 && Math.abs(Number(b.dataset.y) - (st.y ?? .92)) < .06));
  const fs = st.bold !== false && st.italic ? "bold-italic" : st.bold !== false ? "bold" : st.italic ? "italic" : "regular";
  if ($("capFontStyle") && document.activeElement !== $("capFontStyle")) $("capFontStyle").value = fs;
  syncAlignButtons();
  if (typeof InspectorRefreshText === "function") InspectorRefreshText();
}

/* ------------------------------------------------- caption animation (preview)
 *
 * The same four entrance animations and two word effects the ASS burn writes.
 * Everything is computed from the playhead, so scrubbing shows the exact frame
 * playback does and nothing has to be timed by hand.
 */

function capAnimProgress(cue, st, t) {
  const ms = Math.max(0, Number(st.anim_ms) || 0);
  if (!cue) return 1;
  if (!ms) return 1;
  return Math.min(1, Math.max(0, ((t - cue.start) * 1000) / ms));
}

function capEaseOut(p) { return 1 - Math.pow(1 - p, 3); }
function capEaseOutBack(p) {
  const c1 = 1.70158, c3 = c1 + 1, q = p - 1;
  return 1 + c3 * q * q * q + c1 * q * q;
}

// Word timings for the preview. Captions without words fall back to an even
// spread across the cue, matching what the burn does.
function capPreviewWords(cue) {
  const raw = Array.isArray(cue.words) ? cue.words : [];
  if (raw.length) {
    return raw.map((w) => ({ w: String(w.w ?? ""), s: Number(w.s) || cue.start,
      e: Number(w.e) || cue.end }));
  }
  const toks = String(cue.text || "").split(/\s+/).filter(Boolean);
  const slot = Math.max(0.001, (cue.end - cue.start) / Math.max(1, toks.length));
  return toks.map((w, i) => ({ w, s: cue.start + i * slot, e: cue.start + (i + 1) * slot }));
}

function wrapTokenLines(tokens, maxChars) {
  const lines = [];
  let cur = [];
  let len = 0;
  for (const tok of tokens) {
    const add = (len ? 1 : 0) + tok.w.length;
    if (cur.length && len + add > maxChars) { lines.push(cur); cur = []; len = 0; }
    cur.push(tok);
    len += (len ? 1 : 0) + tok.w.length;
  }
  if (cur.length) lines.push(cur);
  return lines;
}

// Returns true when it drew an animated caption; false lets the caller fall
// back to the plain line renderer.
function capRenderAnimated(cue, st, t, maxChars) {
  const animWords = st.anim_words || "none";
  const animIn = st.anim_in || "none";
  const container = $("capBoxText");
  if (!container) return false;
  if (!cue) return false;
  if (animWords === "none" && animIn !== "typewriter") return false;
  const words = capPreviewWords(cue);
  container.replaceChildren();
  container.style.setProperty("--cap-hl", st.highlight || "#ffd400");
  // The marker is sized in em, like the burn's percentages of the font size.
  const hlPad = Math.min(40, Math.max(0, Number(st.hl_pad ?? 12))) / 100;
  const hlRadius = Math.min(50, Math.max(0, Number(st.hl_radius ?? 22))) / 100;
  const hlBg = /^#[0-9a-f]{6}$/i.test(st.hl_bg || "") ? st.hl_bg : "#101418";
  const hlBgA = Math.min(100, Math.max(0, Number(st.hl_bg_opacity ?? 85))) / 100;
  const hlRgb = [1, 3, 5].map((i) => parseInt(hlBg.slice(i, i + 2), 16));
  container.style.setProperty("--cap-hl-pad", `${hlPad}em`);
  container.style.setProperty("--cap-hl-radius", `${hlRadius}em`);
  container.style.setProperty("--cap-hl-bg",
    `rgba(${hlRgb[0]},${hlRgb[1]},${hlRgb[2]},${hlBgA})`);
  const hlMark = ["color", "bg", "both"].includes(st.hl_mark) ? st.hl_mark : "color";
  const hlSpan = st.hl_span === "spoken" ? "spoken" : "word";
  const lineFor = (text) => {
    const row = document.createElement("div");
    row.className = "cap-line";
    row.style.textAlign = st.align === "justify" ? "left" : st.align;
    return row;
  };
  if (animIn === "typewriter" && animWords === "none") {
    const full = words.map((w) => w.w).join(" ") || String(cue.text || "");
    const p = capAnimProgress(cue, st, t);
    const shown = full.slice(0, Math.ceil(full.length * p));
    for (const line of wrapText(shown, maxChars)) {
      const row = lineFor(line);
      const label = document.createElement("span");
      label.className = "cap-line-label";
      label.textContent = line;
      row.appendChild(label);
      container.appendChild(row);
    }
    return true;
  }
  const stagger = Math.max(0, Number(st.anim_stagger) || 0) / 1000;
  const visible = animWords === "reveal"
    ? words.filter((w, i) => t >= (w.s ?? (cue.start + i * stagger)) - 1e-6)
    : words;
  if (animWords === "reveal" && !visible.length) return true;   // nothing yet
  // Which words the highlight is on: the one being spoken, or every word
  // heard so far. `spoken` is the persistent "already read" look.
  // One word is "current" at a time: the last one whose start has passed.
  // The burn holds each word from its own start until the next word starts
  // (the last one until the cue ends), so the preview must do the same or a
  // boundary frame would light two words.
  let cur = -1;
  words.forEach((w, i) => { if (t >= (w.s ?? 0) - 1e-6) cur = i; });
  for (const line of wrapTokenLines(visible, Math.max(4, maxChars))) {
    const row = lineFor("");
    for (const w of line) {
      const span = document.createElement("span");
      span.className = "cap-word";
      if (animWords === "word" || animWords === "karaoke") {
        const idx = words.indexOf(w);
        const on = hlSpan === "spoken" ? idx <= cur && cur >= 0 : idx === cur;
        if (on && hlMark !== "bg") span.classList.add("hl");      // accent ink
        if (idx === cur) span.classList.add("now");
        // The marker box is its own layer, so it never shifts the glyphs:
        // the word keeps its own advance and the box hangs off it.
        if (on && hlMark !== "color") {
          const bg = document.createElement("span");
          bg.className = "cap-word-bg";
          span.appendChild(bg);
        }
      }
      const glyph = document.createElement("span");
      glyph.className = "cap-word-tx";
      glyph.textContent = w.w;
      span.appendChild(glyph);
      row.appendChild(span);
      row.appendChild(document.createTextNode(" "));
    }
    container.appendChild(row);
  }
  return true;
}

function capApplyEntryAnim(box, cue, st, t, frame) {
  if (!box) return;
  const animIn = cue ? (st.anim_in || "none") : "none";
  let opacity = 1, scale = 1, dy = 0;
  const p = capAnimProgress(cue, st, t);
  const pop = Math.max(1, (Number(st.anim_pop) || 130) / 100);
  if (animIn === "fade") opacity = p;
  else if (animIn === "pop") scale = 1 + (pop - 1) * (1 - capEaseOut(p));
  else if (animIn === "bounce") scale = 1 + (pop - 1) * (1 - capEaseOutBack(p));
  else if (animIn === "slide") {
    dy = (1 - capEaseOut(p)) * frame.h * 0.06;
    opacity = Math.min(1, p * 1.35);
  }
  box.style.opacity = opacity >= 0.999 ? "" : opacity.toFixed(3);
  box.style.transform = (Math.abs(scale - 1) > 0.002 || dy > 0.05)
    ? `translateY(${dy.toFixed(1)}px) scale(${scale.toFixed(3)})`
    : "";
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
  bindCapApplyAll();
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
    applyCaptionStylePatch({ ...CAPPOS_DEFAULT, shadow_enabled: true }, targetCue);
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
    insAnimIn: ["anim_in", "text"], insAnimMs: ["anim_ms", "number"],
    insAnimWords: ["anim_words", "text"], insAnimStagger: ["anim_stagger", "number"],
    insAnimPop: ["anim_pop", "number"], insHighlight: ["highlight", "text"],
    insHlMark: ["hl_mark", "text"], insHlSpan: ["hl_span", "text"],
    insHlBg: ["hl_bg", "text"], insHlBgOpacity: ["hl_bg_opacity", "number"],
    insHlPad: ["hl_pad", "number"], insHlRadius: ["hl_radius", "number"],
  };
  for (const [id, [key, type]] of Object.entries(styleInputs)) {
    const input = $(id); if (!input) continue;
    const update = () => {
      const cue = capActiveCue();
      if (type !== "text" && (input.value === "" || !Number.isFinite(Number(input.value)))) return;
      let numeric = Number(input.value);
      if (type !== "text") {
        if (input.min !== "") numeric = Math.max(Number(input.min), numeric);
        if (input.max !== "") numeric = Math.min(Number(input.max), numeric);
      }
      const value = type === "number" ? numeric : type === "percent" ? numeric / 100 : input.value;
      applyCaptionStylePatch({ [key]: value }, cue);
      layoutCapOverlay();
    };
    input.addEventListener("input", update);
    input.addEventListener("change", () => { update(); if (captionStyleEditTouchesTimeline()) commitCaptions(); });
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
  $("capShadowEnabled")?.addEventListener("change", () => {
    const cue = capActiveCue();
    applyCaptionStylePatch({ shadow_enabled: $("capShadowEnabled").checked }, cue);
    layoutCapOverlay();
    if (captionStyleEditTouchesTimeline(cue)) commitCaptions();
  });
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
              fwStatus: null, wcpp: null, segmentation: null, segPreset: null };
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
  shadow_distance: 3, shadow_size: 6, shadow_blur: 12, box_h: 0,
  // Text animation (Inspector > Text animation). "none" everywhere keeps the
  // burn byte-identical for projects that never touch these controls.
  anim_in: "none", anim_ms: 400, anim_words: "none",
  anim_stagger: 120, anim_pop: 130, highlight: "#ffd400",
  // Word highlight (Inspector > Typography > Word highlight): what marks the
  // spoken word - its colour, a marker box behind it, or both - and how.
  // Mirrors DEFAULT_STYLE in vts/captionmap.py, which burns it.
  hl_mark: "color", hl_span: "word", hl_bg: "#101418", hl_bg_opacity: 85,
  hl_pad: 12, hl_radius: 22 };
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
  fillSegmentation(caption.segmentation);
  updateEngineUI();
}

/* ------------------------------------------------- caption layout (words) */

// How words are grouped into captions. The presets come from the server
// (vts/segmenter.py, via /api/env), so they never drift out of sync. The
// choice applies to the next transcription and to "Re-split".
// A freshly transcribed set keeps the recogniser's own segments; picking a
// layout (Burst, One word, ...) is what re-splits, by Transcribe or by
// Re-split. This must match vts/segmenter.py DEFAULT_PRESET.
const SEG_DEFAULT = "engine";

function fillSegmentation(cat) {
  CAP.segmentation = cat || null;
  const sel = $("cSeg");
  if (!sel || !cat) return;
  sel.textContent = "";
  // "Custom" needs the numeric limit fields, which this one-row control has
  // no space for: keep it to the four named layouts here, custom limits stay
  // available over the API / auto_caption.py --layout custom.
  (cat.presets || []).filter((p) => p.id !== "custom").forEach((p) => {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.label;
    o.title = p.hint || "";
    sel.appendChild(o);
  });
  CAP.segPreset = CAP.segPreset || cat.default || SEG_DEFAULT;
  if ([...sel.options].some((o) => o.value === CAP.segPreset)) sel.value = CAP.segPreset;
  sel.onchange = () => { CAP.segPreset = sel.value; };
  const btn = $("capResplit");
  if (btn) btn.onclick = resplitCaptions;
}

// Re-cut the captions that are in the editor right now - transcribed or
// imported - from the words they already carry. No new pass over the audio.
async function resplitCaptions() {
  if (!CAP.job) return;
  const btn = $("capResplit");
  const preset = ($("cSeg") && $("cSeg").value) || CAP.segPreset || SEG_DEFAULT;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Re-splitting…";
  try {
    const job = await api(`/api/caption/${CAP.job.id}/resegment`, {
      method: "POST", body: JSON.stringify({ preset }),
    });
    CAP.editorSig = null;                  // force the table to be rebuilt
    renderCaptionJob(job);
    $("capNote").textContent = "";
    $("capSaved").textContent = job.note || `${job.cues.length} caption(s)`;
  } catch (e) {
    alert("Could not re-split the captions: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
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
    segment_preset: ($("cSeg") && $("cSeg").value) || CAP.segPreset || SEG_DEFAULT,
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
  // Don't let a user-open race with automatic restore and reset their edits.
  const openControls = ["openBtn", "demoBtn", "speechDemoBtn", "uploadInput", "browseBtn", "pathInput"].map($);
  openControls.forEach(el => { el.disabled = true; });
  try {
    bindWorkspaceDocking();
    bindVideoZoom();
    bindUI();
    syncQualityRows();
    await loadEnv();
    let activeProject;
    try { activeProject = await api("/api/project"); }
    catch (_) { /* No active server project after a restart. */ }
    if (activeProject) await onProjectOpen(activeProject);
    else await restoreLastProject();
    draw();
  } finally {
    openControls.forEach(el => { el.disabled = false; });
  }
})();
