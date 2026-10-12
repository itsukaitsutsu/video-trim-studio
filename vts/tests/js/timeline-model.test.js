// Run with: node --test tests/js/
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const TLM = require("../../static/timeline-model.js");

const clip = (id, start, end, inPoint) => ({ id, start, end, in: inPoint, kind: null, text: "" });
const cap = (id, lane, start, end, text) => ({ id, lane, start, end, text, style: null });
const ids = (list) => list.map((x) => x.id);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-3, `${msg || ""} expected ${b}, got ${a}`);

test("a fresh source is one clip covering the whole video", () => {
  const clips = TLM.clipsFromSource(18);
  assert.equal(clips.length, 1);
  assert.deepEqual([clips[0].start, clips[0].end, clips[0].in], [0, 18, 0]);
});

test("sections become clips, and captions map through them", () => {
  const clips = TLM.clipsFromSections([
    { start: 0, end: 4, kind: "other", text: "" },
    { start: 4, end: 6, kind: "silence", text: "" },
    { start: 6, end: 10, kind: "caption", text: "hi" },
  ], 10);
  assert.equal(clips.length, 3);
  // A cue from 3 to 7 (source time) crosses the silence, so it is split in pieces.
  const { caps, lanes } = TLM.capsFromCues(clips, [{ start: 3, end: 7, text: "x" }]);
  assert.deepEqual(caps.map((c) => [c.start, c.end]), [[3, 4], [4, 6], [6, 7]]);
  assert.equal(lanes, 1);
});

test("cues in removed time are dropped and the rest follows the cut", () => {
  // Source 0-4 is kept as 0-4; source 4-6 is removed; source 6-10 plays at 4-8.
  const clips = [clip("a", 0, 4, 0), clip("b", 4, 8, 6)];
  const { caps } = TLM.capsFromCues(clips, [
    { start: 1, end: 2, text: "keep" },
    { start: 4.5, end: 5.5, text: "gone" },
    { start: 7, end: 8, text: "late" },
  ]);
  assert.deepEqual(caps.map((c) => [c.text, c.start, c.end]), [
    ["keep", 1, 2], ["late", 5, 6],
  ]);
});

test("razor splits clips and captions at the playhead", () => {
  const tl = { clips: [clip("a", 0, 10, 0)], caps: [cap("t1", 0, 2, 8, "x")], lanes: 1 };
  const out = TLM.splitSelection(tl, 5, null);
  assert.equal(out.clips.length, 2);
  assert.equal(out.clips[0].id, "a");
  near(out.clips[1].start, 5);
  near(out.clips[1].in, 5, "right part keeps its source position");
  assert.equal(out.caps.length, 2);
  assert.deepEqual(TLM.validate(out), []);
});

test("razor ignores cuts that would leave a sliver", () => {
  const tl = { clips: [clip("a", 0, 10, 0)], caps: [], lanes: 1 };
  assert.equal(TLM.splitSelection(tl, 0.01, null).clips.length, 1);
});

test("lift delete leaves a gap; ripple delete closes it and moves captions", () => {
  const tl = {
    clips: [clip("a", 0, 4, 0), clip("b", 4, 8, 4), clip("c", 8, 12, 8)],
    caps: [cap("t1", 0, 9, 10, "after")],
    lanes: 1,
  };
  const lift = TLM.deleteItems(tl, ["b"], false);
  assert.deepEqual(ids(lift.clips), ["a", "c"]);
  assert.equal(lift.clips[1].start, 8, "lift leaves the gap");
  const ripple = TLM.deleteItems(tl, ["b"], true);
  assert.deepEqual(ids(ripple.clips), ["a", "c"]);
  near(ripple.clips[1].start, 4, "c moves up");
  near(ripple.clips[1].in, 8, "c keeps its source time");
  near(ripple.caps[0].start, 5, "the caption follows the picture");
  assert.deepEqual(TLM.validate(ripple), []);
});

