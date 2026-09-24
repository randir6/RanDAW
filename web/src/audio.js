// Preparing samples, and bending their pitch.
//
// Audio here is a Float32Array: a fixed-length list of 32-bit decimal
// numbers between -1 and +1, one per sample. At 44100 samples a second, a
// one-second sound is 44100 of them. "Sample" is unfortunately overloaded in
// audio: it means both "a short sound you trigger" and "one measurement of a
// waveform". Here it usually means the second.
//
// Why 32-bit, when ordinary JavaScript numbers are 64-bit? Half the memory,
// and it is what the Python version used -- every value stored into a
// Float32Array is rounded to 32 bits, exactly as numpy's float32 arrays did,
// which is part of how the two produce identical files.

import { roundHalfEven } from "./numbers.js";

// Stretch or squash a sound to a new length, inventing in-between values by
// drawing straight lines between neighbouring samples ("linear
// interpolation"). Crude but fast; a studio-grade resampler would fit smooth
// curves instead.
//
// This follows the steps of numpy's np.linspace and np.interp exactly,
// including where each position is computed and how, because the tiniest
// difference in a position changes the last digit of a sample.
export function resampleLinear(data, newLength) {
  if (newLength === data.length) return data;

  const n = data.length;
  // Both the old and new sounds are laid along the same 0-to-1 timeline:
  // position i of n sits at i * (1 / n).
  const oldStep = 1 / n;
  const newStep = 1 / newLength;
  const oldX = (i) => i * oldStep;

  const out = new Float32Array(newLength);
  let j = 0;  // the old sample at or just before the current new position
  for (let i = 0; i < newLength; i++) {
    const x = i * newStep;
    // Walk j forward while the next old sample is still not past x. The new
    // positions only ever increase, so j never has to go back.
    while (j + 1 < n && oldX(j + 1) <= x) j++;
    if (j === n - 1) {
      out[i] = data[n - 1];  // past the last old sample: hold its value
    } else {
      const x0 = oldX(j);
      if (x0 === x) {
        out[i] = data[j];
      } else {
        const slope = (data[j + 1] - data[j]) / (oldX(j + 1) - x0);
        out[i] = slope * (x - x0) + data[j];
      }
    }
  }
  return out;
}

// Shift pitch by resampling, like changing the speed of a record: higher
// pitch finishes sooner, so duration changes with pitch.
export function pitchShift(sample, semitones) {
  if (semitones === 0) return sample;  // the common case: skip the work

  // An octave is a doubling of frequency, split into 12 equal steps, so each
  // semitone multiplies frequency by the twelfth root of 2 and n semitones by
  // 2 ** (n / 12): +12 -> 2.0, -12 -> 0.5, +7 -> 1.498 (a perfect fifth).
  const ratio = 2 ** (semitones / 12);

  // Playing a sound through FEWER samples makes it finish sooner, which
  // raises its pitch. Hence dividing. Math.max keeps at least one sample.
  const newLength = Math.max(1, roundHalfEven(sample.length / ratio));
  return resampleLinear(sample, newLength);
}

// One sample, ready to use: mono, at the rate the piece renders at.
//
// Stereo is mixed down by averaging the channels, one frame at a time.
// A sound recorded at 48000 Hz but played as if it were 44100 would come out
// too slow and too low, so its length is rescaled to compensate.
export function prepareSample(decoded, targetRate) {
  const { channels, sampleRate } = decoded;
  let mono;
  if (channels.length === 1) {
    mono = channels[0];
  } else {
    mono = new Float32Array(channels[0].length);
    for (let i = 0; i < mono.length; i++) {
      // Math.fround rounds to 32 bits at each step, as numpy's float32 sum did.
      let sum = channels[0][i];
      for (let ch = 1; ch < channels.length; ch++) sum = Math.fround(sum + channels[ch][i]);
      mono[i] = sum / channels.length;
    }
  }
  if (sampleRate !== targetRate) {
    const ratio = targetRate / sampleRate;
    mono = resampleLinear(mono, roundHalfEven(mono.length * ratio));
  }
  return mono;
}

