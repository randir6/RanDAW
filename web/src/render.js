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
export function renderAudio(events, { totalPulses, samplesPerPulse, sampleRate, library }) {
  // Start with silence, the full length of the piece; everything adds into
  // it. new Float32Array(n) is n zeros.
  const mix = new Float32Array(totalPulses * samplesPerPulse);

  // Two caches, so repeated work happens once. A 13-beat layer over 4 cycles
  // is 52 notes, but only a handful of distinct sounds.
  const samples = new Map();  // name -> mono audio at this sample rate
  const voices = new Map();   // name + pitch + gain -> the finished sound

  for (const event of events) {
    if (!samples.has(event.sample)) {
      samples.set(event.sample, prepareSample(library.get(event.sample), sampleRate));
    }
    // These three together decide what a note sounds like, so any note
    // sharing all three can reuse the same computed audio. Joined into one
    // text key because a Map compares list keys by identity, not contents.
    const key = `${event.sample}|${event.semitones}|${event.gain}`;
    if (!voices.has(key)) {
      const source = samples.get(event.sample);
      // Gain first, then pitch: the same order as the Python version, since
      // changing the order would change the last digit of some samples.
      // Math.fround rounds the gain to 32 bits first, as numpy did.
      const gain = Math.fround(event.gain);
      const scaled = source.map((x) => x * gain);
      voices.set(key, pitchShift(scaled, event.semitones));
    }
    addWrapped(mix, event.pulse * samplesPerPulse, voices.get(key));
  }
  return mix;
}

// The finished mix, held inside -1..+1, and how loud it got before that.
//
// Values past 1 cannot be stored in a 16-bit file; left alone they would wrap
// round into loud noise. Clipping flattens them instead -- still audible as
// distortion, which is why the peak is reported so the page can warn.
export function finishMix(mix) {
  let peak = 0;
  for (const x of mix) peak = Math.max(peak, Math.abs(x));
  const clipped = peak > 1 ? mix.map((x) => Math.max(-1, Math.min(1, x))) : mix;
  return { mix: clipped, peak };
}
