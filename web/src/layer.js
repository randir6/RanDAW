// What a layer IS, and the rules a layer must obey.
//
// Deliberately the "boring" module: it holds the data and the validation,
// and knows nothing about audio, timing, files or the page. Reading a layer
// out of a piece lives in spec.js, which ends up calling makeLayer() below,
// so there is exactly one set of rules.

import { degreeToSemitones, isScale, scaleNames } from "./scales.js";

// Written in a sequence where a pitch would go, this means "sound nothing
// here". It has to be a marker rather than a number because 0 is already a
// legitimate value in both notations -- unison in semitones, and one step
// below the root as a degree.
export const REST = "-";

// Broken layer rules are reported with this, and spec.js adds which layer it
// was. A class of our own, rather than a plain Error, so the code catching it
// can tell "the user wrote something invalid" apart from a genuine bug.
//
// `extends Error` makes it a kind of Error: it gets a message and a stack
// trace for free, and `instanceof LayerError` can pick it out.
export class LayerError extends Error {}

// Validate the pieces of a layer and build one.
//
// The argument is a single object with named parts -- makeLayer({ beats: 3,
// sample: "kick.wav", notes: [0] }) -- rather than a long list of positional
// arguments, the JavaScript way of getting what Python's keyword arguments
// give. The `= ...` parts are defaults for anything left out.
//
// A layer states its pitches EITHER as `notes` (raw semitones, right for
// drums and anything where a scale is meaningless) OR as `degrees` against a
// named scale. Two separate fields rather than one that changes meaning, so
// adding a scale somewhere can never silently reinterpret a drum layer.
//
// Degrees are resolved to semitones right here, which is why nothing
// downstream -- schedule, render, the event list -- knows scales exist.
//
// `active` and `degrees` both arrive 1-BASED, as the user writes them. A rest
// arrives as null.
export function makeLayer({
  beats,
  sample,
  notes = null,
  degrees = null,
  scale = null,
  root = 0,
  gain = 1.0,
  active = null,
}) {
  if (beats < 1) throw new LayerError(`beat count must be >= 1, got ${beats}`);

  // Exactly one of the two. Compared with null rather than tested for
  // truth, so an explicitly empty list is caught below as empty rather than
  // as missing.
  if (notes === null && degrees === null) {
    throw new LayerError("needs either notes (semitones) or degrees (with a scale)");
  }
  if (notes !== null && degrees !== null) {
    throw new LayerError("give either notes or degrees, not both");
  }

  let written, pitchKind;
  if (degrees !== null) {
    if (scale === null) throw new LayerError(`degrees need a scale; try one of: ${scaleNames()}`);
    if (!isScale(scale)) {
      throw new LayerError(`unknown scale "${scale}"; expected one of: ${scaleNames()}`);
    }
    if (degrees.length === 0) throw new LayerError("degree sequence must not be empty");
    written = [...degrees];  // [...list] makes a copy of it
    pitchKind = "degrees";
    // .map() builds a new list by running a function over every item --
    // JavaScript's version of a Python list comprehension. Rests stay rests.
    notes = degrees.map((d) => (d === null ? null : degreeToSemitones(d, scale, root)));
  } else if (scale !== null) {
    // A scale alongside raw semitones means someone expected the numbers to
    // be degrees. Better to say so than to silently ignore the scale.
    throw new LayerError("scale given but pitches are notes (semitones); use degrees instead");
  } else {
    written = [...notes];
    pitchKind = "notes";
  }

  if (notes.length === 0) throw new LayerError("note sequence must not be empty");
  if (notes.every((n) => n === null)) {
    throw new LayerError("sequence is all rests, so the layer would never sound");
  }
  if (gain < 0) throw new LayerError(`gain must be >= 0, got ${gain}`);
  if (!sample) throw new LayerError("no sample");

  let activeBeats = null;
  if (active !== null) {
    for (const n of active) {
      if (n < 1 || n > beats) throw new LayerError(`active beat ${n} is outside 1..${beats}`);
    }
    // A Set holds each value once, so [3, 3, 5] quietly means the same as
    // [3, 5], and asking "is 4 in it?" is fast. The -1 shifts the 1-based
    // numbers people write to the 0-based positions used everywhere inside.
    activeBeats = new Set(active.map((n) => n - 1));
  }

  // Object.freeze makes the layer read-only: a layer is a decision already
  // made, and code that tries to change one afterwards is a bug.
  return Object.freeze({
    beats,
    notes: Object.freeze(notes),
    sample,
    gain,
    activeBeats,
    // Kept only for display: the sequence exactly as written (degrees or
    // semitones), so a picture can show "degree 3 of dorian" rather than
    // "3 semitones". None of these three affects the sound.
    written: Object.freeze(written),
    pitchKind,
    scale,
    root,
  });
}
