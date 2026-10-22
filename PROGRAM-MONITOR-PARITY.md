# Program Monitor: Premiere Pro vs. VTS

A complete inventory of what Adobe Premiere Pro's **Program Monitor** does, matched
against what **Video Trim Studio's Program panel** does today in this workspace.

Status legend:

| Mark | Meaning |
|------|---------|
| ✅ | present and working |
| ◐ | partly there / behaves differently |
| ✗ | missing |
| – | not applicable to a local browser app (reason given) |

Counted rows: **66**. Today: **53 ✅**, **3 ◐**, **6 ✗**, **4 –**.

**Phase 1 + 2 + the transform half of Phase 3 shipped.** The transport, timecode
block, playback/paused resolution, safe margins and guides, alpha view, scopes
(waveform / RGB parade / vectorscope / histogram), audio meters, Export Frame,
fullscreen, panel gear menu and button editor are real features, and so is
**direct manipulation on the picture**: click a clip in the monitor, double-click
(or V / C / P) for handles, then move, resize, rotate, crop and mask it in place
(`static/gizmo.js`, rows E5/E6 and H5/H6). Every write goes through the same
`fx` fields the exporter reads, and `vts/fx.py` + `vts/edl.py` grew a rotation
angle and a shape mask so the rendered file matches the monitor pixel for pixel.
Browser tests: `tests/test_gizmo_ui.py` and `test_monitor_*` in
`tests/test_timeline_ui.py`; filter-graph tests in `tests/test_fx.py` and
`tests/test_mask_render.py` (real ffmpeg, real pixels). Trim-in-monitor (H1–H2)
is still deliberately out of scope.

---

## 1. Transport

| # | Premiere feature | VTS | Notes on VTS |
|---|---|---|---|
| A1 | Play / Pause (Space) | ✅ | `#playBtn`, Space toggles `startPlayback()`/`pausePlayback()` |
| A2 | Stop (return to start) | ✅ | Pause keeps the playhead; Home / `mnStart` is the explicit go-to-start |
| A3 | Step one frame back/forward | ✅ | `#frameBack` / `#frameFwd`, ← → keys, uses the source fps |
| A4 | Step by 5 / 10 frames (Shift) | ◐ | VTS uses Shift+←/→ for **one second** instead |
| A5 | J / K / L shuttle (reverse, pause, forward) | ✅ | J / K / L in `monitor.js` (capture-phase keys), K also stops the shuttle |
| A6 | L or J pressed repeatedly for 2×, 4×, 8× | ✅ | Repeat L (1→2→4→8×) or J (−1→−2→−4→−8×); rate shown in `#playInfo` and the speed menu |
| A7 | Playback speed control (0.5×–4×) | ✅ | `#mnSpeed` 0.1×–8× plus −1/−2/−4/−8×; drives the master clock, media follows up to 4× |
| A8 | Loop playback | ✅ | `mnLoop` / the gear menu; wraps at the Out point (or the sequence end) |
| A9 | Play In→Out | ✅ | `mnPlayInOut` button and Shift+Space |
| A10 | Mark In / Mark Out (I / O) | ✅ | I / O mark in and out; shown as a blue band + flags on the ruler |
| A11 | Go to In / Go to Out | ◐ | Play In→Out starts at the In point; there is no separate go-to-in/out key yet |
| A12 | Go to start / end (Home / End) | ✅ | Home / End, plus `mnStart` / `mnEnd` |
| A13 | Sequence markers (M) and next/prev marker | ✅ | M adds a marker (prompt for the name), `,` / `.` jump; markers render on the ruler. Lane mute moved to **Shift+M** |
| A14 | Scrub by dragging in the monitor / jog | ✗ | Scrubbing is done on the timeline ruler only |

## 2. Time display

| # | Premiere feature | VTS | Notes on VTS |
|---|---|---|---|
| B1 | Timecode readout | ✅ | `#timecode` shows `00:00:03:15 / 00:00:18:00`, frame-exact at the project fps |
| B2 | Click-and-type timecode entry | ✅ | Click the timecode and type `00:00:03:15`, `3:15`, `105f`, `3.5` or `+2` |
| B3 | Display mode: timecode / frames / seconds | ✅ | Right-click the timecode, or the gear menu: timecode / frames / seconds |
| B4 | Toggle elapsed vs. remaining | ✅ | Gear menu → Show remaining instead of duration |
| B5 | Dropped-frames indicator (green/yellow/red) | ✅ | `#playInfo` reports fps, dropped frames (measured from `pvTick` dt jitter) and the active resolution |

