// Every change the editor can make to a piece.
//
// Each is a plain function: a spec goes in, a NEW spec comes out, and the one
// passed in is never touched. Three things follow from that:
//
//   * Undo is simply keeping the old specs in a list.
//   * These can be checked in Node with no browser, like the rest of the
//     engine -- the page only wires buttons to them.
//   * None of them needs to know whether the result is valid. The page runs
//     every result through buildPiece, which is the one place the rules
//     live, and refuses (with its message) anything that breaks them.
//
// They work on the spec -- what the user wrote -- so degrees stay degrees,
// beats are counted from 1, and a rest is "-".

import { REST } from "./layer.js";
import { degreeToSemitones, SCALES } from "./scales.js";

// Sensible ends for the + and - buttons. Not rules of the engine, which has
// no upper limits, just where the buttons stop.
export const MAX_BEATS = 32;
export const MAX_LOOPS = 32;
export const MAX_STEPS = 32;

// structuredClone makes a complete, independent copy -- lists inside objects
// inside lists included -- so changing the copy cannot reach the original.
const copy = (spec) => structuredClone(spec);
const clamp = (x, low, high) => Math.min(high, Math.max(low, x));

// Set a key, or remove it when the value is null: "not there" is how a spec
// says "use the default", which keeps saved pieces short.
function put(object, key, value) {
  if (value === null || value === undefined) delete object[key];
  else object[key] = value;
}

// --- The whole piece ---------------------------------------------------------------

// Change a piece-wide setting: cycle_duration, loops, scale or root.
export function setSetting(spec, key, value) {
  const next = copy(spec);
  if (key === "cycle_duration") {
    // The two tempo settings cannot both be given, and the editor speaks in
    // cycles, so setting a cycle length replaces a pulse duration.
    delete next.pulse_duration;
  }
  put(next, key, value);
  return next;
}

// --- Layers -----------------------------------------------------------------------

// Which key holds this layer's sequence: "notes" or "degrees".
export const sequenceKey = (layer) => (Object.hasOwn(layer, "degrees") ? "degrees" : "notes");

// Change one field of one layer (null removes it, meaning "the default").
export function setLayer(spec, index, key, value) {
  const next = copy(spec);
  put(next.layer[index], key, value);
  return next;
}

// A new layer: a single hit, on a sample not used yet if there is one, fairly
// quiet so adding it does not suddenly overload the mix.
export function addLayer(spec, sampleNames) {
  const next = copy(spec);
  const used = new Set(next.layer.map((l) => l.sample));
  const sample = sampleNames.find((name) => !used.has(name)) ?? sampleNames[0];
  next.layer.push({ beats: 4, notes: [0], sample, gain: 0.4 });
  return next;
}

// A copy of a layer, placed straight after it: the quickest way to try a
// variation on something that already works.
export function duplicateLayer(spec, index) {
  const next = copy(spec);
  next.layer.splice(index + 1, 0, copy(next.layer[index]));
  return next;
}

export function removeLayer(spec, index) {
  const next = copy(spec);
  next.layer.splice(index, 1);  // splice(at, 1) removes one item at `at`
  return next;
}

export const toggleMute = (spec, index) =>
  setLayer(spec, index, "mute", spec.layer[index].mute ? null : true);
export const toggleSolo = (spec, index) =>
  setLayer(spec, index, "solo", spec.layer[index].solo ? null : true);

// Tidy a layer's active beats: sorted, no duplicates, none past the last
// beat -- and removed altogether when every beat is on, since "all of them"
// is what leaving it out already means.
function tidyActive(layer) {
  if (!Object.hasOwn(layer, "active")) return;
  const beats = [...new Set(layer.active)].filter((b) => b >= 1 && b <= layer.beats).sort((a, b) => a - b);
  if (beats.length === layer.beats) delete layer.active;
  else layer.active = beats;
}

// Change how many beats a layer has. Switched-off beats past the new end go.
export function setBeats(spec, index, beats) {
  const next = copy(spec);
  const layer = next.layer[index];
  layer.beats = clamp(beats, 1, MAX_BEATS);
  tidyActive(layer);
  return next;
}

