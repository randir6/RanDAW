// Checks on editing in the page, in a real browser.
//
// Each check does what a person would -- taps a beat, presses M, picks a
// position and a key, types a sequence, presses Undo -- and then compares the audio the
// page made against the audio Node makes for the same edit, done directly with
// edit.js. Matching fingerprints mean the page applied exactly that edit.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  addLayer, duplicateLayer, setBeats, setOver, setPosition, setSequence, setSetting, toggleBeat, toggleMute, toggleSolo,
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

test("editing: the beat buttons in a card switch beats, like tapping the drawing", { skip }, () =>
  editing("tresillo", async (page) => {
    const spec = example("tresillo");  // the kick has 8 beats, on at 1, 4 and 7
    const pressed = "[...document.querySelectorAll('.card')[0].querySelectorAll('.beat')].map((b) => b.getAttribute('aria-pressed'))";
    assert.deepEqual(await page.evaluate(pressed),
      ["true", "false", "false", "true", "false", "false", "true", "false"]);
    await click(page, ".card .beat", 1);  // beat 2 of the kick
    assert.equal(await fingerprint(page), print(toggleBeat(spec, 0, 2)));
    assert.equal((await page.evaluate(pressed))[1], "true");
  }));

test("editing: mute and solo change what sounds, and fade what does not", { skip }, () =>
  editing("tresillo", async (page) => {
    const spec = example("tresillo");
    await click(page, ".card .toggle", 2);  // M on the second layer
    assert.equal(await fingerprint(page), print(toggleMute(spec, 1)));
    assert.equal(await page.evaluate("document.querySelectorAll('#stage g.silent').length > 0"), true);

    assert.match(await page.evaluate("document.getElementById('text-grid').textContent"), /snare.*\(silent\)/);
    await click(page, ".card .toggle", 2);  // M off again
    await click(page, ".card .toggle", 5);  // S on the third layer
    assert.equal(await fingerprint(page), print(toggleSolo(spec, 2)));
  }));

