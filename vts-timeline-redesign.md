# VTS timeline redesign — implementation spec

**Goal:** make the redesigned timeline the default (and only) timeline UI in
`video-trim-studio`. No feature flag, no old-UI fallback: the old toolbar rail,
`#tlTools`, canvas, and pill are deleted and replaced.

**Sources of truth (in priority order):**

| # | Source | What it is |
|---|--------|------------|
| 1 | `/home/user/vts-integrated-preview.html` | The target UI running inside the real app snapshot. What you see here is what ships. Rebuildable via `/home/user/build-integrated.py` (reads the mhtml + the mock). |
| 2 | `/home/user/vts-timeline-preview.html` | Standalone interactive mock. The **behavior reference**: tray logic, lane grid, headers, shortcuts, edge handle. Its `<style>`/`<script>` are the porting source. Its mapping tables document every old→new decision. |
| 3 | kconcat `src/crates/concat/ui/timeline/*.slint` | Design authority: `timeline-pane.slint` (pane order), `tray.slint` (tray groups/order), `track-header.slint` (header controls), `lanes.slint`, `tabs.slint`, `model.slint`. Palette in `ui/theme/dark.slint` (not adopted — VTS keeps its own colors). |

**Non-goals:** Sections panel (comes next; pills are its temporary home) —
merge and trim-follow stay greyed until implemented — no backend/`vts/`
changes — no Export/List/Inspector changes except the pill↔filter sync.

---

## 1. Target UI summary

### 1.1 Layout order (top → bottom, per `timeline-pane.slint`)

```
ws-tabs ("Timeline 01" | "List")          ← existing workspace chrome, keep
tray (40px icon bar)                       ← NEW, replaces .tl-head + #tlTools
lane grid (152px headers + lanes)          ← NEW, replaces canvas + trackLabels
statusline (status text … timecode)        ← NEW, replaces #tlHint + #tlStatus
legend                                     ← NEW wording, same spot
workspace-resize-handle resize-bottom      ← replaces the pill, same behavior
```

Only `#tab-tl`'s content is replaced. The `tl` moveunit wrapper, `ws-head`,
`List` tabpage, drag/drop, and panel resize handles are untouched.

### 1.2 Tray inventory (left → right, per `tray.slint` groups)

| Control | Behavior |
|---------|----------|
| `+` (Add) | Menu with **exactly 2 items**: Add video track / Add audio track. New V goes **above** the V stack; new A goes at the very bottom. |
| undo / redo | `undoTL()` / `redoTL()`; disabled when the stack is empty that way. |
| split | Split at playhead (`Ctrl+K` kept): the selection, else everything. |
| razor (toggle, `R`) | Click a clip to split it there; blade hairline follows the cursor. Toggling off (or `V`) returns to select. `R` kept (kconcat uses `B`). |
| merge (disabled) | Greyed with the reason in the tooltip: needs 2+ adjacent clips on one lane (not in VTS yet). kconcat rule: a blocked button says *why*. |
| trash (`Del`) | Deletes the selection. Count badge appears when ≥2 selected. With magnetic on, deletes close the gap (replaces ripple-delete). |
| pan (toggle, `H`) | Drag scrolls the timeline. |
| trim-follow (disabled) | Greyed + reason (not in VTS yet). |
| snap (toggle) | Snap moves/trims to playhead + edges (existing `tlSnap` behavior). |
| magnet (toggle) | Magnetic timeline: deletes/trims close the gap. |
| `T` (+ caption) | **Adds a caption at the playhead** on the topmost unlocked V track (replaces the text *tool*). Auto-creates a V track at the top if none exists; toasts if all V tracks are locked. |
| pills: caption / silence / other | Toggle `S.filter` kinds; wired to the same filters as the List panel. |
| pill: all silence | Selects every silence section. |
| pill: remove selected | Only visible when ≥1 section is marked; removes marked sections. Temporary — moves to the Sections panel next. |
| fit / − / + | Zoom to fit, zoom out, zoom in (`Ctrl`+wheel also zooms). |