// Switch one beat (counting from 1) off, or back on. The same beat in every
// cycle, which is what `active` means.
export function toggleBeat(spec, index, beat) {
  const next = copy(spec);
  const layer = next.layer[index];
  const all = Array.from({ length: layer.beats }, (_, i) => i + 1);
  const on = new Set(layer.active ?? all);
  if (on.has(beat)) on.delete(beat);
  else on.add(beat);
  layer.active = [...on];
  tidyActive(layer);
  return next;
}

// --- The sequence ------------------------------------------------------------------

// Put a value (a number, or REST) at one step of a layer's sequence.
export function setStep(spec, index, step, value) {
  const next = copy(spec);
  next.layer[index][sequenceKey(next.layer[index])][step] = value;
  return next;
}

// Add a step after `step`, copying it, so the sequence grows by repeating
// what is selected -- usually the most useful thing to change next.
export function insertStep(spec, index, step) {
  const next = copy(spec);
  const seq = next.layer[index][sequenceKey(next.layer[index])];
  if (seq.length < MAX_STEPS) seq.splice(step + 1, 0, seq[step]);
  return next;
}

export function removeStep(spec, index, step) {
  const next = copy(spec);
  const seq = next.layer[index][sequenceKey(next.layer[index])];
  if (seq.length > 1) seq.splice(step, 1);
  return next;
}

export function setSequence(spec, index, values) {
  return setLayer(spec, index, sequenceKey(spec.layer[index]), values);
}

// A sequence as the text field shows it: "1 - 5 4".
export const formatSequence = (values) => values.join(" ");

// And back: numbers or "-", separated by spaces or commas. Throws an Error
// with a readable message for anything else, which the page shows beside
// the field.
export function parseSequence(text) {
  const tokens = text.split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) throw new Error("type at least one number, or - for a rest");
  return tokens.map((token) => {
    if (token === REST) return REST;
    // A whole number, optionally negative, and nothing else.
    if (!/^[-+]?\d+$/.test(token)) throw new Error(`"${token}" is not a whole number or - (a rest)`);
    return Number(token);
  });
}

// --- Switching between notes and degrees ------------------------------------------

// The scale and root a layer's degrees are actually read against: its own if
// it has them, else the piece's.
export function effectiveScale(spec, layer) {
  return layer.scale ?? spec.scale ?? null;
}
export function effectiveRoot(spec, layer) {
  return layer.root ?? spec.root ?? 0;
}

// Change a layer from semitones to scale degrees or back, keeping the sound
// as close as it can.
//
// Degrees to notes is exact: each degree becomes the semitones it already
// meant. Notes to degrees has to snap each pitch to the nearest note of the
// scale (the lower one on a tie), since a semitone may not be in the scale.
export function switchPitchKind(spec, index, kind) {
  const next = copy(spec);
  const layer = next.layer[index];
  if (kind === sequenceKey(layer)) return next;

  if (kind === "notes") {
    const scale = effectiveScale(spec, layer);
    const root = effectiveRoot(spec, layer);
    layer.notes = layer.degrees.map((d) => (d === REST ? REST : degreeToSemitones(d, scale, root)));
    delete layer.degrees;
    // Scale and root only ever applied to degrees; the notes above already
    // include them.
    delete layer.scale;
    delete layer.root;
  } else {
    // With no scale anywhere yet, start from major.
    if (effectiveScale(spec, layer) === null) layer.scale = "major";
    const scale = effectiveScale(next, layer);
    const root = effectiveRoot(next, layer);
    layer.degrees = layer.notes.map((n) => (n === REST ? REST : nearestDegree(n, scale, root)));
    delete layer.notes;
  }
  return next;
}

function nearestDegree(semitones, scale, root) {
  const span = SCALES[scale].length;
  let best = 1;
  let bestDistance = Infinity;
  // Search a few octaves either side; the first found wins a tie, and the
  // search runs upwards, so a tie goes to the lower pitch.
  for (let d = 1 - 4 * span; d <= 1 + 4 * span; d++) {
    const distance = Math.abs(degreeToSemitones(d, scale, root) - semitones);
    if (distance < bestDistance) {
      best = d;
      bestDistance = distance;
    }
  }
  return best;
}
