// Does the JavaScript engine give exactly the Python engine's answers?
//
// The answers were recorded by make_fixtures.py, running the Python version,
// before both were retired in phase 11. They are still in git history, at
// commit 3fffdeb: `git show 3fffdeb:web/test/make_fixtures.py`. The recorded
// answers in fixtures/ stay, as a fixed record of what the engine does.
// "Exactly" means the same grid, number for number, and a byte-identical WAV
// file -- not "close enough". Anything looser would let small differences
// pile up unnoticed.
//
// Run with:  cd web && npm test     (or: node --test test/*.test.js)

import assert from "node:assert/strict";
import { test } from "node:test";

import { pieceToDerived } from "../src/derive.js";
import { buildPiece } from "../src/piece.js";
import { SpecError } from "../src/spec.js";
import { fingerprint, HERE, LIBRARY, readJson, renderWav, sha256 } from "./helpers.js";

const FIXTURES = `${HERE}/fixtures`;

// The answers were recorded in the older words: "cycle" for a bar, "loops"
// for the number of bars, "lcm" for pulses per bar, "step" for a sequence
// position. This puts today's
// derived data back into those words, and sets aside the fields added since,
// which the answer key cannot know about. Only the NAMES change here -- every
// number is compared exactly as it comes out.
const OLD_WARNING = /^bar rounded to (\S+)s from (\S+)s -- (\d+) pulses per bar do not divide the sample rate evenly$/;
const asRecorded = ({ tempo, base, click, repeat_bars, bars, bar_duration, pulses_per_bar, ...derived }) => ({
  ...derived,
  loops: bars,
  lcm: pulses_per_bar,
  cycle_duration: bar_duration,
  warnings: derived.warnings.map((w) =>
    w.replace(OLD_WARNING, "cycle rounded to $1s from $2s -- an LCM of $3 does not divide the sample rate evenly")),
  layers: derived.layers.map(({ over, mute, solo, audible, repeat_bars, follow, ...rest }) => rest),
  cells: derived.cells.map(({ bar, position, ...rest }) => ({ ...rest, cycle: bar, step: position })),
  coincidences: derived.coincidences.map(({ bar, ...rest }) => ({ ...rest, cycle: bar })),
});

test("the canonical fingerprint agrees with Python's", () => {
  const probe = readJson(FIXTURES, "canonical.json");
  assert.equal(fingerprint(probe.value), probe.fingerprint);
});

const examples = readJson(FIXTURES, "examples.json");
for (const [name, expected] of Object.entries(examples)) {
  test(`example ${name}: same grid and a byte-identical WAV`, () => {
    // The examples as they were when the answers were recorded. (Today's
    // examples/ are in the newer words, which time a piece slightly
    // differently.)
    const spec = readJson(FIXTURES, "legacy_examples", `${name}.json`);
    const { piece, wav } = renderWav(spec);
    // deepStrictEqual compares every field of every cell, and on failure
    // prints exactly which ones differ.
    assert.deepStrictEqual(asRecorded(pieceToDerived(piece)), expected.derived);
    assert.equal(sha256(wav), expected.wav);
  });
}

test("600 random pieces: same verdict, same grid, same audio", () => {
  const cases = readJson(FIXTURES, "fuzz.json");
  const problems = [];
  for (const [index, c] of cases.entries()) {
    let result;
    try {
      result = renderWav(c.spec);
    } catch (e) {
      if (!(e instanceof SpecError)) throw e;  // a crash is a bug, never a verdict
      if (c.ok) problems.push(`#${index}: JavaScript refused a piece Python accepted: ${e.message}`);
      continue;
    }
    if (!c.ok) {
      problems.push(`#${index}: JavaScript accepted a piece Python refused (${c.error})`);
      continue;
    }
    if (fingerprint(asRecorded(pieceToDerived(result.piece))) !== c.derived) problems.push(`#${index}: grid differs`);
    if (sha256(result.wav) !== c.wav) problems.push(`#${index}: audio differs`);
  }
  // Listing every problem, rather than stopping at the first, shows whether
  // it is one bug or many.
  assert.deepEqual(problems, [], `\n${problems.slice(0, 20).join("\n")}`);
});

test("every refusal in the random set is a friendly SpecError, never a crash", () => {
  const cases = readJson(FIXTURES, "fuzz.json").filter((c) => !c.ok);
  for (const c of cases) {
    assert.throws(() => buildPiece(c.spec, { samples: LIBRARY.keys() }), SpecError);
  }
});
