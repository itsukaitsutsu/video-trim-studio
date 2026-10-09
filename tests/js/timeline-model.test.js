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

test("moving a clip overwrites what is underneath it", () => {
  const tl = { clips: [clip("a", 0, 4, 0), clip("b", 4, 8, 10)], caps: [], lanes: 1 };
  const out = TLM.moveItems(tl, ["b"], -2, 0);
  assert.deepEqual(out.clips.map((c) => [c.id, c.start, c.end]), [["a", 0, 2], ["b", 2, 6]]);
  const moved = out.clips.find((c) => c.id === "b");
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

test("copy and paste overwrite; paste insert pushes later items", () => {
  const tl = { clips: [clip("a", 0, 6, 0), clip("b", 6, 12, 6)], caps: [cap("t1", 0, 7, 8, "x")], lanes: 1 };
  const clipboard = TLM.copyItems(tl, ["a"]);
  const over = TLM.pasteItems(tl, clipboard, 4, false);
  const sorted = over.tl.clips.slice().sort((x, y) => x.start - y.start);
  assert.deepEqual(sorted.map((c) => [c.start, c.end]), [[0, 4], [4, 10], [10, 12]]);
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
  const pasted = back.clips.find((c) => c.start === 0);
  near(pasted.in, 4, "the pasted clip plays source 4 s first");
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