## 3. Image, zoom and pan

| # | Premiere feature | VTS | Notes on VTS |
|---|---|---|---|
| C1 | Fit (fit the frame to the panel) | ✅ | `#videoZoomFit` |
| C2 | Zoom presets, 10 % → 800 % | ✅ | `PREVIEW_ZOOM_LEVELS` is now 10 % → 800 %; click the % read-out for the full list |
| C3 | Zoom in / out buttons | ✅ | `#videoZoomIn` / `#videoZoomOut` |
| C4 | Zoom percentage readout | ✅ | `#videoZoomLevel` |
| C5 | Zoom around the pointer (Ctrl/⌘+wheel) | ✅ | Same, with the point under the cursor pinned |
| C6 | Pan / hand tool when zoomed | ✅ | Drag the stage; pan is clamped to the frame |
| C7 | Resize the viewing area inside the panel | ✅ | **VTS extra** — `#previewViewportResize` grip; Premiere only resizes the panel |
| C8 | Pasteboard / background around the frame | ✅ | Stage is letterboxed on black |

## 4. Playback quality and performance

| # | Premiere feature | VTS | Notes on VTS |
|---|---|---|---|
| D1 | Playback resolution Full / ½ / ¼ / ⅛ / 1/16 | ✅ | Playback resolution Full / ½ / ¼ / ⅛ / 1/16, re-composited on a smaller canvas |
| D2 | Paused resolution (separate from playback) | ✅ | Separate paused resolution, applied on every seek |
| D3 | High Quality Playback toggle | ✅ | High Quality Playback: look filters (brightness/contrast/saturation) on during playback |
| D4 | Proxy / preview-build status | ✅ | VTS is ahead here: an unplayable codec triggers a preview copy with a % banner |
| D5 | Render bar (yellow = needs render, green = rendered) | – | No render cache: the browser composites live every frame |
| D6 | Mercury Playback Engine / GPU indicator | – | Nothing to switch: compositing is CSS + `<video>` |

## 5. Overlays and guides

| # | Premiere feature | VTS | Notes on VTS |
|---|---|---|---|
| E1 | Action-safe / title-safe margins | ✅ | Action-safe (10 %) and title-safe (20 %) boxes, toggled in the gear menu |
| E2 | Safe-margin settings (percentages, 4:3 box) | ✅ | 4:3 safe box, custom margin in percent, all adjustable |
| E3 | Guides, centre crosshair, grid | ✅ | Centre crosshair and rule-of-thirds guides |
| E4 | Alpha-channel view (transparency) | ✅ | Alpha view renders the composite's alpha as a white-on-black matte |
| E5 | Transform handles on the monitor (move/scale/rotate the selected clip) | ✅ | Click the picture to select, double-click for handles: drag the body to move, the 8 squares to scale (the opposite corner stays put), the knob to rotate (Shift = 15° steps, Alt = no snapping). Mouse only — no cursor-tool switching needed |
| E6 | Mask / effect handles on the monitor | ✅ | Rect/ellipse mask with feather and invert: drag on the picture to draw, drag the shape/handles to adjust, the dot on the right edge sets the feather. Applied as a real alpha mask in the preview and on export (`geq` + `format=yuva420p`) |
| E7 | Edit text/graphics directly in the monitor | ✅ | The caption box: drag, resize, double-click to type |
| E8 | Snap guides while placing that text | ✅ | **VTS extra** — thirds + centre lines while dragging |

## 6. Display modes and scopes

| # | Premiere feature | VTS | Notes on VTS |
|---|---|---|---|
| F1 | Composite video mode (the normal view) | ✅ | The only mode |
| F2 | Alpha display mode | ✅ | Alpha display mode (see E4) |
| F3 | Scopes: YC waveform, RGB parade, YCbCr parade, vectorscope, histogram | ✅ | Waveform, RGB parade, vectorscope and histogram, sampled from the composited program frame |
| F4 | Grading while watching the monitor (Lumetri) | ◐ | Look sliders (brightness/contrast/saturation) in the Inspector's Effect mode, no monitor-side panel |

## 7. Comparison and reference

| # | Premiere feature | VTS | Notes on VTS |
|---|---|---|---|
| G1 | Comparison view (side-by-side / wipe / difference vs. a reference) | ✗ | — |
| G2 | Reference monitor, gang source + program | ✗ | There is no Source monitor either |
| G3 | Multi-cam angle grid + 1/2/3/4 switching | – | VTS has no multi-cam sequence type |