test("ripple through the middle of a clip keeps the right source times", () => {
  // Clip h (3-5) is removed with ripple; b (5-10 in source 5-10) moves up to 3-8.
  const tl = { clips: [clip("a", 0, 3, 0), clip("h", 3, 5, 20), clip("b", 5, 10, 5)], caps: [], lanes: 1 };
  const r = TLM.deleteItems(tl, ["h"], true);
  assert.deepEqual(r.clips.map((c) => [c.start, c.end, c.in]), [[0, 3, 0], [3, 8, 5]]);
  assert.deepEqual(TLM.validate(r), []);
});

test("moving a clip onto a busy lane drops it onto a free lane", () => {
  const tl = { clips: [clip("a", 0, 4, 0), clip("b", 4, 8, 10)], caps: [], lanes: 1 };
  const out = TLM.moveItems(tl, ["b"], -2, 0);
  assert.deepEqual(out.clips.map((c) => [c.id, c.start, c.end]), [["a", 0, 4], ["b", 2, 6]]);
  const moved = out.clips.find((c) => c.id === "b");
  assert.equal(moved.track, 1, "the moved clip restacks instead of overwriting");
  near(moved.in, 10, "the moved clip keeps its in point");
  assert.deepEqual(TLM.validate(out), []);
});

test("moving a caption onto a busy lane drops it onto a free lane", () => {
  const tl = { clips: [], caps: [cap("t1", 0, 0, 2, "a"), cap("t2", 0, 3, 5, "b")], lanes: 1 };
  const out = TLM.moveItems(tl, ["t2"], -2, 0);     // now 1-3, overlaps t1 (0-2)
  assert.equal(out.caps.find((c) => c.id === "t2").lane, 1);
  assert.equal(out.lanes, 2);
  assert.deepEqual(TLM.validate(out), []);
});

test("trimming stops at the neighbour and at the source limits", () => {
  const tl = { clips: [clip("a", 0, 4, 0), clip("b", 4, 8, 4)], caps: [], lanes: 1 };
  const grown = TLM.trimItem(tl, "a", "r", 9, 18);                 // would run into b
  assert.equal(grown.clips.find((c) => c.id === "a").end, 4);
  const shorter = TLM.trimItem(tl, "a", "r", 2, 18);
  assert.equal(shorter.clips.find((c) => c.id === "a").end, 2);
  const left = TLM.trimItem(tl, "b", "l", 5, 18);
  const b = left.clips.find((c) => c.id === "b");
  assert.equal(b.start, 5);
  near(b.in, 5, "a left trim moves the in point with the edge");
  const before = TLM.trimItem(tl, "a", "l", -3, 18);               // cannot go before 0
  assert.equal(before.clips.find((c) => c.id === "a").start, 0);
  const atEnd = TLM.trimItem({ clips: [clip("s", 0, 4, 14)], caps: [], lanes: 1 }, "s", "r", 10, 18);
  assert.equal(atEnd.clips[0].end, 4, "a right trim cannot pass the source end (18 s)");
});

test("paste restacks onto a free lane; paste insert pushes later items", () => {
  const tl = { clips: [clip("a", 0, 6, 0), clip("b", 6, 12, 6)], caps: [cap("t1", 0, 7, 8, "x")], lanes: 1 };
  const clipboard = TLM.copyItems(tl, ["a"]);
  const over = TLM.pasteItems(tl, clipboard, 4, false);
  const sorted = over.tl.clips.slice().sort((x, y) => x.start - y.start);
  assert.deepEqual(sorted.map((c) => [c.start, c.end]), [[0, 6], [4, 10], [6, 12]]);
  const pasted = over.tl.clips.find((c) => c.id !== "a" && c.id !== "b");
  assert.equal(pasted.track, 1, "the pasted copy stacks instead of overwriting");
  assert.equal(over.ids.length, 1);
  assert.deepEqual(TLM.validate(over.tl), []);

  const inserted = TLM.pasteItems(tl, clipboard, 4, true);
  const ins = inserted.tl.clips.slice().sort((x, y) => x.start - y.start);
  assert.deepEqual(ins.map((c) => [c.start, c.end]), [[0, 4], [4, 10], [10, 12], [12, 18]]);
  near(inserted.tl.caps[0].start, 7 + 6, "insert shifts captions too");
  assert.deepEqual(TLM.validate(inserted.tl), []);
});

