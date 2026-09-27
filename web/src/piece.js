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
import { CLICK_SAMPLE, pulsesPerBar } from "./schedule.js";
import { checkSettings, DEFAULT_BASE, layerFromSpec, SpecError } from "./spec.js";

export const DEFAULT_TEMPO = 120;
export const DEFAULT_SAMPLE_RATE = 44100;
// What an older piece with no timing at all got: a 2-second bar.
const LEGACY_BAR_SECONDS = 2.0;
// The most pulses a piece may have, so every pulse is still a whole number
// JavaScript can count exactly (2^53, with room to spare for arithmetic).
const MAX_PULSES = 2 ** 44;

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

  // Older pieces called the length `loops`; checkSettings has refused both.
  const bars = settings.bars ?? settings.loops ?? null;
  if (bars === null) throw new SpecError('need bars: e.g. "bars": 8');
  if (bars < 1) throw new SpecError(`bars must be >= 1, got ${bars}`);

  const base = settings.base ?? DEFAULT_BASE;
  if (base < 1) throw new SpecError(`base must be at least 1 beat per bar, got ${base}`);

  const sampleRate = settings.sample_rate ?? DEFAULT_SAMPLE_RATE;
  if (sampleRate < 1) throw new SpecError(`sample_rate must be > 0, got ${sampleRate}`);

  const click = settings.click;
  const warnings = [];

  // Two ways of timing a piece.
  //
  // TODAY'S: a tempo in BPM of the base beat. 4 beats at 120 BPM is a
  // 2-second bar, and the file is EXACTLY that long: bars x bar length,
  // rounded once to the nearest audio sample. Each beat is placed at its
  // exact fraction of the piece, again rounded to the nearest sample. So a
  // loop dropped into a DAW or looper at the same tempo stays in time with it
  // however many times it goes round. The base joins the pulse grid, so its
  // beats land exactly.
  //
  // OLDER pieces gave the bar's length in seconds (cycle_duration), or the
  // length of one pulse (pulse_duration). They are timed exactly as they
  // always were -- every pulse a whole number of samples, the base out of the
  // grid unless the click needs it -- so they sound identical, to the byte.
  // That timing made the bar only roughly the length asked for (8 bars of a
  // 2.4 s bar could come out 15 ms long), which is why today's is different.
  //
  // Either way the result is a whole number of samples for the piece
  // (totalSamples), and every pulse is placed at its share of it -- see
  // sampleAt() in render.js. For an older piece that share always works out
  // to a whole number of samples per pulse, as it always did.
  let perBar, samplesPerPulse, requestedBar, totalSamples;
  if (!settings.legacy) {
    const tempo = settings.tempo ?? DEFAULT_TEMPO;
    if (tempo <= 0) throw new SpecError(`tempo must be > 0 BPM, got ${tempo}`);
    requestedBar = (base * 60) / tempo;
    perBar = pulsesPerBar(layers, base);
    // Worked out from the settings in one expression, rather than from
    // requestedBar, so as little rounding as possible happens on the way.
    totalSamples = roundHalfEven((bars * base * 60 * sampleRate) / tempo);
    if (totalSamples < 1) throw new SpecError(`a piece of ${bars} bars at ${tempo} BPM is under one sample long`);
    // Pulses stay whole numbers so the arithmetic stays exact; past this
    // many, JavaScript's numbers could no longer count them exactly. Only
    // beat counts sharing almost no factors, over many bars, get near it.
    if (bars * perBar > MAX_PULSES) {
      throw new SpecError(
        `these beat counts need ${perBar} pulses per bar, too fine to keep exact time over ${bars} bars; ` +
          `choose beat counts sharing more common factors, or fewer bars`,
      );
    }
    // Not a whole number any more: beats fall between samples and are
    // rounded to the nearest one where they land.
    samplesPerPulse = null;
  } else {
    perBar = pulsesPerBar(layers, click ? base : null);
    if (Object.hasOwn(settings, "pulse_duration")) {
      const pulseDuration = settings.pulse_duration;
      if (pulseDuration <= 0) throw new SpecError(`pulse_duration must be > 0, got ${pulseDuration}`);
      samplesPerPulse = roundHalfEven(pulseDuration * sampleRate);
      requestedBar = null;
    } else {
      requestedBar = settings.cycle_duration ?? LEGACY_BAR_SECONDS;
      if (requestedBar <= 0) throw new SpecError(`cycle_duration must be > 0, got ${requestedBar}`);
      // Share the bar out across the pulse grid. This is the line that makes
      // adding a layer subdivide the bar rather than stretch it: more pulses
      // make a finer grid, not a longer piece.
      samplesPerPulse = roundHalfEven((requestedBar * sampleRate) / perBar);
    }
    if (samplesPerPulse < 1) {
      throw new SpecError(
        `a ${requestedBar}s bar split into ${perBar} pulses leaves under one sample per pulse; ` +
          `slow the tempo, or choose beat counts sharing more common factors`,
      );
    }
    totalSamples = bars * perBar * samplesPerPulse;
    // Work back from the rounded whole number to the bar length we'll
    // ACTUALLY produce, which may differ slightly from what was asked for.
    // Only worth mentioning past 1% -- below that it's inaudible, and warning
    // about the inaudible teaches people to ignore warnings.
    const produced = (perBar * samplesPerPulse) / sampleRate;
    if (requestedBar !== null && Math.abs(produced - requestedBar) > requestedBar / 100) {
      warnings.push(
        `bar rounded to ${toFixedHalfEven(produced, 4)}s from ` +
          `${toFixedHalfEven(requestedBar, 4)}s -- ${perBar} pulses per bar ` +
          `do not divide the sample rate evenly`,
      );
    }
  }

  // The length of one bar as it is actually produced. For today's pieces
  // that is the tempo's bar, give or take the one rounding of the whole
  // file's length -- under half a sample across the whole piece. (Older
  // pieces keep the arithmetic they always had, to the last digit.)
  const barDuration = samplesPerPulse === null
    ? totalSamples / (sampleRate * bars)
    : (perBar * samplesPerPulse) / sampleRate;

  // Every sample must exist in the library. Checked now, so a typo fails
  // immediately rather than part-way through making the sound.
  const known = new Set(samples);
  const needed = layers.map((layer) => layer.sample).concat(click ? [CLICK_SAMPLE] : []);
  const missing = needed.filter((name) => !known.has(name));
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
    bars,
    base,
    click,
    // The tempo as asked for (or, for an older piece, as its bar length
    // works out), in BPM of the base beat.
    tempo: (base * 60) / (requestedBar ?? barDuration),
    // True for a piece in the older words, timed the older way.
    legacy: settings.legacy,
    pulsesPerBar: perBar,
    // Whole samples per pulse for an older piece; null for today's, whose
    // beats are placed at their exact time instead.
    samplesPerPulse,
    sampleRate,
    // The bar length asked for, or null when an older piece gave a pulse
    // duration instead.
    requestedBar,
    // A private copy of the spec, so changing the original afterwards cannot
    // reach into a Piece that is supposed to be fixed. structuredClone copies
    // everything, lists inside objects inside lists included.
    spec: structuredClone(spec),
    warnings: Object.freeze(warnings),
    // Worked out once here from the settled values above, so they can never
    // disagree with them.
    totalPulses: bars * perBar,
    // The file's length, in samples: every pulse is placed at its share of it.
    totalSamples,
    pulseDuration: samplesPerPulse === null ? barDuration / perBar : samplesPerPulse / sampleRate,
    barDuration,
    totalDuration: samplesPerPulse === null ? totalSamples / sampleRate : bars * barDuration,
  });
}
