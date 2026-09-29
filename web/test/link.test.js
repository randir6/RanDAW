// Checks on writing a piece into a link and reading it back (link.js,
// pack.js).

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { isLink, linkToPiece, pieceToLink } from "../src/link.js";
import { pack, unpack, Unpackable } from "../src/pack.js";
import { SpecError, upgradeSpec } from "../src/spec.js";
import { readJson, WEB } from "./helpers.js";

const examples = readdirSync(join(WEB, "examples")).map((f) => ({
  name: f.replace(/\.json$/, ""), spec: readJson(WEB, "examples", f),
}));
// The random pieces the fuzz checks use; the good ones, in today's words, as
// the page would hold them.
const fuzzed = readJson(WEB, "test", "fixtures", "fuzz.json")
  .filter((x) => x.ok)
  .map((x, i) => ({ name: `fuzz ${i}`, spec: upgradeSpec(x.spec) }));

test("link: every example comes back exactly, packed short", async () => {
  for (const { name, spec } of examples) {
    const link = await pieceToLink(name, spec);
    assert.ok(isLink(link));
    assert.match(link, /^#p[\w-]+$/, `${name} is not packed`);
    assert.ok(link.length <= 42, `${name}: ${link.length} characters`);
    assert.deepEqual(await linkToPiece(link), { name, spec });
  }
});

test("link: tresillo, the first example, fits in 22 characters", async () => {
  const { name, spec } = examples.find((x) => x.name === "tresillo");
  assert.ok((await pieceToLink(name, spec)).length <= 22);
});

test("link: every random piece comes back exactly, packed or not", async () => {
  let short = 0;
  for (const { name, spec } of fuzzed) {
    const link = await pieceToLink(name, spec);
    if (link.startsWith("#p")) short++;
    assert.deepEqual(await linkToPiece(link), { name, spec }, `${name}: ${link}`);
  }
  // Most random pieces are stranger than real ones (fractional gains, odd
  // settings); still, a good share should pack.
  assert.ok(short > fuzzed.length / 4, `only ${short} of ${fuzzed.length} packed`);
});

test("link: names in any script survive", async () => {
  const { spec } = examples[0];
  for (const name of ["Grüße — 七拍子 🥁", "My Groove 2", ""]) {
    assert.deepEqual(await linkToPiece(await pieceToLink(name, spec)), { name, spec });
  }
});

test("link: the plain way of writing it still opens", async () => {
  const { name, spec } = examples[0];
  const plain = "#j" + Buffer.from(JSON.stringify({ name, spec })).toString("base64url");
  assert.deepEqual(await linkToPiece(plain), { name, spec });
});

test("link: a link cut short or mangled is refused with a SpecError, not opened as something else", async () => {
  for (const { name, spec } of examples) {
    const link = await pieceToLink(name, spec);
    for (let cut = 2; cut < link.length; cut++) {
      await assert.rejects(linkToPiece(link.slice(0, cut)), SpecError, `${name} cut to ${cut}`);
    }
  }
  for (const bad of ["#p", "#q123", "#j" + Buffer.from("[1,2]").toString("base64url"),
    "#j" + Buffer.from("not json").toString("base64url"), "#z!!!!"]) {
    await assert.rejects(linkToPiece(bad), SpecError, bad);
  }
});

test("pack: random text never hangs or crashes: it unpacks or is refused", () => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let seed = 1;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 3000; i++) {
    const text = Array.from({ length: 1 + Math.floor(random() * 60) }, () => chars[Math.floor(random() * 64)]).join("");
    try {
      unpack(text);
    } catch (e) {
      assert.ok(e instanceof Unpackable, `${text}: ${e}`);
    }
  }
});

test("pack: a piece outside what it covers is refused, for link.js to write another way", () => {
  const { spec } = examples[0];
  assert.throws(() => pack("x", { ...spec, layer: [{ ...spec.layer[0], notes: [0.5] }] }), Unpackable);
  assert.throws(() => pack("x", { ...spec, layer: [{ ...spec.layer[0], sample: "mine.wav" }] }), Unpackable);
});

// Links already sent must open the same piece for ever. These were made
// when the packed form was first written; if this fails, a frozen list in
// pack.js has changed -- make a new format letter instead.
test("link: links made with the first packed form still open exactly what they did", async () => {
  const links = readJson(WEB, "test", "fixtures", "links.json");
  for (const { name, spec } of examples) {
    assert.deepEqual(await linkToPiece(links[name]), { name, spec }, name);
    assert.equal(await pieceToLink(name, spec), links[name], `${name} is now written differently`);
  }
});
