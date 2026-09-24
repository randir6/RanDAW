// Checks on the built page, in a real browser.
//
// Builds dist/randaw.html, then drives it in headless Chromium (a browser
// with no window) through browser.js: open the page, run a little JavaScript
// in it, wait for something to become true, read the result. Skipped, not
// failed, when no Chromium is installed -- set CHROMIUM=/path/to/chrome.
//
// The key check is the audio fingerprint: the page renders every piece
// itself, in the browser, and its fingerprint must match the one Node
// computes for the same piece. That proves the browser made the identical file.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { pieceToDerived } from "../src/derive.js";
import { fnv1a } from "../src/fingerprint.js";
import { pageWithPiece } from "../src/share.js";
import { findChromium, launch } from "./browser.js";
import { readJson, renderWav, WEB } from "./helpers.js";

const chromium = findChromium();
const skip = chromium === null ? "no headless Chromium found (set CHROMIUM=path)" : false;

const PAGE = join(WEB, "dist", "randaw.html");
let browser = null;
let scratch = null;

before(async () => {
  if (skip) return;
  execFileSync(process.execPath, [join(WEB, "build.js")], { stdio: "ignore" });
  scratch = mkdtempSync(join(tmpdir(), "randaw-page-"));
  browser = await launch(chromium);
});
after(async () => browser?.close());

// What the page says about itself: the data-... attributes on <html>.
const ATTRS = "({ ...document.documentElement.dataset })";

// Open a page, run `check` with it, and always close it afterwards.
async function withPage(file, query, check) {
  const page = await browser.open(`file://${file}${query}`);
  try {
    return await check(page);
  } finally {
    await page.close();
  }
}

