// Checks on the built page, in a real browser.
//
// Builds dist/randaw.html, then opens it in headless Chromium (a browser with
// no window) and reads back what the page reported about itself: the
// data-... attributes it sets on its <html> element. Skipped, not failed,
// when no Chromium is installed -- set CHROMIUM=/path/to/chrome to point at one.
//
// The key check is the audio fingerprint: the page renders every piece
// itself, in the browser, and its fingerprint must match the one Node
// computes for the same piece. That proves the browser made the identical file.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pieceToDerived } from "../src/derive.js";
import { fnv1a } from "../src/fingerprint.js";
import { pageWithPiece } from "../src/share.js";
import { readJson, renderWav, WEB } from "./helpers.js";

function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const base = "/opt/pw-browsers";
  if (!existsSync(base)) return null;
  const found = readdirSync(base)
    .filter((name) => name.startsWith("chromium-"))
    .map((name) => join(base, name, "chrome-linux", "chrome"))
    .filter(existsSync);
  return found.at(-1) ?? null;
}

const chromium = findChromium();
const skip = chromium === null ? "no headless Chromium found (set CHROMIUM=path)" : false;

// Build once for all the checks below.
const PAGE = join(WEB, "dist", "randaw.html");
if (!skip) execFileSync(process.execPath, [join(WEB, "build.js")], { stdio: "ignore" });

