// Checks on editing in the page, in a real browser.
//
// Each check does what a person would -- taps a beat, presses M, picks a step
// and a key, types a sequence, presses Undo -- and then compares the audio the
// page made against the audio Node makes for the same edit, done directly with
// edit.js. Matching fingerprints mean the page applied exactly that edit.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  addLayer, setBeats, setSequence, setSetting, setStep, toggleBeat, toggleMute, toggleSolo,
} from "../src/edit.js";
import { fnv1a } from "../src/fingerprint.js";
import { planSwap } from "../src/player.js";
import { findChromium, launch } from "./browser.js";
import { LIBRARY, readJson, renderWav, WEB } from "./helpers.js";

const chromium = findChromium();
const skip = chromium === null ? "no headless Chromium found (set CHROMIUM=path)" : false;
const PAGE = `file://${join(WEB, "dist", "randaw.html")}`;
let browser = null;

before(async () => {
  if (skip) return;
  execFileSync(process.execPath, [join(WEB, "build.js")], { stdio: "ignore" });
  browser = await launch(chromium);
});
after(async () => browser?.close());

const example = (name) => readJson(WEB, "examples", `${name}.json`);
const print = (spec) => fnv1a(renderWav(spec).wav);
const FINGERPRINT = "document.documentElement.dataset.audioFingerprint";

// Open the page on an example, with no piece left over from another check.
async function editing(name, check) {
  const page = await browser.open(`${PAGE}?example=${name}`);
  try {
    await page.evaluate("localStorage.clear(), true");
    return await check(page);
  } finally {
    await page.close();
  }
}
// Click something, found by a CSS selector (and the nth match).
const click = (page, selector, n = 0) =>
  page.evaluate(`document.querySelectorAll(${JSON.stringify(selector)})[${n}].click(), true`);
// A click that bubbles up like a real one, for SVG elements, which have no .click().
const tap = (page, selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)})
  .dispatchEvent(new MouseEvent("click", { bubbles: true })), true`);
// The page redraws at once and makes the sound a moment later; wait for the
// sound before reading its fingerprint.
async function fingerprint(page) {
  await page.waitFor("!document.documentElement.dataset.busy");
  return page.evaluate(FINGERPRINT);
}
const button = (card, text) => `.card:nth-of-type(${card + 1}) button[title^="${text}"]`;

test("editing: tapping a beat switches it off; undo and redo step through it", { skip }, () =>
  editing("tresillo", async (page) => {
    const spec = example("tresillo");
    const off = toggleBeat(spec, 0, 2);
    await tap(page, '.band[data-layer="0"][data-beat="2"]');
    assert.equal(await fingerprint(page), print(off));
    assert.match(await page.evaluate("document.getElementById('meta').textContent"), /edited/);

    await click(page, "button[title^='Undo']");
    assert.equal(await fingerprint(page), print(spec));
    await click(page, "button[title^='Redo']");
    assert.equal(await fingerprint(page), print(off));

    // And from the keyboard: Ctrl+Z.
    await page.evaluate(`document.body.dispatchEvent(new KeyboardEvent("keydown",
      { key: "z", ctrlKey: true, bubbles: true })), true`);
    assert.equal(await fingerprint(page), print(spec));

    // Tapping the switched-off beat again turns it back on.
    await tap(page, '.band[data-layer="0"][data-beat="2"]');
    await tap(page, '.band[data-layer="0"][data-beat="2"]');
    assert.equal(await fingerprint(page), print(spec));
  }));

test("editing: mute and solo change what sounds, and fade what does not", { skip }, () =>
  editing("tresillo", async (page) => {
    const spec = example("tresillo");
    await click(page, ".card .toggle", 2);  // M on the second layer
    assert.equal(await fingerprint(page), print(toggleMute(spec, 1)));
    assert.equal(await page.evaluate("document.querySelectorAll('#stage g.silent').length > 0"), true);

    await click(page, ".card .toggle", 2);  // M off again
    await click(page, ".card .toggle", 5);  // S on the third layer
    assert.equal(await fingerprint(page), print(toggleSolo(spec, 2)));
  }));

test("editing: picking a step and a key sets that step, and shows where it lands", { skip }, () =>
  editing("rests", async (page) => {
    const spec = example("rests");
    await click(page, ".card .tile", 1);  // the pluck's second step (a rest)
    assert.ok(await page.evaluate("document.querySelectorAll('#stage .picked').length") >= 3,
      "the step is outlined everywhere it lands");
    await page.evaluate(`[...document.querySelectorAll(".keypad button")].find((b) => b.textContent === "3").click(), true`);
    assert.equal(await fingerprint(page), print(setStep(spec, 0, 1, 3)));
  }));

test("editing: typing a sequence sets it; a mistake is explained and changes nothing", { skip }, () =>
  editing("rests", async (page) => {
    const spec = example("rests");
    const type = (text) => page.evaluate(`{
      const field = document.querySelector(".card input.sequence");
      field.value = ${JSON.stringify(text)};
      field.dispatchEvent(new Event("change"));
      true }`);
    await type("1 q 5");
    assert.match(await page.evaluate("document.querySelector('.field-error').textContent"), /"q" is not a whole number/);
    assert.equal(await fingerprint(page), print(spec));

    await type("1 3 5 8");
    assert.equal(await fingerprint(page), print(setSequence(spec, 0, [1, 3, 5, 8])));

    // Breaking a rule of the engine (a sequence of nothing but rests) is
    // refused with the engine's own message, and the piece is unchanged.
    await type("- -");
    assert.match(await page.evaluate("document.getElementById('message').textContent"), /all rests/);
    assert.equal(await fingerprint(page), print(setSequence(spec, 0, [1, 3, 5, 8])));
  }));

test("editing: piece settings, beats and adding a layer", { skip }, () =>
  editing("tresillo", async (page) => {
    let spec = example("tresillo");
    await click(page, ".piece-controls button[aria-label='Loops down']");
    spec = setSetting(spec, "loops", spec.loops - 1);
    assert.equal(await fingerprint(page), print(spec));

    await click(page, ".card button[aria-label='Beats up']");
    spec = setBeats(spec, 0, spec.layer[0].beats + 1);
    assert.equal(await fingerprint(page), print(spec));

    await page.evaluate(`{
      const cycle = document.querySelector(".piece-controls input[type=number]");
      cycle.value = "1.5";
      cycle.dispatchEvent(new Event("change"));
      true }`);
    spec = setSetting(spec, "cycle_duration", 1.5);
    assert.equal(await fingerprint(page), print(spec));

    await page.evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent === "+ Add layer").click(), true`);
    spec = addLayer(spec, [...LIBRARY.keys()].sort());
    assert.equal(await page.evaluate("document.querySelectorAll('.card').length"), spec.layer.length);
    assert.equal(await fingerprint(page), print(spec));

    await click(page, ".card .remove", spec.layer.length - 1);
    assert.equal(await page.evaluate("document.querySelectorAll('.card').length"), spec.layer.length - 1);
  }));

