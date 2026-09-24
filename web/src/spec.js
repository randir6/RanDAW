// The spec: a piece exactly as the user wrote it.
//
// A spec is a plain object, saved and loaded as JSON:
//
//   {
//     "cycle_duration": 2.0,
//     "loops": 8,
//     "scale": "dorian",
//     "layer": [
//       { "beats": 8, "notes": [0, "-", 0], "sample": "kick.wav", "active": [1, 4, 7] },
//       { "beats": 5, "degrees": [1, 3, 5], "sample": "pluck.wav", "gain": 0.4 }
//     ]
//   }
//
// It keeps things the way you wrote them -- degrees rather than semitones,
// beats counted from 1, rests as "-". That is deliberate: the spec is what
// gets saved, and an editor can only let you change a scale if the scale is
// still there to change.
//
// `sample` is a NAME, looked up in the page's sample library, not a path to a
// file: a web page cannot reach into folders on your disk.
//
// Turning a spec into something playable is buildPiece()'s job, in piece.js.
// This module checks what a spec says and builds layers from its entries.
//
// A note on names: the keys inside a spec keep Python-style snake_case
// ("cycle_duration") because they are the saved file format, shared with
// every piece already written. JavaScript's own names use camelCase.

import { LayerError, makeLayer, REST } from "./layer.js";
import { isScale, scaleNames } from "./scales.js";

// Written into a saved piece so a file can say what it is. A version number
// costs nothing now and means a future change of shape can be detected
// rather than silently misread.
export const EXPORT_FORMAT = "randaw-piece";
export const EXPORT_VERSION = 1;

// Listing the permitted keys lets us reject typos. Without this, writing
// "cycle_durations": 2.0 would be silently ignored and you would spend ten
// minutes wondering why the tempo never changed.
export const TOP_LEVEL_KEYS = [
  "cycle_duration", "pulse_duration", "loops", "sample_rate", "scale", "root", "layer",
];
export const LAYER_KEYS = [
  "beats", "notes", "degrees", "sample", "gain", "active", "scale", "root", "mute", "solo",
];

// Settings a spec may carry, and the kind of number each must be.
const SETTING_KINDS = {
  cycle_duration: "number",
  pulse_duration: "number",
  loops: "whole number",
  sample_rate: "whole number",
};

// Anything wrong with what the user asked for, with a message meant for a
// person to read. One error type for every part of the page to catch.
export class SpecError extends Error {}

// --- Small checks ---------------------------------------------------------------

// A "plain object": {...}. Not null (which JavaScript, famously, says is an
// object) and not a list (which it also calls an object).
export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Number.isInteger is false for anything that is not a number at all --
// strings, true/false, null -- so it does the type check and the "whole"
// check in one go.
const isWhole = (value) => Number.isInteger(value);
// Number.isFinite is likewise false for non-numbers, and for Infinity.
const isNumber = (value) => Number.isFinite(value);

// Show a value in an error message the way it was written.
const shown = (value) => JSON.stringify(value);

// Does the object have this key itself? (As opposed to inheriting it -- see
// isScale() in scales.js for why that distinction matters.)
const has = (object, key) => Object.hasOwn(object, key);

function requireWholeList(value, what) {
  if (!Array.isArray(value) || !value.every(isWhole)) {
    throw new SpecError(`${what} must be a list of whole numbers, got ${shown(value)}`);
  }
  return value;
}

// Like the above, but for notes and degrees, where the rest marker is allowed
// alongside the numbers and becomes null. Not used for `active`, where a rest
// would be meaningless -- silencing a beat is what `active` already does.
function requireSequence(value, what) {
  if (!Array.isArray(value)) throw new SpecError(`${what} must be a list, got ${shown(value)}`);
  return value.map((item) => {
    if (item === REST) return null;
    if (!isWhole(item)) {
      throw new SpecError(
        `${what} must contain whole numbers or "${REST}" for a rest, got ${shown(item)}`,
      );
    }
    return item;
  });
}

function rejectUnknownKeys(object, allowed, where, noun) {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new SpecError(
      `${where}: unknown ${noun} ${unknown.sort().join(", ")}. ` +
        `Expected any of: ${[...allowed].sort().join(", ")}`,
    );
  }
}

// --- Reading -----------------------------------------------------------------

// Read a spec from the text of a JSON file. The file may hold a bare spec or
// a full export (with the derived timing and grid alongside); an export is
// unwrapped to its spec half.
export function readSpec(text, name = "file") {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new SpecError(`${name} is not valid JSON: ${e.message}`);
  }
  if (!isPlainObject(data)) throw new SpecError(`${name}: expected a piece at the top level`);

  if (data.format === EXPORT_FORMAT) {
    if (data.version !== EXPORT_VERSION) {
      throw new SpecError(
        `${name}: written by a different version of this tool ` +
          `(format version ${shown(data.version)}, expected ${EXPORT_VERSION})`,
      );
    }
    data = data.spec;
    if (!isPlainObject(data)) throw new SpecError(`${name}: export has no spec in it`);
  }
  return data;
}

