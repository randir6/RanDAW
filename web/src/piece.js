// The Piece: everything needed to render, fully worked out.
//
// A spec is what the user wrote. A Piece is what that means: degrees resolved
// to semitones, beats counted from 0, the tempo turned into the length of the
// piece in audio samples, and every beat's place in it. Nothing about a
// Piece is left to interpret.
//
// buildPiece() is the only way to make one, and the single place where a spec
// is checked and resolved. It reads today's words (tempo, base, bars); a
// piece in the older words is turned into them first by upgradeSpec(), which
// the page does whenever it opens a piece.

import { roundHalfEven } from "./numbers.js";
import { CLICK_SAMPLE, pulsesPerBar } from "./schedule.js";
import { checkSettings, DEFAULT_BASE, layerFromSpec, SpecError } from "./spec.js";

export const DEFAULT_TEMPO = 120;
export const DEFAULT_SAMPLE_RATE = 44100;
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

  const bars = settings.bars ?? null;
  if (bars === null) throw new SpecError('need bars: e.g. "bars": 8');
  if (bars < 1) throw new SpecError(`bars must be >= 1, got ${bars}`);

  const base = settings.base ?? DEFAULT_BASE;
  if (base < 1) throw new SpecError(`base must be at least 1 beat per bar, got ${base}`);

  const sampleRate = settings.sample_rate ?? DEFAULT_SAMPLE_RATE;
  if (sampleRate < 1) throw new SpecError(`sample_rate must be > 0, got ${sampleRate}`);

  const click = settings.click;
  const tempo = settings.tempo ?? DEFAULT_TEMPO;
  if (tempo <= 0) throw new SpecError(`tempo must be > 0 BPM, got ${tempo}`);

  // The tempo is BPM of the base beat, so the base and the tempo set the bar:
  // 4 beats at 120 BPM is a 2-second bar.
  const requestedBar = (base * 60) / tempo;

  // How finely the bar is divided so that every beat of every layer, and
  // every base beat, lands on a whole number of pulses. Pulses keep the
  // musical arithmetic exact; they are never heard or shown. Adding a layer
  // divides the bar more finely -- it never makes the bar longer.
  const perBar = pulsesPerBar(layers, base);
  // Past this many, JavaScript's numbers could no longer count pulses
  // exactly. Only beat counts sharing almost no factors, over many bars, get
  // near it.
  if (bars * perBar > MAX_PULSES) {
    throw new SpecError(
      `these beat counts need ${perBar} pulses per bar, too fine to keep exact time over ${bars} bars; ` +
        `choose beat counts sharing more common factors, or fewer bars`,
    );
  }

  // The file is EXACTLY bars x the bar's length, rounded once to the nearest
  // audio sample, and every beat is placed at its exact share of it, again
  // rounded to the nearest sample (sampleAt in render.js). So a loop dropped
  // into a DAW or looper at the same tempo stays in time with it however many
  // times it goes round. Worked out from the settings in one expression, so
  // as little rounding as possible happens on the way.
  const totalSamples = roundHalfEven((bars * base * 60 * sampleRate) / tempo);
  if (totalSamples < 1) throw new SpecError(`a piece of ${bars} bars at ${tempo} BPM is under one sample long`);

  // The length of one bar as it is actually produced: the tempo's bar, give
  // or take that one rounding -- under half a sample across the whole piece.
  // One division, so that a bar that is exactly 2.8 s comes out as 2.8.
  const barDuration = totalSamples / (sampleRate * bars);

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
    // The tempo as asked for, in BPM of the base beat.
    tempo,
    pulsesPerBar: perBar,
    sampleRate,
    // The bar length the tempo asks for; barDuration is what is produced.
    requestedBar,
    // A private copy of the spec, so changing the original afterwards cannot
    // reach into a Piece that is supposed to be fixed. structuredClone copies
    // everything, lists inside objects inside lists included.
    spec: structuredClone(spec),
    // Things worth telling a person that are not reasons to refuse, shown by
    // the page. None today: the one there was (a bar rounded to fit a grid
    // of whole-sample pulses) went with that grid.
    warnings: Object.freeze([]),
    // Worked out once here from the settled values above, so they can never
    // disagree with them.
    totalPulses: bars * perBar,
    // The file's length, in samples: every pulse is placed at its share of it.
    totalSamples,
    pulseDuration: barDuration / perBar,
    barDuration,
    totalDuration: totalSamples / sampleRate,
  });
}
