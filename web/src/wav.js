// Reading and writing WAV files, byte by byte.
//
// Browsers can decode audio themselves, but they quietly convert it to their
// own sample rate as they go, and each browser does that slightly
// differently. Reading WAV ourselves means every device gets exactly the same
// numbers, so a piece renders to the identical file everywhere.
//
// A WAV file is a short header describing the audio, then the audio itself as
// a long run of numbers. The header is split into "chunks", each starting
// with a four-letter name and its length in bytes:
//
//   "RIFF" <size> "WAVE"
//     "fmt " <size>  format, channels, sample rate, bits per sample ...
//     "data" <size>  the samples, channels interleaved: L R L R ...
//
// Numbers in WAV files are "little-endian" (least significant byte first),
// hence the `true` passed to every DataView read and write below.

import { roundHalfEven } from "./numbers.js";

export class WavError extends Error {}

const FORMAT_PCM = 1;           // whole numbers
const FORMAT_FLOAT = 3;         // floating point
const FORMAT_EXTENSIBLE = 0xfffe;  // "see the real format further in"

// Turn the bytes of a WAV file into audio: one Float32Array per channel, each
// value between -1 and +1, plus the sample rate.
export function decodeWav(bytes) {
  // A Uint8Array is a list of bytes. A DataView over the same memory reads
  // multi-byte numbers out of it at any position.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at) => String.fromCharCode(...bytes.subarray(at, at + 4));

  if (bytes.length < 12 || text(0) !== "RIFF" || text(8) !== "WAVE") {
    throw new WavError("not a WAV file");
  }

  let format = null;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = text(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      format = {
        code: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
      if (format.code === FORMAT_EXTENSIBLE) format.code = view.getUint16(body + 24, true);
    } else if (id === "data") {
      if (format === null) throw new WavError("WAV data came before its format");
      // Some programs write a data size larger than the file; trust the file.
      const length = Math.min(size, bytes.length - body);
      return { channels: readSamples(view, body, length, format), sampleRate: format.sampleRate };
    }
    // Chunks are padded to an even number of bytes.
    at = body + size + (size % 2);
  }
  throw new WavError("WAV file has no audio data");
}

function readSamples(view, start, length, { code, channels, bits }) {
  const bytesPer = bits / 8;
  const frames = Math.floor(length / (bytesPer * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));

  // How to read one sample at a byte position, as a number from -1 to +1.
  // Whole-number samples are divided by the largest size they can have:
  // 16-bit runs from -32768 to 32767, so dividing by 32768 lands in -1..+1.
  let read;
  if (code === FORMAT_PCM && bits === 16) read = (p) => view.getInt16(p, true) / 32768;
  else if (code === FORMAT_PCM && bits === 24) {
    // No getInt24, so assemble three bytes; `<< 8 >> 8` restores the sign.
    read = (p) => (((view.getUint8(p + 2) << 16) | (view.getUint16(p, true))) << 8 >> 8) / 8388608;
  } else if (code === FORMAT_PCM && bits === 32) read = (p) => view.getInt32(p, true) / 2147483648;
  else if (code === FORMAT_PCM && bits === 8) read = (p) => (view.getUint8(p) - 128) / 128;
  else if (code === FORMAT_FLOAT && bits === 32) read = (p) => view.getFloat32(p, true);
  else if (code === FORMAT_FLOAT && bits === 64) read = (p) => view.getFloat64(p, true);
  else throw new WavError(`unsupported WAV format (code ${code}, ${bits}-bit)`);

  for (let frame = 0; frame < frames; frame++) {
    for (let ch = 0; ch < channels; ch++) {
      out[ch][frame] = read(start + (frame * channels + ch) * bytesPer);
    }
  }
  return out;
}

// The bytes of a mono 16-bit WAV file.
//
// Each value goes to 16 bits in two steps: first to a 32-bit whole number
// (scaled by 2^31 and rounded to nearest, halves to even), then the top 16
// bits of that are kept. It is an odd route -- mostly the same as rounding
// down, except for values a hair below a whole step -- but it is exactly what
// the Python version's audio library did. That was worked out by testing the
// library against two million values, after a first guess (plain rounding
// down) matched 428,000 random values yet still missed 70 samples in a real
// piece. Matching it is what lets the two versions write identical files.
export function encodeWav16(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const writeText = (at, s) => { for (let i = 0; i < 4; i++) bytes[at + i] = s.charCodeAt(i); };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);              // this chunk is 16 bytes long
  view.setUint16(20, FORMAT_PCM, true);
  view.setUint16(22, 1, true);               // one channel: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);  // bytes per second
  view.setUint16(32, 2, true);               // bytes per sample frame
  view.setUint16(34, 16, true);              // bits per sample
  writeText(36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    const wide = Math.max(-2147483648, Math.min(2147483647, roundHalfEven(samples[i] * 2147483648)));
    // Dividing by 65536 (2^16) and rounding down keeps the top 16 bits.
    view.setInt16(44 + i * 2, Math.floor(wide / 65536), true);
  }
  return bytes;
}