test("cut then paste keeps the source frames of the moved material", () => {
  const tl = { clips: [clip("a", 0, 10, 0)], caps: [], lanes: 1 };
  const split = TLM.splitSelection(tl, 4, null);
  const right = split.clips.find((c) => c.start === 4);
  const cut = TLM.deleteItems(split, [right.id], false);             // lift: gap 4-10
  const back = TLM.pasteItems(cut, TLM.copyItems(split, [right.id]), 0, false).tl;
  const pasted = back.clips.find((c) => c.start === 0 && c.id !== "a");
  near(pasted.in, 4, "the pasted clip plays source 4 s first");
  assert.equal(pasted.track, 1, "it stacks above the clip underneath");
  assert.deepEqual(TLM.validate(back), []);
});

test("duplicate (alt-drag) creates a copy at the new position", () => {
  const tl = { clips: [clip("a", 0, 4, 0)], caps: [], lanes: 1 };
  const out = TLM.duplicateItems(tl, ["a"], 5);
  assert.equal(out.tl.clips.length, 2);
  assert.equal(out.tl.clips.find((c) => c.id !== "a").start, 5);
  assert.equal(out.ids.length, 1);
  assert.deepEqual(TLM.validate(out.tl), []);
});

test("add caption puts it on the lowest free lane", () => {
  let tl = { clips: [], caps: [cap("t1", 0, 0, 2, "a")], lanes: 1 };
  tl = TLM.addCaption(tl, 1, "new", null, 0).tl;
  assert.equal(tl.caps.find((c) => c.text === "new").lane, 1);
  assert.equal(tl.lanes, 2);
  assert.deepEqual(TLM.validate(tl), []);
});

test("operations never change their input", () => {
  const tl = { clips: [clip("a", 0, 4, 0), clip("b", 4, 8, 4)], caps: [], lanes: 1 };
  const before = JSON.stringify(tl);
  TLM.deleteItems(tl, ["a"], true);
  TLM.moveItems(tl, ["b"], -2, 0);
  TLM.splitSelection(tl, 2, null);
  assert.equal(JSON.stringify(tl), before);
});

test("renaming a caption section also renames its caption on the timeline", () => {
  const tl = {
    clips: [{ id: "a", start: 0, end: 4, in: 0, kind: "caption", text: "old words" }],
    caps: [cap("t1", 0, 1, 3, "old words"), cap("t2", 0, 5, 6, "old words")],
    lanes: 1,
  };
  const out = TLM.setClipText(tl, "a", "new words");
  assert.equal(out.clips[0].text, "new words");
  assert.equal(out.caps.find((c) => c.id === "t1").text, "new words");
  assert.equal(out.caps.find((c) => c.id === "t2").text, "old words", "captions outside the section keep their text");
  assert.equal(tl.clips[0].text, "old words", "the input is not changed");
});

test("renaming a timeline caption updates its matching section label", () => {
  const tl = {
    clips: [clip("a", 0, 4, 0), clip("b", 4, 6, 4)].map((c) => ({
      ...c, kind: "caption", text: "old words",
    })),
    caps: [cap("t1", 0, 1, 3, "old words"), cap("t2", 1, 5, 5.5, "old words")],
    lanes: 2,
  };
  const out = TLM.setCaptionText(tl, "t1", "new words");
  assert.equal(out.caps.find((c) => c.id === "t1").text, "new words");
  assert.equal(out.clips.find((c) => c.id === "a").text, "new words");
  assert.equal(out.clips.find((c) => c.id === "b").text, "old words", "non-overlapping sections keep their text");
  assert.equal(tl.caps.find((c) => c.id === "t1").text, "old words", "the input is not changed");
});

