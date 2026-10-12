# B-roll and text tools

## Update and run

```sh
python -m pip install -r requirements.txt
python server.py
```

Open http://127.0.0.1:8765. FFmpeg and FFprobe must be on PATH. Use a current Chrome or Edge for the optional device-font permission API. Normal font import and server-installed font discovery do not require that API.

## Uploaded B-roll

1. Open the main video. Position the playhead where the overlay should begin.
2. In **B-roll · B1**, choose **Upload B-roll**. Multiple files are supported, up to 2 GB each.
3. The upload fills the first available B1 space at/after the playhead, capped by the source and main timeline duration. Files with the same name receive unique storage IDs.
4. Click a purple B1 clip or its card. Drag its middle to move it, or either edge to trim it. Alternatively edit **Timeline start**, **Source in**, **Duration**, and **Frame fit**, then click **Apply trim**.
5. **Fill / crop** fills the main frame; **Fit / black bars** preserves the full overlay image. Both center the footage.
6. **Remove clip** removes the timeline item. Global Undo/Redo works with B-roll edits. Removing an item retains its uploaded media so Undo can recover it.
7. Export normally. The exporter automatically re-encodes when B-roll is present, even if stream copy is selected. Captions are burned after compositing, above B-roll. The main audio is preserved; overlay audio is deliberately not mixed.

### Timeline behavior and limits

- One non-overlapping, full-frame B1 track; at most 100 clips. No picture-in-picture positioning, transitions, stock search, or automatic B-roll generation.
- B-roll uses edited timeline time, not the original source time. V1 ripple deletion and video insert-paste update B-roll timing/source offsets. Shortening the main picture trims/removes overlays beyond the new end. Undo restores them.
- Caption-only ripple edits do not move B-roll. Ordinary V1 moves/lifts leave B-roll at its timeline position.
- Unsupported/uncertain browser formats get an FFmpeg preview proxy; the original upload is used for export. If proxy creation fails, try an H.264 MP4. A browser that rejects a supposedly supported codec may still require converting the upload manually.
- Edits and asset references survive a browser refresh while this local server is running. Like the original editor, project state is in memory: opening another main video or restarting the server resets the timeline. Upload files remain in `work/broll`; remove unused ones manually only after you no longer need their project/history/export.
- Main-video duration determines output duration. B-roll cannot extend the export past V1.

## Fonts

- **Import fonts:** select one or more `.ttf` / `.otf` files, up to 20 MB each. The real family/style names come from the font metadata. Importing is deduplicated and the last imported family is applied to the current caption (or all captions when Apply to all is enabled).
- **Refresh installed:** scan common Windows, macOS, and Linux system/user font directories for TTF/OTF files. This lists fonts on the machine running Python. Font collections (`.ttc`), WOFF/WOFF2 files, bitmap fonts and OS-private formats are not included.
- **Device fonts…:** with permission, Chrome/Edge on localhost or HTTPS can enumerate fonts on the browser's machine. Selecting a discovered family copies its font faces into the app for export. If unsupported, denied or blocked by an embedded preview, import files instead.
- Imports go into `work/fonts` and persist across server restarts. This is **app installation**, not OS-wide font installation; no administrator rights or registry modifications are needed.
- The browser loads font files from this local server. FFmpeg/libass receives the app font directory and copies of the selected installed faces. This avoids a browser-only font that disappears when burned into the video.
- Use fonts you have permission to use/embed. Only send device fonts to a server you trust. With a remote server, importing uploads font bytes to that server.

## Text and shadow fixes

- Partial older cue styles inherit missing defaults instead of producing undefined CSS values.
- Text controls stay synchronized even when caption burn preview is disabled. Selected font names remain visible while font discovery loads.
- Numeric style controls clamp to their declared ranges; select changes are committed to history/save.
- Reset style re-enables the default shadow. Shadow off/on preserves its opacity and geometry.
- Shadow distance, spread and blur use design pixels at 1080p in both preview and export. Export offsets are calculated after resolution scaling. Multiple spread passes distribute opacity instead of multiplying it nine times, and shadow passes render behind sharp foreground text.
- Font, color, and other global style settings are passed through to ASS burn-in, not discarded in favor of position-only fields. Plain SRT export has no styling by design.
- Caption text no longer lingers on the preview when the playhead is between cues.
- Browser/CSS and libass still use different font rasterizers; spread uses a multi-pass approximation. Pixel-identical typography/shadow blur, variable-font axes, exact font-metric wrapping, and every advanced stroke/background effect are not guaranteed.

## Development checks

```sh
python -m pip install -r requirements-dev.txt
python -m pytest -q
node --test tests/js/*.test.js
```

Browser tests additionally require `pip install playwright`, `python -m playwright install chromium`, and the browser's system libraries. The regression coverage includes real FFmpeg B-roll exports, overlay end boundaries, retained audio, caption-over-overlay ordering, font validation/import/persistence, resolution-scaled shadows, history, and browser reload.

This remains a trusted, local, single-user application. Do not expose its filesystem/video APIs as an unauthenticated public service.
