// The answer key: does the engine still make exactly what it made when the
// answers were recorded?
//
// Every example, and 600 random pieces -- about a third broken on purpose in
// one of 61 ways -- with each one's verdict, and for a piece that is accepted,
// fingerprints of its grid and of its WAV file, byte for byte. For a piece
// that is refused, the exact message a person would read.
//
// engine.test.js says what the rules ARE. This catches what those checks
// never thought to ask: any change at all to the sound, the drawing's data or
// a refusal. When a change is deliberate, re-record the answers (see
// record_answers.js) and read the diff; when it is not, this fails.
//
// "Exactly" means byte for byte, not "close enough". Anything looser lets
// small differences pile up unnoticed -- this habit found every real bug in
// moving the engine from Python.

import assert from "node:assert/strict";
import { test } from "node:test";

import { answerFor, EXAMPLES, HERE, readJson } from "./helpers.js";

const answers = readJson(HERE, "fixtures", "answers.json");
const RECORD = "if the change is deliberate, re-record with: node test/record_answers.js";

test("every example is recorded, and nothing recorded is missing", () => {
  assert.deepEqual(Object.keys(answers.examples).sort(), [...EXAMPLES.keys()].sort());
});

for (const [name, spec] of EXAMPLES) {
  test(`example ${name}: the same grid and a byte-identical WAV`, () => {
    assert.deepEqual(answerFor(spec), answers.examples[name], `${name} changed; ${RECORD}`);
  });
}

test("600 random pieces: the same verdict, grid, audio and refusal message", () => {
  const problems = [];
  for (const [index, expected] of answers.pieces.entries()) {
    // answerFor throws on anything but a friendly refusal: a crash is a bug.
    const { spec, ...recorded } = expected;
    const got = answerFor(spec);
    if (got.ok !== recorded.ok) {
      problems.push(`#${index}: now ${got.ok ? "accepted" : `refused (${got.error})`}, was ${recorded.ok ? "accepted" : "refused"}`);
    } else if (!got.ok && got.error !== recorded.error) {
      problems.push(`#${index}: refused with "${got.error}", was "${recorded.error}"`);
    } else if (got.ok && got.derived !== recorded.derived) {
      problems.push(`#${index}: grid differs`);
    } else if (got.ok && got.wav !== recorded.wav) {
      problems.push(`#${index}: audio differs`);
    }
  }
  // Listing every problem, rather than stopping at the first, shows whether
  // it is one bug or many.
  assert.deepEqual(problems, [], `\n${problems.slice(0, 20).join("\n")}\n${RECORD}`);
});

test("the random pieces still include plenty of both verdicts", () => {
  // A guard on the key itself: re-recording after a change that refused
  // (or accepted) everything would otherwise quietly gut this check.
  const refused = answers.pieces.filter((p) => !p.ok).length;
  assert.ok(refused > 150 && answers.pieces.length - refused > 300, `${refused} of ${answers.pieces.length} refused`);
});
