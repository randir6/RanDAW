// Checks on the shape of the code, rather than what it does.
//
// The rule worth protecting: the ENGINE -- everything that works out the
// music -- knows nothing about the page. It never imports the drawing, the
// editor or the player, and never touches the browser (document, window and
// so on). That is what lets every check run the engine in Node with no
// browser, and what would let a different front end reuse it unchanged.
//
// This reads the source files and fails if the rule is ever broken, so the
// boundary cannot wear away one convenient import at a time.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { WEB } from "./helpers.js";

const SRC = join(WEB, "src");
const ENGINE = [
  "numbers.js", "scales.js", "layer.js", "spec.js", "piece.js", "schedule.js",
  "derive.js", "audio.js", "wav.js", "render.js", "edit.js", "fingerprint.js", "share.js",
];
const PAGE = ["view.js", "editor.js", "player.js", "draft.js", "files.js", "main.js"];

const source = (file) => readFileSync(join(SRC, file), "utf8");
const importsOf = (file) => [...source(file).matchAll(/from\s+"\.\/([\w-]+\.js)"/g)].map((m) => m[1]);
// The code with comments removed, so a comment mentioning "document" is fine.
const code = (file) => source(file).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

test("every source file is either engine or page, and none is forgotten", () => {
  assert.deepEqual(readdirSync(SRC).sort(), [...ENGINE, ...PAGE].sort());
});

test("the engine imports only the engine", () => {
  for (const file of ENGINE) {
    for (const dependency of importsOf(file)) {
      assert.ok(ENGINE.includes(dependency), `${file} imports ${dependency}, which is part of the page`);
    }
  }
});

test("the engine never touches the browser", () => {
  const browserOnly = /\b(document|window|navigator|localStorage|requestAnimationFrame|AudioContext)\b/;
  for (const file of ENGINE) {
    const found = code(file).match(browserOnly);
    assert.equal(found, null, `${file} uses ${found?.[0]}`);
  }
});

test("only main.js wires things together; the drawing and player do not import the editor", () => {
  for (const file of ["view.js", "player.js"]) {
    for (const dependency of importsOf(file)) {
      assert.ok(ENGINE.includes(dependency), `${file} imports ${dependency}`);
    }
  }
});
