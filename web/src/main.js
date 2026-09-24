// The page itself: wiring the engine, the drawing and the player to the
// buttons.
//
// Everything musical happens in the engine modules; everything visual in
// view.js; everything audible in player.js. This file only connects them to
// the page, which is the job the command line used to do.

import { pieceToDerived } from "./derive.js";
import { fnv1a } from "./fingerprint.js";
import { buildPiece } from "./piece.js";
import { createPlayer } from "./player.js";
import { finishMix, renderAudio } from "./render.js";
import { schedule } from "./schedule.js";
import { pageWithPiece } from "./share.js";
import { formatSpec, readSpec, SpecError } from "./spec.js";
import { createView, MAX_LAYERS } from "./view.js";
import { decodeWav, encodeWav16 } from "./wav.js";

// The page exactly as it arrived, before anything was drawn into it. "Save
// page" copies this with a different piece inside, so a shared page is the
// same program as this one. It has to be read first thing, while nothing has
// been changed yet.
const PRISTINE = "<!doctype html>\n" + document.documentElement.outerHTML;

// How long a piece may be. A policy of this page, not a rule of the engine:
// past a couple of minutes the file gets unwieldy to open and share.
const MAX_SECONDS = 120;

// Any error ends up as an attribute on the page, where the automated checks
// can see it, and as a message a person can read. Otherwise a broken page
// would just look empty.
window.addEventListener("error", (e) => {
  document.documentElement.dataset.error = String(e.message);
  say(`Something went wrong: ${e.message}`, "error");
});

// `$` is just a short name for looking up an element by its id.
const $ = (id) => document.getElementById(id);

function say(text, kind = "") {
  $("message").textContent = text;
  $("message").className = `message ${kind}`;
}

// --- The data built into the page ------------------------------------------------

const readBlock = (id) => JSON.parse($(id).textContent);

