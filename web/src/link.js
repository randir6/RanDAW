// A piece written into a link, so the address itself can carry it.
//
// The part of an address after "#" never leaves the browser -- it is not sent
// to the server -- so a link like
//
//   https://randir6.github.io/RanDAW/#tresillo.submarine-dreamlike-frivolous.93zBpVYcgWzT44Mb
//
// opens the page and then the piece written after the "#". Nothing is
// stored anywhere: the link is the piece. Sending the link shares it, a
// bookmark keeps it, and a reload opens it again.
//
// A link has three parts, joined by dots:
//
//   the name    as it is, so a link says what it is. Spaces are written as
//               hyphens; anything an address cannot hold plainly is escaped
//               (%2E for a dot, %2D for a real hyphen, and so on). Editing it
//               in the address renames the piece.
//   3 words     from words.js: the first 32 bits of the packed piece
//               (pack.js), which are its skeleton -- tempo, base, layers,
//               their samples and beats -- plus 6 bits that check the words.
//               Pieces with the same shape share their words.
//   the tail    the rest of the packed piece in base64url, then two
//               characters that check the whole piece.
//
// A link cut short, or mistyped, fails a check (all but 1 time in 4,096),
// or has a word that is not a word, and is refused rather than opening some
// other piece.
//
// A piece the packed form does not cover gets a longer kind of link, with no
// dots: "#z" and the piece as JSON squeezed with deflate in base64url (a
// few hundred characters; browsers made since 2023 can do this), or "#j"
// and the JSON as it is, for a browser that cannot squeeze.

import { pack, Unpackable, unpack } from "./pack.js";
import { SpecError } from "./spec.js";
import { WORDS } from "./words.js";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// How many bits of the piece the words hold, and how many check them.
const WORD_BITS = 32;
const WORD_CHECK = 6;
// How many characters of the tail check the whole piece, six bits each.
const TAIL_CHECK = 2;
const tailCheck = (bits) => toBase64url(toBits(checkOf(bits, 6 * TAIL_CHECK), 6 * TAIL_CHECK)).padEnd(TAIL_CHECK, "A");

// Is this the #part of an address that carries a piece?
export const isLink = (hash) => /^#[^.]*\.[A-Za-z]+-[A-Za-z]+-[A-Za-z]+\.[\w-]+$/.test(hash) || /^#[zj][\w-]/.test(hash);

// --- The parts -----------------------------------------------------------------------