test("editing: the strip along the top jumps playback", { skip }, () =>
  editing("tresillo", async (page) => {
    await page.evaluate(`{
      const ruler = document.querySelector(".ruler").getBoundingClientRect();
      document.querySelector(".ruler").dispatchEvent(new MouseEvent("click",
        { bubbles: true, clientX: ruler.left + ruler.width * 0.625, clientY: ruler.top + 5 }));
      true }`);
    // Four cycles of 2 s across the strip: five-eighths of the way is 5 s.
    const clock = await page.evaluate("document.getElementById('clock').textContent");
    assert.match(clock, /^5\.00 \//);
  }));

test("editing: the piece survives a reload", { skip }, () =>
  editing("tresillo", async (page) => {
    const spec = toggleBeat(example("tresillo"), 1, 1);
    await tap(page, '.band[data-layer="1"][data-beat="1"]');
    const again = await browser.open(PAGE);
    try {
      assert.equal(await fingerprint(again), print(spec));
      assert.equal(await again.evaluate("document.getElementById('examples').options[0].text"), "Last edited: tresillo");
    } finally {
      await again.close();
    }
  }));

test("editing: while playing, an edit waits for the next cycle and playback carries on", { skip }, () =>
  editing("tresillo", async (page) => {
    // The browser's audio clock runs in real time even with no speakers, so
    // this takes a couple of seconds: tresillo's cycle is 2 s long.
    const seconds = () => page.evaluate("parseFloat(document.getElementById('clock').textContent)");
    await click(page, "#play");
    await page.waitFor("document.getElementById('play').textContent === 'Pause'");
    await page.waitFor("parseFloat(document.getElementById('clock').textContent) > 0.3");
    const before = await seconds();
    assert.ok(before < 1.9, `too near the boundary to test (${before} s)`);

    await tap(page, '.band[data-layer="0"][data-beat="2"]');
    // The sound is made a moment after the tap; then the change is waiting.
    await page.waitFor("!document.documentElement.dataset.busy");
    await page.waitFor("!document.getElementById('pending').hidden", 2);
    assert.equal(await page.evaluate("document.getElementById('play').textContent"), "Pause",
      "playback must not stop for an edit");

    await page.waitFor("document.getElementById('pending').hidden", 5);
    const after = await seconds();
    // It came in at the 2 s boundary, and time carried on rather than restarting.
    assert.ok(after >= 2 && after < 3, `came in at ${after} s`);
    assert.equal((await page.evaluate("({ ...document.documentElement.dataset })")).error, undefined);
  }));

test("editing: jumping while playing carries on playing from the new place", { skip }, () =>
  editing("tresillo", async (page) => {
    await click(page, "#play");
    await page.waitFor("parseFloat(document.getElementById('clock').textContent) > 0.3");
    await click(page, "#next");  // the next page: cycles 5-8, starting at 8 s
    await page.waitFor("parseFloat(document.getElementById('clock').textContent) > 8.3");
    assert.equal(await page.evaluate("document.getElementById('play').textContent"), "Pause");
    assert.equal(await page.evaluate("document.getElementById('window').textContent"), "cycles 5–8 of 8");
  }));

// --- Where an edit comes in (no browser needed) ---------------------------------------

test("an edit comes in at the next cycle, continuing the cycle count", () => {
  const two = { cycle: 2, loops: 4 };
  // 1.5 cycles in: wait half a cycle (1 s), then start the new version at cycle 2.
  assert.deepEqual(planSwap(1.5, two, { cycle: 3, loops: 8 }), { wait: 1, startCycle: 2 });
  // The new version is shorter: the count wraps into its length.
  assert.deepEqual(planSwap(2.25, two, { cycle: 2, loops: 2 }), { wait: 1.5, startCycle: 1 });
  // At the end of the loop, the new version starts from its beginning.
  assert.deepEqual(planSwap(3.5, two, { cycle: 2, loops: 8 }), { wait: 1, startCycle: 0 });
  // Too close to a boundary to set up in time: the one after.
  assert.deepEqual(planSwap(0.99, two, two), { wait: 2.02, startCycle: 2 });
});
