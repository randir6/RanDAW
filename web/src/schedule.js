// Working out WHEN every note happens. No audio anywhere in this file.
//
// This is the musical heart of the project. Two views of the same thing come
// out of here:
//
//   * the GRID -- every beat of every layer in every bar, including the ones
//     that stay silent. What a picture of the piece needs.
//   * the SCHEDULE -- only the beats that actually sound, plus the click if
//     it is on. What the renderer needs.
//
// Both come from one loop (walk() below), so they cannot disagree about where
// anything falls.

import { gcd, lcm } from "./numbers.js";

// What happened at one beat of the grid.
export const STATUS_NOTE = "note";          // this beat sounds
export const STATUS_REST = "rest";          // a rest in the sequence: travels with the sequence
export const STATUS_INACTIVE = "inactive";  // this beat is switched off: the same beat every time round

// The click (the base beat made audible): a short tick, higher on the first
// beat of each bar so you can hear where the bar starts.
export const CLICK_SAMPLE = "click.wav";
export const CLICK_GAIN = 0.5;
export const CLICK_DOWNBEAT = 7;  // semitones up on beat 1: a fifth higher

// How many PULSES make up one bar: the finest grid on which every beat of
// every layer lands. Pulses are inside the engine only -- nobody composes in
// them -- but every position in time is a whole number of them, which is what
// keeps the arithmetic exact.
//
// A layer of 3 beats over 1 bar needs the bar split into 3; 4 beats needs 4;
// both at once need 12, the lowest common multiple. A layer of 7 beats over 2
// bars needs 7 pulses per TWO bars -- still 7 per bar once the two bars are
// cut in 7 each -- and in general beats / gcd(beats, over) per bar. (6 beats
// over 2 bars is just 3 per bar, so it needs only 3.)
//
// `base`, when given, joins in too, so the base beats -- the click, and the
// faint lines in the picture -- land on pulses as well. Older pieces are
// timed without it (see buildPiece), which is why it is optional.
//
// .reduce() folds a list down to one value, here by taking the lcm of the
// running answer with each layer's need in turn.
export function pulsesPerBar(layers, base = null) {
  const layersNeed = layers.reduce(
    (running, layer) => lcm(running, layer.beats / gcd(layer.beats, layer.over)), 1);
  return base === null ? layersNeed : lcm(layersNeed, base);
}

