// A piece written into a link, so the address itself can carry it.
//
// The part of an address after "#" never leaves the browser -- it is not sent
// to the server -- so a link like
//
//   https://randir6.github.io/RanDAW/#piece=zq1ZKkktLlGyMjTQUUpKLE...
//
// opens the page and then the piece written after "piece=". Nothing is
// stored anywhere: the link is the piece. Sending the link shares it, a
// bookmark keeps it, and a reload opens it again.
//
// What follows "piece=" is one letter saying how it is written, then the
// piece ({ name, spec } as JSON) in base64url (base64 using - and _ instead
// of + and /, so it needs no escaping in an address):
//
//   z  squeezed with deflate first: roughly half as long. Browsers made
//      since 2023 can do this (CompressionStream).
//   j  the JSON as it is, for a browser that cannot squeeze.
//
// A later way of writing it would take a new letter, so every link made
// before keeps opening.

import { SpecError } from "./spec.js";

const PREFIX = "#piece=";

// Is this the #part of an address that carries a piece?
export const isLink = (hash) => hash.startsWith(PREFIX);

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
  const json = new TextEncoder().encode(JSON.stringify({ name, spec }));
  if (typeof CompressionStream === "undefined") return PREFIX + "j" + toBase64url(json);
  return PREFIX + "z" + toBase64url(await through(new CompressionStream("deflate-raw"), json));
}

// The { name, spec } a link's #part carries. A link that has been cut short
// or mangled on its way is refused with a SpecError saying so.
export async function linkToPiece(hash) {
  const how = hash.charAt(PREFIX.length);
  const data = hash.slice(PREFIX.length + 1);
  const broken = new SpecError("That link does not hold a whole piece -- it may have been cut short " +
    "on its way. The page has opened something else instead.");
  if (how === "z" && typeof DecompressionStream === "undefined") {
    throw new SpecError("This browser is too old to open that link (it needs Safari 16.4 or later, " +
      "or a recent Chrome or Firefox). The page has opened something else instead.");
  }
  let piece;
  try {
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
