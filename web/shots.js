// Screenshots of the page, for looking at the design: node shots.js
//
// Builds dist/randaw.html, opens it in headless Chromium (through the same
// test/browser.js the checks use, so still no dependencies), and saves one
// picture per drawing, screen size and colour scheme into dist/shots/.
// Nothing is asserted: this is for eyes, human or Claude's.
//
//   node shots.js                       every drawing, size and scheme
//   node shots.js --example=seven       a different piece (default tresillo)
//   node shots.js --only=ipad           just the sizes whose name matches
//   node shots.js --full                the whole page, not just the screen
//
// Sizes are CSS pixels. "ipad" is an 11-inch iPad held sideways, the main
// device; "ipad-tall" the same held upright.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findChromium, launch } from "./test/browser.js";
import { WEB } from "./test/helpers.js";

const SIZES = [
  { name: "laptop", width: 1440, height: 900 },
  { name: "ipad", width: 1180, height: 820 },
  { name: "ipad-tall", width: 820, height: 1180 },
  { name: "phone", width: 390, height: 844 },
];
const DRAWINGS = ["grid", "rings", "polygons"];
const SCHEMES = ["light", "dark"];

const args = Object.fromEntries(process.argv.slice(2)
  .map((a) => a.replace(/^--/, "").split("=")));
const example = args.example ?? "tresillo";
const sizes = SIZES.filter((s) => !args.only || s.name.includes(args.only));

const chromium = findChromium();
if (!chromium) {
  console.error("No headless Chromium found (set CHROMIUM=path).");
  process.exit(1);
}

execFileSync(process.execPath, [join(WEB, "build.js")], { stdio: "ignore" });
const page = join(WEB, "dist", "randaw.html");
const out = join(WEB, "dist", "shots");
mkdirSync(out, { recursive: true });

const browser = await launch(chromium);
try {
  for (const drawing of DRAWINGS) {
    // t=0 stops the playhead at the start, so pictures are comparable.
    const tab = await browser.open(`file://${page}?example=${example}&view=${drawing}&t=0`);
    try {
      for (const size of sizes) {
        for (const scheme of SCHEMES) {
          const png = await tab.screenshot({ ...size, dark: scheme === "dark", full: "full" in args });
          const file = join(out, `${example}-${drawing}-${size.name}-${scheme}.png`);
          writeFileSync(file, png);
          console.log(file);
        }
      }
    } finally {
      await tab.close();
    }
  }
} finally {
  await browser.close();
}