// A name as the first part of a link, and back. Hyphens stand for spaces,
// so a real hyphen, and the dot that ends the part, are escaped, as are the
// few characters some apps take for the end of a link.
const toSlug = (name) => encodeURIComponent(name)
  .replace(/[-.!~*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
  .replaceAll("%20", "-");
const fromSlug = (slug) => decodeURIComponent(slug.replaceAll("-", "%20"));

// A short hash of some bits, as a number below 2^width.
function checkOf(bits, width) {
  let h = 0x811c9dc5;
  for (const b of bits) h = Math.imul(h ^ (b + 48), 0x01000193);
  return (h >>> 0) % 2 ** width;
}

// Bits as a whole number, and back.
const toNumber = (bits) => bits.reduce((n, b) => n * 2 + b, 0);
const toBits = (n, width) => Array.from({ length: width }, (_, i) => Math.floor(n / 2 ** (width - 1 - i)) % 2);

// Bits as base64url characters, and back. Trailing zeros are left out: the
// packed form reads missing bits as zeros.
function toBase64url(bits) {
  let out = "";
  for (let i = 0; i < bits.length; i += 6) out += B64[toNumber(toBits(0, 6).map((_, j) => bits[i + j] ?? 0))];
  return out.replace(/A+$/, "");
}
function fromBase64url(text) {
  return [...text].flatMap((c) => {
    const v = B64.indexOf(c);
    if (v < 0) throw new Unpackable(`not a link character: ${c}`);
    return toBits(v, 6);
  });
}
const withoutTrailingZeros = (bits) => bits.slice(0, bits.lastIndexOf(1) + 1);

// The same piece, whatever order its keys were written in?
const sorted = (value) => JSON.stringify(value, (_, v) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v);

// --- Links ---------------------------------------------------------------------------

// The name.words.tail link, if the packed form gives back exactly this
// piece; otherwise null.
function wordsLink(name, spec) {
  let bits;
  try {
    bits = pack(spec);
    if (sorted(unpack(bits)) !== sorted(spec)) return null;
  } catch (e) {
    if (e instanceof Unpackable) return null;
    throw e;
  }
  bits = withoutTrailingZeros(bits);
  const head = toBits(0, WORD_BITS).map((_, i) => bits[i] ?? 0);
  let n = toNumber(head) * 2 ** WORD_CHECK + checkOf(head, WORD_CHECK);
  const words = [];
  for (let i = 0; i < 3; i++) {
    words.unshift(WORDS[n % WORDS.length]);
    n = Math.floor(n / WORDS.length);
  }
  const tail = toBase64url(bits.slice(WORD_BITS)) + tailCheck(bits);
  return `#${toSlug(name)}.${words.join("-")}.${tail}`;
}

// The { name, spec } in a name.words.tail link; throws if it is not one.
function readWordsLink(hash) {
  const [, slug, words, tail] = hash.match(/^#([^.]*)\.([A-Za-z-]+)\.([\w-]+)$/) ?? [];
  if (tail === undefined) throw new Unpackable("not a link");
  let n = 0;
  for (const word of words.toLowerCase().split("-")) {
    const i = WORDS.indexOf(word);
    if (i < 0) throw new Unpackable(`not one of the words: ${word}`);
    n = n * WORDS.length + i;
  }
  if (n >= 2 ** (WORD_BITS + WORD_CHECK)) throw new Unpackable("not a link");
  const head = toBits(Math.floor(n / 2 ** WORD_CHECK), WORD_BITS);
  if (checkOf(head, WORD_CHECK) !== n % 2 ** WORD_CHECK) throw new Unpackable("the words do not check");
  if (tail.length < TAIL_CHECK) throw new Unpackable("not a link");
  const bits = withoutTrailingZeros([...head, ...fromBase64url(tail.slice(0, -TAIL_CHECK))]);
  if (tailCheck(bits) !== tail.slice(-TAIL_CHECK)) throw new Unpackable("the tail does not check");
  return { name: fromSlug(slug), spec: unpack(bits) };
}

// Bytes to base64url and back, for the longer kinds of link. btoa and atob
// work one character per byte.
function bytesToBase64url(bytes) {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function base64urlToBytes(text) {
  const raw = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// Run bytes through a CompressionStream or DecompressionStream.
async function through(stream, bytes) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

// The #part of a link that carries this piece.
export async function pieceToLink(name, spec) {
  const short = wordsLink(name, spec);
  if (short) return short;
  const json = new TextEncoder().encode(JSON.stringify({ name, spec }));
  if (typeof CompressionStream === "undefined") return "#j" + bytesToBase64url(json);
  return "#z" + bytesToBase64url(await through(new CompressionStream("deflate-raw"), json));
}

// The { name, spec } a link's #part carries. A link that has been cut short
// or mangled on its way is refused with a SpecError saying so.
export async function linkToPiece(hash) {
  const how = hash.charAt(1);
  const broken = new SpecError("That link does not hold a whole piece -- it may have been cut short " +
    "or mistyped on its way. The page has opened something else instead.");
  if (how === "z" && typeof DecompressionStream === "undefined" && !hash.includes(".")) {
    throw new SpecError("This browser is too old to open that link (it needs Safari 16.4 or later, " +
      "or a recent Chrome or Firefox). The page has opened something else instead.");
  }
  let piece;
  try {
    if (hash.includes(".")) return readWordsLink(hash);
    let bytes = base64urlToBytes(hash.slice(2));
    if (how === "z") bytes = await through(new DecompressionStream("deflate-raw"), bytes);
    else if (how !== "j") throw broken;
    piece = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw broken;
  }
  if (!(piece && typeof piece.name === "string" && piece.spec && typeof piece.spec === "object")) throw broken;
  return { name: piece.name.slice(0, 60), spec: piece.spec };
}