test("editing: picking a position and a key sets it, and shows where it lands", { skip }, () =>
  editing("rests", async (page) => {
    const spec = example("rests");
    await click(page, ".card .tile", 1);  // the pluck's second position (a rest)
    assert.ok(await page.evaluate("document.querySelectorAll('#stage .picked').length") >= 3,
      "the position is outlined everywhere it lands");
    assert.equal(await page.evaluate("document.querySelector('.keypad .label').textContent"), "Position 2");
    await page.evaluate(`[...document.querySelectorAll(".keypad button")].find((b) => b.textContent === "3").click(), true`);
    assert.equal(await fingerprint(page), print(setPosition(spec, 0, 1, 3)));
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
    await click(page, ".piece-controls button[aria-label='Bars down']");
    spec = setSetting(spec, "bars", spec.bars - 1);
    assert.equal(await fingerprint(page), print(spec));

    await click(page, ".card button[aria-label='Beats up']");
    spec = setBeats(spec, 0, spec.layer[0].beats + 1);
    assert.equal(await fingerprint(page), print(spec));

    await page.evaluate(`{
      const tempo = document.querySelector(".piece-controls input[type=number]");
      tempo.value = "90";
      tempo.dispatchEvent(new Event("change"));
      true }`);
    spec = setSetting(spec, "tempo", 90);
    assert.equal(await fingerprint(page), print(spec));

    await click(page, ".piece-controls button[aria-label='Base up']");
    spec = setSetting(spec, "base", 5);
    assert.equal(await fingerprint(page), print(spec));
    assert.match(await page.evaluate("document.getElementById('meta').textContent"), /90 BPM, 5 beats per bar/);

    // The click starts off, and adds the base beats to the sound.
    assert.equal(await page.evaluate("document.querySelector('.piece-controls .click').getAttribute('aria-pressed')"), "false");
    await click(page, ".piece-controls .click");
    spec = setSetting(spec, "click", true);
    assert.equal(await fingerprint(page), print(spec));

    // Spreading the hat's 3 beats over 2 bars.
    await click(page, ".card button[aria-label='over up']", 2);
    spec = setOver(spec, 2, 2);
    assert.equal(await fingerprint(page), print(spec));
    assert.match(await page.evaluate("document.getElementById('text-grid').textContent"), /hat/);

    await page.evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent === "+ Add layer").click(), true`);
    spec = addLayer(spec, [...LIBRARY.keys()].sort());
    assert.equal(await page.evaluate("document.querySelectorAll('.card').length"), spec.layer.length);
    assert.equal(await fingerprint(page), print(spec));

    await click(page, ".card .remove", spec.layer.length - 1);
    assert.equal(await page.evaluate("document.querySelectorAll('.card').length"), spec.layer.length - 1);
  }));

test("editing: duplicate a layer, and rename the piece for saving", { skip }, () =>
  editing("tresillo", async (page) => {
    await click(page, ".card .duplicate", 3);  // the pluck
    assert.equal(await fingerprint(page), print(duplicateLayer(example("tresillo"), 3)));
    await page.evaluate(`{
      const name = document.querySelector("input.name");
      name.value = "  my/groove?  ";
      name.dispatchEvent(new Event("change"));
      window.saved = [];
      HTMLAnchorElement.prototype.click = function () { window.saved.push(this.download); };
      document.getElementById("save-piece").click();
      true }`);
    assert.deepEqual(await page.evaluate("window.saved"), ["mygroove.json"]);
    assert.equal(await page.evaluate("document.title"), "mygroove · RanDAW");
  }));

test("editing: the strip along the top jumps playback", { skip }, () =>
  editing("tresillo", async (page) => {
    await page.evaluate(`{
      const ruler = document.querySelector(".ruler").getBoundingClientRect();
      document.querySelector(".ruler").dispatchEvent(new MouseEvent("click",
        { bubbles: true, clientX: ruler.left + ruler.width * 0.625, clientY: ruler.top + 5 }));
      true }`);
    // Four bars of 2 s across the strip: five-eighths of the way is 5 s --
    // give or take a couple of pixels, each about 0.01 s here.
    const seconds = await page.evaluate("parseFloat(document.getElementById('clock').textContent)");
    assert.ok(Math.abs(seconds - 5) < 0.03, `jumped to ${seconds} s`);
  }));

test("editing: the rings drawing edits like the grid, and is remembered", { skip }, () =>
  editing("tresillo", async (page) => {
    await click(page, "#mode-rings");
    assert.equal(await page.evaluate("document.querySelectorAll('#stage .ring-bg').length"), 4);
    // Tapping a slice of a ring switches that beat, as tapping the grid does.
    await tap(page, '.band[data-layer="0"][data-beat="2"]');
    assert.equal(await fingerprint(page), print(toggleBeat(example("tresillo"), 0, 2)));
    // A quarter of the way round the outer ring is a quarter of the way
    // through the bar: 0.5 s of tresillo's 2 s bar.
    await page.evaluate(`{
      const ring = document.querySelector(".ruler-ring");
      const box = ring.getBoundingClientRect();
      // 6 pixels in from its right-hand edge: 3 o'clock, on the ring.
      ring.dispatchEvent(new MouseEvent("click", { bubbles: true,
        clientX: box.left + box.width / 2 + (box.width / 2 - 6), clientY: box.top + box.height / 2 }));
      true }`);
    const seconds = await page.evaluate("parseFloat(document.getElementById('clock').textContent)");
    assert.ok(Math.abs(seconds - 0.5) < 0.03, `jumped to ${seconds} s`);
    // Opening the page again keeps the rings.
    const again = await browser.open(PAGE);
    try {
      assert.equal(await again.evaluate("document.getElementById('mode-rings').getAttribute('aria-pressed')"), "true");
      assert.ok(await again.evaluate("document.querySelectorAll('#stage .ring-bg').length") > 0);
      await again.evaluate("document.getElementById('mode-grid').click(), true");
      assert.equal(await again.evaluate("document.querySelectorAll('#stage .ring-bg').length"), 0);
    } finally {
      await again.close();
    }
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

test("editing: while playing, an edit waits for the next bar and playback carries on", { skip }, () =>
  editing("tresillo", async (page) => {
    // The browser's audio clock runs in real time even with no speakers, so
    // this takes a couple of seconds: tresillo's bar is 2 s long.
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
    // It came in at the start of bar 2, and time carried on rather than restarting.
    assert.ok(after >= 2 && after < 3, `came in at ${after} s`);
    assert.equal((await page.evaluate("({ ...document.documentElement.dataset })")).error, undefined);
  }));

test("editing: the drawing waits for sound to reach the speakers", { skip }, () =>
  editing("tresillo", async (page) => {
    // Pretend the speakers are 300 ms away, as Bluetooth headphones often
    // are: the browser reports that as the context's outputLatency.
    await page.evaluate(`Object.defineProperty((window.AudioContext || window.webkitAudioContext).prototype,
      "outputLatency", { get: () => 0.3 }), true`);
    await click(page, "#play");
    await page.waitFor("document.getElementById('play').textContent === 'Pause'");
    const started = Date.now();
    await page.waitFor("parseFloat(document.getElementById('clock').textContent) > 0.5");
    // Sound sent at time 0 is heard 0.3 s later, so the drawing reaches 0.5 s
    // at about 0.8 s of real time, not 0.5.
    const waited = (Date.now() - started) / 1000;
    assert.ok(waited > 0.7, `the drawing reached 0.5 s after only ${waited} s`);
    assert.match(await page.evaluate("document.getElementById('latency').textContent"),
      /drawing delayed 3\d\d ms to match your speakers/);
    assert.equal(await page.evaluate("document.getElementById('latency').hidden"), false);
  }));

test("editing: jumping while playing carries on playing from the new place", { skip }, () =>
  editing("tresillo", async (page) => {
    await click(page, "#play");
    await page.waitFor("parseFloat(document.getElementById('clock').textContent) > 0.3");
    await click(page, "#next");  // the next page: bars 5-8, starting at 8 s
    await page.waitFor("parseFloat(document.getElementById('clock').textContent) > 8.3");
    assert.equal(await page.evaluate("document.getElementById('play').textContent"), "Pause");
    assert.equal(await page.evaluate("document.getElementById('window').textContent"), "bars 5–8 of 8");
  }));

test("editing: the piece says how long its pattern takes, and can loop on it exactly", { skip }, () =>
  editing("rests", async (page) => {
    assert.match(await page.evaluate("document.querySelector('.piece-controls .repeat').textContent"),
      /whole pattern repeats every 21 bars/);
    await page.evaluate(`[...document.querySelectorAll(".piece-controls button")].find((b) => b.textContent === "Use 21 bars").click(), true`);
    assert.equal(await fingerprint(page), print(setSetting(example("rests"), "bars", 21)));
    assert.equal(await page.evaluate("document.querySelector('.piece-controls .repeat').className"), "repeat");
  }));

test("editing: the length suggestion rounds up to whole repeats, keeping the length chosen", { skip }, () =>
  editing("tresillo", async (page) => {
    // tresillo: 8 bars of a pattern that repeats every 3. The next whole number is 9.
    const button = "[...document.querySelectorAll('.piece-controls .repeat button')].map((b) => b.textContent)";
    assert.deepEqual(await page.evaluate(button), ["Use 9 bars"]);
  }));

test("editing: a clipping mix offers to turn everything down, and that cures it", { skip }, () =>
  editing("tresillo", async (page) => {
    // Every gain up to 1.5 is far too loud for four layers together.
    for (let i = 0; i < 4; i++) {
      await page.evaluate(`{
        const slider = document.querySelectorAll(".card input[type=range]")[${i}];
        slider.value = "1.5";
        slider.dispatchEvent(new Event("change"));
        true }`);
    }
    await page.waitFor("!document.documentElement.dataset.busy");
    assert.match(await page.evaluate("document.getElementById('message').textContent"), /clipped/);
    await click(page, "#message .fix");
    await page.waitFor("!document.documentElement.dataset.busy");
    assert.doesNotMatch(await page.evaluate("document.getElementById('message').textContent"), /clipped/);
  }));

test("editing: Escape puts the position keypad away", { skip }, () =>
  editing("rests", async (page) => {
    await click(page, ".card .tile", 0);
    assert.equal(await page.evaluate("document.querySelectorAll('.keypad').length"), 1);
    await page.evaluate(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    assert.equal(await page.evaluate("document.querySelectorAll('.keypad').length"), 0);
  }));

test("editing: keyboard focus stays on the control just used", { skip }, () =>
  editing("tresillo", async (page) => {
    // Focus the first card's "Beats up" and press it three times, as a
    // keyboard would (Enter on a focused button clicks it).
    for (let i = 0; i < 3; i++) {
      await page.evaluate(`{
        const button = document.activeElement?.matches("[aria-label='Beats up']")
          ? document.activeElement
          : document.querySelector(".card [aria-label='Beats up']");
        button.focus();
        button.click();
        true }`);
    }
    assert.equal(await page.evaluate("document.activeElement.getAttribute('aria-label')"), "Beats up");
    assert.equal(await page.evaluate("document.querySelector('.card .stepper .value').textContent"), "11");
  }));

test("editing: a refusal straight after an edit is not wiped by that edit's sound", { skip }, () =>
  editing("rests", async (page) => {
    // Both in the same instant: a good edit (its sound is made 25 ms later),
    // then one that breaks a rule. The refusal must still be showing after.
    await page.evaluate(`{
      document.querySelectorAll(".card .beat")[0].click();
      const field = document.querySelector(".card input.sequence");
      field.value = "- -";
      field.dispatchEvent(new Event("change"));
      true }`);
    await page.waitFor("!document.documentElement.dataset.busy");
    assert.match(await page.evaluate("document.getElementById('message').textContent"), /all rests/);
  }));

test("editing: a refused change leaves the controls showing the real piece", { skip }, () =>
  editing("rests", async (page) => {
    // Removing the piece's scale is refused: the rests layers need it.
    await page.evaluate(`{
      const scale = document.querySelector(".piece-controls select");
      scale.value = "";
      scale.dispatchEvent(new Event("change"));
      true }`);
    assert.match(await page.evaluate("document.getElementById('message').textContent"), /degrees need a scale/);
    assert.equal(await page.evaluate("document.querySelector('.piece-controls select').value"), "dorian");

    // 10 BPM makes a 24 s bar, and 6 of them 144 s, over the limit: refused.
    await page.evaluate(`{
      const tempo = document.querySelector(".piece-controls input[type=number]");
      tempo.value = "10";
      tempo.dispatchEvent(new Event("change"));
      true }`);
    assert.match(await page.evaluate("document.getElementById('message').textContent"), /over this page's limit/);
    assert.equal(await page.evaluate("document.querySelector('.piece-controls input[type=number]').value"), "110");
  }));

// --- Where an edit comes in (no browser needed) ---------------------------------------

test("an edit comes in at the start of the next bar, continuing the bar count", () => {
  const two = { bar: 2, bars: 4 };
  // 1.5 bars in: wait half a bar (1 s), then start the new version at bar 2.
  assert.deepEqual(planSwap(1.5, two, { bar: 3, bars: 8 }), { wait: 1, startBar: 2 });
  // The new version is shorter: the count wraps into its length.
  assert.deepEqual(planSwap(2.25, two, { bar: 2, bars: 2 }), { wait: 1.5, startBar: 1 });
  // At the end of the piece, the new version starts from its beginning.
  assert.deepEqual(planSwap(3.5, two, { bar: 2, bars: 8 }), { wait: 1, startBar: 0 });
  // Too close to a bar line to set up in time: the one after.
  assert.deepEqual(planSwap(0.99, two, two), { wait: 2.02, startBar: 2 });
});
