# Text, fonts and shadows

## Run

```sh
python -m pip install -r requirements.txt
python server.py
```

Open http://127.0.0.1:8765. FFmpeg and FFprobe must be on PATH.

## Shadow controls

- **Size (spread)** grows the shadow's glyph contour. It does not move, scale, or make a ring of offset text copies.
- **Blur** controls the softness of that silhouette's edge.
- **Distance / angle** place the single silhouette relative to the text.
- **Opacity / color** control its appearance. The shadow has an independent enable switch, which preserves the other settings when switched off.

The preview uses a single filled glyph silhouette with a same-color outline. The outline expands its contour; the merged layer is blurred and opacity is applied once. Export uses a single ASS shadow event per line with a filled/outlined glyph contour, below the sharp foreground. Shadow styles do not inherit caption-background rectangles. Size/distance/blur are design pixels at 1080p and scale with the frame.

At zero blur and a large distance, a hard shadow naturally resembles one offset silhouette of the text. That is different from multiple ghost copies appearing when **Size** increases. To inspect spread, set Distance and Blur to zero, then move Size: the contour should expand continuously around the same center.

Browser/CSS and FFmpeg/libass rasterizers and blur kernels differ; preview/export are not guaranteed pixel-identical. This implementation removes the ring-of-copies approximation rather than claiming exact emulation of a particular editing application's shadow engine.

## Fonts

- **Import fonts:** import `.ttf` / `.otf` files up to 20 MB each. The app reads the family/style names from the font metadata. Imports are deduplicated, and the last imported family is applied to the current caption or all captions if Apply to all is enabled.
- **Refresh installed:** discover TTF/OTF fonts in common system/user directories on the machine running Python. TTC collections, WOFF/WOFF2, bitmap fonts, and OS-private formats are not included.
- **Device fonts…:** supporting Chrome/Edge browsers on localhost or HTTPS can request permission to enumerate fonts on the browser's machine. Selecting a discovered family copies its faces into the app so exports can use it. If unsupported or denied, use manual import instead.
- Imports persist in `work/fonts`. This installs fonts **into the app**, not into the operating system; no administrator privileges are required.
- Fonts are delivered to the browser, and selected installed faces plus imported files are made available to FFmpeg/libass during styled burn-in.
- Use fonts you have permission to use/embed. Device-font import sends font bytes to the server; only use a server you trust.

Text controls inherit missing older style defaults, synchronize while caption preview is disabled, and preserve global font/color/appearance settings in ASS export. Plain SRT export does not carry visual styling.

## Removed feature

This revision uses one main video track and caption lanes only. The uploaded secondary-video feature, panel, extra picture track, media endpoints and compositor have been removed. Font tools and the earlier external-editor cleanup are retained.

Extract the corrected ZIP into a new directory, or apply the revision patch to the previous delivered version. Merging ZIP files over an old directory cannot remove obsolete files; the patch handles deletion explicitly. Existing personal uploads are not deleted by the patch.

## Tests

```sh
python -m pip install -r requirements-dev.txt
python -m pytest -q
node --test tests/js/*.test.js
```

Browser tests need Playwright Chromium and its system libraries. Shadow regression checks cover contour continuity, stable center, independent offset, non-stacked opacity, blur, font import, style history and browser reload. Project editing state is still in memory: it survives browser refresh while the server is running, not server restart or opening another main video. This remains a trusted local single-user app, not an authenticated public service.
