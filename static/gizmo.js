/* Direct manipulation on the Program Monitor.
 *
 * Premiere lets you grab the picture in the Program panel and move, scale,
 * rotate, crop and mask it without leaving the monitor. This module adds that:
 * click the picture to select, double-click it (or press V/C/P) to put handles
 * on it, then drag.
 *
 * Everything it writes goes into the same `clip.fx` fields the Inspector and
 * the exporter use - x/y (%), scale (%), rot (deg), crop_l/t/r/b (%) and
 * fx.mask - and always through TLM.cleanFx(), so what you see is what
 * vts/edl.py renders.
 *
 * Geometry note: stage.js draws a clip as
 *     .fx-layer { transform: translate(x%, y%) }        the frame-sized layer
 *       .fx-box { width: scale%, height: scale%, centred }  the crop window
 *         .fx-media { enlarged by the crop, offset by it }
 * so `fx.x/y` move the *box*, and the box is the picture the viewer sees.
 * The mask is a percentage of that box.
 */
"use strict";

const GIZ = {
  id: null,               // clip being edited
  editing: false,         // handles + HUD shown (double-click / V C P)
  mode: "transform",      // transform | crop | mask
  drag: null,             // live drag state
  hover: null,            // handle id under the pointer
  svg: null,              // the <svg> overlay
  hud: null,              // the floating mode strip
  sig: "",                // geometry signature, to skip identical repaints
  bound: false,
};

const GIZ_HANDLE = 9;     // handle size in screen px
const GIZ_EDGE = 6;       // hit padding around edge handles

/* ------------------------------------------------------------------ utils */

const gizClamp = (v, lo, hi) => (v > hi ? hi : v < lo ? lo : v);
const gizR1 = (v) => Math.round(v * 10) / 10;

function gizStage() { return document.getElementById("previewStage"); }

/** Stage-local pixel point for a pointer event (undoes viewport zoom/pan). */
function gizPoint(ev) {
  const stage = gizStage();
  if (!stage) return { x: 0, y: 0 };
  const r = stage.getBoundingClientRect();
  const w = stage.clientWidth || r.width || 1;
  const h = stage.clientHeight || r.height || 1;
  return {
    x: (ev.clientX - r.left) * (w / (r.width || w)),
    y: (ev.clientY - r.top) * (h / (r.height || h)),
    W: w,
    H: h,
  };
}

function gizFxOf(clip) {
  if (!clip) return null;
  if (typeof clipEnsureFx === "function") clipEnsureFx(clip);
  // What the picture looks like *right now*: while a clip is animated the
  // handles have to sit on the keyframed position, not the clip-wide value.
  return TLM.evalFxAt(clip, playheadTime());
}

/** Writes an edit, through the keyframes when the clip is animated.
 *
 *  Premiere and CapCut both work this way: once the stopwatch (the first ◆)
 *  is on, dragging the picture at a time records a keyframe there. Writing
 *  clip.fx instead would be invisible - evalFxAt() takes x/y/scale/opacity/
 *  rot from the keyframes and ignores the base value.
 *
 *  Properties that cannot animate (crop, mask, fit, colour, audio) always go
 *  to the clip-wide effect, animated or not. */
function gizWrite(clip, mutate) {
  if (!clip) return;
  if (typeof clipEnsureFx === "function") clipEnsureFx(clip);
  const len = Math.max(0, clip.end - clip.start);
  const animated = TLM.cleanKf(clip.kf, len).length > 0;
  if (!animated) {
    mutate(clip.fx);
    clip.fx = TLM.cleanFx(clip.fx);
    return;
  }
  const shown = TLM.evalFxAt(clip, playheadTime());
  const work = JSON.parse(JSON.stringify(shown));
  mutate(work);
  // Clip-wide values first, so rot/crop/mask/fit keep working while animated.
  const base = JSON.parse(JSON.stringify(clip.fx));
  for (const k of Object.keys(work)) {
    if (TLM.KF_KEYS.indexOf(k) < 0) base[k] = work[k];
  }
  clip.fx = TLM.cleanFx(base);
  const patch = {};
  for (const k of TLM.KF_KEYS) {
    if (Math.abs(Number(work[k]) - Number(shown[k])) > 1e-6) patch[k] = work[k];
  }
  if (Object.keys(patch).length) TLM.kfWrite(clip, playheadTime(), patch);
}

/** The box a clip currently occupies, in stage px. rot in degrees. */
function gizBox(clip, fx, W, H) {
  const s = Math.max(0.01, (Number(fx.scale) || 100) / 100);
  return {
    cx: W / 2 + (Number(fx.x) || 0) / 100 * W,
    cy: H / 2 + (Number(fx.y) || 0) / 100 * H,
    w: W * s,
    h: H * s,
    rot: Number(fx.rot) || 0,
    W, H,
  };
}

/** Point from stage px into box-local px (origin at the box's top-left). */
function gizToLocal(box, p) {
  const a = -box.rot * Math.PI / 180;
  const dx = p.x - box.cx, dy = p.y - box.cy;
  return {
    x: dx * Math.cos(a) - dy * Math.sin(a) + box.w / 2,
    y: dx * Math.sin(a) + dy * Math.cos(a) + box.h / 2,
  };
}

