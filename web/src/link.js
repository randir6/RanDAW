// A piece written into a link, so the address itself can carry it.
//
// The part of an address after "#" never leaves the browser -- it is not sent
// to the server -- so a link like
//
//   https://randir6.github.io/RanDAW/#p_rV3zB7SqwncgRy2afIO
//
// opens the page and then the piece written after the "#". Nothing is
// stored anywhere: the link is the piece. Sending the link shares it, a
// bookmark keeps it, and a reload opens it again.
//
// After the "#" comes one letter saying how the piece is written, then the
// piece, in characters an address can carry without escaping:
//
//   p  packed (pack.js), plus one check character: usually 20-40
//      characters. Used whenever it gives back exactly the piece it was given.
//   z  the piece as JSON, squeezed with deflate, in base64url: a few hundred
//      characters. For anything the packed form does not cover. Browsers
//      made since 2023 can do this (CompressionStream).
//   j  the JSON as it is, for a browser that cannot squeeze.
//
// A later way of writing it would take a new letter, so every link made
// before keeps opening.

import { pack, Unpackable, unpack } from "./pack.js";
import { SpecError } from "./spec.js";

// Is this the #part of an address that carries a piece?
export const isLink = (hash) => /^#[pzj][\w-]/.test(hash);

// The same piece, whatever order its keys were written in?
const sorted = (value) => JSON.stringify(value, (_, v) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v);

// One character worked out from the rest of a packed link and written after
// it. A link cut short, or with a character changed, almost always (63
// times in 64) no longer matches it, and is refused rather than opening some
// other piece.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function check(text) {
  let h = 0x811c9dc5;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  return B64[(h >>> 0) % 64];
}

// The packed form, if it gives back exactly this piece; otherwise null.
function packed(name, spec) {
  try {
    const text = pack(name, spec);
    return sorted(unpack(text)) === sorted({ name, spec }) ? "#p" + text + check(text) : null;
  } catch (e) {
    if (e instanceof Unpackable) return null;
    throw e;
  }
}

// Bytes to base64url and back. btoa and atob work one character per byte.
function toBase64url(bytes) {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function fromBase64url(text) {
  const raw = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// Run bytes through a CompressionStream or DecompressionStream.
async function through(stream, bytes) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

// The #part of a link that carries this piece.
export async function pieceToLink(name, spec) {
  const short = packed(name, spec);
  if (short) return short;
  const json = new TextEncoder().encode(JSON.stringify({ name, spec }));
  if (typeof CompressionStream === "undefined") return "#j" + toBase64url(json);
  return "#z" + toBase64url(await through(new CompressionStream("deflate-raw"), json));
}

// The { name, spec } a link's #part carries. A link that has been cut short
// or mangled on its way is refused with a SpecError saying so.
export async function linkToPiece(hash) {
  const how = hash.charAt(1);
  const data = hash.slice(2);
  const broken = new SpecError("That link does not hold a whole piece -- it may have been cut short " +
    "on its way. The page has opened something else instead.");
  if (how === "z" && typeof DecompressionStream === "undefined") {
    throw new SpecError("This browser is too old to open that link (it needs Safari 16.4 or later, " +
      "or a recent Chrome or Firefox). The page has opened something else instead.");
  }
  let piece;
  try {
    if (how === "p") {
      if (data.length < 2 || check(data.slice(0, -1)) !== data.at(-1)) throw broken;
      return unpack(data.slice(0, -1));
    }
    let bytes = fromBase64url(data);
    if (how === "z") bytes = await through(new DecompressionStream("deflate-raw"), bytes);
    else if (how !== "j") throw broken;
    piece = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw broken;
  }
  if (!(piece && typeof piece.name === "string" && piece.spec && typeof piece.spec === "object")) throw broken;
  return { name: piece.name.slice(0, 60), spec: piece.spec };
}
