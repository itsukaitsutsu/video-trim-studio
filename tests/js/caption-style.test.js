"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appPath = path.join(__dirname, "..", "..", "static", "app.js");
const appSource = fs.readFileSync(appPath, "utf8");
const helpersStart = appSource.indexOf("function ensureCueCaptionStyle");
const helpersEnd = appSource.indexOf("function styleCapBoxEl", helpersStart);
assert(helpersStart >= 0 && helpersEnd > helpersStart, "caption style helpers are present");
const helpersSource = appSource.slice(helpersStart, helpersEnd);

const defaults = { x: 0.5, y: 0.88, size_pct: 5.5, box_w: 0.7, align: "center" };
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadHelpers(cues, { applyAll, activeCue, defaultStyle = defaults }) {
  const context = {
    S: { capCues: cues },
    CAPPOS: { ...defaultStyle },
    $: (id) => id === "capApplyAll" ? { checked: applyAll } : null,
    capActiveCue: () => activeCue,
  };
  vm.createContext(context);
  vm.runInContext(helpersSource, context);
  return context;
}

test("Apply to all copies the active caption's full layout to every cue and new-cue default", () => {
  const cues = [
    { id: "t1", style: { x: 0.1, y: 0.2, size_pct: 4, box_w: 0.4, align: "left" } },
    { id: "t2", style: { x: 0.8, y: 0.9, size_pct: 9, box_w: 0.9, align: "right" } },
    { id: "t3", style: null },
  ];
  const ctx = loadHelpers(cues, { applyAll: true, activeCue: cues[1] });

  ctx.applyCaptionStylePatch({ x: 0.33 }, cues[1]);

  const expected = { x: 0.33, y: 0.9, size_pct: 9, box_w: 0.9, align: "right" };
  for (const cue of cues) assert.deepEqual(plain(cue.style), expected);
  assert.deepEqual(plain(ctx.CAPPOS), expected);
  assert.equal(ctx.captionStyleEditTouchesTimeline(null), true);
});

test("with Apply to all off, layout changes stay on the active caption", () => {
  const cues = [
    { id: "t1", style: { x: 0.1, y: 0.2, size_pct: 4, box_w: 0.4, align: "left" } },
    { id: "t2", style: { x: 0.8, y: 0.9, size_pct: 9, box_w: 0.9, align: "right" } },
  ];
  const beforeDefault = { ...defaults };
  const ctx = loadHelpers(cues, { applyAll: false, activeCue: cues[0] });

  ctx.applyCaptionStylePatch({ x: 0.33 }, cues[0]);

  assert.equal(cues[0].style.x, 0.33);
  assert.equal(cues[0].style.align, "left");
  assert.equal(cues[1].style.x, 0.8);
  assert.deepEqual(plain(ctx.CAPPOS), beforeDefault);
  assert.equal(ctx.captionStyleEditTouchesTimeline(cues[0]), true);
});

test("Apply to all with no cue at the playhead uses the default layout for every cue", () => {
  const cues = [
    { id: "t1", style: { x: 0.1, y: 0.2, size_pct: 4, box_w: 0.4, align: "left" } },
    { id: "t2", style: { x: 0.8, y: 0.9, size_pct: 9, box_w: 0.9, align: "right" } },
  ];
  const ctx = loadHelpers(cues, { applyAll: true, activeCue: null });

  ctx.applyCaptionStylePatch({ x: 0.33 }, null);

  const expected = { ...defaults, x: 0.33 };
  for (const cue of cues) assert.deepEqual(plain(cue.style), expected);
  assert.deepEqual(plain(ctx.CAPPOS), expected);
});
