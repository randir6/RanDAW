// Turning scale degrees into semitones.
//
// A scale is a pattern of steps within an octave, written here as semitones
// from the root. Twelve semitones make an octave, so the major scale --
// tone, tone, semitone, tone, tone, tone, semitone -- comes out as
// [0, 2, 4, 5, 7, 9, 11].
//
// Degrees are what musicians actually say: "the 1, the 3 and the 5" is a
// major chord. Working in degrees rather than semitones means swapping the
// scale re-harmonises a part without rewriting a single note -- degree 3 is
// simply a different interval in minor than it is in major.

import { divmod } from "./numbers.js";

// Each entry lists semitones above the root. Lengths vary on purpose: a
// pentatonic scale has five degrees per octave, a chromatic one twelve, and
// the arithmetic below handles any of them without special cases.
//
// Object.freeze stops anything changing the table later by accident.
export const SCALES = Object.freeze({
  // The seven modes, all the same seven notes started from different points
  major: [0, 2, 4, 5, 7, 9, 11],       // also called ionian
  minor: [0, 2, 3, 5, 7, 8, 10],       // natural minor, also called aeolian
  dorian: [0, 2, 3, 5, 7, 9, 10],      // minor with a raised 6th -- brighter
  phrygian: [0, 1, 3, 5, 7, 8, 10],    // minor with a flat 2nd -- Spanish
  lydian: [0, 2, 4, 6, 7, 9, 11],      // major with a raised 4th -- floating
  mixolydian: [0, 2, 4, 5, 7, 9, 10],  // major with a flat 7th -- bluesy
  locrian: [0, 1, 3, 5, 6, 8, 10],     // unstable; rarely used as a home key
  // Altered minors
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
  melodic_minor: [0, 2, 3, 5, 7, 9, 11],
  // Five-note scales. Fewer notes means fewer ways to clash, which is why
  // these are so forgiving to improvise over.
  major_pentatonic: [0, 2, 4, 7, 9],
  minor_pentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],          // minor pentatonic plus the flat 5th
  // No tonal centre at all: every step the same size.
  whole_tone: [0, 2, 4, 6, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
});

// Is this the name of a scale? Written as a function because the obvious
// `name in SCALES` has a trap: every JavaScript object quietly inherits
// properties like "toString" and "constructor", so `"toString" in SCALES` is
// true. Object.hasOwn only looks at what was actually written above.
export function isScale(name) {
  return typeof name === "string" && Object.hasOwn(SCALES, name);
}

// Comma-separated list, for error messages. Sorted so it reads the same
// every time.
export function scaleNames() {
  return Object.keys(SCALES).sort().join(", ");
}

// Convert a 1-based scale degree into semitones above the sample's pitch.
//
// Degrees count from 1 as musicians count: in major, 1 -> 0 semitones,
// 3 -> 4 (a major third), 5 -> 7 (a perfect fifth).
//
// Degrees past the end of the scale wrap into the next octave, so in a
// seven-note scale degree 8 is the octave above degree 1. Degrees below 1 run
// downwards the same way: degree 0 is one step BELOW the root. That depends on
// divmod rounding down, which JavaScript's own % does not -- see numbers.js.
//
// `root` shifts the whole thing by a number of semitones. It is an offset
// rather than a key name like "D" on purpose: we have no idea what pitch the
// sample already is, so naming a key would be a fiction.
export function degreeToSemitones(degree, scale, root = 0) {
  const intervals = SCALES[scale];
  const [octave, step] = divmod(degree - 1, intervals.length);
  return root + intervals[step] + 12 * octave;
}
