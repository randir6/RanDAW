// Checks on the editor's changes (src/edit.js).
//
// Each edit is a plain function, spec in and new spec out, so these need no
// browser. What matters: the change is the one intended, the original is
// never altered, and edits that keep a piece valid produce a piece that
// still builds.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addLayer, duplicateLayer, formatSequence, insertPosition, MAX_BARS, MAX_OVER, parseSequence, removeLayer, removePosition,
  scaleGains, setAllBeats, setBeats, setFollow, setLayer, setLayerRoot, setOver, setPosition, setSetting, switchPitchKind,
  toggleBeat, toggleMute, toggleSolo,
} from "../src/edit.js";
import { buildPiece } from "../src/piece.js";
import { schedule } from "../src/schedule.js";
import { LIBRARY, readJson, WEB } from "./helpers.js";

const builds = (spec) => buildPiece(spec, { samples: LIBRARY.keys() });
const rests = () => readJson(WEB, "examples", "rests.json");

test("edits never change the piece they are given", () => {
  const spec = rests();
  const before = JSON.stringify(spec);
  setSetting(spec, "bars", 2);
  setSetting(spec, "tempo", 90);
  setOver(spec, 0, 2);
  setLayer(spec, 0, "gain", 0.1);
  toggleBeat(spec, 3, 1);
  setBeats(spec, 3, 5);
  setPosition(spec, 0, 1, 3);
  insertPosition(spec, 0, 0);
  removePosition(spec, 0, 0);
  addLayer(spec, [...LIBRARY.keys()]);
  removeLayer(spec, 0);
  toggleMute(spec, 0);
  toggleSolo(spec, 0);
  switchPitchKind(spec, 0, "notes");
  assert.equal(JSON.stringify(spec), before);
});

test("setting the tempo or the bars replaces the older words for them", () => {
  assert.deepEqual(setSetting({ pulse_duration: 0.1, bars: 1, layer: [] }, "tempo", 90), { bars: 1, layer: [], tempo: 90 });
  assert.deepEqual(setSetting({ cycle_duration: 2, tempo: 1, layer: [] }, "tempo", 90), { tempo: 90, layer: [] });
  assert.deepEqual(setSetting({ loops: 3, layer: [] }, "bars", 4), { layer: [], bars: 4 });
  assert.equal(setSetting({ scale: "major", layer: [] }, "scale", null).scale, undefined);
});

test("a layer's span of bars stays within its limits, and 1 is written by leaving it out", () => {
  const spec = { bars: 1, layer: [{ beats: 7, notes: [0], sample: "kick.wav" }] };
  assert.equal(setOver(spec, 0, 2).layer[0].over, 2);
  assert.equal(setOver(spec, 0, 99).layer[0].over, MAX_OVER);
  assert.equal(Object.hasOwn(setOver(setOver(spec, 0, 2), 0, 1).layer[0], "over"), false);
  assert.equal(Object.hasOwn(setOver(spec, 0, 0).layer[0], "over"), false, "never less than one bar");
});

test("a layer can have up to 32 beats for each bar it spreads across", () => {
  const spec = { bars: 12, layer: [{ beats: 7, notes: [0], sample: "kick.wav" }] };
  assert.equal(setBeats(spec, 0, 100).layer[0].beats, 32);
  const overTen = setOver(spec, 0, 10);
  assert.equal(setBeats(overTen, 0, 320).layer[0].beats, 320);
  assert.equal(setBeats(overTen, 0, 400).layer[0].beats, 320);
  assert.equal(setOver(spec, 0, 99).layer[0].over, MAX_BARS);
});

test("spreading a layer over fewer bars brings too many beats down with it", () => {
  const spec = { bars: 12, layer: [{ beats: 300, over: 10, active: [1, 50, 90], notes: [0], sample: "kick.wav" }] };
  const two = setOver(spec, 0, 2).layer[0];
  assert.equal(two.beats, 64);
  assert.deepEqual(two.active, [1, 50]);
  assert.equal(setOver(spec, 0, 12).layer[0].beats, 300, "more bars leave the beats alone");
});

test("every beat of a layer can be switched on, or off, at once", () => {
  const spec = { bars: 1, layer: [{ beats: 12, active: [1, 5], notes: [0], sample: "kick.wav" }] };
  assert.equal(Object.hasOwn(setAllBeats(spec, 0, true).layer[0], "active"), false, "all on is written by leaving it out");
  assert.deepEqual(setAllBeats(spec, 0, false).layer[0].active, []);
  builds(setAllBeats(spec, 0, false));
  assert.deepEqual(spec.layer[0].active, [1, 5], "the spec passed in is untouched");
});

