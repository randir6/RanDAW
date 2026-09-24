// Working out WHEN every note happens. No audio anywhere in this file.
//
// This is the musical heart of the project. Two views of the same thing come
// out of here:
//
//   * the GRID -- every beat of every layer in every cycle, including the
//     ones that stay silent. What a picture of the piece needs.
//   * the SCHEDULE -- only the beats that actually sound. What the renderer
//     needs.
//
// Both come from one loop (walk() below), so they cannot disagree about where
// anything falls.

import { lcm } from "./numbers.js";

// What happened at one position in the grid.
export const STATUS_NOTE = "note";          // this beat sounds
export const STATUS_REST = "rest";          // a rest in the sequence: travels with the sequence
export const STATUS_INACTIVE = "inactive";  // this beat is switched off: same place every cycle

// Lowest common multiple of all the layers' beat counts: the number of pulses
// in one cycle. For 3 and 4 it is 12, the first number both go into.
// .reduce() folds a list down to one value, here by taking the lcm of the
// running answer with each beat count in turn.
export function lcmOfBeats(layers) {
  return layers.reduce((running, layer) => lcm(running, layer.beats), 1);
}

// Visit every beat of every layer in every cycle, saying what happens there.
//
// The `function*` makes this a GENERATOR: `yield` hands back one cell and
// pauses right there, carrying on from the same spot when the next one is
// asked for. Nothing is stored along the way; each caller decides what to
// keep -- grid() keeps everything, schedule() keeps only the notes.
//
// The shared timeline is divided into pulses: the finest grid on which every
// layer's beats land. A layer with `beats` beats fires once every
// (lcm / beats) pulses, so all layers complete one full cycle in the same
// span -- which is what makes it a polyrhythm rather than beats of different
// lengths playing side by side.
//
// Worked example, a 3-beat layer against a 4-beat one:
//
//     LCM(3, 4) = 12, so one cycle is 12 pulses long.
//     The 3-beat layer steps 12 / 3 = 4 pulses between hits -> 0, 4, 8
//     The 4-beat layer steps 12 / 4 = 3 pulses between hits -> 0, 3, 6, 9
//
//     pulse:  0  1  2  3  4  5  6  7  8  9 10 11
//     3-beat: x        .  x     .     x     .
//     4-beat: x     .     .  x     .     x
//
// Both fill the same 12 pulses, so both complete a cycle in the same amount
// of time. That is the whole trick.
function* walk(layers, loops) {
  const lcmBeats = lcmOfBeats(layers);

  // .entries() gives [position, item] pairs, like Python's enumerate().
  for (const [layerIndex, layer] of layers.entries()) {
    // Always exact, because the LCM is by definition a multiple of every
    // layer's beat count.
    const pulsesPerBeat = lcmBeats / layer.beats;

    for (let cycle = 0; cycle < loops; cycle++) {
      for (let beat = 0; beat < layer.beats; beat++) {
        // Count this layer's beats from the very start, continuing across
        // cycles rather than restarting, so a 3-beat layer's second cycle
        // begins at beat 3 of the sequence.
        const occurrence = cycle * layer.beats + beat;

        // % wraps the counter back to 0 when it runs off the end of the
        // sequence. (Safe here: both numbers are positive. See numbers.js
        // for why % needs care with negative ones.)
        //
        // Because the counter keeps running, a 5-note sequence on a 3-beat
        // layer lines up differently each cycle -- the sequence phases
        // against the beat count. Give the sequence a length equal to the
        // beat count, or a multiple of it, and you get a plainly composed
        // pattern instead. Both are the same model.
        const step = occurrence % layer.notes.length;
        const semitones = layer.notes[step];

        // What happens here. The order of these tests matters: a beat that is
        // switched off is silent whatever the sequence says.
        //
        // INACTIVE -- the same beat is silent every cycle. It does NOT hold
        // the sequence back: the note this beat would have played is simply
        // not heard. Muting a step on a drum machine rather than deleting it.
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
          cycle,
          beat,
          // Two parts: whole cycles already gone by, plus the way into this one.
          pulse: cycle * lcmBeats + beat * pulsesPerBeat,
          step,
          status,
          // The resolved pitch. null for a rest; for an inactive beat, the
          // pitch it WOULD have played, so a picture can show it greyed out.
          semitones,
        };
      }
    }
  }
}

// Time order: by pulse, and for the same pulse by layer, so the result is
// always the same rather than depending on the order things were found in.
// A sort "comparator" returns a negative number if a comes first, positive if
// b does. `||` moves on to the layer only when the pulses are equal (0).
const byTime = (a, b) => a.pulse - b.pulse || a.layer - b.layer;

// Every beat of every layer in every cycle, silent ones included, in time
// order. What a picture of the piece is drawn from.
export function grid(layers, loops) {
  // [...walk()] runs the generator to the end, collecting what it yields.
  return [...walk(layers, loops)].sort(byTime);
}

// Every note in the piece, in time order. What the renderer plays. Built from
// the same walk as the grid, keeping only the beats that sound.
export function schedule(layers, loops) {
  const events = [];
  for (const cell of walk(layers, loops)) {
    if (cell.status !== STATUS_NOTE) continue;
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
  return events.sort(byTime);
}