// Visit every beat of every layer across the piece, saying what happens
// there.
//
// The `function*` makes this a GENERATOR: `yield` hands back one cell and
// pauses right there, carrying on from the same spot when the next one is
// asked for. Nothing is stored along the way; each caller decides what to
// keep -- grid() keeps everything, schedule() keeps only the notes.
//
// Each layer lays its beats evenly across its span of bars, so all layers
// share the bar line even though their beats fall in different places --
// which is what makes it a polyrhythm rather than beats of different lengths
// playing side by side.
//
// Worked example, 3 beats against 4, both over 1 bar:
//
//     12 pulses per bar (the lcm of 3 and 4).
//     The 3-beat layer is 12 / 3 = 4 pulses between beats -> 0, 4, 8
//     The 4-beat layer is 12 / 4 = 3 pulses between beats -> 0, 3, 6, 9
//
//     pulse:  0  1  2  3  4  5  6  7  8  9 10 11
//     3-beat: x        .  x     .     x     .
//     4-beat: x     .     .  x     .     x
//
// Both fill the same 12 pulses, so both come round in the same time. That is
// the whole trick. A layer over 2 bars simply spreads its beats across 24.
function* walk({ layers, bars, pulsesPerBar: perBar }) {
  const end = bars * perBar;

  // .entries() gives [index, item] pairs, like Python's enumerate().
  for (const [layerIndex, layer] of layers.entries()) {
    // Always exact, because pulsesPerBar() made sure this layer's beats land
    // on pulses.
    const spacing = (perBar * layer.over) / layer.beats;

    // Count this layer's beats from the very start of the piece. The count
    // keeps running rather than restarting each bar, so a 3-beat layer's
    // second bar begins at position 3 of its sequence. A layer over 2 bars
    // in a 3-bar piece just stops half-way through its second span.
    for (let count = 0; count * spacing < end; count++) {
      const pulse = count * spacing;

      // Which of the layer's beats this is, 0 up to beats - 1: the same beat
      // each time the layer comes round its span of bars.
      const beat = count % layer.beats;

      // % wraps the count back to 0 when it runs off the end of the
      // sequence. (Safe here: both numbers are positive. See numbers.js for
      // why % needs care with negative ones.)
      //
      // Because the count keeps running, a 5-note sequence on a 3-beat layer
      // lines up differently each time round -- the sequence phases against
      // the beats. Give the sequence a length equal to the beat count, or a
      // multiple of it, and you get a plainly composed pattern instead. Both
      // are the same model.
      const position = count % layer.notes.length;
      const semitones = layer.notes[position];

      // What happens here. The order of these tests matters: a beat that is
      // switched off is silent whatever the sequence says.
      //
      // INACTIVE -- the same beat is silent every time round. It does NOT
      // hold the sequence back: the note this beat would have played is
      // simply not heard. Muting a step on a drum machine rather than
      // deleting it.
      //
      // REST -- a rest in the sequence travels with the SEQUENCE, so when
      // the sequence and the beat count are different lengths, the silence
      // lands on a different beat each time round.
      let status;
      if (layer.activeBeats !== null && !layer.activeBeats.has(beat)) status = STATUS_INACTIVE;
      else if (semitones === null) status = STATUS_REST;
      else status = STATUS_NOTE;

      yield {
        layer: layerIndex,
        // Which bar this beat falls in, from 0.
        bar: Math.floor(pulse / perBar),
        beat,
        pulse,
        position,
        status,
        // The resolved pitch. null for a rest; for an inactive beat, the
        // pitch it WOULD have played, so a picture can show it greyed out.
        semitones,
      };
    }
  }
}

// Time order: by pulse, and for the same pulse by layer, so the result is
// always the same rather than depending on the order things were found in.
// A sort "comparator" returns a negative number if a comes first, positive if
// b does. `||` moves on to the layer only when the pulses are equal (0).
const byTime = (a, b) => a.pulse - b.pulse || a.layer - b.layer;

// Every beat of every layer across the piece, silent ones included, in time
// order. What a picture of the piece is drawn from.
//
// Takes a Piece (from buildPiece), or anything with the same `layers`,
// `bars` and `pulsesPerBar`.
export function grid(piece) {
  // [...walk()] runs the generator to the end, collecting what it yields.
  return [...walk(piece)].sort(byTime);
}

// Every note in the piece, in time order. What the renderer plays. Built from
// the same walk as the grid, keeping only the beats that sound.
//
// `piece.audible`, if there, is a true/false per layer: layers that are
// muted, or silenced by another layer's solo, are left out. The grid keeps
// them, so they can still be drawn.
//
// With `piece.click` on, the base beats are added too, marked with a layer
// number one past the last real layer.
export function schedule(piece) {
  const { layers, audible = null } = piece;
  const events = [];
  for (const cell of walk(piece)) {
    if (cell.status !== STATUS_NOTE) continue;
    if (audible !== null && !audible[cell.layer]) continue;
    const layer = layers[cell.layer];
    events.push({
      layer: cell.layer,
      beat: cell.beat,
      pulse: cell.pulse,
      semitones: cell.semitones,
      // Copied onto the event rather than referenced, so it can be rendered
      // or exported without the layer it came from.
      sample: layer.sample,
      gain: layer.gain,
    });
  }
  if (piece.click) {
    const every = piece.pulsesPerBar / piece.base;
    for (let beat = 0; beat < piece.bars * piece.base; beat++) {
      const first = beat % piece.base === 0;
      events.push({
        layer: layers.length,
        beat: beat % piece.base,
        pulse: beat * every,
        semitones: first ? CLICK_DOWNBEAT : 0,
        sample: CLICK_SAMPLE,
        gain: CLICK_GAIN,
      });
    }
  }
  return events.sort(byTime);
}