**Deleted from the timeline (all deliberate):** select button (select is the
default mode), text/zoom/mute *tools*, copy/cut/paste buttons (already in the
Edit menu; shortcuts stay), ripple button (→ magnetic toggle), `+ lane`
(caption lanes no longer exist), `+ track` (split into the two `+` menu items),
auto-caption button (that feature already lives elsewhere).

### 1.3 Lane grid rules

- **Two groups, Premiere-style:** VIDEO on top, AUDIO at the bottom, with
  labeled divider bars. No caption group anywhere.
- **Top lane = top layer.** V tracks render highest-index-at-top; A tracks
  render top-down.
- **Mixed V tracks:** a V track holds video + image + caption clips together.
  A caption is just another media clip; captions are transparent overlays that
  **float above** same-track media (z-index), never collide with it.
- **Numbering (view-only):** V numbers bottom-up (bottom-most V = V1),
  A numbers top-down (top-most A = A1). Model indices don't change.
- **Typed headers** (per `track-header.slint`): lock · output-eye (V) or
  mute-switch (A) · kind letter · `···` menu. The `···` menu holds Delete,
  **greyed on the last lane standing**. No height/size button.
- **Lane height = Alt+scroll over the header only**, 24–140px per lane,
  double-click resets to auto. A view tweak like zoom — **not** an undo step.
- **Ruler:** sticky on vertical scroll, click/drag seeks; 6px section strip
  along its foot — click a bar to mark/unmark that section for removal.
- **Playhead** spans the lanes with a cap in the ruler.
- **Headers ride along** on vertical scroll (corner stays pinned to the ruler).

### 1.4 Statusline, legend, edge handle, keyboard

- **Statusline:** left = `status()` text (same helper as today); right =
  `playhead / end` timecode.
- **Legend:** video · image/overlay · caption (floats over video) · audio ·
  silence section · `top lane = top layer · A lanes mix · gaps export black`.
- **Edge handle:** the standard
  `<div class="workspace-resize-handle resize-bottom" …>` at the foot of the
  lane grid. Drag adds/removes empty viewing space (80px–85vh, track sizes
  untouched, persisted via `saveWorkspaceLayout`), double-click resets to auto.
- **Keyboard (unchanged):** `V` select · `R` razor · `H` pan · `T` add-caption ·
  `M` mute (A lane) / output toggle (V lane, on the selected clip's lane else
  first lane) · `Del` delete · `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` undo/redo ·
  `Ctrl+K` split · `Ctrl+C/X/V` clipboard (Edit menu owns the buttons).

---

## 2. Current-code map (what lives where today)

All paths under `video-trim-studio/static/`.

| File | Owns today |
|------|------------|
| `index.html` ~L524–571 | `#tab-tl`: `.tl-head` (zoom/undo/clipboard/split/delete/ripple/caption/lane/track/snap buttons + `#tlHint` + `#tlStatus`), `#tlTools` tool rail (`data-tool` = select/razor/text/hand/zoom/mute), `#timelineViewportWrap` → `#timelineViewport` → `#timelineStage` → `#trackLabels` + `canvas#timeline`, `#timelineViewportResize` pill, `.legend`. |
| `style.css` | Old timeline rules: `.tl-head`, `.tl-tools`, `.tl-tool`, `.timeline-viewport*`, `#trackLabels`, `.track-ruler`, old `.legend`, `.timeline-viewport-resize`. Plus the shared rules the redesign reuses: `:root` palette, `button`, `.workspace-resize-handle*`, `[hidden]`, `.menu`. |
| `timeline.js` (~2300 lines) | Everything timeline: `TL_TOOLS` + `curTool` (L881), canvas `draw()` (L517) + `drawClip/drawCap/drawAud/drawWave/drawFilmstrip/drawPoster`, hit-testing (`rowAt/hitItem/edgeAt`), `syncTrackLabels`, `commitTL/undoTL/redoTL` (L600/643/655), `S.filter` + `renderList()` (L1651), keydown handler (L1502), boot wiring incl. `window resize → draw` (L2228). |
| `timeline-model.js` | Pure model, `window.TLM` (+ node exports, tested). Buckets `clips/auds/caps`; `trackOf/atrackOf/prefixOf`, `vtracksOf/atracksOf`; `MAX_VTRACKS/MAX_ATRACKS`; ops: `placeClip/placeAudio/placeCap`, `splitClip/splitCaption/splitSelection`, `deleteItems/moveItems/trimItem`, `addCaption`, `assignLanes`, `copyItems/pasteItems/duplicateItems`, `clipAt/clipStackAt/audioStackAt`, `linkedAudioOf`, `flattenClips`, `validate`. **Do not break its API or the node tests.** |
| `app.js` | Global `S` state (`T`, `tl`, `view{start,span}`, `sel`, `undo/redo/lastJSON`, `filter`, `sections`, `laneHidden/laneLocked`), workspace layout `WS` (`timelineViewportHeight`, `sizes.timeline`), `applyTimelineViewportHeight` (L231), `bindTimelineViewportResize` (L261), `saveWorkspaceLayout`, global keydown (L1327). |

