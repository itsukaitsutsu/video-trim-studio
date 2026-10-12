"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "..");
const appSource = fs.readFileSync(path.join(root, "static", "app.js"), "utf8");
const cssSource = fs.readFileSync(path.join(root, "static", "style.css"), "utf8");
const panStart = appSource.indexOf("function clampPreviewPan(");
const panEnd = appSource.indexOf("\nfunction paintPreviewZoom", panStart);
const zoomStart = appSource.indexOf("function setPreviewZoom(");
const zoomEnd = appSource.indexOf("\nfunction resetPreviewZoom", zoomStart);
assert(panStart >= 0 && panEnd > panStart, "preview pan helper is present");
assert(zoomStart >= 0 && zoomEnd > zoomStart, "preview zoom helper is present");

function createZoomContext() {
  const context = {
    PREVIEW_VIEW: {
      zoom: 1, panX: 0, panY: 0,
      baseW: 1200, baseH: 900, viewW: 800, viewH: 600,
    },
    $: () => ({}),
    clampWorkspaceSize: (value, min, max) => Math.max(min, Math.min(max, value)),
    paintPreviewZoom: () => {},
  };
  vm.createContext(context);
  vm.runInContext(
    `${appSource.slice(panStart, panEnd)}\n${appSource.slice(zoomStart, zoomEnd)}`,
    context,
  );
  return context;
}

test("preview zoom keeps the point under the pointer fixed", () => {
  const context = createZoomContext();
  const point = { x: 300, y: 220 };
  const before = {
    x: (point.x - context.PREVIEW_VIEW.panX) / context.PREVIEW_VIEW.zoom,
    y: (point.y - context.PREVIEW_VIEW.panY) / context.PREVIEW_VIEW.zoom,
  };

  context.setPreviewZoom(1.5, point.x, point.y);

  const after = {
    x: (point.x - context.PREVIEW_VIEW.panX) / context.PREVIEW_VIEW.zoom,
    y: (point.y - context.PREVIEW_VIEW.panY) / context.PREVIEW_VIEW.zoom,
  };
  assert.ok(Math.abs(after.x - before.x) < 1e-9);
  assert.ok(Math.abs(after.y - before.y) < 1e-9);
});

test("preview keeps the hand cursor for pan and wires Ctrl+wheel to its pointer", () => {
  assert.match(appSource, /event\.clientX\s*-\s*bounds\.left/);
  assert.match(appSource, /event\.clientY\s*-\s*bounds\.top/);
  assert.match(cssSource, /\.preview-viewport\.pan-available\s*\{\s*cursor:\s*grab;/);
  assert.match(cssSource, /\.preview-viewport\.panning\s*\{\s*cursor:\s*grabbing;/);
});
