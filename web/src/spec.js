// The spec: a piece exactly as the user wrote it.
//
// A spec is a plain object, saved and loaded as JSON:
//
//   {
//     "tempo": 120,        beats per minute, counting the BASE beat
//     "base": 4,           beats per bar: the meter everything sits on
//     "bars": 8,           how long the piece is, in bars
//     "scale": "dorian",
//     "layer": [
//       { "beats": 8, "notes": [0, "-", 0], "sample": "kick.wav", "active": [1, 4, 7] },
//       { "beats": 7, "over": 2, "degrees": [1, 3, 5], "sample": "pluck.wav", "gain": 0.4 }
//     ]
//   }
//
// The words, which README.md lists in full: the BASE sets the bar (4 beats
// at 120 BPM makes a 2-second bar); every layer lays its own BEATS over a
// number of bars ("7 over 2 bars"), 1 unless it says `over`; each layer's
// SEQUENCE of notes and rests is read one position per beat.
//
// It keeps things the way you wrote them -- degrees rather than semitones,
// beats counted from 1, rests as "-". That is deliberate: the spec is what
// gets saved, and an editor can only let you change a scale if the scale is
// still there to change.
//
// `sample` is a NAME, looked up in the page's sample library, not a path to a
// file: a web page cannot reach into folders on your disk.
//
// OLDER PIECES said `cycle_duration` (seconds per bar) or `pulse_duration`,
// and `loops` (the number of bars). Those still read, and still sound exactly
// as they did -- the checks compare them against answers recorded long ago --
// and upgradeSpec() below turns one into the current form.
//
// A note on names: the keys inside a spec use snake_case, because they are
// the saved file format. JavaScript's own names use camelCase.

import { LayerError, makeLayer, REST } from "./layer.js";
import { gcd, lcm, roundTo } from "./numbers.js";
import { isScale, scaleNames } from "./scales.js";

// Written into a saved piece so a file can say what it is. Version 2 is the
// tempo/base/bars vocabulary; version 1 files still read.
export const EXPORT_FORMAT = "randaw-piece";
export const EXPORT_VERSION = 2;
const READABLE_VERSIONS = [1, 2];

// The older names for timing, still understood when reading.
export const LEGACY_KEYS = ["cycle_duration", "pulse_duration", "loops"];

// Listing the permitted keys lets us reject typos. Without this, writing
// "tempos": 120 would be silently ignored and you would spend ten minutes
// wondering why the tempo never changed.
export const TOP_LEVEL_KEYS = [
  "tempo", "base", "bars", "click", "sample_rate", "scale", "root", "layer", ...LEGACY_KEYS,
];
export const LAYER_KEYS = [
  "beats", "over", "notes", "degrees", "sample", "gain", "active", "scale", "root", "mute", "solo", "follow",
];

// Settings a spec may carry, and the kind of value each must be.
const SETTING_KINDS = {
  tempo: "number",
  base: "whole number",
  bars: "whole number",
  sample_rate: "whole number",
  cycle_duration: "number",
  pulse_duration: "number",
  loops: "whole number",
};

// With no base given, a bar has four beats: the most common meter by far.
export const DEFAULT_BASE = 4;

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
    if (!READABLE_VERSIONS.includes(data.version)) {
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

// Turn an older piece (cycle_duration or pulse_duration, and loops) into the
// current form (tempo, base, bars). The page does this when it opens one, so
// the editor only ever meets today's words.
//
// The tempo is the BPM whose base beats fill the old bar length: a
// cycle_duration of 2.2 s with 4 beats to the bar is 109.091 BPM. Rounded to three places, so the new piece can sound
// a hair different -- a fraction of a millisecond per bar. Anything not
// understood is left alone for buildPiece to explain.
export function upgradeSpec(spec) {
  if (!isPlainObject(spec) || !LEGACY_KEYS.some((key) => has(spec, key))) return spec;
  const next = structuredClone(spec);
  const base = isWhole(next.base) && next.base >= 1 ? next.base : DEFAULT_BASE;

  let barSeconds = null;
  if (isNumber(next.cycle_duration) && next.cycle_duration > 0) {
    barSeconds = next.cycle_duration;
  } else if (isNumber(next.pulse_duration) && next.pulse_duration > 0 && Array.isArray(next.layer)) {
    // A pulse duration fixed the grid step, so the bar was that many pulses.
    const layers = next.layer.filter((l) => isPlainObject(l) && isWhole(l.beats) && l.beats >= 1);
    const pulses = layers.reduce((running, l) => lcm(running, l.beats / gcd(l.beats, isWhole(l.over) ? l.over : 1)), 1);
    barSeconds = next.pulse_duration * pulses;
  } else if (!has(next, "cycle_duration") && !has(next, "pulse_duration")) {
    barSeconds = 2.0;  // the old default
  }
  if (barSeconds === null) return spec;  // cannot tell; let buildPiece explain

  delete next.cycle_duration;
  delete next.pulse_duration;
  const upgraded = { tempo: roundTo((base * 60) / barSeconds, 3), base };
  if (has(next, "loops")) upgraded.bars = next.loops;
  delete next.loops;
  // Keep the timing settings first, where a person reading the file looks.
  return { ...upgraded, ...next, base };
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
//
// The returned `legacy` is true for a piece in the older words, which is
// timed exactly as it always was (see buildPiece).
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

  // Each of these pairs says the same thing two ways. Given both, one would
  // have to silently lose, so refuse instead.
  if (has(settings, "cycle_duration") && has(settings, "pulse_duration")) {
    throw new SpecError(`${source}: give cycle_duration or pulse_duration, not both`);
  }
  if (has(settings, "tempo") && (has(settings, "cycle_duration") || has(settings, "pulse_duration"))) {
    throw new SpecError(`${source}: give tempo, or the older cycle_duration/pulse_duration, not both`);
  }
  if (has(settings, "bars") && has(settings, "loops")) {
    throw new SpecError(`${source}: give bars, or its older name loops, not both`);
  }
  settings.legacy = LEGACY_KEYS.some((key) => has(settings, key));

  const click = has(spec, "click") ? spec.click : false;
  if (typeof click !== "boolean") throw new SpecError(`${source}: click must be true or false, got ${shown(click)}`);
  settings.click = click;

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
  const over = has(entry, "over") ? entry.over : 1;
  if (!isWhole(over)) {
    throw new SpecError(`${where}: over must be a whole number of bars, got ${shown(over)}`);
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

  // Which beats move the sequence on; makeLayer checks the value.
  const follow = has(entry, "follow") ? entry.follow : "beats";

  try {
    // The same rules everywhere -- one place, no drift.
    return makeLayer({
      beats: entry.beats, over, sample: entry.sample, notes, degrees, scale, root, gain, active, mute, solo, follow,
    });
  } catch (e) {
    // Only rule-breaking gets a friendly message. Anything else is a real
    // bug, and re-throwing it unchanged keeps it loud.
    if (e instanceof LayerError) throw new SpecError(`${where}: ${e.message}`);
    throw e;
  }
}
