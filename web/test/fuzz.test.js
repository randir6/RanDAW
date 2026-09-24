// Thousands of random edits, checked for things that must ALWAYS hold.
//
// Each run starts from an example and applies random edits the way the page
// does: the edit makes a new spec, buildPiece either accepts it or refuses it
// with a SpecError, and a refused edit leaves the piece as it was. Nothing may
// ever throw anything else -- that would be a crash in the page.
//
// After every accepted edit, the invariants below are checked. They are
// properties rather than particular answers, so they hold for pieces nobody
// thought to write a test for. The random numbers come from a fixed seed, so a
// failure happens the same way every time and can be investigated.

import assert from "node:assert/strict";
import { test } from "node:test";

import * as edit from "../src/edit.js";
import { pieceToDerived } from "../src/derive.js";
import { REST } from "../src/layer.js";
import { buildPiece } from "../src/piece.js";
import { SCALES } from "../src/scales.js";
import { formatSpec, SpecError } from "../src/spec.js";
import { LIBRARY, readJson, WEB } from "./helpers.js";

// A small, fast random number generator with a fixed starting point
// ("mulberry32"), so every run makes the same choices.
function randomFrom(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const SAMPLES = [...LIBRARY.keys()].sort();
const SCALE_NAMES = Object.keys(SCALES);

// One random edit, of the kinds the editor offers.
function randomEdit(spec, rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const int = (low, high) => low + Math.floor(rand() * (high - low + 1));
  const i = int(0, spec.layer.length - 1);
  const layer = spec.layer[i];
  const seq = layer[edit.sequenceKey(layer)];
  const step = int(0, seq.length - 1);
  return pick([
    () => edit.setSetting(spec, "loops", int(1, 8)),
    () => edit.setSetting(spec, "cycle_duration", pick([0.5, 1, 1.7, 2.2, 3])),
    () => edit.setSetting(spec, "scale", pick([null, ...SCALE_NAMES])),
    () => edit.setSetting(spec, "root", pick([null, -7, 3, 12])),
    () => edit.setBeats(spec, i, int(1, 16)),
    () => edit.toggleBeat(spec, i, int(1, layer.beats)),
    () => edit.setStep(spec, i, step, rand() < 0.2 ? REST : int(-12, 14)),
    () => edit.insertStep(spec, i, step),
    () => edit.removeStep(spec, i, step),
    () => edit.setLayer(spec, i, "sample", pick(SAMPLES)),
    () => edit.setLayer(spec, i, "gain", Math.round(rand() * 150) / 100),
    () => edit.setLayer(spec, i, "scale", pick([null, ...SCALE_NAMES])),
    () => edit.switchPitchKind(spec, i, pick(["notes", "degrees"])),
    () => edit.toggleMute(spec, i),
    () => edit.toggleSolo(spec, i),
    () => (spec.layer.length < 5 ? edit.addLayer(spec, SAMPLES) : spec),
    () => edit.removeLayer(spec, i),
  ])();
}

function checkInvariants(spec, piece) {
  const d = pieceToDerived(piece);
  // One cell per layer per cycle per beat, in time order.
  const beats = piece.layers.reduce((sum, l) => sum + l.beats, 0);
  assert.equal(d.cells.length, beats * piece.loops);
  for (let k = 1; k < d.cells.length; k++) {
    const [a, b] = [d.cells[k - 1], d.cells[k]];
    assert.ok(a.pulse < b.pulse || (a.pulse === b.pulse && a.layer < b.layer), "cells out of order");
  }
  for (const c of d.cells) {
    assert.ok(c.height >= 0 && c.height <= 1, `height ${c.height} outside its row`);
    assert.ok(c.offset >= 0 && c.offset < 1, `offset ${c.offset}`);
    assert.ok(c.cycle >= 1 && c.cycle <= piece.loops);
  }
  // "Sounding together" means two or more AUDIBLE layers with a note there.
  for (const k of d.coincidences) {
    assert.ok(k.layers.length >= 2);
    for (const l of k.layers) assert.ok(d.layers[l].audible, "a silent layer counted as sounding");
  }
  // Solo wins over mute, and with no solo, exactly the unmuted layers sound.
  const anySolo = spec.layer.some((l) => l.solo);
  spec.layer.forEach((l, n) => assert.equal(d.layers[n].audible, anySolo ? Boolean(l.solo) : !l.mute));
  // Saving and reading back gives the same piece.
  assert.deepEqual(JSON.parse(formatSpec(spec)), spec);
}

test("random edits never crash, and every accepted piece keeps its invariants", () => {
  const names = ["tresillo", "rests", "seven", "phase_study", "sparse_dub", "scales"];
  let accepted = 0;
  let refused = 0;
  for (let run = 0; run < 60; run++) {
    const rand = randomFrom(1000 + run);
    let spec = readJson(WEB, "examples", `${names[run % names.length]}.json`);
    const history = [];
    for (let n = 0; n < 50; n++) {
      const next = randomEdit(spec, rand);
      let piece;
      try {
        piece = buildPiece(next, { samples: SAMPLES });
      } catch (e) {
        if (!(e instanceof SpecError)) throw new Error(`run ${run}, edit ${n}: crashed: ${e.stack}`);
        refused++;
        continue;
      }
      history.push(spec);
      spec = piece.spec;
      accepted++;
      checkInvariants(spec, piece);
    }
    // Undo all the way: every earlier piece must still build, exactly as it was.
    for (const earlier of history.reverse()) {
      assert.deepEqual(buildPiece(earlier, { samples: SAMPLES }).spec, earlier);
    }
  }
  // Both outcomes must actually happen, or the test is not testing much.
  assert.ok(accepted > 1500 && refused > 50, `accepted ${accepted}, refused ${refused}`);
  if (process.env.SHOW_COUNTS) console.log({ accepted, refused });
});