// A copy of the page with a piece saved inside, as "Save page" makes.
function savedPage(name, spec) {
  const file = join(scratch, `${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(file, pageWithPiece(readFileSync(PAGE, "utf8"), name, spec));
  return file;
}
const layer = (beats, sample = "hat.wav") => ({ beats, notes: [0], sample, gain: 0.1 });

const examples = readdirSync(join(WEB, "examples")).map((f) => f.replace(/\.json$/, ""));

for (const name of examples) {
  test(`page: ${name} renders the same audio as Node and draws every note`, { skip }, () =>
    withPage(PAGE, `?example=${name}&t=0`, async (page) => {
      const attrs = await page.evaluate(ATTRS);
      const spec = readJson(WEB, "examples", `${name}.json`);
      const { piece, wav } = renderWav(spec);
      assert.equal(attrs.error, undefined, `page error: ${attrs.error}`);
      assert.equal(attrs.audioFingerprint, fnv1a(wav));
      // Notes drawn on the first page: every sounding cell in its cycles.
      const perPage = Number(attrs.window);
      const expected = pieceToDerived(piece).cells
        .filter((c) => c.status === "note" && c.cycle <= perPage).length;
      assert.equal(Number(attrs.notesDrawn), expected);
    }));
}

test("page: a saved page opens with the piece saved into it", { skip }, () => {
  const spec = { cycle_duration: 1.5, loops: 2, layer: [layer(3), layer(4, "kick.wav")] };
  return withPage(savedPage("my groove", spec), "?t=0", async (page) => {
    const attrs = await page.evaluate(ATTRS);
    assert.equal(attrs.error, undefined);
    assert.equal(await page.evaluate("document.title"), "my groove · RanDAW");
    assert.equal(attrs.audioFingerprint, fnv1a(renderWav(spec).wav));
  });
});

test("page: a name that looks like HTML cannot break out of the page", { skip }, () =>
  withPage(savedPage("</script><b>bold</b>", { loops: 1, layer: [layer(3)] }), "?t=0", async (page) => {
    assert.equal((await page.evaluate(ATTRS)).error, undefined);
    assert.equal(await page.evaluate("document.querySelectorAll('b').length"), 0);
    assert.equal(await page.evaluate("document.getElementById('title').textContent"), "</script><b>bold</b>");
  }));

test("page: six layers still play, but the drawing says why it is missing", { skip }, () => {
  const spec = { loops: 1, layer: [2, 3, 4, 5, 6, 7].map((b) => layer(b)) };
  return withPage(savedPage("six", spec), "?t=0", async (page) => {
    const attrs = await page.evaluate(ATTRS);
    assert.equal(attrs.error, undefined);
    assert.equal(attrs.audioFingerprint, fnv1a(renderWav(spec).wav));
    assert.equal(await page.evaluate("document.getElementById('figure').hidden"), true);
    assert.match(await page.evaluate("document.getElementById('message').textContent"),
      /at most 5 layers and this piece has 6/);
  });
});

test("page: a piece it cannot use gets a message, not a crash", { skip }, () =>
  withPage(savedPage("typo", { loops: 1, layer: [layer(3, "kik.wav")] }), "?t=0", async (page) => {
    assert.equal((await page.evaluate(ATTRS)).error, undefined);
    assert.equal(await page.evaluate("document.getElementById('message').className"), "message error");
    assert.match(await page.evaluate("document.getElementById('message').textContent"), /unknown sample kik\.wav/);
  }));

// Pressing the buttons. Saved files are caught instead of saved: the page
// saves by clicking a hidden link, so link clicks are recorded instead.
const CATCH_SAVES = `
  window.saved = [];
  HTMLAnchorElement.prototype.click = function () { window.saved.push({ name: this.download, href: this.href }); };
  window.savedBytes = async (i) => new Uint8Array(await (await fetch(window.saved[i].href)).arrayBuffer());
  window.fnv = (b) => { let h = 0x811c9dc5; for (const x of b) h = Math.imul(h ^ x, 0x01000193); return (h >>> 0).toString(16).padStart(8, "0"); };
  true`;

test("page: the buttons save the right files, and Open reads a saved piece back", { skip }, () =>
  withPage(PAGE, "", async (page) => {
    await page.evaluate(CATCH_SAVES);
    await page.evaluate(`{
      const menu = document.getElementById("examples");
      menu.value = "seven";
      menu.dispatchEvent(new Event("change"));
      for (const id of ["download", "save-piece", "save-page"]) document.getElementById(id).click();
    }`);
    assert.equal(await page.evaluate("document.title"), "seven · RanDAW");
    assert.deepEqual(await page.evaluate("saved.map((s) => s.name)"), ["seven.wav", "seven.json", "seven.html"]);

    const spec = readJson(WEB, "examples", "seven.json");
    assert.equal(await page.evaluate("savedBytes(0).then(fnv)"), fnv1a(renderWav(spec).wav));
    const pieceText = await page.evaluate("savedBytes(1).then((b) => new TextDecoder().decode(b))");
    assert.equal(pieceText, readFileSync(join(WEB, "examples", "seven.json"), "utf8"));

    // The saved page must itself work: open it, and it plays the same piece.
    const shared = join(scratch, "saved-by-button.html");
    writeFileSync(shared, await page.evaluate("savedBytes(2).then((b) => new TextDecoder().decode(b))"));
    await withPage(shared, "?t=0", async (copy) => {
      const attrs = await copy.evaluate(ATTRS);
      assert.equal(attrs.error, undefined);
      assert.equal(attrs.audioFingerprint, fnv1a(renderWav(spec).wav), "the saved page plays something else");
    });

    // Open the saved piece twice through the file picker.
    for (let i = 0; i < 2; i++) {
      await page.evaluate(`{
        const picker = document.getElementById("open");
        const files = new DataTransfer();
        files.items.add(new File([${JSON.stringify(pieceText)}], "mine.json"));
        picker.files = files.files;
        picker.dispatchEvent(new Event("change"));
      }`);
      await page.waitFor("document.title === 'mine · RanDAW'");
    }
    assert.equal(await page.evaluate("document.getElementById('examples').options[0].text"), "Opened: mine");
    assert.equal(await page.evaluate("document.getElementById('examples').options.length"), examples.length + 1,
      "opening twice added a second menu entry");
  }));
