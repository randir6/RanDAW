// Checks on writing a piece into a link and reading it back (link.js).

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { isLink, linkToPiece, pieceToLink } from "../src/link.js";
import { SpecError } from "../src/spec.js";
import { readJson, WEB } from "./helpers.js";

const examples = readdirSync(join(WEB, "examples")).map((f) => ({
  name: f.replace(/\.json$/, ""), spec: readJson(WEB, "examples", f),
}));

test("link: every example comes back exactly, in a link of a few hundred characters", async () => {
  for (const { name, spec } of examples) {
    const link = await pieceToLink(name, spec);
    assert.ok(isLink(link));
    assert.match(link, /^#piece=z[\w-]+$/, "only letters, digits, - and _ after the letter");
    assert.ok(link.length < 400, `${name}: ${link.length} characters`);
    assert.deepEqual(await linkToPiece(link), { name, spec });
  }
});

test("link: names in any script survive", async () => {
  const spec = examples[0].spec;
  assert.deepEqual(await linkToPiece(await pieceToLink("Grüße — 七拍子 🥁", spec)), { name: "Grüße — 七拍子 🥁", spec });
});

test("link: the plain way of writing it still opens", async () => {
  const { name, spec } = examples[0];
  const plain = "#piece=j" + Buffer.from(JSON.stringify({ name, spec })).toString("base64url");
  assert.deepEqual(await linkToPiece(plain), { name, spec });
});

test("link: a link cut short or mangled is refused with a SpecError, not a crash", async () => {
  const link = await pieceToLink(examples[0].name, examples[0].spec);
  for (const bad of [link.slice(0, -10), link.slice(0, 12), "#piece=", "#piece=z", "#piece=q" + link.slice(8),
    "#piece=j" + Buffer.from("[1,2]").toString("base64url"), "#piece=j" + Buffer.from("not json").toString("base64url")]) {
    await assert.rejects(linkToPiece(bad), SpecError, bad);
  }
});
