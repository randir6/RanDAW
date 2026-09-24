// The Piece: everything needed to render, fully worked out.
//
// A spec is what the user wrote. A Piece is what that means: degrees resolved
// to semitones, beats counted from 0, the tempo turned into an exact number of
// audio samples per pulse, the length known to the sample. Nothing about a
// Piece is left to interpret.
//
// buildPiece() is the only way to make one, and the single place where a spec
// is checked and resolved.

import { roundHalfEven, toFixedHalfEven } from "./numbers.js";
import { lcmOfBeats } from "./schedule.js";
import { checkSettings, layerFromSpec, SpecError } from "./spec.js";

export const DEFAULT_CYCLE_DURATION = 2.0;
export const DEFAULT_SAMPLE_RATE = 44100;

// Check a spec and resolve it into a Piece, or throw SpecError saying why not.
//
// `samples` is the set of sample names available -- the page's library -- so
// a misspelt name fails here, straight away, rather than part-way through
// making the sound. `source` only appears in error messages.
//
// Deliberately NOT checked here: how long is too long. That is a policy for
// whatever is using the engine to decide, whereas everything below is simply
// true or false.
export function buildPiece(spec, { samples, source = "piece" }) {
  const settings = checkSettings(spec, source);

  const layers = spec.layer.map((entry, index) =>
    layerFromSpec(entry, {
      defaultScale: settings.scale,
      defaultRoot: settings.root,
      // index + 1 so errors say "layer 1" for the first layer, as a person would.
      where: `${source}: layer ${index + 1}`,
    }),
  );

  const loops = settings.loops ?? null;
  if (loops === null) throw new SpecError('need loops: e.g. "loops": 4');
  if (loops < 1) throw new SpecError(`loops must be >= 1, got ${loops}`);

  const sampleRate = settings.sample_rate ?? DEFAULT_SAMPLE_RATE;
  if (sampleRate < 1) throw new SpecError(`sample_rate must be > 0, got ${sampleRate}`);

  const lcmBeats = lcmOfBeats(layers);
  const warnings = [];

  // Two ways to set the tempo; checkSettings has already refused both at once.
  let samplesPerPulse, requestedCycle;
  if (Object.hasOwn(settings, "pulse_duration")) {
    const pulseDuration = settings.pulse_duration;
    if (pulseDuration <= 0) throw new SpecError(`pulse duration must be > 0, got ${pulseDuration}`);
    samplesPerPulse = roundHalfEven(pulseDuration * sampleRate);
    requestedCycle = null;
  } else {
    requestedCycle = settings.cycle_duration ?? DEFAULT_CYCLE_DURATION;
    if (requestedCycle <= 0) throw new SpecError(`cycle duration must be > 0, got ${requestedCycle}`);
    // Share the cycle out across the grid. This is the line that makes adding
    // a layer subdivide the cycle rather than stretch it: a bigger LCM
    // produces a finer grid, not a longer piece.
    samplesPerPulse = roundHalfEven((requestedCycle * sampleRate) / lcmBeats);
  }

  if (samplesPerPulse < 1) {
    throw new SpecError(
      `a ${requestedCycle}s cycle split across an LCM of ${lcmBeats} pulses leaves under one ` +
        `sample per pulse; lengthen the cycle or choose beat counts sharing more common factors`,
    );
  }

  // Work back from the rounded whole number to the cycle length we'll
  // ACTUALLY produce, which may differ slightly from what was asked for. Only
  // worth mentioning past 1% -- below that it's inaudible, and warning about
  // the inaudible teaches people to ignore warnings.
  const cycleDuration = (lcmBeats * samplesPerPulse) / sampleRate;
  if (requestedCycle !== null && Math.abs(cycleDuration - requestedCycle) > requestedCycle / 100) {
    warnings.push(
      `cycle rounded to ${toFixedHalfEven(cycleDuration, 4)}s from ` +
        `${toFixedHalfEven(requestedCycle, 4)}s -- an LCM of ${lcmBeats} ` +
        `does not divide the sample rate evenly`,
    );
  }

  // Every sample must exist in the library. Checked now, so a typo fails
  // immediately rather than part-way through making the sound.
  const known = new Set(samples);
  const missing = layers.map((layer) => layer.sample).filter((name) => !known.has(name));
  if (missing.length > 0) {
    const available = [...known].sort().join(", ") || "none";
    throw new SpecError(`unknown sample ${missing.join(", ")}. This page has: ${available}`);
  }

  // Which layers sound. If any layer is soloed, exactly the soloed ones;
  // otherwise every layer that is not muted. Solo wins over mute, as on a
  // mixing desk: soloing a muted layer lets you hear it on its own.
  const anySolo = layers.some((layer) => layer.solo);
  const audible = layers.map((layer) => (anySolo ? layer.solo : !layer.mute));

  return Object.freeze({
    layers: Object.freeze(layers),
    audible: Object.freeze(audible),
    loops,
    samplesPerPulse,
    sampleRate,
    // The cycle length asked for, or null when the tempo was given as a pulse
    // duration instead.
    requestedCycle,
    // A private copy of the spec, so changing the original afterwards cannot
    // reach into a Piece that is supposed to be fixed. structuredClone copies
    // everything, lists inside objects inside lists included.
    spec: structuredClone(spec),
    warnings: Object.freeze(warnings),
    // Worked out once here from the settled values above, so they can never
    // disagree with them.
    lcmBeats,
    totalPulses: loops * lcmBeats,
    pulseDuration: samplesPerPulse / sampleRate,
    cycleDuration,
    totalDuration: loops * cycleDuration,
  });
}