test("switching a beat off and on again leaves the layer as it was", () => {
  const spec = { bars: 1, layer: [{ beats: 4, notes: [0], sample: "kick.wav" }] };
  const off = toggleBeat(spec, 0, 2);
  assert.deepEqual(off.layer[0].active, [1, 3, 4]);
  const on = toggleBeat(off, 0, 2);
  assert.equal(Object.hasOwn(on.layer[0], "active"), false, "all beats on is written as no `active` at all");
  // The switched-off beat is silent in every bar.
  const p = builds({ ...off, bars: 3 });
  assert.deepEqual(schedule(p).map((e) => e.beat).filter((b) => b === 1), []);
});

test("fewer beats drops switched-off beats past the new end", () => {
  const spec = { bars: 1, layer: [{ beats: 8, notes: [0], sample: "hat.wav", active: [1, 4, 7] }] };
  assert.deepEqual(setBeats(spec, 0, 5).layer[0].active, [1, 4]);
  assert.equal(setBeats(spec, 0, 0).layer[0].beats, 1, "never fewer than one beat");
  assert.equal(setBeats(spec, 0, 999).layer[0].beats, 32);
});

test("positions are set, added and removed in the layer's own notation", () => {
  const spec = rests();  // layer 0 is degrees [1, "-", 5, 4, "-", 2, 8]
  assert.deepEqual(setPosition(spec, 0, 1, 3).layer[0].degrees, [1, 3, 5, 4, "-", 2, 8]);
  assert.deepEqual(insertPosition(spec, 0, 2).layer[0].degrees, [1, "-", 5, 5, 4, "-", 2, 8]);
  assert.deepEqual(removePosition(spec, 0, 0).layer[0].degrees, ["-", 5, 4, "-", 2, 8]);
  const one = { layer: [{ beats: 1, notes: [0], sample: "kick.wav" }] };
  assert.deepEqual(removePosition(one, 0, 0).layer[0].notes, [0], "never an empty sequence");
});

test("a sequence round-trips through the text field", () => {
  assert.equal(formatSequence([1, "-", 5, -3]), "1 - 5 -3");
  assert.deepEqual(parseSequence(" 1 - 5,-3  +2 "), [1, "-", 5, -3, 2]);
  assert.throws(() => parseSequence("1 q 5"), /"q" is not a whole number/);
  assert.throws(() => parseSequence("1 2.5"), /"2.5" is not a whole number/);
  assert.throws(() => parseSequence("   "), /at least one/);
});

test("degrees to notes keeps the sound exactly", () => {
  const spec = rests();
  const asNotes = switchPitchKind(spec, 0, "notes");
  assert.equal(asNotes.layer[0].degrees, undefined);
  const pitches = (s) => builds(s).layers[0].notes;
  assert.deepEqual(pitches(asNotes), pitches(spec));
});

test("notes to degrees snaps each pitch to the scale, and back again exactly", () => {
  const spec = { bars: 1, scale: "major", layer: [{ beats: 4, notes: [0, 4, 7, 12, 1, "-"], sample: "pluck.wav" }] };
  const asDegrees = switchPitchKind(spec, 0, "degrees");
  // 1 semitone is not in C major: it snaps down to 0, degree 1.
  assert.deepEqual(asDegrees.layer[0].degrees, [1, 3, 5, 8, 1, "-"]);
  assert.deepEqual(switchPitchKind(asDegrees, 0, "notes").layer[0].notes, [0, 4, 7, 12, 0, "-"]);
  // With no scale anywhere, the piece gets one so the degrees mean something,
  // and the layer follows it rather than pinning a scale of its own.
  const bare = { bars: 1, layer: [{ beats: 1, notes: [0], sample: "kick.wav" }] };
  const switched = switchPitchKind(bare, 0, "degrees");
  assert.equal(switched.scale, "major");
  assert.equal(switched.layer[0].scale, undefined);

});

test("after switching to degrees, changing the piece's scale changes the pitches", () => {
  const tresillo = readJson(WEB, "examples", "tresillo.json");
  const asDegrees = switchPitchKind(tresillo, 3, "degrees");
  const pitches = (s) => builds(s).layers[3].notes;
  assert.notDeepEqual(pitches(setSetting(asDegrees, "scale", "minor")), pitches(asDegrees));
});