// base64 text back into raw bytes. atob() gives a string with one character
// per byte; charCodeAt reads each one's number.
function fromBase64(text) {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

// Sample name -> decoded audio. Decoding them all up front takes a few
// milliseconds for the built-in set.
const library = new Map(
  Object.entries(readBlock("randaw-samples")).map(([name, b64]) => [name, decodeWav(fromBase64(b64))]),
);
const examples = readBlock("randaw-examples");  // [{ name, about, spec }]

// --- The current piece ---------------------------------------------------------

const player = createPlayer();
let current = null;  // { name, spec, wav } for the piece on screen
let view = null;     // the drawing, or null when the piece has too many layers

// Work out everything about a piece, make its sound, and show it. Returns
// false (having said why) if the piece cannot be used.
function open(spec, name) {
  let piece;
  try {
    piece = buildPiece(spec, { samples: library.keys(), source: name });
  } catch (e) {
    if (!(e instanceof SpecError)) throw e;
    say(e.message, "error");
    return false;
  }
  if (piece.totalDuration > MAX_SECONDS) {
    say(`${name} would be ${piece.totalDuration.toFixed(1)} s long, over this page's limit of ` +
      `${MAX_SECONDS} s. Use fewer loops or a shorter cycle.`, "error");
    return false;
  }

  const derived = pieceToDerived(piece);
  const { mix, peak } = finishMix(renderAudio(schedule(piece.layers, piece.loops), { ...piece, library }));
  const wav = encodeWav16(mix, piece.sampleRate);
  current = { name, spec: piece.spec, wav };
  player.load(mix, piece.sampleRate);

  const notes = [...piece.warnings];
  if (peak > 1) {
    notes.push(`the mix peaked at ${peak.toFixed(2)} and was clipped, which distorts -- ` +
      `turn the layers down, e.g. multiply every gain by ${(0.99 / peak).toFixed(2)}`);
  }
  say(notes.length ? `Note: ${notes.join("; ")}.` : "", notes.length ? "warn" : "");

  document.title = `${name} · RanDAW`;
  $("title").textContent = name;
  $("meta").textContent =
    `${derived.loops} cycles × ${derived.cycle_duration.toFixed(2)} s = ${derived.total_duration.toFixed(2)} s` +
    ` · ${derived.layers.length} layers · ${derived.lcm} pulses per cycle`;

  if (derived.layers.length > MAX_LAYERS) {
    // Refuse to draw rather than draw only some: a layer you can hear but not
    // see would make the rest of the picture untrustworthy. It still plays.
    view = null;
    $("figure").hidden = true;
    say(`The drawing shows at most ${MAX_LAYERS} layers and this piece has ` +
      `${derived.layers.length}. It still plays and downloads.`, "warn");
    $("text-grid").textContent = "";
  } else {
    $("figure").hidden = false;
    view = createView(derived, $("stage"));
    $("text-grid").textContent = view.textGrid();
  }
  $("prev").disabled = $("next").disabled = view === null || view.pages === 1;

  const print = fnv1a(wav);
  $("fingerprint").textContent = print;
  document.documentElement.dataset.audioFingerprint = print;
  refresh();
  return true;
}

// Bring the drawing and the clock up to date with the player.
function refresh() {
  const t = player.position();
  if (view !== null) {
    view.show(t);
    $("window").textContent = view.pageLabel();
  }
  $("clock").textContent = `${t.toFixed(2)} / ${player.duration().toFixed(2)} s`;
  $("play").textContent = player.isPlaying() ? "Pause" : "Play";
}

// Called by the browser before each screen refresh, about 60 times a second,
// for as long as the piece plays. Everything visual follows the audio clock.
function tick() {
  refresh();
  if (player.isPlaying()) requestAnimationFrame(tick);
}

async function togglePlay() {
  if (player.isPlaying()) {
    player.stop();
    refresh();
  } else {
    await player.play();
    requestAnimationFrame(tick);
  }
}

function changePage(delta) {
  if (view === null) return;
  player.seek(view.pageStart(delta));
  refresh();
}

// --- Saving things ---------------------------------------------------------------

// Hand the browser some bytes as a file to save. A "blob" is a lump of data
// held in memory; an object URL is a temporary address for it that a link
// can point at.
function download(data, filename, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Give the browser a moment to start the download before letting go.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// This same page, set to open with the current piece.
const pageWithCurrentPiece = () => pageWithPiece(PRISTINE, current.name, current.spec);

// --- Controls ---------------------------------------------------------------------

$("play").addEventListener("click", togglePlay);
$("prev").addEventListener("click", () => changePage(-1));
$("next").addEventListener("click", () => changePage(1));

$("stage").addEventListener("click", (e) => {
  const t = view?.timeAtClick(e.clientX);  // ?. : only if there is a view
  if (t === null || t === undefined) return;
  player.seek(t);
  refresh();
});

document.addEventListener("keydown", (e) => {
  // Leave keys alone while something like a button or menu has focus, so
  // space presses that button rather than doing two things at once.
  if (e.target.closest("button, select, input, label, textarea")) return;
  if (e.code === "Space") {
    e.preventDefault();  // stop the page scrolling
    togglePlay();
  } else if (e.code === "ArrowLeft") changePage(-1);
  else if (e.code === "ArrowRight") changePage(1);
});

// The menu lists the examples, plus one extra entry at the top for a piece
// that is not an example (one opened from a file, or saved into this page).
// Reusing that one entry keeps them from piling up.
const other = new Option("", "");
function showOther(label) {
  other.text = label;
  if (!other.parentElement) $("examples").add(other, 0);
  $("examples").value = "";
}

for (const example of examples) {
  $("examples").add(new Option(`Example: ${example.name} — ${example.about}`, example.name));
}
$("examples").addEventListener("change", () => {
  const example = examples.find((x) => x.name === $("examples").value);
  if (example && open(example.spec, example.name)) other.remove();
});

$("open").addEventListener("change", async () => {
  const file = $("open").files[0];
  if (!file) return;
  const name = file.name.replace(/\.json$/i, "");
  try {
    if (open(readSpec(await file.text(), file.name), name)) showOther(`Opened: ${name}`);
  } catch (e) {
    if (!(e instanceof SpecError)) throw e;
    say(e.message, "error");
  }
  $("open").value = "";  // so choosing the same file again still counts as a change
});

$("download").addEventListener("click", () => {
  if (current) download(current.wav, `${current.name}.wav`, "audio/wav");
});
$("save-piece").addEventListener("click", () => {
  if (current) download(formatSpec(current.spec), `${current.name}.json`, "application/json");
});
$("save-page").addEventListener("click", () => {
  if (current) download(pageWithCurrentPiece(), `${current.name}.html`, "text/html");
});

// --- Start -------------------------------------------------------------------------

// Which piece to open first: ?example=name in the address, else the piece
// saved into this page, else the first example.
const params = new URLSearchParams(location.search);
const embedded = readBlock("randaw-piece");  // null, or { name, spec }
const asked = examples.find((x) => x.name === params.get("example"));
const first = asked ?? (embedded ? null : examples[0]);
if (first) {
  $("examples").value = first.name;
  open(first.spec, first.name);
} else {
  showOther(`Piece: ${embedded.name}`);
  open(embedded.spec, embedded.name);
}

// ?t=3.2 shows a still frame at 3.2 seconds, without sound -- for linking to
// a moment, and for the automated checks, which have no speakers.
if (params.has("t")) {
  const t = parseFloat(params.get("t"));
  if (!Number.isNaN(t)) {
    player.seek(t);
    $("play").disabled = true;
    $("hint").textContent = `Still frame at ${player.position().toFixed(2)} s — remove ?t= from the address to play`;
    refresh();
  }
}
document.documentElement.dataset.ready = "1";
