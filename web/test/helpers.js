// Shared by the checks: loading the built-in samples and the examples, and
// the fingerprints the answer key is recorded as.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { pieceToDerived } from "../src/derive.js";
import { buildPiece } from "../src/piece.js";
import { finishMix, renderAudio } from "../src/render.js";
import { schedule } from "../src/schedule.js";
import { SpecError } from "../src/spec.js";
import { decodeWav, encodeWav16 } from "../src/wav.js";

// import.meta.url is this file's own address; these lines turn it into
// folder paths the checks can read from.
export const HERE = dirname(fileURLToPath(import.meta.url));
export const WEB = join(HERE, "..");
export const ROOT = join(WEB, "..");

// The built-in samples, decoded: name -> { channels, sampleRate }.
export const LIBRARY = new Map(
  readdirSync(join(ROOT, "samples"))
    .filter((name) => name.endsWith(".wav"))
    .map((name) => [name, decodeWav(readFileSync(join(ROOT, "samples", name)))]),
);

export const readJson = (...parts) => JSON.parse(readFileSync(join(...parts), "utf8"));

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// A value written out so that equal values always give equal text, whatever
// order their keys arrived in: numbers as the hex of their exact 64-bit form,
// text as the hex of its UTF-8 bytes, keys sorted. (First written to match
// the retired Python version's checks, and kept because it is exact.)
export function canonical(value) {
  if (value === null) return "n";
  if (value === true) return "t";
  if (value === false) return "f";
  if (typeof value === "number") {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value);  // big-endian by default
    return "d" + Buffer.from(bytes).toString("hex");
  }
  if (typeof value === "string") return "s" + Buffer.from(value, "utf8").toString("hex") + ";";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => canonical(k) + ":" + canonical(value[k])).join(",") + "}";
}

export const fingerprint = (value) => sha256(canonical(value));

// Spec in, WAV bytes out: what the page does when you press Download.
export function renderWav(spec) {
  const piece = buildPiece(spec, { samples: LIBRARY.keys() });
  const mix = renderAudio(schedule(piece), { ...piece, library: LIBRARY });
  return { piece, wav: encodeWav16(finishMix(mix).mix, piece.sampleRate) };
}

// The example pieces, by name, as the page lists them.
export const EXAMPLES = new Map(
  readdirSync(join(WEB, "examples"))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => [file.replace(/\.json$/, ""), readJson(WEB, "examples", file)]),
);

// Everything the engine makes of one spec, in a form small enough to record:
// its verdict and, for a piece it accepts, a fingerprint of everything a
// drawing is given and of the WAV file, byte for byte. For a piece it
// refuses, the message a person would read. Anything but a SpecError is a
// crash, which is a bug, never an answer.
export function answerFor(spec) {
  let made;
  try {
    made = renderWav(spec);
  } catch (e) {
    if (!(e instanceof SpecError)) throw e;
    return { ok: false, error: e.message };
  }
  return { ok: true, derived: fingerprint(pieceToDerived(made.piece)), wav: sha256(made.wav) };
}
