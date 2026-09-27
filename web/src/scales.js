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

// --- Naming pitches ---------------------------------------------------------------
//
// A layer's pitches are shifts of its sample, and a sample's own pitch is not
// something the engine knows -- which is why `root` is a number of semitones
// rather than a key name. The built-in sounds were made at known pitches,
// though (see make_samples.py), so for those alone a display can name the
// notes a sequence actually plays. None of this affects the sound.
//
// The pitch each built-in sample sounds at, as a MIDI note number (60 is
// middle C, C4). The tom's pitch settles at 110 Hz, A2; the drums without a
// clear pitch are left out.
export const SAMPLE_PITCH = Object.freeze({
  "pluck.wav": 57,    // 220 Hz, A3
  "keys.wav": 57,
  "marimba.wav": 57,
  "bell.wav": 64,     // 330 Hz, E4
  "tom.wav": 45,      // 110 Hz, A2
});

const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
// The pitch classes a piano plays on its black keys.
const BLACK = new Set([1, 3, 6, 8, 10]);

// divmod rather than %, so notes below C-1 still name correctly.
const pitchClass = (midi) => divmod(midi, 12)[1];

// "A3", "C♯5". Octave numbers change at C, with middle C as C4.
export function noteName(midi) {
  return `${NOTE_NAMES[pitchClass(midi)]}${divmod(midi, 12)[0] - 1}`;
}

export const isBlackKey = (midi) => BLACK.has(pitchClass(midi));
