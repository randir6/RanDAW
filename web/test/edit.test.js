// Checks on the editor's changes (src/edit.js).
//
// Each edit is a plain function, spec in and new spec out, so these need no
// browser. What matters: the change is the one intended, the original is
// never altered, and edits that keep a piece valid produce a piece that
// still builds.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addLayer, formatSequence, insertStep, parseSequence, removeLayer, removeStep, setBeats,
  setLayer, setSetting, setStep, switchPitchKind, toggleBeat, toggleMute, toggleSolo,
} from "../src/edit.js";
import { buildPiece } from "../src/piece.js";
import { schedule } from "../src/schedule.js";
import { LIBRARY, readJson, WEB } from "./helpers.js";

const builds = (spec) => buildPiece(spec, { samples: LIBRARY.keys() });
const rests = () => readJson(WEB, "examples", "rests.json");

test("edits never change the piece they are given", () => {
  const spec = rests();
  const before = JSON.stringify(spec);
  setSetting(spec, "loops", 2);
  setLayer(spec, 0, "gain", 0.1);
  toggleBeat(spec, 3, 1);
  setBeats(spec, 3, 5);
  setStep(spec, 0, 1, 3);
  insertStep(spec, 0, 0);
  removeStep(spec, 0, 0);
  addLayer(spec, [...LIBRARY.keys()]);
  removeLayer(spec, 0);
  toggleMute(spec, 0);
  toggleSolo(spec, 0);
  switchPitchKind(spec, 0, "notes");
  assert.equal(JSON.stringify(spec), before);
});

test("setting the cycle length replaces a pulse duration", () => {
  const next = setSetting({ pulse_duration: 0.1, loops: 1, layer: [] }, "cycle_duration", 2);
  assert.deepEqual(next, { loops: 1, layer: [], cycle_duration: 2 });
  assert.equal(setSetting({ scale: "major", layer: [] }, "scale", null).scale, undefined);
});

test("switching a beat off and on again leaves the layer as it was", () => {
  const spec = { loops: 1, layer: [{ beats: 4, notes: [0], sample: "kick.wav" }] };
  const off = toggleBeat(spec, 0, 2);
  assert.deepEqual(off.layer[0].active, [1, 3, 4]);
  const on = toggleBeat(off, 0, 2);
  assert.equal(Object.hasOwn(on.layer[0], "active"), false, "all beats on is written as no `active` at all");
  // The switched-off beat is silent in every cycle.
  const p = builds({ ...off, loops: 3 });
  assert.deepEqual(schedule(p.layers, 3).map((e) => e.beat % 4).filter((b) => b === 1), []);
});

test("fewer beats drops switched-off beats past the new end", () => {
  const spec = { loops: 1, layer: [{ beats: 8, notes: [0], sample: "hat.wav", active: [1, 4, 7] }] };
  assert.deepEqual(setBeats(spec, 0, 5).layer[0].active, [1, 4]);
  assert.equal(setBeats(spec, 0, 0).layer[0].beats, 1, "never fewer than one beat");
  assert.equal(setBeats(spec, 0, 999).layer[0].beats, 32);
});

test("steps are set, added and removed in the layer's own notation", () => {
  const spec = rests();  // layer 0 is degrees [1, "-", 5, 4, "-", 2, 8]
  assert.deepEqual(setStep(spec, 0, 1, 3).layer[0].degrees, [1, 3, 5, 4, "-", 2, 8]);
  assert.deepEqual(insertStep(spec, 0, 2).layer[0].degrees, [1, "-", 5, 5, 4, "-", 2, 8]);
  assert.deepEqual(removeStep(spec, 0, 0).layer[0].degrees, ["-", 5, 4, "-", 2, 8]);
  const one = { layer: [{ beats: 1, notes: [0], sample: "kick.wav" }] };
  assert.deepEqual(removeStep(one, 0, 0).layer[0].notes, [0], "never an empty sequence");
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
  const spec = { loops: 1, scale: "major", layer: [{ beats: 4, notes: [0, 4, 7, 12, 1, "-"], sample: "pluck.wav" }] };
  const asDegrees = switchPitchKind(spec, 0, "degrees");
  // 1 semitone is not in C major: it snaps down to 0, degree 1.
  assert.deepEqual(asDegrees.layer[0].degrees, [1, 3, 5, 8, 1, "-"]);
  assert.deepEqual(switchPitchKind(asDegrees, 0, "notes").layer[0].notes, [0, 4, 7, 12, 0, "-"]);
  // With no scale anywhere, the layer gets one so its degrees mean something.
  const bare = { loops: 1, layer: [{ beats: 1, notes: [0], sample: "kick.wav" }] };
  assert.equal(switchPitchKind(bare, 0, "degrees").layer[0].scale, "major");
});

test("every example still builds after each kind of edit", () => {
  const names = [...LIBRARY.keys()];
  for (const name of ["tresillo", "rests", "seven", "phase_study", "sparse_dub", "scales"]) {
    const spec = readJson(WEB, "examples", `${name}.json`);
    for (const [label, edit] of [
      ["loops", (s) => setSetting(s, "loops", 2)],
      ["cycle", (s) => setSetting(s, "cycle_duration", 1.7)],
      ["beats", (s) => setBeats(s, 0, s.layer[0].beats + 1)],
      ["toggle", (s) => toggleBeat(s, 0, 1)],
      ["insert", (s) => insertStep(s, 0, 0)],
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

test("a new layer uses a sample not already in the piece", () => {
  const spec = { loops: 1, layer: [{ beats: 3, notes: [0], sample: "bell.wav" }] };
  assert.equal(addLayer(spec, ["bell.wav", "hat.wav"]).layer[1].sample, "hat.wav");
});