test("clips on different video tracks may overlap; same track may not", () => {
  const tl = {
    clips: [
      { ...clip("a", 0, 5, 0), track: 0 },
      { ...clip("b", 2, 4, 10), track: 1 },
    ],
    caps: [], lanes: 1, vtracks: 2,
  };
  assert.deepEqual(TLM.validate(tl), []);
  assert.equal(TLM.vtracksOf(tl), 2);
  // topmost clip wins the playhead
  assert.equal(TLM.clipAt(tl, 3).id, "b");
  assert.deepEqual(ids(TLM.clipStackAt(tl, 3)), ["a", "b"]);
  assert.equal(TLM.clipAt(tl, 0.5).id, "a");
  assert.equal(TLM.clipAt(tl, 9), null);
});

test("same-track overlap is still reported", () => {
  const tl = {
    clips: [clip("a", 0, 5, 0), clip("b", 3, 6, 3)],
    caps: [], lanes: 1, vtracks: 1,
  };
  assert.equal(TLM.validate(tl).length, 1);
});

test("moving a clip up a track leaves the base track untouched", () => {
  const tl = {
    clips: [
      { ...clip("a", 0, 5, 0), track: 0 },
      { ...clip("b", 1, 3, 1), track: 0 },
    ],
    caps: [], lanes: 1, vtracks: 1,
  };
  const next = TLM.moveItems(tl, ["b"], 0, 0, 1);
  const b = next.clips.find((c) => c.id === "b");
  assert.equal(b.track, 1);
  // the V1 clip underneath survives (carve is per-track)
  assert.ok(next.clips.some((c) => c.id === "a" && c.start === 0 && c.end === 5));
  assert.equal(next.vtracks, 2);
});

test("paste restacks onto a free lane instead of overwriting", () => {
  const tl = {
    clips: [{ ...clip("a", 0, 5, 0), track: 1 }],
    caps: [], lanes: 1, vtracks: 2,
  };
  const cb = TLM.copyItems(tl, ["a"]);
  const { tl: next } = TLM.pasteItems(tl, cb, 1, false);
  // the pasted copy wants V2 but V2 is taken there, so it drops to V1
  assert.equal(next.clips.length, 2);
  assert.deepEqual(
    next.clips.map((c) => c.track).sort(),
    [0, 1]
  );
  assert.equal(TLM.validate(next).length, 0);
});

test("placeClip keeps the preferred lane when free, else lowest free", () => {
  const a = { ...clip("a", 0, 5, 0), track: 0 };
  const free = TLM.placeClip([a], { ...clip("b", 6, 8, 6), track: 0 });
  assert.equal(free.track, 0);
  const clash = TLM.placeClip([a], { ...clip("b", 2, 4, 2), track: 0 });
  assert.equal(clash.track, 1);
  const clash2 = TLM.placeClip(
    [a, { ...clip("b", 2, 4, 2), track: 1 }],
    { ...clip("c", 3, 6, 3), track: 1 }
  );
  assert.equal(clash2.track, 2);
});

