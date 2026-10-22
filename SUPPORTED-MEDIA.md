# Supported files in Video Trim Studio

Every list here is taken from the code (`vts/ffprobe.py`, `vts/medialib.py`,
`vts/preview.py`), so it matches what the app will actually accept.

## 1. Project source (Project panel -> Open / drag a file in)

The source is the video you are trimming. It is opened one at a time and gives
the project its frame size, frame rate and format profile.

`.3gp`, `.avi`, `.flv`, `.m2ts`, `.m4v`, `.mkv`, `.mov`, `.mp4`, `.mpeg`, `.mpg`, `.mts`, `.ts`, `.vob`, `.webm`, `.wmv`

- **Plays directly in the browser** (no conversion): `mp4`, `m4v`, `mov`,
  `webm` carrying H.264, VP8, VP9 or AV1 video with AAC, MP3, Opus, Vorbis or
  FLAC audio.
- **Everything else** (`mkv`, `avi`, `ts`, `mts`, `m2ts`, `mpg`, `mpeg`, `flv`,
  `wmv`, `3gp`, `vob`, or a codec the browser cannot decode) gets a one-time
  **H.264 preview copy** so the program monitor can play it. Trimming and
  export always read the **original** file, so nothing is lost.
- A **still image cannot be the project source**. Open a video first, then
  import the picture into the Media bin.

## 2. Media bin (Project panel -> Import... / Upload)

Anything you layer on top of the source: extra video, music, voice-over, logos,
screenshots.

**Video** - same list as the source above. Bin video is drawn as an overlay on
its own track, and any format that the browser cannot decode also gets a
preview copy (never the export).

**Images (stills)**

- Served to the browser as they are: `.avif`, `.bmp`, `.gif`, `.jpe`, `.jpeg`, `.jpg`, `.png`, `.webp`
- Converted once to a PNG copy for the preview (the export still reads your
  original file): `.jp2`, `.pgm`, `.pnm`, `.ppm`, `.svg`, `.tga`, `.tif`, `.tiff`
- A still gets a default **5 s** on the timeline; change it with the
  "still length" box next to Import. GIF is imported as its first frame for
  export, while the bin tile shows the animation.
- A still is never transcoded into a video proxy and never touches the source.

**Audio**

`.aac`, `.ac3`, `.aif`, `.aiff`, `.amr`, `.caf`, `.dts`, `.flac`, `.m4a`, `.mka`, `.mp3`, `.oga`, `.ogg`, `.opus`, `.wav`, `.wma`

- Played as-is (no proxy): `mp3`, `wav`, `flac`, `m4a`, `aac`, `ogg`, `oga`,
  `opus`.
- Everything else (`wma`, `ac3`, `dts`, `amr`, `caf`, `mka`) is converted once
  for preview; the export reads the original.
- Audio dropped on a timeline becomes its own item on an audio lane and mixes
  with the other lanes.

**Limits:** up to **64** assets in the bin, **2 GB** per uploaded file.
Files imported by path are referenced in place, never copied.

## 3. Captions

- `.srt` and `.vtt` - import, edit in the caption editor, export.
- `.ass` is written internally when you burn captions (it is the file FFmpeg
  renders), but it is not an import format.

## 4. Fonts (Inspector -> Typography -> Import fonts)

- `.ttf` and `.otf`, up to **20 MB** each. Installed system fonts are listed
  too, plus the browser's own "Device fonts" picker.

## 5. Export containers

The export keeps the source container, so the output extension is the
extension of your source file (from the video list in section 1). One file may
also gain a sidecar `.srt` when captions are exported next to the video.

## Quick sheet

| What | Extensions | Notes |
|------|------------|-------|
| Source video / bin video | mp4, mov, m4v, mkv, webm, avi, ts, mts, m2ts, mpg, mpeg, flv, wmv, 3gp, vob | non-web formats get a preview copy |
| Images | png, jpg, jpeg, jpe, gif, webp, bmp, avif (+ tif, tiff, ppm, pgm, pnm, tga, jp2, svg via a PNG copy) | stills, 5 s default |
| Audio | mp3, wav, flac, aac, m4a, ogg, oga, opus, aiff, aif, wma, mka, ac3, dts, amr, caf | mp3/wav/flac/m4a/aac/ogg/opus play directly |
| Captions | srt, vtt | ass is written for burning only |
| Fonts | ttf, otf | max 20 MB each |
| Export | same as the source | + optional .srt sidecar |
