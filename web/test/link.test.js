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

test("link: every example comes back exactly, as name.three-words.tail", async () => {
  for (const { name, spec } of examples) {
    const link = await pieceToLink(name, spec);
    assert.ok(isLink(link));
    assert.match(link, new RegExp(`^#${name}\\.[a-z]+-[a-z]+-[a-z]+\\.[\\w-]+$`), link);
    assert.ok(link.length <= 70, `${name}: ${link.length} characters`);
    assert.deepEqual(await linkToPiece(link), { name, spec });
  }
});

test("link: tresillo, the first example, fits in 47 characters", async () => {
  const { name, spec } = examples.find((x) => x.name === "tresillo");
  assert.ok((await pieceToLink(name, spec)).length <= 47);
});

const wordsOf = (link) => link.split(".")[1];

test("link: the words are the skeleton -- the same while details change, different when the shape does", async () => {
  const spec = examples.find((x) => x.name === "tresillo").spec;
  const words = wordsOf(await pieceToLink("tresillo", spec));
  const detail = structuredClone(spec);
  detail.layer[0].gain = 0.5;
  detail.layer[3].notes = [0, 5, 7];
  detail.layer[1].active = [3];
  detail.bars = 4;
  assert.equal(wordsOf(await pieceToLink("another name", detail)), words);
  for (const change of [(s) => { s.tempo = 100; }, (s) => { s.layer[2].beats = 5; }, (s) => { s.layer.pop(); },
    (s) => { s.layer[0].sample = "tom.wav"; }]) {
    const shape = structuredClone(spec);
    change(shape);
    assert.notEqual(wordsOf(await pieceToLink("tresillo", shape)), words);
  }
});

test("link: every random piece comes back exactly, as words or not", async () => {
  let short = 0;
  for (const { name, spec } of fuzzed) {
    const link = await pieceToLink(name, spec);
    if (link.includes(".")) short++;
    assert.deepEqual(await linkToPiece(link), { name, spec }, `${name}: ${link}`);
  }
  // Most random pieces are stranger than real ones (fractional gains, odd
  // settings); still, nearly all should pack.
  assert.ok(short > fuzzed.length * 0.9, `only ${short} of ${fuzzed.length} packed`);
});

test("link: names in any script survive, and read plainly where they can", async () => {
  const { spec } = examples[0];
  for (const name of ["Grüße — 七拍子 🥁", "My Groove 2", "a-b.c d", "(it's) 100%!", ""]) {
    assert.deepEqual(await linkToPiece(await pieceToLink(name, spec)), { name, spec }, name);
  }
  assert.match(await pieceToLink("My Groove 2", spec), /^#My-Groove-2\./);
});

test("link: editing the name in the address renames the piece", async () => {
  const { name, spec } = examples[0];
  const link = await pieceToLink(name, spec);
  assert.deepEqual(await linkToPiece(link.replace(`#${name}.`, "#Night-bus.")), { name: "Night bus", spec });
});

test("link: words typed in capitals still open", async () => {
  const { name, spec } = examples[0];
  const link = await pieceToLink(name, spec);
  const [slug, words, tail] = link.slice(1).split(".");
  assert.deepEqual(await linkToPiece(`#${slug}.${words.toUpperCase()}.${tail}`), { name, spec });
});

test("link: the plain way of writing it still opens", async () => {
  const { name, spec } = examples[0];
  const plain = "#j" + Buffer.from(JSON.stringify({ name, spec })).toString("base64url");
  assert.deepEqual(await linkToPiece(plain), { name, spec });
});

test("link: a link cut short or mistyped is refused with a SpecError, not opened as something else", async () => {
  for (const { name, spec } of examples) {
    const link = await pieceToLink(name, spec);
    for (let cut = 2; cut < link.length; cut++) {
      await assert.rejects(linkToPiece(link.slice(0, cut)), SpecError, `${name} cut to ${cut}`);
    }
  }
  const link = await pieceToLink(examples[0].name, examples[0].spec);
  const [slug, words, tail] = link.slice(1).split(".");
  for (const bad of [
    `#${slug}.${words.replace(/^[a-z]+/, "abacus")}.${tail}`,         // another word
    `#${slug}.${words.replace(/^[a-z]+/, "zzzz")}.${tail}`,           // not a word
    `#${slug}.${words}.${tail.slice(0, 3)}X${tail.slice(4)}`,         // a character changed
    "#j" + Buffer.from("[1,2]").toString("base64url"), "#j" + Buffer.from("not json").toString("base64url"),
    "#z!!!!", "#p", "#q123"]) {
    await assert.rejects(linkToPiece(bad), SpecError, bad);
  }
});

test("pack: random bits never hang or crash: they unpack or are refused", () => {
  let seed = 1;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 3000; i++) {
    const bits = Array.from({ length: 1 + Math.floor(random() * 300) }, () => (random() < 0.5 ? 0 : 1));
    try {
      unpack(bits);
    } catch (e) {
      assert.ok(e instanceof Unpackable, `${bits.join("")}: ${e}`);
    }
  }
});

test("pack: a piece outside what it covers is refused, for link.js to write another way", () => {
  const { spec } = examples[0];
  assert.throws(() => pack({ ...spec, layer: [{ ...spec.layer[0], notes: [0.5] }] }), Unpackable);
  assert.throws(() => pack({ ...spec, layer: [{ ...spec.layer[0], sample: "mine.wav" }] }), Unpackable);
});

// Links already sent must open the same piece for ever. These were made
// when the words form was first written; if this fails, a frozen list in
// pack.js or words.js has changed -- make a new kind of link instead.
test("link: links made with the first words form still open exactly what they did", async () => {
  const links = readJson(WEB, "test", "fixtures", "links.json");
  for (const { name, spec } of examples) {
    assert.deepEqual(await linkToPiece(links[name]), { name, spec }, name);
    assert.equal(await pieceToLink(name, spec), links[name], `${name} is now written differently`);
  }
});