test("flattenClips resolves the stack, topmost wins", () => {
  const tl = {
    clips: [
      { ...clip("a", 0, 6, 0), track: 0, fx: TLM.defaultFx(), kf: [] },
      {
        ...clip("b", 2, 4, 10), track: 1,
        fx: { ...TLM.defaultFx(), volume: 50 },
        kf: [
          { t: 0, x: 0, y: 0, scale: 20, opacity: 100 },
          { t: 2, x: 0, y: 0, scale: 40, opacity: 100 },
        ],
      },
    ],
    caps: [], lanes: 1, vtracks: 2,
  };
  const flat = TLM.flattenClips(tl.clips);
  assert.deepEqual(
    flat.map((p) => [p.from, p.start, p.end]),
    [["a", 0, 2], ["b", 2, 4], ["a", 4, 6]]
  );
  assert.equal(flat[1].in, 10);
  assert.equal(flat[2].in, 4, "source offset follows the timeline cut");
  assert.equal(flat[1].fx.volume, 50);
  assert.deepEqual(flat[1].kf.map((k) => k.t), [0, 2]);
  assert.equal(TLM.clipAt(tl, 3).id, "b", "preview agrees with the flatten");
});

test("splitting a clip splits its keyframes; trims drop out-of-range ones", () => {
  const kf = [
    { t: 0.5, x: -50, y: 0, scale: 50, opacity: 100 },
    { t: 3.5, x: 50, y: 0, scale: 100, opacity: 100 },
  ];
  const tl = {
    clips: [{ ...clip("a", 0, 4, 0), track: 0, fx: TLM.defaultFx(), kf }],
    caps: [], lanes: 1, vtracks: 1,
  };
  const split = TLM.splitSelection(tl, 2, ["a"]);
  assert.equal(split.clips.length, 2);
  const left = split.clips.find((c) => c.start === 0);
  const right = split.clips.find((c) => c.start === 2);
  assert.deepEqual(left.kf.map((k) => k.t), [0.5]);
  assert.deepEqual(right.kf.map((k) => k.t), [1.5]);
  // fx objects are not shared between the halves
  left.fx.scale = 10;
  assert.equal(right.fx.scale, 100);
  const trimmed = TLM.trimItem(split, right.id, "r", 3, 20);
  const rc = trimmed.clips.find((c) => c.id === right.id);
  assert.equal(rc.end, 3);
  assert.deepEqual(rc.kf.map((k) => k.t), []);
});

test("evalFxAt interpolates between keyframes and holds the ends", () => {
  const c = {
    ...clip("a", 10, 14, 0), track: 0, fx: { ...TLM.defaultFx(), opacity: 80 },
    kf: [
      { t: 0, x: -100, y: 0, scale: 50, opacity: 0 },
      { t: 4, x: 100, y: 0, scale: 100, opacity: 100 },
    ],
  };
  const mid = TLM.evalFxAt(c, 12);
  near(mid.x, 0, "x at midpoint");
  near(mid.scale, 75, "scale at midpoint");
  near(mid.opacity, 50, "opacity at midpoint");
  assert.equal(TLM.evalFxAt(c, 9).x, -100);
  assert.equal(TLM.evalFxAt(c, 99).x, 100);
  // no keyframes -> base fx untouched
  const plain = TLM.evalFxAt({ ...clip("b", 0, 2, 0), fx: { ...TLM.defaultFx(), volume: 50 } }, 1);
  assert.equal(plain.volume, 50);
  assert.equal(plain.scale, 100);
});

test("fade envelopes ramp 0..1 at the clip edges", () => {
  const c = {
    ...clip("a", 10, 20, 0),
    fx: { ...TLM.defaultFx(), fade_in: 2, fade_out: 4, vfade_in: 1, vfade_out: 1 },
  };
  near(TLM.fadeEnv(c, 10).audio, 0, "audio starts silent");
  near(TLM.fadeEnv(c, 11).audio, 0.5, "audio half faded");
  near(TLM.fadeEnv(c, 15).audio, 1, "audio full in the middle");
  near(TLM.fadeEnv(c, 19).audio, 0.25, "audio fading out");
  near(TLM.fadeEnv(c, 10).video, 0, "video starts black");
  near(TLM.fadeEnv(c, 15).video, 1, "video full in the middle");
});

