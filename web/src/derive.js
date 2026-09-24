// Everything a display needs, worked out from a Piece.
//
// A saved piece has two halves:
//
//   {
//     "format": "randaw-piece", "version": 1,
//     "spec":    { ... },   what the user wrote -- loads back in
//     "derived": { ... },   everything worked out from it -- timing, the grid
//   }
//
// The spec half round-trips. The derived half is one-way: it is everything
// the drawing needs, fully worked out HERE, so the drawing code only draws and
// never repeats a musical rule.
//
// Numbering rule inside `derived`: counts a musician would say out loud --
// cycle 1, beat 3 -- start at 1, matching how beats and degrees are written
// everywhere else. Positions in a list -- `layer`, `step` -- start at 0,
// because they index the lists beside them.
//
// The key names are snake_case because this is a data format, and it stayed
// the same shape when the engine moved from Python to JavaScript.

import { roundTo } from "./numbers.js";
import { grid, STATUS_NOTE } from "./schedule.js";
import { EXPORT_FORMAT, EXPORT_VERSION } from "./spec.js";

// Six decimal places is a microsecond -- far finer than anyone can hear or
// see -- and keeps the file readable instead of full of 0.30000000000000004.
const PLACES = 6;

// A sample's name without its extension: "kick.wav" -> "kick".
export function sampleStem(name) {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  // dot > 0 rather than >= 0: a name like ".wav" is all name, no extension.
  return dot > 0 ? base.slice(0, dot) : base;
}

// A layer written as notes that are all 0 is a drum: no melody, just hits.
// Displayed as x marks rather than a row of zeros.
function isPercussive(layer) {
  return layer.pitchKind === "notes" && layer.notes.every((n) => n === 0 || n === null);
}

// What to print at one position, in the user's own notation.
function label(layer, step, percussive) {
  const value = layer.written[step];
  if (value === null) return "-";
  if (percussive) return "x";
  return String(value);
}

export function pieceToDerived(piece) {
  const layersInfo = piece.layers.map((layer, index) => {
    const percussive = isPercussive(layer);
    const pitches = layer.notes.filter((n) => n !== null);
    return {
      layer: index,
      name: sampleStem(layer.sample),
      sample: layer.sample.slice(layer.sample.lastIndexOf("/") + 1),
      beats: layer.beats,
      gain: layer.gain,
      pitch_kind: layer.pitchKind,
      percussive,
      scale: layer.scale,
      root: layer.root,
      sequence: layer.written.map((w) => (w === null ? "-" : w)),
      // The same sequence as a display should print it: drums as x.
      sequence_labels: layer.written.map((_, step) => label(layer, step, percussive)),
      // Back to 1-based for anything a person reads. Sets have no order, so
      // sort them -- and sort needs telling to compare as numbers, because by
      // default JavaScript sorts everything as text, putting 10 before 9.
      active: layer.activeBeats === null
        ? null
        : [...layer.activeBeats].map((b) => b + 1).sort((a, b) => a - b),
      // The layer's own pitch range, so each row of a display can spread its
      // notes across the full height. A shared range would flatten a narrow
      // melody sitting next to a wide one.
      pitch_low: Math.min(...pitches),
      pitch_high: Math.max(...pitches),
      mute: layer.mute,
      solo: layer.solo,
      // Whether it sounds, once every layer's mute and solo are taken into
      // account. A silent layer is still drawn, faded.
      audible: piece.audible[index],
    };
  });

  const cells = [];
  // Which layers sound at each pulse. A Map is a dictionary whose keys can be
  // anything -- here, numbers -- and which remembers the order keys arrived.
  const notesAtPulse = new Map();
  for (const cell of grid(piece.layers, piece.loops)) {
    const info = layersInfo[cell.layer];
    const low = info.pitch_low, high = info.pitch_high;
    const height = info.percussive || cell.semitones === null || high === low
      ? 0.5
      : (cell.semitones - low) / (high - low);

    cells.push({
      layer: cell.layer,
      cycle: cell.cycle + 1,
      beat: cell.beat + 1,
      step: cell.step,
      pulse: cell.pulse,
      time: roundTo(cell.pulse * piece.pulseDuration, PLACES),
      // How far through its cycle this beat falls, 0 to just under 1. A
      // display lays each cycle out across the same width, so this is all it
      // needs to place the beat -- and it is identical for beats in different
      // layers that land at the same instant.
      offset: roundTo(cell.beat / piece.layers[cell.layer].beats, PLACES),
      status: cell.status,
      semitones: cell.semitones,
      label: label(piece.layers[cell.layer], cell.step, info.percussive),
      height: roundTo(height, PLACES),
    });
    // Only layers you can hear count towards "sounding together".
    if (cell.status === STATUS_NOTE && piece.audible[cell.layer]) {
      if (!notesAtPulse.has(cell.pulse)) notesAtPulse.set(cell.pulse, new Set());
      notesAtPulse.get(cell.pulse).add(cell.layer);
    }
  }

  // Instants where two or more layers sound together. Worked out here so the
  // display can simply draw them, and so the rule for what counts as
  // "together" (exactly the same pulse) lives with the other rules.
  const lcmBeats = piece.lcmBeats;
  const coincidences = [...notesAtPulse.entries()]
    .filter(([, layers]) => layers.size >= 2)
    .sort(([a], [b]) => a - b)
    .map(([pulse, layers]) => ({
      pulse,
      time: roundTo(pulse * piece.pulseDuration, PLACES),
      cycle: Math.floor(pulse / lcmBeats) + 1,
      offset: roundTo((pulse % lcmBeats) / lcmBeats, PLACES),
      layers: [...layers].sort((a, b) => a - b),
    }));

  return {
    sample_rate: piece.sampleRate,
    loops: piece.loops,
    lcm: lcmBeats,
    samples_per_pulse: piece.samplesPerPulse,
    pulse_duration: roundTo(piece.pulseDuration, 9),
    cycle_duration: roundTo(piece.cycleDuration, 9),
    total_duration: roundTo(piece.totalDuration, 9),
    warnings: [...piece.warnings],
    layers: layersInfo,
    cells,
    coincidences,
  };
}

// The whole saved form: what the user wrote, plus everything worked out.
export function pieceToExport(piece) {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    spec: structuredClone(piece.spec),
    derived: pieceToDerived(piece),
  };
}