test("a layer's root set back to the piece's follows the piece again", () => {
  const spec = { bars: 1, scale: "major", root: 2, layer: [{ beats: 1, degrees: [1], sample: "pluck.wav" }] };
  const moved = setLayerRoot(spec, 0, 3);
  assert.equal(moved.layer[0].root, 3);
  assert.equal(setLayerRoot(moved, 0, 2).layer[0].root, undefined);
  // Once following, changing the piece's root moves the layer too.
  const following = setSetting(setLayerRoot(moved, 0, 2), "root", 5);
  assert.deepEqual(builds(following).layers[0].notes, [5]);
  // With no piece root, 0 is the piece's.
  assert.equal(setLayerRoot({ layer: [{ root: 1 }] }, 0, 0).layer[0].root, undefined);
});

test("a layer made melodic follows its hits; following beats is written by leaving it out", () => {
  const spec = { bars: 1, scale: "major", layer: [{ beats: 4, notes: [0, 4], sample: "pluck.wav" }] };
  const melodic = switchPitchKind(spec, 0, "degrees");
  assert.equal(melodic.layer[0].follow, "hits");
  // Back to semitones keeps the choice; it is the layer's, not the notation's.
  assert.equal(switchPitchKind(melodic, 0, "notes").layer[0].follow, "hits");
  assert.equal(setFollow(melodic, 0, "beats").layer[0].follow, undefined);
  assert.equal(setFollow(spec, 0, "hits").layer[0].follow, "hits");
  // A layer that already chose keeps its choice when made melodic.
  const chosen = { ...spec, layer: [{ ...spec.layer[0], follow: "beats" }] };
  assert.equal(switchPitchKind(chosen, 0, "degrees").layer[0].follow, "beats");
});

test("every example still builds after each kind of edit", () => {
  const names = [...LIBRARY.keys()];
  for (const name of ["tresillo", "rests", "seven", "spans", "phase_study", "sparse_dub", "scales"]) {
    const spec = readJson(WEB, "examples", `${name}.json`);
    for (const [label, edit] of [
      ["bars", (s) => setSetting(s, "bars", 2)],
      ["tempo", (s) => setSetting(s, "tempo", 97)],
      ["base", (s) => setSetting(s, "base", 5)],
      ["click", (s) => setSetting(s, "click", true)],
      ["beats", (s) => setBeats(s, 0, s.layer[0].beats + 1)],
      ["over", (s) => setOver(s, 0, 3)],
      ["toggle", (s) => toggleBeat(s, 0, 1)],
      ["insert", (s) => insertPosition(s, 0, 0)],
      ["add", (s) => addLayer(s, names)],
      ["mute", (s) => toggleMute(s, 0)],
      ["solo", (s) => toggleSolo(s, 1)],
      ["notes", (s) => switchPitchKind(s, 0, "notes")],
      ["degrees", (s) => switchPitchKind(s, 0, "degrees")],
    ]) {
      assert.doesNotThrow(() => builds(edit(spec)), `${name}: ${label}`);
    }
  }
});

test("duplicating a layer puts an exact copy straight after it", () => {
  const spec = rests();
  const next = duplicateLayer(spec, 1);
  assert.equal(next.layer.length, spec.layer.length + 1);
  assert.deepEqual(next.layer[2], spec.layer[1]);
  assert.deepEqual(next.layer[3], spec.layer[2]);
  next.layer[2].gain = 0;  // the copy is independent of the original
  assert.notEqual(next.layer[1].gain, 0);
});

test("turning every layer down keeps the balance and never overshoots", () => {
  const spec = { layer: [{ gain: 1 }, { gain: 0.5 }, {}] };
  assert.deepEqual(scaleGains(spec, 0.618).layer.map((l) => l.gain), [0.61, 0.3, 0.61]);
});

test("a new layer uses a sample not already in the piece", () => {
  const spec = { bars: 1, layer: [{ beats: 3, notes: [0], sample: "bell.wav" }] };
  assert.equal(addLayer(spec, ["bell.wav", "hat.wav"]).layer[1].sample, "hat.wav");
  assert.equal(addLayer(spec, ["bell.wav", "click.wav", "hat.wav"]).layer[1].sample, "hat.wav", "not the click");
});