---

## 3. Implementation phases

### Phase 0 — Branch + safety net
1. Cut a branch (e.g. `timeline-redesign`).
2. Run the existing node tests for `timeline-model.js`; they must stay green
   through every phase.
3. Acceptance: `python -m http.server`-served app behaves exactly as `main`.

### Phase 1 — HTML skeleton (`index.html`, `#tab-tl` only)
Replace the `#tab-tl` body (`.tl-head`, `#tlTools`, viewport wrap, pill,
legend) with the mock's section inner markup (mock `tl-panel` div minus its
tabs strip — the workspace `ws-tabs` already provide Timeline/List):

```
<div id="pvTimeline">  → rename to a permanent id, e.g. id="tlNew" (any id;
   tray                the mock ids tray/headers/scroll/lanes/status/tc are
   grid                all collision-free vs the app today — verified)
   statusline
   legend
   workspace-resize-handle
```

Keep: `#tab-tl` wrapper, `ws-head`, everything outside `tab-tl`.
Acceptance: page loads, no dead-id JS errors (old `timeline.js` will throw on
missing ids — stub or gate it until Phase 3 lands; see §5.4).

### Phase 2 — CSS (`style.css`)
1. Port the mock `<style>` block, **dropping** page-chrome rules
   (`body`, `.page-head*`, `.badges`, `.mapping*`, `.card*`, `.tag*`, `kbd`,
   `.tabs/.tab*`, `#toast`, `@media`, `*`).
2. Un-scope: the integrated build prefixes everything with `#pvTimeline` —
   in the real file, use the plain selectors (`.tray`, `.grid`, …); they were
   chosen collision-free.
3. Reuse, don't duplicate: `:root` (already identical), `button`,
   `.workspace-resize-handle*`, `[hidden]`.
4. Delete the old rules: `.tl-head`, `.tl-tools`, `.tl-tool`,
   `.timeline-viewport*` (keep `.timeline-viewport-resize` only if anything
   still references it — nothing should), `#trackLabels`, `.track-ruler`,
   old `.legend`/`.sw` (replaced by the new legend rules).
5. Acceptance: static render matches the integrated preview pixel-close
   (compare against `pv-integrated-final.png` in the workspace).

### Phase 3 — JS (`timeline.js` rewrite of view + wiring; `TLM` untouched)
This is the bulk. Port the mock `<script>` section by section, rewiring each
piece from mock state to real state (§5). Concretely:

1. **Tray build + wiring** — static HTML buttons + `renderTray()`-equivalent:
   undo/redo disabled states, razor/pan/snap/magnet toggles, trash + count,
   pills ↔ `S.filter`, remove-selected visibility. Popups (Add menu, `···`
   menu): port the mock's `.pop` menu builder (rename to something app-scoped,
   e.g. `.tl-pop`, to avoid the generic name).
2. **Headers + lanes render** — replace `draw()` + `syncTrackLabels` +
   hit-testing with DOM render (`renderHeaders`/`renderLanes` equivalents
   reading `S.tl` via `TLM`). Delete `rowAt/hitItem/edgeAt`, all `draw*`,
   `canvasGeo`, filmstrip/wave/poster painters (clip bodies become
   CSS: `.frames`/`.wave` divs as in the mock).
