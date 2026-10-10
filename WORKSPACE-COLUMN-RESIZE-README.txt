Video Trim Studio workspace column resize update

INSTALL
1. Stop Video Trim Studio.
2. Back up same-named files in your project folder.
3. Extract this ZIP into the project root (the folder containing server.py),
   preserve the folder paths, and allow overwrite.
4. Restart the app and refresh the browser; CSS and JavaScript URLs are
   cache-busted.

RESIZE BEHAVIOR
On wide layouts, dragging the right edge of a main-column panel or the left
edge of a side-column panel moves the shared divider. The main and side columns
resize together: shrinking the main side shifts the right-side panels left and
lets them grow wider. Cards in each column stay stacked/aligned without overlap.
This shared column width is saved in the workspace layout. Outer panel edges
still resize individual panels. On narrow layouts, columns stack and edge
handles resize individual panels.

Timeline keeps its right/top/bottom panel handles and its separate centered
bottom grip for changing the visible timeline workspace height. The Apply to
all captions option remains beside + caption in Timeline; Alt+wheel still
scrolls overflowing V/T tracks and Ctrl+wheel retains its existing behavior.
No video/media files are included or changed.