// A spec as JSON text for saving: settings one per line, then each layer on
// a single line, so a sequence reads as [1, "-", 5] rather than taking a
// line per note.
export function formatSpec(spec) {
  // One value on one line, with a space after each comma and colon.
  const inline = (value) => {
    if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
    if (isPlainObject(value)) {
      return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`).join(", ")}}`;
    }
    return JSON.stringify(value);
  };
  const lines = Object.entries(spec)
    .filter(([key]) => key !== "layer")
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${inline(value)}`);
  const layers = (spec.layer ?? []).map((layer) => `    ${inline(layer)}`);
  lines.push(`  "layer": [\n${layers.join(",\n")}\n  ]`);
  return `{\n${lines.join(",\n")}\n}\n`;
}

// --- Checking ----------------------------------------------------------------

// Check the top level of a spec and return its settings. `source` is only
// for error messages, so a person can tell where the mistake is.
export function checkSettings(spec, source) {
  if (!isPlainObject(spec)) throw new SpecError(`${source}: expected a table of settings`);
  rejectUnknownKeys(spec, TOP_LEVEL_KEYS, source, "setting(s)");

  if (!Array.isArray(spec.layer) || spec.layer.length === 0) {
    throw new SpecError(`${source}: no layers. Add at least one layer.`);
  }

  const settings = {};
  for (const [key, kind] of Object.entries(SETTING_KINDS)) {
    if (!has(spec, key)) continue;
    const value = spec[key];
    const ok = kind === "number" ? isNumber(value) : isWhole(value);
    if (!ok) throw new SpecError(`${source}: ${key} must be a ${kind}, got ${shown(value)}`);
    settings[key] = value;
  }

  // The two tempo settings are alternative ways of saying the same thing.
  // Given both, one would have to silently lose, so refuse instead.
  if (has(settings, "cycle_duration") && has(settings, "pulse_duration")) {
    throw new SpecError(`${source}: give cycle_duration or pulse_duration, not both`);
  }

  // `scale` and `root` at the top level are defaults for any layer written in
  // degrees. A layer stating pitches as `notes` ignores both, which is what
  // stops a global scale from quietly reinterpreting the drums.
  //
  // `?? null` means "or null if missing": the ?? operator picks its right side
  // only when the left is null or undefined (JavaScript's "not there at all").
  const scale = spec.scale ?? null;
  if (scale !== null && typeof scale !== "string") {
    throw new SpecError(`${source}: scale must be a name, got ${shown(scale)}`);
  }
  if (scale !== null && !isScale(scale)) {
    throw new SpecError(`${source}: unknown scale "${scale}"; expected one of: ${scaleNames()}`);
  }
  const root = has(spec, "root") ? spec.root : 0;
  if (!isWhole(root)) {
    throw new SpecError(`${source}: root must be a whole number of semitones, got ${shown(root)}`);
  }
  settings.scale = scale;
  settings.root = root;
  return settings;
}

// Build one layer from one entry of a spec's layer list.
export function layerFromSpec(entry, { defaultScale = null, defaultRoot = 0, where = "layer" } = {}) {
  if (!isPlainObject(entry)) throw new SpecError(`${where} must be a layer object`);
  rejectUnknownKeys(entry, LAYER_KEYS, where, "key(s)");

  const missing = ["beats", "sample"].filter((key) => !has(entry, key));
  if (missing.length > 0) throw new SpecError(`${where}: missing ${missing.join(", ")}`);
  // Whether notes or degrees are present is makeLayer's rule, not ours --
  // checking it here too would be a second copy with its own wording.

  if (!isWhole(entry.beats)) {
    throw new SpecError(`${where}: beats must be a whole number, got ${shown(entry.beats)}`);
  }
  if (typeof entry.sample !== "string") throw new SpecError(`${where}: sample must be a name`);

  const notes = has(entry, "notes") ? requireSequence(entry.notes, `${where}: notes`) : null;
  const degrees = has(entry, "degrees") ? requireSequence(entry.degrees, `${where}: degrees`) : null;
  const active = has(entry, "active") ? requireWholeList(entry.active, `${where}: active`) : null;

  // A layer's own scale wins over the piece-wide one. The piece-wide default
  // reaches a layer only when that layer is written in degrees, so a drum
  // layer using notes is never touched by it.
  const scale = has(entry, "scale") ? entry.scale : degrees !== null ? defaultScale : null;
  if (scale !== null && typeof scale !== "string") {
    throw new SpecError(`${where}: scale must be a name, got ${shown(scale)}`);
  }
  const root = has(entry, "root") ? entry.root : defaultRoot;
  if (!isWhole(root)) {
    throw new SpecError(`${where}: root must be a whole number of semitones, got ${shown(root)}`);
  }
  const gain = has(entry, "gain") ? entry.gain : 1.0;
  if (!isNumber(gain)) throw new SpecError(`${where}: gain must be a number, got ${shown(gain)}`);

  // Mute and solo are switches: true or false, and false when left out.
  const [mute, solo] = ["mute", "solo"].map((key) => {
    const value = has(entry, key) ? entry[key] : false;
    if (typeof value !== "boolean") {
      throw new SpecError(`${where}: ${key} must be true or false, got ${shown(value)}`);
    }
    return value;
  });

  try {
    // The same rules everywhere -- one place, no drift.
    return makeLayer({
      beats: entry.beats, sample: entry.sample, notes, degrees, scale, root, gain, active, mute, solo,
    });
  } catch (e) {
    // Only rule-breaking gets a friendly message. Anything else is a real
    // bug, and re-throwing it unchanged keeps it loud.
    if (e instanceof LayerError) throw new SpecError(`${where}: ${e.message}`);
    throw e;
  }
}