/** Local box px -> stage px. */
function gizToStage(box, lx, ly) {
  const a = box.rot * Math.PI / 180;
  const dx = lx - box.w / 2, dy = ly - box.h / 2;
  return {
    x: box.cx + dx * Math.cos(a) - dy * Math.sin(a),
    y: box.cy + dx * Math.sin(a) + dy * Math.cos(a),
  };
}

/** A stage-pixel drag expressed along the box's own axes (rotation-aware). */
function gizLocalDelta(box, dx, dy) {
  const a = box.rot * Math.PI / 180;
  return {
    x: dx * Math.cos(a) + dy * Math.sin(a),
    y: -dx * Math.sin(a) + dy * Math.cos(a),
  };
}

/* ------------------------------------------------------------- selection */

function gizSelectedClip() {
  if (!S.project || !S.tl || !GIZ.id) return null;
  return (S.tl.clips || []).find((c) => c.id === GIZ.id) || null;
}

function gizLaneHidden(clip) {
  const tr = TLM.trackOf(clip);
  if (typeof laneHidden === "function") {
    try { if (laneHidden(`v${tr}`)) return true; } catch (_) {}
  }
  return false;
}

/** Clips under the playhead, topmost first (the ones the viewer can see). */
function gizStack() {
  if (!S.project || !S.tl) return [];
  const t = playheadTime();
  return TLM.clipStackAt(S.tl, t).slice().reverse()
    .filter((c) => !gizLaneHidden(c));
}

/** Is the playhead inside this clip, i.e. is it on screen right now? */
function gizOnScreen(clip) {
  const t = playheadTime();
  return !!clip && t >= clip.start - 1e-6 && t < clip.end - 1e-6;
}

function gizSelect(clip, mode) {
  if (!clip) return;
  GIZ.id = clip.id;
  GIZ.editing = true;
  if (mode) GIZ.mode = mode;
  if (typeof selectOnly === "function") selectOnly(clip.id);
  else { S.sel = new Set([clip.id]); refresh(); }
  gizRender();
  return GIZ;
}

function gizSetMode(mode) {
  if (!["transform", "crop", "mask"].includes(mode)) return;
  GIZ.mode = mode;
  if (mode === "mask") {
    const clip = gizSelectedClip();
    if (clip && (!clip.fx || !clip.fx.mask || !clip.fx.mask.on)) {
      gizWrite(clip, (fx) => { fx.mask = Object.assign(TLM.defaultMask(fx.mask), { on: true }); });
      commitTL();
    }
  }
  if (typeof ClipRefresh === "function") ClipRefresh();
  gizRender();
  if (typeof status === "function") {
    status(mode === "transform" ? "Transform: drag to move, corners to resize, the dot above to rotate."
      : mode === "crop" ? "Crop: drag an edge inward to trim that side."
      : "Mask: drag inside the picture to draw, drag the shape or its handles to adjust.");
  }
}

function gizExit() {
  GIZ.editing = false;
  GIZ.drag = null;
  GIZ.hover = null;
  const stage = gizStage();
  if (stage) stage.style.cursor = "";
  gizRender();
}

/** Called when the selection changes elsewhere (timeline click, Inspector). */
function gizSyncSelection() {
  const sel = S.sel ? [...S.sel] : [];
  const clip = sel.length === 1
    ? (S.tl && (S.tl.clips || []).find((c) => c.id === sel[0])) : null;
  if (!clip || !gizOnScreen(clip)) {
    GIZ.id = null;
    GIZ.editing = false;
    GIZ.drag = null;
  } else if (GIZ.id !== clip.id) {
    GIZ.id = clip.id;
  }
  gizRender();
}

/* --------------------------------------------------------------- hit test */

/** Topmost clip whose picture contains `pt`, or null. */
function gizClipAt(pt) {
  for (const clip of gizStack()) {
    const fx = gizFxOf(clip);
    const box = gizBox(clip, fx, pt.W, pt.H);
    const l = gizToLocal(box, pt);
    if (l.x >= 0 && l.x <= box.w && l.y >= 0 && l.y <= box.h) return clip;
  }
  return null;
}

/* -------------------------------------------------------------- rendering */

function gizSvg() {
  if (GIZ.svg && GIZ.svg.isConnected) return GIZ.svg;
  const stage = gizStage();
  if (!stage) return null;
  let svg = document.getElementById("gizSvg");
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = "gizSvg";
    svg.setAttribute("class", "giz-svg");
    stage.appendChild(svg);
  }
  GIZ.svg = svg;
  return svg;
}

function gizHud() {
  if (GIZ.hud && GIZ.hud.isConnected) return GIZ.hud;
  const stage = gizStage();
  if (!stage) return null;
  let hud = document.getElementById("gizHud");
  if (!hud) {
    hud = document.createElement("div");
    hud.id = "gizHud";
    hud.className = "giz-hud";
    hud.innerHTML =
      `<button type="button" class="giz-tool" data-tool="transform" title="Move, resize and rotate (V)">transform</button>` +
      `<button type="button" class="giz-tool" data-tool="crop" title="Trim the edges (C)">crop</button>` +
      `<button type="button" class="giz-tool" data-tool="mask" title="Draw a mask shape (P)">mask</button>` +
      `<span class="giz-read" id="gizRead"></span>` +
      `<button type="button" class="giz-tool giz-x" data-tool="done" title="Done (Esc)">&times;</button>`;
    hud.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    hud.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-tool]");
      if (!b) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (b.dataset.tool === "done") gizExit();
      else gizSetMode(b.dataset.tool);
    });
    stage.appendChild(hud);
  }
  GIZ.hud = hud;
  return hud;
}

