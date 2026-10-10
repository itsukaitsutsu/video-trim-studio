Video Trim Studio — preview zoom and viewing-area resize update

INSTALL
1. Stop Video Trim Studio.
2. Back up same-named files in your project folder.
3. Extract this ZIP into the project root (the folder containing server.py),
   preserve the folder paths, and allow overwrite.
4. Restart the app and refresh the browser; CSS and JavaScript URLs are
   cache-busted.

VIDEO PREVIEW ZOOM AND PAN
Use the “−” and “+” controls below the video or Ctrl+wheel over the preview to
zoom from 50% to 400%. Ctrl+wheel zooms around the pointer position, matching
the Timeline's cursor-anchored zoom. When the hand cursor appears, drag to pan;
the cursor changes to a closed hand while dragging. Press “fit” to return to
the full-frame zoom. This is display-only and does not change the source or
exported video. The caption overlay stays aligned with the image.

The centered inner grip below the Video viewing area adjusts its visible height
separately from the Video panel. It changes the viewport, not the preview-stage
scale. The normal outer Video panel bottom handle is retained and still resizes
the whole panel. The viewport height is saved with the workspace layout; Reset
layout restores its default.

This package retains the current Timeline features: Apply to all captions
beside + caption, Alt+wheel track scrolling, and shared main/side workspace
column resizing. No source-video/media files are included or changed.
