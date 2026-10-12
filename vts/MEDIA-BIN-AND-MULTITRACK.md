# Media bin, B-roll and audio lanes

This revision turns the single-track editor into a small multi-track one:

- a **Media bin** for importing video, audio and stills,
- **V1..Vn** picture tracks that **composite** instead of restacking,
- **A1..An** audio lanes with linked-then-unlinkable sound,
- a **program monitor** that shows every visible track at once,
- an **export** that builds the same composite with FFmpeg.

It replaces the old single `B1` overlay track. The font and shadow work is
unchanged and documented in **TEXT-AND-FONTS.md**.

## Update and run

```sh
python -m pip install -r requirements.txt
python server.py
```

Open http://127.0.0.1:8765. FFmpeg and FFprobe must be on PATH.

## The media bin

| Action | What it does |
| --- | --- |
| **Import…** | Picks files on this computer. They are **referenced in place** — nothing is copied — so importing a 40 GB master costs nothing. Because it is only a reference, a file that is later moved or renamed can no longer be read. |
| **Upload** | Copies the file into `work/bin` and references that copy. Use it for files arriving over the network that you want kept with the project. |
| **Remove** | Takes the tile out of the bin. The file on disk is never touched. |
| double-click a tile | Adds it at the playhead: video/stills on the lowest free **V** track, sound on **A1**. |
| drag a tile | Drop it on the exact track and time you want. |

- Each tile shows a poster frame, name, kind (**video** / **audio** / **image**)
  and duration; audio gets a waveform instead of a poster.
- The main video you opened the project with is always the first tile and cannot
  be removed. The bin holds 64 assets including that one.
- Files a browser cannot decode (MKV, HEVC, ProRes, WAV, …) get their own
  H.264/AAC proxy so they preview and scrub. **Export always reads the
  full-quality original**, never the proxy.

## Picture tracks — how B-roll works now

1. Open the main video, then import the B-roll clip.
2. Drag it onto **V2** above the shot it should sit on. It **overlays** V1 —
   the clip below is not pushed aside and nothing is overwritten.
3. Use the **Clip** panel to make it picture-in-picture:
   - **Scale %**, **X % / Y %** — size and position (percent of the frame).
   - **Opacity %** — let the shot below show through.
   - **Crop %** — trim the clip's own edges.
   - **Fit** — `fill` stretches, `contain` letterboxes inside the box (the
     default for a source whose shape does not match the project), `cover`
     crops to fill it.
   - **corner PiP** is the ready-made small bottom-right preset;
     **fill frame** snaps the clip back to full frame.
4. Add as many tracks as you need with **+ track** in the timeline toolbar.
   Every transform is keyframeable with **◆ Add at playhead**.

The **program monitor** composites all of this live: each visible track gets its
own `<video>` layer, scaled, positioned, cropped and faded exactly as the export
will be. Overlapping tracks are no longer flattened to a single picture.

## Audio lanes

- A clip's sound starts **linked** to its picture — V1→A1, V2→A2. Moving the
  clip moves its sound. The linked sound is drawn as a thin strip under the
  picture clip, and muted with the clip.
- **Unlink audio** in the Clip panel turns that sound into a free item on the
  matching **A** lane, which you can then slide, trim or move to another lane
  while the picture stays put. **Relink audio** puts it back.
- **A3** and above are for music, voice-over and narration: drop an audio-only
  file from the bin onto any **A** lane.
- Lanes **mix**. Overlapping sounds play together rather than stacking onto a
  new lane, which is what you want for music under dialogue.
- Every clip and every audio item has its own **Volume %**, **Mute**,
  **Fade in** and **Fade out**.

## Still images

Dropping a PNG or JPG adds a 5-second clip. Set **still … s** in the Media card
first if you want a different length, then trim it like any other clip.

## Export

Export needs no special setting: whenever more than one track is visible at
some point, or anything is transformed, the exporter re-encodes and builds the
composite. Stream copy is still used when a project is a plain set of cuts.

- The picture is a canvas of the project's frame size with each track laid over
  it, bottom track first, honouring scale, position, opacity, crop and fades.
- Every audio lane and every clip's sound is delayed to its timeline position
  and mixed. Muted items contribute silence rather than being dropped, so the
  mix stays aligned.
- Output length is the end of the last item on any track, so B-roll can extend
  the export past the end of V1.
- Captions are still burned **after** compositing, above all picture tracks.

## Limits

- 64 bin assets, 64 video tracks, 64 audio lanes.
- Imported media is a reference: moving or renaming a file breaks its link.
- The program monitor is a **preview**. It uses the browser's decoder, so colour
  handling can differ very slightly from the export, and a very slow machine may
  drop frames. The exported file is the reference.
- No transitions, no titles beyond captions, and no effects beyond scale,
  position, opacity, crop, fit and fades.
- Project editing state lives in the running server: it survives a browser
  refresh, but not a server restart or opening a different main video. Export
  (or save) finished work before stopping the app.

## Development checks

```sh
python -m pip install -r requirements-dev.txt
python -m pytest -q
node --test tests/js/*.test.js
```

Browser tests additionally require `pip install playwright`,
`python -m playwright install chromium`, and the browser's system libraries.

The regression coverage includes real FFmpeg exports of multi-track composites
(pixel-sampled at the centre and the corner to prove the overlay is a
picture-in-picture and not a wipe), audio-lane mixing measured with a Goertzel
tone detector, unlinked-audio exports, still-image defaults, bin import /
upload / dedupe / removal, the program monitor's layer count in a real browser,
and the unlink → reload round trip.

This remains a trusted, local, single-user application. Do not expose its
filesystem/video APIs as an unauthenticated public service.