3. **Interactions** — Alt+scroll heights (+ dblclick reset), razor clicks +
   blade, pan drag, clip drag/trim (keep existing `moveItems/trimItem` model
   ops; reimplement pointer handling on DOM nodes), ruler seek, section-strip
   clicks, `T` caption placement rule, `M` lane rule, More-menu delete rule.
4. **Zoom/pan model** — keep `S.view{start,span}`; retarget `plotWidth()` from
   the canvas to the lanes width; keep `zoomBy`/fit; add `Ctrl`+wheel zoom.
5. **Tools model** — shrink `TL_TOOLS` to `{select, razor}` + `pan` flag;
   delete `text/zoom/mute` tool code paths (caption/zoom/mute become buttons,
   tray zoom, and lane switches). Keep `V/R/H` keys and `curTool` name.
6. Acceptance: every tray control, header control, shortcut, and drag behaves
   per §1 against **real** timelines (open demo + speech demo + an SRT-backed
   project).

### Phase 4 — Integration (`app.js`, List, persistence)
1. `applyTimelineViewportHeight` + `bindTimelineViewportResize`: retarget from
   `#timelineViewport` to the lanes scroller; keep 80px–85vh clamp,
   `saveWorkspaceLayout`, dblclick→auto (new).
2. `renderList()` / `S.filter`: pills and List chips must stay in sync both
   ways (single source: `S.filter` + `S.sections[].sel`).
3. Undo: tray buttons call `undoTL/redoTL`; lane-height and viewport-height
   changes stay out of history (view tweaks, like zoom).
4. `window resize → draw`: repoint at the DOM render (or drop if render is
   event-driven).
5. Acceptance: List filters follow pills and vice versa; reload restores
   viewport height; no console errors.

### Phase 5 — Cleanup + QA
1. Delete dead code: `TL_TOOLS` leftovers, canvas/hit-test/labels functions,
   `capApplyAll` from the timeline (**move it to the Text panel**, where
   caption style is edited — the mock never covered it), `tlLane`/`tlTrack`
   handlers (superseded by the `+` menu).
2. Run the §6 QA checklist + the node model tests.
3. Acceptance: `grep` finds no references to `tlTools`, `tl-head`,
   `timelineViewportResize`, `trackLabels`, `canvas#timeline`, `curTool`
   values `text/zoom/mute`.

---

## 4. kconcat → VTS fusion map

| kconcat | Adopted in VTS as | Deliberate deviations |
|---------|-------------------|----------------------|
| `timeline-pane.slint`: tabs → tray → lanes | tabs → tray → grid → statusline → legend | statusline/legend/edge handle appended (VTS originals, kept) |
| `tray.slint`: single 40px icon tray, grouped + dividers | §1.2 tray, same grouping | VTS shortcuts kept (`R`, not `B`); no B-roll/voiceover/TTS buttons (live elsewhere in VTS); copy/cut/paste omitted (Edit menu) |
| `track-header.slint`: lock/vis/mute/kind/more | Typed headers, `···` menu w/ greyed Delete | size menu deleted → Alt+scroll (Premiere-style, user decision) |
| disabled-carries-reason buttons | merge + trim-follow greyed with tooltip reasons | — |
| `tabs.slint`: one tab per sequence | Not built — workspace `ws-tabs` already do this | mock's inner strip deleted in integration |
| `dark.slint` palette (lime accent) | Not adopted — VTS keeps `#3fb950/#58a6ff` | visual consistency with the rest of VTS |
| Premiere stacking (top = top layer) | §1.3 stacking + numbering | replaces VTS's old lane order |

---

## 5. Porting notes (mock → repo)

### 5.1 State rewiring

