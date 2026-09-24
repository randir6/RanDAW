// Shared by the checks: loading the built-in samples, and the canonical
// fingerprint that lets JavaScript and Python results be compared exactly.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPiece } from "../src/piece.js";
import { finishMix, renderAudio } from "../src/render.js";
import { schedule } from "../src/schedule.js";
import { decodeWav, encodeWav16 } from "../src/wav.js";

// import.meta.url is this file's own address; these lines turn it into
// folder paths the checks can read from.
export const HERE = dirname(fileURLToPath(import.meta.url));
export const WEB = join(HERE, "..");
export const ROOT = join(WEB, "..");

// The six built-in samples, decoded: name -> { channels, sampleRate }.
export const LIBRARY = new Map(
  readdirSync(join(ROOT, "samples"))
    .filter((name) => name.endsWith(".wav"))
    .map((name) => [name, decodeWav(readFileSync(join(ROOT, "samples", name)))]),
);

export const readJson = (...parts) => JSON.parse(readFileSync(join(...parts), "utf8"));

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// The same encoding as canonical() in the (retired) make_fixtures.py, which
// recorded the fixtures: numbers as the hex of their 64-bit form, text as the
// hex of its UTF-8 bytes.
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
  const mix = renderAudio(schedule(piece.layers, piece.loops), { ...piece, library: LIBRARY });
  return { piece, wav: encodeWav16(finishMix(mix).mix, piece.sampleRate) };
}
