// Turning a schedule into sound.
//
// The counterpart to schedule.js: that decides *when*, this makes the noise.
// It has no idea what a layer or a polyrhythm is -- it just drops sounds into
// a buffer at the positions it is told.

import { pitchShift, prepareSample } from "./audio.js";

// Add `audio` into `buffer` at `start`, wrapping past the end back to the
// beginning. A note whose tail runs off the end carries into the next repeat
// instead of being cut off, so the piece loops without a click.
//
// This changes `buffer` itself rather than returning a new one.
function addWrapped(buffer, start, audio) {
  let pos = start % buffer.length;
  let from = 0;
  // Each pass writes as much as fits before the end of the buffer, then
  // carries on from position 0 -- so a sound longer than the whole buffer
  // simply wraps more than once.
  while (from < audio.length) {
    const count = Math.min(audio.length - from, buffer.length - pos);
    for (let i = 0; i < count; i++) {
      // += is MIXING: overlapping sounds sum together, exactly as air
      // pressure does. Storing into a Float32Array rounds to 32 bits.
      buffer[pos + i] += audio[from + i];
    }
    from += count;
    pos = 0;
  }
}

// Mix a schedule down to one Float32Array.
//
// `library` maps each sample's name to its decoded audio (from wav.js). Knows
// nothing about layers, beat counts or polyrhythm -- only where each note
// lands and how it should sound.
//
// `cache`, if given, is a Map that remembers finished sounds from one render
// to the next. The editor passes the same one every time: an edit usually
// changes one layer, so most notes' sounds are already made. A sound depends
// only on its sample, pitch, gain and the sample rate, so a remembered one is
// always exactly right. Without a cache, each render starts from scratch.
export function renderAudio(events, { totalPulses, totalSamples, sampleRate, library, cache = new Map() }) {
  // Start with silence, the full length of the piece; everything adds into
  // it. new Float32Array(n) is n zeros.
  const mix = new Float32Array(totalSamples);

  for (const event of events) {
    // These together decide what a note sounds like, so any note sharing all
    // of them can reuse the same computed audio. Joined into one text key
    // because a Map compares list keys by identity, not contents.
    const key = `${event.sample}|${sampleRate}|${event.semitones}|${event.gain}`;
    if (!cache.has(key)) cache.set(key, makeVoice(library.get(event.sample), event, sampleRate, cache));
    addWrapped(mix, sampleAt(event.pulse, totalPulses, totalSamples), cache.get(key));
  }
  return mix;
}

// Which audio sample a pulse starts on: its exact share of the piece, rounded
// to the nearest sample. A beat two-thirds of the way through a 1000-sample
// piece starts on sample 667.
//
// Divided first and multiplied after, because pulse x totalSamples could be
// too big for a JavaScript number to hold exactly. The tiny error that
// leaves is far below half a sample, so it only matters for a beat exactly
// halfway between two samples -- which then goes the same way on every
// device, since every browser does this arithmetic identically. When a pulse
// is a whole number of samples (as in every older piece), that whole number
// is exactly what comes back.
export function sampleAt(pulse, totalPulses, totalSamples) {
  return Math.round((pulse / totalPulses) * totalSamples);
}

// One note's sound: its sample at the piece's rate, scaled by its gain, then
// pitch-shifted. Gain first, then pitch: the same order as the Python
// version, since changing the order would change the last digit of some
// samples.
function makeVoice(decoded, event, sampleRate, cache) {
  // The sample itself, mono at this rate, is worth remembering too.
  const sourceKey = `${event.sample}|${sampleRate}`;
  if (!cache.has(sourceKey)) cache.set(sourceKey, prepareSample(decoded, sampleRate));
  const source = cache.get(sourceKey);
  // Math.fround rounds the gain to 32 bits first, as numpy did. A plain loop
  // rather than .map(), which calls a function per sample and is much slower.
  const gain = Math.fround(event.gain);
  const scaled = new Float32Array(source.length);
  for (let i = 0; i < source.length; i++) scaled[i] = source[i] * gain;
  return pitchShift(scaled, event.semitones);
}

// The finished mix, held inside -1..+1, and how loud it got before that.
//
// Values past 1 cannot be stored in a 16-bit file; left alone they would wrap
// round into loud noise. Clipping flattens them instead -- still audible as
// distortion, which is why the peak is reported so the page can warn.
export function finishMix(mix) {
  // Plain index loops: this runs over every sample, and for-of or .map()
  // would call extra functions for each one.
  let peak = 0;
  for (let i = 0; i < mix.length; i++) {
    const size = Math.abs(mix[i]);
    if (size > peak) peak = size;
  }
  if (peak <= 1) return { mix, peak };
  const clipped = new Float32Array(mix.length);
  for (let i = 0; i < mix.length; i++) clipped[i] = Math.max(-1, Math.min(1, mix[i]));
  return { mix: clipped, peak };
}