| Mock state | Real state |
|------------|-----------|
| `tracks[]` (V/A lanes) | Derive from `S.tl` via `TLM.vtracksOf/atracksOf` + `trackOf/atrackOf`; lane identity = existing `laneKeyOf()` keys (keeps `S.laneHidden`/`S.laneLocked` working) |
| `clips[]` | `S.tl.clips/auds/caps` (buckets stay; view groups them) |
| `S.playhead/S.pps` | `S.T` + `S.view{start,span}` (keep; retarget width fns) |
| `S.tool/S.pan/S.snap` | keep names; add `S.magnetic` |
| `S.filters` | `S.filter` (existing; extend kind flags if needed) |
| `sections[]` (+`.sel`) | `S.sections` (+ existing selection marking) |
| `t.h` (lane px, null=auto) | new view-only map, e.g. `S.laneH = {}` (never persisted in history; workspace persistence optional) |
| `undoStack/redoStack` | `S.undo/S.redo/S.lastJSON` via `commitTL/undoTL/redoTL` |

### 5.2 The one model change: captions live on V tracks

Today caps sit in caption lanes (`assignLanes`). The redesign has no caption
lanes: every cap is assigned to a V track and rendered as a floating overlay
on it (§1.3). Recommended change, contained in `TLM.normalise` + `placeCap`:

- caps gain a V-track home (e.g. `cap.track`, same indexing as clips);
  legacy `lane` values are migrated on load (all → topmost V by default;
  overlaps are acceptable — overlays are transparent).
- `placeCap` follows the `T` rule: topmost unlocked V, else create one.
- `assignLanes` stays only as a legacy shim (or is removed if unused).
- `MAX_VTRACKS` bounds V creation; `+` menu items enforce the same caps as
  today (`tlTrack`/`tlLane` logic, minus caption lanes).

### 5.3 Behavior rules to preserve exactly

- V bottom-up / A top-down numbering; new V above the stack, new A at bottom.
- `T`: topmost unlocked V → create V at top → toast if all locked.
- `···` → Delete greyed when it's the last lane standing.
- `M`: mute on A lanes, output toggle on V lanes (selected clip's lane, else
  first lane).
- Split: selection, else everything, at playhead (`Ctrl+K`).
- Magnetic on: delete/trim closes the gap (implement via
  `deleteItems`+`moveItems`).
- Pills ↔ List filters: single source of truth, both directions.
- Viewport height 80px–85vh + dblclick auto; lane heights 24–140px + dblclick
  auto; neither is an undo step.

### 5.4 Cutover strategy (avoid a broken intermediate state)

`timeline.js` currently throws if old ids are missing, and Phase 1 removes
them. Options: (a) land Phases 1–3 as one branch merged together (simplest,
recommended — the previews already prove the end state); or (b) gate the old
boot on `if ($("timeline"))` so the app runs headless-timeline until Phase 3
lands. Either way, do not ship a half-migrated timeline.

---

## 6. QA checklist (acceptance = all green)

**Tray:** `+` menu has exactly 2 items, placed correctly · undo/redo enable
correctly · split/razor/trash/pan/snap/magnet/T all act on real media ·
merge + trim-follow greyed with reasons · count badge at ≥2 selected ·
pills toggle List filters both ways · all-silence + remove-selected work ·
fit/−/+ and `Ctrl`+wheel zoom.
**Grid:** V-over-A groups, top=top-layer · mixed V tracks incl. floating
captions · V1-at-foot / A1-at-top numbering · lock/eye/mute/`···` per header ·
Delete greyed on last lane · Alt+scroll 24–140 + dblclick reset (no undo
entries) · sticky ruler seeks · strip bars mark sections · playhead+cap.
**Chrome:** statusline text + timecode · legend · edge handle drags 80–85vh,
dblclick resets, survives reload · Timeline/List tabs switch.
**Regression:** demo + speech-demo + SRT projects open and render · List
renders and edits · Export output byte-comparable for a fixed project ·
node model tests green · zero console errors · §5.3 rules hold · no
references to deleted ids (§Phase 5.3).

---

## 7. Open items (carried, not blocking)

1. **Sections panel (next):** pills + strip move off the tray into a dedicated
   panel; tray keeps no section UI after that.
2. **Merge + trim-follow:** specify against `TLM` ops when implemented; until
   then stay greyed with reasons.
3. **`capApplyAll`:** relocated to the Text panel (§Phase 5.1) — confirm
   placement when touching that panel.
4. **Text tool removal:** caption *editing* stays in the Text panel/List;
   timeline only adds (`T`) and splits/deletes.