## 8. Editing from the monitor

| # | Premiere feature | VTS | Notes on VTS |
|---|---|---|---|
| H1 | Trim mode in the monitor (two-up A/B display) | ✗ | Trimming is done by dragging block edges on the timeline |
| H2 | Ripple / roll / slip / slide from the monitor | ✗ | — |
| H3 | In→Out range playback | ✅ | In→Out range playback (stops on the Out point, loops when loop is on) |
| H4 | Delete/ripple from the monitor | ✗ | Timeline keys only |
| H5 | Crop the picture in the monitor | ✅ | Crop tool (C): drag any edge or corner inward; the crop window *is* the picture, so the frame fills with what is left (Premiere's Crop + "scale to frame size", which is how this model has always cropped) |
| H6 | Move a clip past the frame edge (off-frame art) | ✅ | `fx.x/y` reaches ±100 % and the exporter now places the layer with the same offset instead of pinning it inside the frame |

## 9. Output and panel chrome

| # | Premiere feature | VTS | Notes on VTS |
|---|---|---|---|
| I1 | Export Frame (camera button → PNG/TIFF still) | ✅ | `mnFrame` / Ctrl+Shift+E writes a project-resolution PNG of the current frame |
| I2 | Fullscreen monitor (Ctrl+`) | ✅ | `mnFull` / Ctrl+`; the frame fills the screen and the zoom/pan math keeps working |
| I3 | Second-monitor video output | – | A browser tab can go fullscreen on a second display, nothing more |
| I4 | Panel menu (hamburger) with monitor settings | ✅ | The gear menu collects every monitor setting in one panel |
| I5 | Customisable button bar (Button Editor) | ✅ | Button editor: untick a button to remove it from the bar (persisted) |

## 10. Audio monitoring

| # | Premiere feature | VTS | Notes on VTS |
|---|---|---|---|
| J1 | Audio level meters under the monitor | ✅ | Stereo meters fed by a WebAudio analyser over the real program mix |
| J2 | Monitor volume slider | ✅ | Monitor volume slider in the gear menu (master gain) |
| J3 | Mute / solo monitoring | ✅ | Monitor mute button; per-clip and Shift+M lane mute still exist |

## 11. Panel behaviour

| # | Premiere feature | VTS | Notes on VTS |
|---|---|---|---|
| K1 | Dock, float, move, hide the panel | ✅ | Workspace units |
| K2 | Tab it with other panels | ✅ | Panel groups |
| K3 | Reset the workspace | ✅ | Reset workspace |
| K4 | Info line (frame size, fps, aspect) | ✅ | `#monInfo`: frame size, fps, playback/paused resolution, HQ, dropped frames, in/out, marker count |

---

## Where VTS is already equal or ahead

- **Resizable viewing area** inside the panel (C7) — Premiere makes you resize the whole panel.
- **Automatic preview build** for codecs the browser can't decode (D4), with a progress banner, instead of a manual "create proxies" workflow.
- **Caption editing on the monitor** (E7/E8) already covers what Premiere splits into the Essential Graphics panel, including snapping.
- **Panel tabs + free-form docking** at the same level as Premiere's workspace system.

## What cannot be replicated, and why

- **D5 render bar / render cache, D6 Mercury engine** — Premiere pre-renders frames to disk and picks a GPU pipeline. VTS composites live DOM layers; there is nothing to render ahead of time.
- **G3 multi-cam** — a feature of a sequence *type* VTS does not have (one source + overlays), not of the monitor.
- **I3 second-monitor output** — browsers cannot open a clean video output window; fullscreen on another display is the closest.
- Everything else in the ✗ column **is** buildable in this app.

---

## Build plan (status)

### Phase 1 — Transport & readouts — **shipped**
- A5/A6 **J/K/L shuttle** with 1×, 2×, 4×, 8× on repeated presses, K = pause.
- A7 **Playback speed** menu (0.1×–4×) next to play.
- A8 **Loop playback** toggle.
- A10/A11 **Mark In / Mark Out** (I / O), drawn on the timeline ruler and the monitor; A9 **Play In→Out**; A12 **Home/End**.
- B1–B4 **Timecode block**: click to type a timecode, right-click/switcher for *timecode / frames / seconds* and *elapsed / remaining*.
- B5 + K4 **Monitor info line**: frame size, fps, dropped-frame counter (measured from rAF jitter), current playback resolution.
- A13 **Markers**: move VTS's "mute" off M (to Shift+M), give M back to markers with next/prev (Shift+←/→ kept as seconds… or moved).
- I2 **Fullscreen monitor**.
- J1/J2/J3 **Audio meters + monitor volume + mute** (WebAudio analyser on the stage layers).

### Phase 2 — Image, overlays, quality — **shipped** (scopes landed here too)
- D1/D2/D3 **Playback resolution / Paused resolution / High Quality** — implemented honestly: the composite is rendered through a scaled canvas for ½–1/16 (softer *and* cheaper), and pause renders full.
- E1/E2 **Safe margins** with an overlay settings popover (action 10 %, title 20 %, 4:3 box, custom %).
- E3 **Guides**: centre crosshair, 3×3 grid, toggleable.
- E4/F2 **Alpha view** (checkerboard + alpha display).
- C2 **Full zoom list** 10 %→800 % in a dropdown.
- I1 **Export Frame** → PNG at project resolution (download or save into the project folder).
- I4 **Panel menu** (gear) collecting all of the above, Premiere-style.

### Phase 3 — Editing from the monitor — **transform/crop/mask shipped, trimming still deferred**
- E5 **Transform handles**: move (body drag), scale (8 handles, anchored on the
  opposite corner), rotate (knob, `fx.rot` new in the model). Alt = no snapping,
  Shift = 15° rotation steps, Alt+arrows = 1 % nudge (Shift = 5 %).
- H5 **Crop handles**: drag an edge inward; the ghost outline shows what is being
  discarded. Same numbers as the Inspector's crop fields.
- E6/H6 **Mask handles + off-frame placement**: rect/ellipse, feather, invert;
  x/y now reach past the frame edge in the export too (`_clamp_pos` widened from
  "inside the frame" to "may hang over, but not absurdly").
- **Not built:** G1 comparison view (still ✗), H1/H2 trim-in-monitor (deferred,
  as decided), F4 monitor-side Lumetri (still ◐).

### Phase 4 — explicitly skipped
- D5, D6, G3, I3 for the reasons above.

## Decisions taken

1. **Scope:** Phase 1 + Phase 2, plus all four scopes, plus Phase 3's on-picture
   transform / crop / mask handles. Comparison view and trim-in-monitor stay out.
2. **M = markers, Shift+M = lane mute.** The old lane-mute binding moved to Shift+M;
   the monitor's own mute is the speaker button in the transport bar.
3. **Trim in the monitor:** deferred. Trimming stays on the timeline.
4. **Scopes:** all four — waveform, RGB parade, vectorscope, histogram.

## How it was built

| File | Role |
|---|---|
| `static/monitor.js` | New. Monitor state, transport bar, timecode, markers/in-out, playback quality, overlays, canvas compositor, scopes, meters, Export Frame, gear menu, button editor. |
| `static/timeline.js` | Hooks: rate-aware `pvTick`, in/out + loop gate, marker rendering in the ruler, Shift+M, Shift+Space, `monSeek()` on every seek. |
| `static/stage.js` | `STAGE.rate` so media follows the shuttle (playbackRate, drift tolerance); rotation + CSS mask on `.fx-box`, and `#player` marked as the hidden reference frame. |
| `static/gizmo.js` | New. On-picture editing: hit-testing the visible clip under the pointer, transform/crop/mask handles, the mode strip, keyboard modes, snapping, undo-safe commits. |
| `static/clip.js` | Rotation slider and the Mask section in the Inspector (nested `fx.mask` bindings, shape/feather/invert, "edit on monitor"). |
| `vts/fx.py` | `rot` (−180…180) and `mask` (rect/ellipse, x/y/w/h %, feather, invert) in `clean_fx`; `rotate_filter`, `rotated_size`, `mask_filter` (ffmpeg `geq` alpha). |
| `vts/edl.py` | Rotation and mask stages after fit, before the overlay; the overlay may now hang past the frame edge. |
| `static/app.js` | `PREVIEW_ZOOM_LEVELS` 10 %→800 %, fullscreen aware layout. |
| `static/index.html` / `static/style.css` | Transport bar, meters, scopes card, overlay layers, gear menu. |

**Honesty notes.** The scopes, Export Frame, alpha view and reduced-resolution
playback all read pixels from the *same* composite stage.js is showing — they are
re-drawn through `monDrawComposite()` into a canvas at the requested size, not
sampled from a placeholder. Dropped frames are counted from the real `requestAnimationFrame`
delta against the project frame rate. The one thing that is approximate is the
cost model: the browser still decodes the source at full size, so ½ res saves
compositing work and looks softer, but does not reduce decode effort.
