// Recording the answer key: what the engine makes of every example and of
// several hundred random pieces, written to fixtures/answers.json for
// answers.test.js to compare against.
//
// Run it ONLY after a deliberate change to what the engine does -- a new
// resampler, say -- and read the diff before committing:
//
//     cd web && node test/record_answers.js && git diff --stat test/fixtures
//
// A change nobody meant shows up as a failing check instead. That is the
// whole point: the sound never changes by accident.
//
// The random pieces were first made by the retired Python version's checks
// (git show 3fffdeb:web/test/make_fixtures.py), about a third of them broken
// on purpose in one of 61 ways. They are kept here in today's words; their
// answers are the JavaScript engine's own, recorded once it had been proved
// to match the Python version exactly, byte for byte.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { answerFor, EXAMPLES, HERE, readJson } from "./helpers.js";

const answers = readJson(HERE, "fixtures", "answers.json");

const examples = {};
for (const [name, spec] of EXAMPLES) examples[name] = answerFor(spec);
const pieces = answers.pieces.map(({ spec }) => ({ spec, ...answerFor(spec) }));

// One piece per line, so a re-recording's diff shows exactly which changed.
const lines = pieces.map((p) => "    " + JSON.stringify(p));
const text = `{\n  "examples": ${JSON.stringify(examples, null, 2).replaceAll("\n", "\n  ")},\n` +
  `  "pieces": [\n${lines.join(",\n")}\n  ]\n}\n`;
writeFileSync(join(HERE, "fixtures", "answers.json"), text);
console.log(`recorded ${Object.keys(examples).length} examples and ${pieces.length} pieces`);