test("captions map through the V1 track only", () => {
  const clips = [
    { ...clip("a", 0, 5, 0), track: 0 },
    { ...clip("b", 0, 5, 10), track: 1 },
  ];
  const { caps } = TLM.capsFromCues(clips, [{ start: 1, end: 2, text: "hi" }]);
  assert.equal(caps.length, 1);
  assert.equal(caps[0].start, 1);
});

test("moving a caption carries its word timings along", () => {
  const words = [{ w: "Halo", s: 1, e: 1.4 }, { w: "dunia", s: 1.5, e: 2 }];
  const tl = {
    clips: TLM.clipsFromSource(20), auds: [], vtracks: 1, atracks: 1, lanes: 1,
    caps: [{ ...cap("w1", 0, 1, 2, "Halo dunia"), words }],
  };
  const out = TLM.moveItems(tl, ["w1"], 2, 0);
  const moved = out.caps[0];
  assert.deepEqual([moved.start, moved.end], [3, 4]);
  assert.deepEqual(moved.words.map((w) => [w.s, w.e]), [[3, 3.4], [3.5, 4]]);
});

test("trimming a caption drops the words that fell outside it", () => {
  const words = [{ w: "Halo", s: 1, e: 1.4 }, { w: "dunia", s: 1.5, e: 2 }];
  const tl = {
    clips: TLM.clipsFromSource(20), auds: [], vtracks: 1, atracks: 1, lanes: 1,
    caps: [{ ...cap("w1", 0, 1, 2, "Halo dunia"), words }],
  };
  const out = TLM.trimItem(tl, "w1", "l", 1.5);
  assert.deepEqual(out.caps[0].words.map((w) => w.w), ["dunia"]);
});

test("razor-splitting a caption slices the words at the cut", () => {
  const words = [{ w: "Halo", s: 1, e: 1.4 }, { w: "dunia", s: 1.5, e: 2 }];
  const tl = {
    clips: TLM.clipsFromSource(20), auds: [], vtracks: 1, atracks: 1, lanes: 1,
    caps: [{ ...cap("w1", 0, 1, 2, "Halo dunia"), words }],
  };
  const parts = TLM.splitSelection(tl, 1.5, ["w1"]);
  assert.equal(parts.caps.length, 2);
  assert.deepEqual(parts.caps[0].words.map((w) => w.w), ["Halo"]);
  assert.deepEqual(parts.caps[1].words.map((w) => w.w), ["dunia"]);
});

test("cues seeded from a transcription keep their word timings on the timeline", () => {
  const cues = [{
    start: 1, end: 2, text: "Halo dunia",
    words: [{ w: "Halo", s: 1, e: 1.4 }, { w: "dunia", s: 1.5, e: 2 }],
    word_source: "whisper",
  }];
  const { caps } = TLM.capsFromCues(TLM.clipsFromSource(10), cues);
  assert.equal(caps.length, 1);
  assert.deepEqual(caps[0].words.map((w) => w.w), ["Halo", "dunia"]);
  assert.equal(caps[0].word_source, "whisper");
});

test("editing caption text keeps the timings of a same-length rewrite", () => {
  const tl = {
    clips: TLM.clipsFromSource(20), auds: [], vtracks: 1, atracks: 1, lanes: 1,
    caps: [{ ...cap("w1", 0, 1, 2, "Halo dunia"),
              words: [{ w: "Halo", s: 1, e: 1.4 }, { w: "dunia", s: 1.5, e: 2 }] }],
  };
  const fixed = TLM.setCaptionText(tl, "w1", "halo duniaku");
  assert.deepEqual(fixed.caps[0].words.map((w) => [w.w, w.s, w.e]),
                   [["halo", 1, 1.4], ["duniaku", 1.5, 2]]);
  assert.equal(fixed.caps[0].word_source, "edited");
  const longer = TLM.setCaptionText(tl, "w1", "Halo dunia semuanya");
  assert.deepEqual(longer.caps[0].words, []);        // no timings to guess from
  assert.equal(longer.caps[0].word_source, null);
});