function gizEl(name, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

/** A square handle centred on (x, y), pulled fully inside the box.
 *
 *  At 100% scale the box is the whole frame, so a handle centred on the edge
 *  would hang outside #previewStage (which clips) and be unclickable. The
 *  handles therefore sit just inside the outline - always reachable. */
function gizHandle(parent, id, x, y, cls = "", w = 0, h = 0) {
  const r = GIZ_HANDLE;
  const px = w ? gizClamp(x, r / 2 + 0.5, w - r / 2 - 0.5) : x;
  const py = h ? gizClamp(y, r / 2 + 0.5, h - r / 2 - 0.5) : y;
  parent.appendChild(gizEl("rect", {
    x: (px - r / 2).toFixed(2), y: (py - r / 2).toFixed(2),
    width: r, height: r, rx: 1.5,
    class: `giz-h ${cls}`.trim(), "data-giz": id,
  }));
}

/** An edge handle (a short bar) centred on (x, y). */
function gizBar(parent, id, x, y, vertical, w = 0, h = 0) {
  const L = 16, T = 6;
  const ix = w ? gizClamp(x, T / 2 + 0.5, w - T / 2 - 0.5) : x;
  const iy = h ? gizClamp(y, T / 2 + 0.5, h - T / 2 - 0.5) : y;
  parent.appendChild(gizEl("rect", vertical
    ? { x: (ix - T / 2).toFixed(2), y: (iy - L / 2).toFixed(2), width: T, height: L, rx: 1.5, class: "giz-h giz-bar", "data-giz": id }
    : { x: (ix - L / 2).toFixed(2), y: (iy - T / 2).toFixed(2), width: L, height: T, rx: 1.5, class: "giz-h giz-bar", "data-giz": id }));
}

function gizRender() {
  const stage = gizStage();
  const svg = gizSvg();
  if (!stage || !svg) return;
  const W = stage.clientWidth || 1;
  const H = stage.clientHeight || 1;
  const clip = gizSelectedClip();
  const show = !!(clip && GIZ.editing && S.project && gizOnScreen(clip) && !PV.playing);
  const hud = gizHud();
  if (hud) hud.hidden = !show;

  if (!show) {
    if (svg.childNodes.length) svg.textContent = "";
    GIZ.sig = "";
    if (stage.classList.contains("giz-on")) stage.classList.remove("giz-on");
    return;
  }
  stage.classList.add("giz-on");

  const fx = gizFxOf(clip);
  const box = gizBox(clip, fx, W, H);
  const mask = fx.mask && fx.mask.on ? TLM.defaultMask(fx.mask) : null;
  const sig = [clip.id, GIZ.mode, W, H, box.cx, box.cy, box.w, box.h, box.rot,
    fx.crop_l, fx.crop_t, fx.crop_r, fx.crop_b,
    mask ? `${mask.shape},${mask.x},${mask.y},${mask.w},${mask.h},${mask.feather},${mask.invert}` : "-",
  ].join("|");
  if (sig === GIZ.sig && svg.childNodes.length) {
    gizReadout(clip, fx, box);
    return;
  }
  GIZ.sig = sig;

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.textContent = "";

  const g = gizEl("g", {
    transform: `translate(${box.cx.toFixed(2)} ${box.cy.toFixed(2)}) ` +
      `rotate(${box.rot.toFixed(3)}) translate(${(-box.w / 2).toFixed(2)} ${(-box.h / 2).toFixed(2)})`,
  });
  svg.appendChild(g);

  const bw = box.w, bh = box.h;

  if (GIZ.mode === "crop") {
    // Ghost of the uncropped source, so you can see what a crop removes.
    const cl = fx.crop_l / 100, cr = fx.crop_r / 100;
    const ct = fx.crop_t / 100, cb = fx.crop_b / 100;
    const fw = Math.max(0.1, 1 - cl - cr), fh = Math.max(0.1, 1 - ct - cb);
    if (cl || cr || ct || cb) {
      g.appendChild(gizEl("rect", {
        x: (-cl * bw / fw).toFixed(2), y: (-ct * bh / fh).toFixed(2),
        width: (bw / fw).toFixed(2), height: (bh / fh).toFixed(2),
        class: "giz-ghost",
      }));
    }
    g.appendChild(gizEl("rect", { x: 0, y: 0, width: bw, height: bh, class: "giz-outline giz-crop-window" }));
    gizBar(g, "crop-l", 0, bh / 2, true, bw, bh);
    gizBar(g, "crop-r", bw, bh / 2, true, bw, bh);
    gizBar(g, "crop-t", bw / 2, 0, false, bw, bh);
    gizBar(g, "crop-b", bw / 2, bh, false, bw, bh);
    gizHandle(g, "crop-tl", 0, 0, "", bw, bh);
    gizHandle(g, "crop-tr", bw, 0, "", bw, bh);
    gizHandle(g, "crop-bl", 0, bh, "", bw, bh);
    gizHandle(g, "crop-br", bw, bh, "", bw, bh);
    // Percentages on each edge while cropping.
    const pct = (v) => `${Math.round(v)}%`;
    svg.appendChild(gizLabel(gizToStage(box, 0, bh / 2), pct(fx.crop_l), "start"));
    svg.appendChild(gizLabel(gizToStage(box, bw, bh / 2), pct(fx.crop_r), "end"));
    svg.appendChild(gizLabel(gizToStage(box, bw / 2, 0), pct(fx.crop_t), "middle", -18));
    svg.appendChild(gizLabel(gizToStage(box, bw / 2, bh), pct(fx.crop_b), "middle", 18));
  } else if (GIZ.mode === "mask") {
    g.appendChild(gizEl("rect", { x: 0, y: 0, width: bw, height: bh, class: "giz-outline giz-dim" }));
    // Drag anywhere outside the shape to draw a new one.
    g.appendChild(gizEl("rect", { x: 0, y: 0, width: bw, height: bh, class: "giz-body", "data-giz": "m-new" }));
    if (mask) {
      const mx = mask.x / 100 * bw, my = mask.y / 100 * bh;
      const mw = mask.w / 100 * bw, mh = mask.h / 100 * bh;
      const x0 = mx - mw / 2, y0 = my - mh / 2;
      if (mask.shape === "ellipse") {
        g.appendChild(gizEl("ellipse", {
          cx: mx.toFixed(2), cy: my.toFixed(2), rx: (mw / 2).toFixed(2), ry: (mh / 2).toFixed(2),
          class: "giz-mask" + (mask.invert ? " giz-inv" : ""),
        }));
      } else {
        g.appendChild(gizEl("rect", {
          x: x0.toFixed(2), y: y0.toFixed(2), width: mw.toFixed(2), height: mh.toFixed(2),
          class: "giz-mask" + (mask.invert ? " giz-inv" : ""),
        }));
      }
      g.appendChild(gizEl("rect", { x: x0.toFixed(2), y: y0.toFixed(2), width: mw.toFixed(2), height: mh.toFixed(2), class: "giz-body", "data-giz": "m-move" }));
      gizHandle(g, "m-nw", x0, y0, "", bw, bh); gizHandle(g, "m-ne", x0 + mw, y0, "", bw, bh);
      gizHandle(g, "m-sw", x0, y0 + mh, "", bw, bh); gizHandle(g, "m-se", x0 + mw, y0 + mh, "", bw, bh);
      gizHandle(g, "m-n", x0 + mw / 2, y0, "", bw, bh); gizHandle(g, "m-s", x0 + mw / 2, y0 + mh, "", bw, bh);
      gizHandle(g, "m-w", x0, y0 + mh / 2, "", bw, bh); gizHandle(g, "m-e", x0 + mw, y0 + mh / 2, "", bw, bh);
      // Feather: a dot on the right edge, pulled outward to soften the edge.
      const fr = Math.max(0, mask.feather) / 100 * Math.min(mw, mh) / 2;
      const fxDot = Math.min(bw - 6, x0 + mw + fr);
      gagFeatherLine(g, x0 + mw, y0 + mh / 2, fxDot, y0 + mh / 2);
      g.appendChild(gizEl("circle", {
        cx: fxDot.toFixed(2), cy: (y0 + mh / 2).toFixed(2), r: 5,
        class: "giz-h giz-feather", "data-giz": "m-feather",
      }));
    }
  } else {
    g.appendChild(gizEl("rect", { x: 0, y: 0, width: bw, height: bh, class: "giz-outline" }));
    // The body sits one pixel inside the outline so the outline itself stays
    // visible, and so the corner handles win the hit test.
    g.appendChild(gizEl("rect", { x: 1, y: 1, width: Math.max(1, bw - 2), height: Math.max(1, bh - 2), class: "giz-body", "data-giz": "move" }));
    gizHandle(g, "nw", 0, 0, "", bw, bh); gizHandle(g, "n", bw / 2, 0, "", bw, bh);
    gizHandle(g, "ne", bw, 0, "", bw, bh); gizHandle(g, "e", bw, bh / 2, "", bw, bh);
    gizHandle(g, "se", bw, bh, "", bw, bh); gizHandle(g, "s", bw / 2, bh, "", bw, bh);
    gizHandle(g, "sw", 0, bh, "", bw, bh); gizHandle(g, "w", 0, bh / 2, "", bw, bh);
    // Rotate: a knob on a stem, docked just inside the top edge so it stays
    // clickable when the clip fills the frame. Once the box is turned, the
    // docked spot can swing outside #previewStage (which clips), so the knob
    // itself is drawn in stage space and pinned to the nearest visible spot -
    // otherwise a rotated full-frame clip could never be turned back.
    const rx = bw / 2, ry = Math.min(28, Math.max(18, bh * 0.22));
    const dock = gizToStage(box, rx, ry);
    const kx = gizClamp(dock.x, 9, W - 9);
    const ky = gizClamp(dock.y, 9, H - 9);
    const anchor = gizToStage(box, rx, 0);
    svg.appendChild(gizEl("line", {
      x1: anchor.x.toFixed(2), y1: anchor.y.toFixed(2),
      x2: kx.toFixed(2), y2: ky.toFixed(2), class: "giz-stem",
    }));
    svg.appendChild(gizEl("circle", {
      cx: kx.toFixed(2), cy: ky.toFixed(2), r: 6, class: "giz-h giz-rot", "data-giz": "rot",
    }));
  }

  gizReadout(clip, fx, box);
}

function gagFeatherLine(g, x1, y1, x2, y2) {
  g.appendChild(gizEl("line", {
    x1: x1.toFixed(2), y1: y1.toFixed(2), x2: x2.toFixed(2), y2: y2.toFixed(2),
    class: "giz-stem",
  }));
}

/** A non-rotating label next to the picture. */
function gizLabel(pt, text, anchor = "middle", dy = 0) {
  const t = gizEl("text", {
    x: pt.x.toFixed(2), y: (pt.y + dy).toFixed(2),
    class: "giz-label", "text-anchor": anchor === "start" ? "start" : anchor === "end" ? "end" : "middle",
    "dominant-baseline": "middle",
  });
  t.textContent = text;
  return t;
}

function gizReadout(clip, fx, box) {
  const read = document.getElementById("gizRead");
  if (!read) return;
  const m = fx.mask && fx.mask.on ? fx.mask : null;
  const txt = GIZ.mode === "crop"
    ? `L ${Math.round(fx.crop_l)} · T ${Math.round(fx.crop_t)} · R ${Math.round(fx.crop_r)} · B ${Math.round(fx.crop_b)}`
    : GIZ.mode === "mask"
      ? (m ? `${m.shape} ${Math.round(m.w)}×${Math.round(m.h)}% · feather ${Math.round(m.feather)}%` : "drag to draw a mask")
      : `x ${gizR1(fx.x)} · y ${gizR1(fx.y)} · ${Math.round(fx.scale)}% · ${gizR1(fx.rot)}°`;
  if (read.textContent !== txt) read.textContent = txt;
  const hud = GIZ.hud || document.getElementById("gizHud");
  if (hud) {
    for (const b of hud.querySelectorAll("[data-tool]")) {
      b.classList.toggle("on", b.dataset.tool === GIZ.mode);
    }
  }
}

/* ------------------------------------------------------------------ drag */

function gizBeginDrag(kind, pt, ev) {
  const clip = gizSelectedClip();
  if (!clip) return false;
  const fx = gizFxOf(clip);
  GIZ.drag = {
    kind,
    clip,
    start: pt,
    startFx: {
      x: fx.x, y: fx.y, scale: fx.scale, rot: fx.rot,
      crop_l: fx.crop_l, crop_t: fx.crop_t, crop_r: fx.crop_r, crop_b: fx.crop_b,
      mask: fx.mask ? Object.assign({}, fx.mask) : null,
    },
    box: gizBox(clip, fx, pt.W, pt.H),
    moved: 0,
    alt: !!ev.altKey,
    shift: !!ev.shiftKey,
  };
  return true;
}

/** 0 / ±50 / box-edge snapping while moving (Alt switches it off). */
function gizSnapX(clip, fx, box) {
  const W = box.W;
  const boxW = box.w;
  const centre = fx.x;
  const edges = [
    { v: 0, at: 0 },                                        // centred
    { v: -100 * (boxW / 2) / W, at: -boxW / 2 },            // flush left
    { v: 100 * (boxW / 2) / W, at: boxW / 2 },              // flush right
  ];
  const px = centre / 100 * W;
  for (const e of edges) {
    if (Math.abs(px - e.at) < 6) return e.v;
  }
  for (const q of [25, 50, 75]) {
    if (Math.abs(centre - q) < 1.2) return q;
    if (Math.abs(centre + q) < 1.2) return -q;
  }
  return centre;
}

function gizSnapY(clip, fx, box) {
  const H = box.H, boxH = box.h;
  const centre = fx.y;
  const edges = [
    { v: 0, at: 0 },
    { v: -100 * (boxH / 2) / H, at: -boxH / 2 },
    { v: 100 * (boxH / 2) / H, at: boxH / 2 },
  ];
  const px = centre / 100 * H;
  for (const e of edges) if (Math.abs(px - e.at) < 6) return e.v;
  for (const q of [25, 50, 75]) {
    if (Math.abs(centre - q) < 1.2) return q;
    if (Math.abs(centre + q) < 1.2) return -q;
  }
  return centre;
}

function gizDragMove(ev) {
  const d = GIZ.drag;
  if (!d) return;
  const clip = d.clip;
  const pt = gizPoint(ev);
  const box = d.box;
  const dx = pt.x - d.start.x;
  const dy = pt.y - d.start.y;
  d.moved = Math.max(d.moved, Math.abs(dx) + Math.abs(dy));
  d.alt = !!ev.altKey;
  d.shift = !!ev.shiftKey;
  const kind = d.kind;

  if (kind === "move") {
    gizWrite(clip, (fx) => {
      fx.x = gizClamp(d.startFx.x + dx / box.W * 100, -100, 100);
      fx.y = gizClamp(d.startFx.y + dy / box.H * 100, -100, 100);
      if (!ev.altKey) {
        fx.x = gizSnapX(clip, fx, box);
        fx.y = gizSnapY(clip, fx, box);
      }
    });
  } else if (kind === "rot") {
    const a0 = Math.atan2(d.start.y - box.cy, d.start.x - box.cx);
    const a1 = Math.atan2(pt.y - box.cy, pt.x - box.cx);
    let deg = d.startFx.rot + (a1 - a0) * 180 / Math.PI;
    if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
    gizWrite(clip, (fx) => { fx.rot = gizClamp(Math.round(deg * 10) / 10, -180, 180); });
  } else if (kind.startsWith("crop-")) {
    // Dragging an edge inward removes that side. The crop window *is* the
    // box, so the percentage is measured against the box.
    const w = Math.max(1, box.w), h = Math.max(1, box.h);
    const sides = kind.slice(5).split("-").join("");     // l | r | t | b | tl | br ...
    const has = (ch) => sides.includes(ch);
    const ld = gizLocalDelta(box, dx, dy);
    gizWrite(clip, (fx) => {
      if (has("l")) fx.crop_l = gizClamp(d.startFx.crop_l + ld.x / w * 100, 0, 45);
      if (has("r")) fx.crop_r = gizClamp(d.startFx.crop_r - ld.x / w * 100, 0, 45);
      if (has("t")) fx.crop_t = gizClamp(d.startFx.crop_t + ld.y / h * 100, 0, 45);
      if (has("b")) fx.crop_b = gizClamp(d.startFx.crop_b - ld.y / h * 100, 0, 45);
    });
  } else if (kind === "m-move" || kind === "m-new" || kind.startsWith("m-")) {
    const m0 = d.startFx.mask || TLM.defaultMask();
    if (kind === "m-new") {
      // Drag out a new rectangle from the anchor corner.
      const a = gizToLocal(box, d.start);
      const b = gizToLocal(box, pt);
      const x0 = gizClamp(a.x, 0, box.w), x1 = gizClamp(b.x, 0, box.w);
      const y0 = gizClamp(a.y, 0, box.h), y1 = gizClamp(b.y, 0, box.h);
      if (Math.abs(x1 - x0) > 6 && Math.abs(y1 - y0) > 6) {
        gizWrite(clip, (fx) => {
          const w = Math.max(0.5, Math.abs(x1 - x0) / box.w * 100);
          const h = Math.max(0.5, Math.abs(y1 - y0) / box.h * 100);
          fx.mask = {
            on: true,
            shape: (fx.mask && fx.mask.shape) || "rect",
            x: (Math.min(x0, x1) + Math.abs(x1 - x0) / 2) / box.w * 100,
            y: (Math.min(y0, y1) + Math.abs(y1 - y0) / 2) / box.h * 100,
            w, h,
            feather: (fx.mask && fx.mask.feather) != null ? fx.mask.feather : 8,
            invert: !!(fx.mask && fx.mask.invert),
          };
        });
      }
    } else {
      // Work in box-local pixels: the mask lives in the box's own frame.
      const lm = gizLocalDelta(box, dx, dy);
      const dl = { x: lm.x / box.w * 100, y: lm.y / box.h * 100 };
      gizWrite(clip, (fx) => {
        if (!fx.mask) fx.mask = TLM.defaultMask(m0);
        const m = fx.mask;
        m.on = true;
        if (kind === "m-move") {
          m.x = gizClamp(m0.x + dl.x, 0, 100);
          m.y = gizClamp(m0.y + dl.y, 0, 100);
        } else if (kind === "m-feather") {
          // The dot sits `feather%` of the shape's half-size outside the edge,
          // so dragging it out by dx px adds dx / (half-size px) of feather.
          const halfPx = Math.min(m0.w / 100 * box.w, m0.h / 100 * box.h) / 2;
          if (halfPx > 0.5) m.feather = gizClamp(m0.feather + (dl.x / 100 * box.w) / halfPx * 100, 0, 100);
        } else {
          const left = kind.includes("w"), right = kind.includes("e");
          const top = kind.includes("n"), bottom = kind.includes("s");
          const dW = (right ? dl.x : left ? -dl.x : 0);
          const dH = (bottom ? dl.y : top ? -dl.y : 0);
          let w = gizClamp(m0.w + dW, 1, 100);
          let h = gizClamp(m0.h + dH, 1, 100);
          if (ev.shiftKey && (left || right) && (top || bottom)) {
            const r = Math.max(w / m0.w, h / m0.h);
            w = gizClamp(m0.w * r, 1, 100);
            h = gizClamp(m0.h * r, 1, 100);
          }
          m.w = w;
          m.h = h;
          // Keep the side you are not dragging where it was.
          let cx = m0.x, cy = m0.y;
          if (left) cx = m0.x - m0.w / 2 + w / 2;
          if (right) cx = m0.x + m0.w / 2 - w / 2;
          if (top) cy = m0.y - m0.h / 2 + h / 2;
          if (bottom) cy = m0.y + m0.h / 2 - h / 2;
          m.x = gizClamp(cx, 0, 100);
          m.y = gizClamp(cy, 0, 100);
        }
      });
    }
  } else if (kind === "mask-auto") {
    // unused
  } else {
    // Resize: corner and edge handles change the single scale value; the
    // opposite corner stays put.
    const hx = kind.includes("e") ? 1 : kind.includes("w") ? -1 : 0;
    const hy = kind.includes("s") ? 1 : kind.includes("n") ? -1 : 0;
    const w0 = box.w, h0 = box.h;
    const ld = gizLocalDelta(box, dx, dy);
    const newW = Math.max(4, w0 + hx * ld.x);
    const newH = Math.max(4, h0 + hy * ld.y);
    let ratio;
    if (hx && hy) ratio = ((newW / w0) + (newH / h0)) / 2;
    else if (hx) ratio = newW / w0;
    else ratio = newH / h0;
    const scale = gizClamp(Math.round(d.startFx.scale * ratio * 10) / 10, 1, 400);
    const bw = box.W * scale / 100, bh = box.H * scale / 100;
    // Anchor the opposite side/corner in stage px, then solve for x/y.
    const anchorX = hx > 0 ? box.cx - w0 / 2 : hx < 0 ? box.cx + w0 / 2 : box.cx;
    const anchorY = hy > 0 ? box.cy - h0 / 2 : hy < 0 ? box.cy + h0 / 2 : box.cy;
    const cx = hx > 0 ? anchorX + bw / 2 : hx < 0 ? anchorX - bw / 2 : box.cx;
    const cy = hy > 0 ? anchorY + bh / 2 : hy < 0 ? anchorY - bh / 2 : box.cy;
    gizWrite(clip, (fx) => {
      fx.scale = scale;
      fx.x = gizClamp((cx - box.W / 2) / box.W * 100, -100, 100);
      fx.y = gizClamp((cy - box.H / 2) / box.H * 100, -100, 100);
    });
  }

  if (typeof syncPreview === "function") syncPreview(true);
  else gizRender();
  gizRender();
}

function gizEndDrag() {
  const d = GIZ.drag;
  GIZ.drag = null;
  if (!d) return;
  if (d.moved > 0.5) {
    if (typeof commitTL === "function") commitTL();
    if (typeof refresh === "function") refresh();
    const clip = d.clip;
    const fx = gizFxOf(clip);
    if (typeof status === "function") {
      const what = d.kind === "move" ? `x ${gizR1(fx.x)}% · y ${gizR1(fx.y)}%`
        : d.kind === "rot" ? `rotation ${gizR1(fx.rot)}°`
        : d.kind.startsWith("crop") ? `crop ${Math.round(fx.crop_l)}/${Math.round(fx.crop_t)}/${Math.round(fx.crop_r)}/${Math.round(fx.crop_b)}%`
        : d.kind.startsWith("m-") ? (fx.mask ? `mask ${Math.round(fx.mask.w)}×${Math.round(fx.mask.h)}%` : "mask")
        : `scale ${Math.round(fx.scale)}%`;
      status(`${what} — undo with Ctrl+Z`);
    }
  }
  gizRender();
}

/** Re-render after the preview moved; cheap when nothing changed. */
function gizRefresh() { gizRender(); }

/** Project swapped or timeline reset: drop the handles. */
function gizReset() {
  GIZ.id = null;
  GIZ.editing = false;
  GIZ.drag = null;
  GIZ.hover = null;
  GIZ.sig = "";
  const svg = document.getElementById("gizSvg");
  if (svg) svg.textContent = "";
  const hud = document.getElementById("gizHud");
  if (hud) hud.hidden = true;
  const stage = gizStage();
  if (stage) stage.style.cursor = "";
}

/* --------------------------------------------------------------- events */

/** Cursor + hover feedback while nothing is being dragged. */
function gizHoverAt(ev) {
  const stage = gizStage();
  if (!stage) return;
  const target = ev.target.closest ? ev.target.closest("[data-giz]") : null;
  if (GIZ.editing && target) {
    const g = target.getAttribute("data-giz");
    stage.style.cursor = g === "move" || g === "m-move" ? "move"
      : g === "rot" ? "grab"
      : g === "m-feather" ? "ew-resize"
      : g === "m-new" ? "crosshair"
      : gizCursorFor(g);
    return;
  }
  const pt = gizPoint(ev);
  const hit = gizClipAt(pt);
  stage.style.cursor = hit ? (GIZ.editing ? "move" : "pointer") : "";
  if (hit !== GIZ.hover) GIZ.hover = hit ? hit.id : null;
}

function gizCursorFor(h) {
  if (!h) return "default";
  if (h === "n" || h === "s") return "ns-resize";
  if (h === "e" || h === "w") return "ew-resize";
  if (h === "nw" || h === "se") return "nwse-resize";
  if (h === "ne" || h === "sw") return "nesw-resize";
  if (h === "crop-l" || h === "crop-r") return "ew-resize";
  if (h === "crop-t" || h === "crop-b") return "ns-resize";
  if (h.startsWith("m-")) return gizCursorFor(h.slice(2));
  return "pointer";
}

function gizPointerDown(ev) {
  if (ev.button !== 0 || !S.project) return;
  // Editing while the playhead runs would record a keyframe at whatever time
  // the pointer happened to be over; Premiere stops you too.
  if (typeof PV !== "undefined" && PV.playing) return;
  if (ev.target.closest && ev.target.closest("#capOverlay")) return;   // captions drag themselves
  if (ev.target.closest && ev.target.closest("#gizHud")) return;
  const stage = gizStage();
  if (!stage) return;

  const hEl = ev.target.closest ? ev.target.closest("[data-giz]") : null;
  if (GIZ.editing && GIZ.id && hEl) {
    const kind = hEl.getAttribute("data-giz");
    if (gizBeginDrag(kind, gizPoint(ev), ev)) {
      ev.preventDefault();
      ev.stopPropagation();
      stage.setPointerCapture && stage.setPointerCapture(ev.pointerId);
      return;
    }
  }

  const pt = gizPoint(ev);
  const hit = gizClipAt(pt);
  if (!hit) {
    // Clicking the black around the picture drops the selection.
    if (GIZ.editing) { gizExit(); if (typeof clearSel === "function") clearSel(); }
    else if (typeof clearSel === "function") clearSel();
    return;
  }
  if (GIZ.id !== hit.id) {
    GIZ.id = hit.id;
    GIZ.editing = GIZ.editing;   // keep edit mode when hopping between clips
    if (typeof selectOnly === "function") selectOnly(hit.id);
    else { S.sel = new Set([hit.id]); refresh(); }
    if (GIZ.editing) gizRender();
  } else if (GIZ.editing && !hEl) {
    // Dragging the body of the selected clip moves it (no double-click needed
    // once the handles are up).
    if (gizBeginDrag("move", pt, ev)) {
      ev.preventDefault();
      stage.setPointerCapture && stage.setPointerCapture(ev.pointerId);
      return;
    }
  }
}

function gizDoubleClick(ev) {
  if (!S.project) return;
  if (typeof PV !== "undefined" && PV.playing) return;
  if (ev.target.closest && (ev.target.closest("#capOverlay") || ev.target.closest("#gizHud"))) return;
  const pt = gizPoint(ev);
  const hit = gizClipAt(pt);
  if (!hit) { gizExit(); if (typeof clearSel === "function") clearSel(); return; }
  ev.preventDefault();
  gizSelect(hit, GIZ.mode);
  if (typeof status === "function") {
    status("Editing “" + (hit.name || mediaName(hit.src) || "clip") + "” on the monitor — drag to move, corners to resize, C to crop, P to mask.");
  }
}

function gizPointerMove(ev) {
  if (GIZ.drag) { gizDragMove(ev); return; }
  gizHoverAt(ev);
}

function gizKey(ev) {
  if (!GIZ.editing || !GIZ.id) return false;
  const tag = (ev.target && ev.target.tagName) || "";
  if (/INPUT|TEXTAREA|SELECT/.test(tag) || (ev.target && ev.target.isContentEditable)) return false;
  const step = ev.shiftKey ? 5 : 1;
  const clip = gizSelectedClip();
  if (!clip) return false;
  if (ev.key === "Escape") { gizExit(); return true; }
  if (ev.key === "v" || ev.key === "V") { gizSetMode("transform"); return true; }
  if (ev.key === "c" || ev.key === "C") { gizSetMode("crop"); return true; }
  if (ev.key === "p" || ev.key === "P") { gizSetMode("mask"); return true; }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const a = arrows[ev.key];
  if (a && ev.altKey) {
    gizWrite(clip, (fx) => {
      if (GIZ.mode === "mask" && fx.mask) {
        if (ev.shiftKey) {
          fx.mask.w = gizClamp(fx.mask.w + a[0] * step, 1, 100);
          fx.mask.h = gizClamp(fx.mask.h + a[1] * step, 1, 100);
        } else {
          fx.mask.x = gizClamp(fx.mask.x + a[0] * step, 0, 100);
          fx.mask.y = gizClamp(fx.mask.y + a[1] * step, 0, 100);
        }
      } else {
        fx.x = gizClamp(fx.x + a[0] * step, -100, 100);
        fx.y = gizClamp(fx.y + a[1] * step, -100, 100);
      }
    });
    if (typeof syncPreview === "function") syncPreview(true);
    gizRender();
    return true;
  }
  return false;
}

function gizInit() {
  if (GIZ.bound) return;
  const stage = gizStage();
  if (!stage) return;
  GIZ.bound = true;
  gizSvg();
  gizHud();
  stage.addEventListener("pointerdown", gizPointerDown);
  stage.addEventListener("pointermove", gizPointerMove);
  stage.addEventListener("dblclick", gizDoubleClick);
  stage.addEventListener("pointerleave", () => { if (!GIZ.drag) stage.style.cursor = ""; });
  window.addEventListener("pointerup", () => { if (GIZ.drag) gizEndDrag(); });
  window.addEventListener("pointercancel", () => { if (GIZ.drag) gizEndDrag(); });
  window.addEventListener("keydown", (ev) => {
    if (gizKey(ev)) { ev.preventDefault(); ev.stopPropagation(); }
  }, true);
  if (window.ResizeObserver) {
    new ResizeObserver(() => gizRender()).observe(stage);
  }
  window.addEventListener("resize", () => gizRender());
  // Selection made on the timeline should bring the handles back into view,
  // but only for the clip that is actually under the playhead.
  const _refresh = window.refresh;
  if (typeof _refresh === "function") {
    window.refresh = function () {
      const out = _refresh.apply(this, arguments);
      gizSyncSelection();
      return out;
    };
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", gizInit);
} else {
  gizInit();
}
