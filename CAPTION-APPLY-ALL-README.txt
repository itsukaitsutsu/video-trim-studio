Apply-to-all caption layout update

INSTALL
1. Stop Video Trim Studio.
2. Back up same-named files in your project folder.
3. Extract this ZIP into the project root (the folder containing server.py),
   preserve the folder paths, and allow overwrite.
4. Restart the app and refresh the browser; CSS and JavaScript URLs were
   cache-busted.

The “Apply to all captions” checkbox is now directly LEFT of the “+ caption”
button in the Timeline toolbar. The explanatory hint text has been removed.
The checkbox is checked by default. When checked, the next layout edit (move,
box resize, size, alignment, or reset) copies the active caption's full layout
to every timeline caption across all tracks (T1, T2, etc.) and sets the default
for new captions. Uncheck it to edit only the caption at the playhead.

The included app.js, index.html and style.css retain the earlier timeline
viewport and translation fixes. No video/media files are included or changed.