test("splitCaption cuts a word-timed caption at the caret and divides the text", () => {
  const tl = {
    clips: TLM.clipsFromSource(20), auds: [], vtracks: 1, atracks: 1, lanes: 1,
    caps: [{ ...cap("w1", 0, 1, 5, "Halo dunia selamat pagi"),
             words: [
               { w: "Halo", s: 1, e: 1.4 },
               { w: "dunia", s: 1.5, e: 2.0 },
               { w: "selamat", s: 2.1, e: 2.6 },
               { w: "pagi", s: 2.7, e: 3.2 },
             ], word_source: "whisper" }],
  };
  // Caret at the middle of the text (frac 0.5) -> splits after the 2nd of 4 words.
  const out = TLM.splitCaption(tl, "w1", 0.5);
  assert.notEqual(out, tl, "returns a new timeline");
  assert.equal(out.caps.length, 2);
  const [left, right] = out.caps;
  assert.deepEqual([left.start, left.end], [1, 2.1]);
  assert.deepEqual([right.start, right.end], [2.1, 5]);
  assert.equal(left.text, "Halo dunia");
  assert.equal(right.text, "selamat pagi");
  assert.deepEqual(left.words.map((w) => w.w), ["Halo", "dunia"]);
  assert.deepEqual(right.words.map((w) => w.w), ["selamat", "pagi"]);
  assert.equal(left.word_source, "whisper");
  assert.equal(right.word_source, "whisper");
  assert.equal(left.id, "w1");
  assert.notEqual(right.id, "w1");
});

test("splitCaption divides a plain caption (no word times) at whitespace", () => {
  const tl = {
    clips: TLM.clipsFromSource(20), auds: [], vtracks: 1, atracks: 1, lanes: 1,
    caps: [cap("p1", 0, 0, 4, "the quick brown fox")],
  };
  // Caret at the middle of the text (frac 0.5) -> splits near the centre word.
  const out = TLM.splitCaption(tl, "p1", 0.5);
  assert.equal(out.caps.length, 2);
  const [left, right] = out.caps;
  assert.equal(left.text + " " + right.text, "the quick brown fox");
  assert.equal(left.text, "the quick");
  assert.equal(right.text, "brown fox");
  assert.deepEqual(left.words, []);
  assert.deepEqual(right.words, []);
});

test("splitCaption is a no-op when the playhead is outside the caption", () => {
  const tl = {
    clips: TLM.clipsFromSource(20), auds: [], vtracks: 1, atracks: 1, lanes: 1,
    caps: [cap("x1", 0, 5, 10, "hello world")],
  };
  assert.equal(TLM.splitCaption(tl, "x1", 0), tl);     // caret at the very start: nothing to cut
  assert.equal(TLM.splitCaption(tl, "x1", 1), tl);     // caret at the very end: nothing to cut
  assert.equal(TLM.splitCaption(tl, "x1", -0.2), tl);  // out of range
  assert.equal(TLM.splitCaption(tl, "x1", 1.4), tl);   // too close to the end for a valid cut
  assert.equal(TLM.splitCaption(tl, "missing", 0.5), tl); // unknown id
});

test("splitCaption keeps both halves non-empty even at an extreme caret", () => {
  const tl = {
    clips: TLM.clipsFromSource(20), auds: [], vtracks: 1, atracks: 1, lanes: 1,
    caps: [{ ...cap("e1", 0, 0, 3, "alpha beta gamma"),
             words: [
               { w: "alpha", s: 0, e: 1 },
               { w: "beta", s: 1, e: 2 },
               { w: "gamma", s: 2, e: 3 },
             ] }],
  };
  const out = TLM.splitCaption(tl, "e1", 0.05);   // caret just inside the start
  assert.equal(out.caps.length, 2);
  const [left, right] = out.caps;
  assert.equal(left.text, "alpha");
  assert.equal(right.text, "beta gamma");
});