// Open a page and return its <html> tag's attributes, and the whole page.
function visit(file, query = "") {
  const dom = execFileSync(chromium, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--virtual-time-budget=5000",
    "--dump-dom", `file://${file}${query}`,
  ], { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "ignore"] });
  const tag = dom.match(/<html[^>]*>/)[0];
  const attrs = Object.fromEntries([...tag.matchAll(/data-([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  return { attrs, dom };
}

const examples = readdirSync(join(WEB, "examples")).map((f) => f.replace(/\.json$/, ""));

for (const name of examples) {
  test(`page: ${name} renders the same audio as Node and draws every note`, { skip }, () => {
    const spec = readJson(WEB, "examples", `${name}.json`);
    const { attrs } = visit(PAGE, `?example=${name}&t=0`);
    assert.equal(attrs.error, undefined, `page error: ${attrs.error}`);
    assert.equal(attrs.ready, "1");
    assert.equal(attrs["audio-fingerprint"], fnv1a(renderWav(spec).wav));

    // Notes drawn on the first page: every sounding cell in its cycles.
    const { piece } = renderWav(spec);
    const perPage = Number(attrs.window);
    const expected = pieceToDerived(piece).cells.filter((c) => c.status === "note" && c.cycle <= perPage).length;
    assert.equal(Number(attrs["notes-drawn"]), expected);
  });
}

// Pages saved with a piece inside, as "Save page" makes them.
const scratch = skip ? null : mkdtempSync(join(tmpdir(), "randaw-page-"));
function savedPage(name, spec) {
  const file = join(scratch, "shared.html");
  writeFileSync(file, pageWithPiece(readFileSync(PAGE, "utf8"), name, spec));
  return visit(file, "?t=0");
}
const layer = (beats, sample = "hat.wav") => ({ beats, notes: [0], sample, gain: 0.1 });

test("page: a saved page opens with the piece saved into it", { skip }, () => {
  const spec = { cycle_duration: 1.5, loops: 2, layer: [layer(3), layer(4, "kick.wav")] };
  const { attrs, dom } = savedPage("my groove", spec);
  assert.equal(attrs.error, undefined);
  assert.match(dom, /<title>my groove · RanDAW<\/title>/);
  assert.equal(attrs["audio-fingerprint"], fnv1a(renderWav(spec).wav));
});

test("page: a name that looks like HTML cannot break out of the page", { skip }, () => {
  const { attrs, dom } = savedPage("</script><b>bold</b>", { loops: 1, layer: [layer(3)] });
  assert.equal(attrs.error, undefined);
  assert.equal(attrs.ready, "1");
  assert.doesNotMatch(dom, /<b>bold<\/b>/);
});

test("page: six layers still play, but the drawing says why it is missing", { skip }, () => {
  const spec = { loops: 1, layer: [2, 3, 4, 5, 6, 7].map((b) => layer(b)) };
  const { attrs, dom } = savedPage("six", spec);
  assert.equal(attrs.error, undefined);
  assert.equal(attrs["audio-fingerprint"], fnv1a(renderWav(spec).wav));
  assert.match(dom, /<figure id="figure" hidden="">/);
  assert.match(dom, /at most 5 layers and this piece has 6/);
});

// Pressing the buttons. A script is added to a copy of the page that picks an
// example, presses Download WAV, Save piece and Save page -- catching the
// files instead of saving them -- then opens the saved piece through the
// Open… button, and reports what happened in a data-probe attribute.
const PROBE = `<script>
(async () => {
  const fnv = (b) => { let h = 0x811c9dc5; for (const x of b) h = Math.imul(h ^ x, 0x01000193); return (h >>> 0).toString(16).padStart(8, "0"); };
  const saved = [];
  HTMLAnchorElement.prototype.click = function () { saved.push({ name: this.download, href: this.href }); };
  const bytes = async (s) => new Uint8Array(await (await fetch(s.href)).arrayBuffer());
  const $ = (id) => document.getElementById(id);
  const out = {};
  $("examples").value = "seven";
  $("examples").dispatchEvent(new Event("change"));
  out.title = document.title;
  $("download").click(); $("save-piece").click(); $("save-page").click();
  out.names = saved.map((s) => s.name);
  out.wav = fnv(await bytes(saved[0]));
  out.piece = new TextDecoder().decode(await bytes(saved[1]));
  const page = new TextDecoder().decode(await bytes(saved[2]));
  out.pageOpensSeven = page.includes('id="randaw-piece">{"name":"seven"');
  out.page = page;
  const file = new DataTransfer();
  file.items.add(new File([out.piece], "mine.json"));
  $("open").files = file.files;
  $("open").dispatchEvent(new Event("change"));
  await new Promise((r) => setTimeout(r, 300));
  $("open").files = file.files;
  $("open").dispatchEvent(new Event("change"));
  await new Promise((r) => setTimeout(r, 300));
  out.afterOpen = document.title;
  out.menuTop = $("examples").options[0].text;
  out.menuLength = $("examples").options.length;
  document.documentElement.dataset.probe = JSON.stringify(out);
})().catch((e) => { document.documentElement.dataset.probe = JSON.stringify({ error: e.message }); });
</script></body>`;

test("page: the buttons save the right files, and Open reads a saved piece back", { skip }, () => {
  const file = join(scratch, "probe.html");
  writeFileSync(file, readFileSync(PAGE, "utf8").replace("</body>", PROBE));
  const { attrs } = visit(file);
  const unescape = (s) => s.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  const probe = JSON.parse(unescape(attrs.probe ?? '{"error": "no probe result"}'));
  assert.equal(probe.error, undefined, probe.error);
  assert.equal(probe.title, "seven · RanDAW");
  assert.deepEqual(probe.names, ["seven.wav", "seven.json", "seven.html"]);
  const spec = readJson(WEB, "examples", "seven.json");
  assert.equal(probe.wav, fnv1a(renderWav(spec).wav), "downloaded WAV differs from Node's");
  assert.equal(probe.piece, readFileSync(join(WEB, "examples", "seven.json"), "utf8"));
  assert.ok(probe.pageOpensSeven, "saved page does not carry the piece");
  // The saved page must itself work: open it, and it plays the same piece.
  const shared = join(scratch, "saved-by-button.html");
  writeFileSync(shared, probe.page);
  const reopened = visit(shared, "?t=0").attrs;
  assert.equal(reopened.error, undefined, reopened.error);
  assert.equal(reopened["audio-fingerprint"], probe.wav, "the saved page plays something else");
  assert.equal(probe.afterOpen, "mine · RanDAW");
  assert.equal(probe.menuTop, "Opened: mine");
  assert.equal(probe.menuLength, examples.length + 1, "opening twice added a second menu entry");
});

test("page: a piece it cannot use gets a message, not a crash", { skip }, () => {
  const { attrs, dom } = savedPage("typo", { loops: 1, layer: [layer(3, "kik.wav")] });
  assert.equal(attrs.error, undefined);
  assert.equal(attrs.ready, "1");
  assert.match(dom, /class="message error"[^>]*>unknown sample kik\.wav/);
});
