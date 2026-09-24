// Build the single-file page: node build.js  ->  dist/randaw.html
//
// The source is split into modules (src/*.js) that import from each other,
// which keeps each file about one thing and lets Node run the checks on them
// directly. But a browser will not load separate module files from a page
// opened straight off the disk -- it blocks them for security -- and the whole
// point is one file you can open anywhere or email to someone.
//
// So this script stitches the modules into one. Each module's code is
// wrapped in its own function, so its private names stay private, and what it
// exports is handed to the modules that import it:
//
//   const scales_js = (() => {
//     ...the module's code, minus its import and export keywords...
//     return { SCALES, isScale, scaleNames, degreeToSemitones };
//   })();
//   const layer_js = (() => {
//     const { degreeToSemitones, isScale, scaleNames } = scales_js;
//     ...
//   })();
//
// That only works for the plain style of import and export used in src/ --
// `import { a, b } from "./file.js"` and `export function|const|class name` --
// and the build stops with a message if it meets anything else, rather than
// producing a page that quietly breaks.
//
// Nothing is minified or changed otherwise, so the page's code stays as
// readable as the source.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { jsonForScript } from "./src/share.js";

const WEB = dirname(fileURLToPath(import.meta.url));
const ROOT = join(WEB, "..");
const SRC = join(WEB, "src");
const ENTRY = "main.js";

// What each example is for, shown in the page's menu.
const EXAMPLE_NOTES = {
  tresillo: "3-3-2 groove with a 3-beat hat cutting across it",
  seven: "7 grouped 3-2-2, with a 4-beat tom pulling against it",
  phase_study: "5 beats against 7 notes, 7 cycles to come back round",
  sparse_dub: "space rather than density",
  scales: "change one word and the whole piece re-harmonises",
  rests: "rests that travel through the bar",
};
// The order the menu lists them in; the first opens by default.
const EXAMPLE_ORDER = ["tresillo", "rests", "seven", "phase_study", "sparse_dub", "scales"];

const IMPORT = /^import\s*\{([^}]*)\}\s*from\s*"\.\/([\w-]+\.js)";[^\S\n]*\n?/gm;
const EXPORT = /^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

function fail(message) {
  console.error(`build failed: ${message}`);
  process.exit(1);
}

// "scales.js" -> "scales_js", a name the stitched code can use.
const varName = (file) => file.replace(/\W/g, "_");

function readModule(file) {
  const source = readFileSync(join(SRC, file), "utf8");
  const imports = [...source.matchAll(IMPORT)].map((m) => ({
    file: m[2],
    // "a, b as c" -> ["a", "b: c"], the destructuring form of a rename.
    names: m[1].split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\s+as\s+/, ": ")),
  }));
  const exports = [...source.matchAll(EXPORT)].map((m) => m[1]);
  const body = source.replace(IMPORT, "").replace(/^export\s+/gm, "");
  const leftover = body.match(/^\s*(import|export)\b.*$/m);
  if (leftover) fail(`${file}: build.js does not understand this line: ${leftover[0].trim()}`);
  return { file, imports, exports, body };
}

// Put modules in an order where each comes after everything it imports.
function inOrder(entry) {
  const done = new Map();
  const visiting = new Set();
  const visit = (file) => {
    if (done.has(file)) return;
    if (visiting.has(file)) fail(`modules import each other in a circle, through ${file}`);
    visiting.add(file);
    const module = readModule(file);
    for (const dependency of module.imports) visit(dependency.file);
    visiting.delete(file);
    done.set(file, module);
  };
  visit(entry);
  return [...done.values()];
}

function bundle() {
  const parts = ['"use strict";', ""];
  for (const module of inOrder(ENTRY)) {
    parts.push(`// ${"=".repeat(74)}`, `// src/${module.file}`, `// ${"=".repeat(74)}`);
    parts.push(`const ${varName(module.file)} = (() => {`);
    for (const { file, names } of module.imports) {
      parts.push(`const { ${names.join(", ")} } = ${varName(file)};`);
    }
    parts.push(module.body.trim());
    parts.push(`return { ${module.exports.join(", ")} };`, "})();", "");
  }
  const code = parts.join("\n");
  // The code sits inside a <script> block, so it must never contain the text
  // that would end one early.
  if (/<\/script/i.test(code)) fail('the code contains "</script", which would end the page\'s script early');
  return code;
}

function build() {
  const samples = {};
  for (const name of readdirSync(join(ROOT, "samples")).filter((n) => n.endsWith(".wav")).sort()) {
    samples[name] = readFileSync(join(ROOT, "samples", name)).toString("base64");
  }

  const available = readdirSync(join(WEB, "examples")).map((f) => f.replace(/\.json$/, ""));
  const missing = available.filter((name) => !EXAMPLE_ORDER.includes(name));
  if (missing.length) fail(`examples not listed in EXAMPLE_ORDER: ${missing.join(", ")}`);
  const examples = EXAMPLE_ORDER.map((name) => ({
    name,
    about: EXAMPLE_NOTES[name],
    spec: JSON.parse(readFileSync(join(WEB, "examples", `${name}.json`), "utf8")),
  }));

  const fill = {
    "{{SAMPLES}}": jsonForScript(samples),
    "{{EXAMPLES}}": jsonForScript(examples),
    "{{PIECE}}": "null",
    "{{SCRIPT}}": bundle(),
  };
  let page = readFileSync(join(WEB, "page.html"), "utf8");
  for (const [marker, value] of Object.entries(fill)) {
    if (!page.includes(marker)) fail(`page.html has no ${marker}`);
    // A function as the replacement, so "$" in the code is taken literally.
    page = page.replace(marker, () => value);
  }

  mkdirSync(join(WEB, "dist"), { recursive: true });
  const out = join(WEB, "dist", "randaw.html");
  writeFileSync(out, page);
  console.log(`wrote ${out} (${(page.length / 1000).toFixed(0)} kB)`);
}

build();
