// The page itself: wiring the engine, the drawing, the editor and the player
// to the buttons.
//
// Everything musical happens in the engine modules; everything visual in
// view.js and editor.js; everything audible in player.js. This file keeps
// the one piece of state -- the piece being edited, and its undo history --
// and connects the rest to it.

import { toggleBeat } from "./edit.js";
import { renderEditor } from "./editor.js";
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

// Two things this code relies on arrived in Safari only in 2022 (iOS 15.4).
// For older devices, simple stand-ins -- the pieces here are plain JSON-style
// data, which is all these need to handle.
Object.hasOwn ??= (object, key) => Object.prototype.hasOwnProperty.call(object, key);
globalThis.structuredClone ??= (value) => JSON.parse(JSON.stringify(value));

// The page exactly as it arrived, before anything was drawn into it. "Save
// page" copies this with a different piece inside, so a shared page is the
// same program as this one. It has to be read first thing, while nothing has
// been changed yet.
const PRISTINE = "<!doctype html>\n" + document.documentElement.outerHTML;

// How long a piece may be. A policy of this page, not a rule of the engine:
// past a couple of minutes the file gets unwieldy to open and share.
const MAX_SECONDS = 120;
// How many steps back Undo can go.
const HISTORY = 200;
// Where the piece is kept between visits, in this browser only.
const DRAFT_KEY = "randaw-draft";

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
const sampleNames = [...library.keys()];
const examples = readBlock("randaw-examples");  // [{ name, about, spec }]

// --- The state -------------------------------------------------------------------

// Everything the page is showing comes from this one object. `spec` is the
// piece as written; `history` and `future` are the specs Undo and Redo step
// through; `selected` is the sequence step being edited, if any.
const state = {
  name: null,
  spec: null,
  history: [],
  future: [],
  selected: null,
  made: null,  // the worked-out piece: { piece, derived, mix, wav }
};

const player = createPlayer();

// Sounds made while rendering, kept from one edit to the next (see
// renderAudio). Each new gain or pitch adds one, so it is emptied now and then
// rather than allowed to grow for ever; everything in it can be remade.
const voices = new Map();
const MAX_VOICES = 300;
let view = null;  // the drawing, or null when the piece has too many layers

// Check a spec and work out everything the drawing needs -- or say why not.
// Returns null (having said why) if the piece cannot be used. Quick: this is
// what every edit waits for before the screen changes.
function check(spec, name) {
  let piece;
  try {
    piece = buildPiece(spec, { samples: sampleNames, source: name });
  } catch (e) {
    if (!(e instanceof SpecError)) throw e;
    say(e.message, "error");
    return null;
  }
  if (piece.totalDuration > MAX_SECONDS) {
    say(`That would be ${piece.totalDuration.toFixed(1)} s long, over this page's limit of ` +
      `${MAX_SECONDS} s. Use fewer loops or a shorter cycle.`, "error");
    return null;
  }
  return { piece, derived: pieceToDerived(piece), mix: null, peak: 0, wav: null };
}

// Make a checked piece's sound, and its WAV file. The slow part of an edit.
function sound(made) {
  const { piece } = made;
  const events = schedule(piece.layers, piece.loops, { audible: piece.audible });
  if (voices.size > MAX_VOICES) voices.clear();
  const { mix, peak } = finishMix(renderAudio(events, { ...piece, library, cache: voices }));
  Object.assign(made, { mix, peak, wav: encodeWav16(mix, piece.sampleRate) });
}

// Everything worth telling the person about the piece as it stands: rounding,
// clipping, and a piece too big to draw.
function notices(made) {
  const notes = [...made.piece.warnings];
  if (made.peak > 1) {
    notes.push(`the mix peaked at ${made.peak.toFixed(2)} and was clipped, which distorts -- ` +
      `turn the layers down, e.g. multiply every gain by ${(0.99 / made.peak).toFixed(2)}`);
  }
  if (made.derived.layers.length > MAX_LAYERS) {
    notes.push(`the drawing shows at most ${MAX_LAYERS} layers and this piece has ` +
      `${made.derived.layers.length}; it still plays and downloads`);
  }
  say(notes.length ? `Note: ${notes.join("; ")}.` : "", notes.length ? "warn" : "");
}

// Open a piece afresh: an example, a file, or the one saved in this page.
// Undo history starts again, and playback goes back to the start.
function open(spec, name) {
  const made = check(spec, name);
  if (made === null) return false;
  cancelSound();
  sound(made);
  Object.assign(state, { name, spec: made.piece.spec, history: [], future: [], selected: null, made });
  player.load(made.mix, made.piece.sampleRate, timing());
  show();
  notices(made);
  return true;
}

// Apply an edit: a function from edit.js, spec in, new spec out. If the result
// breaks a rule, the message says which and nothing changes -- the last good
// version keeps playing. Otherwise it becomes the piece, Undo can take it
// back, and while playing it comes in at the next cycle.
//
// The screen changes straight away; the sound is made a moment later (see
// soundSoon), so a slow phone never makes a tap feel ignored.
function commit(next, { record = true } = {}) {
  const made = check(next, state.name);
  if (made === null) return false;
  if (record) {
    state.history.push(state.spec);
    if (state.history.length > HISTORY) state.history.shift();
    state.future = [];
  }
  state.spec = made.piece.spec;
  state.made = made;
  // Keep the selected step only if it still exists.
  const s = state.selected;
  if (s && !(state.spec.layer[s.layer] && s.step < sequenceOf(state.spec.layer[s.layer]).length)) {
    state.selected = null;
  }
  saveDraft();
  show();
  soundSoon();
  return true;
}

// Making the sound is left until just after the screen has been redrawn, by
// waiting a little over one screen refresh. Quick edits in a row -- tapping +
// three times -- only make the sound once, for the last of them.
// data-busy on the page says a sound is waiting, for the automated checks.
let soundTimer = null;
function soundSoon() {
  clearTimeout(soundTimer);
  document.documentElement.dataset.busy = "1";
  soundTimer = setTimeout(soundNow, 25);
}
function soundNow() {
  soundTimer = null;
  const made = state.made;
  if (made.mix === null) {
    sound(made);
    player.swap(made.mix, made.piece.sampleRate, timing());
    notices(made);
    showFingerprint();
  }
  delete document.documentElement.dataset.busy;
}
function cancelSound() {
  clearTimeout(soundTimer);
  soundTimer = null;
  delete document.documentElement.dataset.busy;
}
// Anything that needs the finished sound -- Download WAV -- calls this first.
function soundReady() {
  if (soundTimer !== null) {
    clearTimeout(soundTimer);
    soundNow();
  }
}

const sequenceOf = (layer) => layer.degrees ?? layer.notes;
const edit = (change) => commit(change(state.spec));

// Undo and redo move specs between the two lists. The move is recorded BEFORE
// the change is made, because making it redraws the page -- including the
// Undo and Redo buttons, which must already know there is something to redo.
// If the change is refused, the move is taken back.
function undo() {
  if (state.history.length === 0) return;
  const previous = state.history.pop();
  state.future.push(state.spec);
  if (!commit(previous, { record: false })) {
    state.future.pop();
    state.history.push(previous);
  }
}
function redo() {
  if (state.future.length === 0) return;
  const next = state.future.pop();
  state.history.push(state.spec);
  if (!commit(next, { record: false })) {
    state.history.pop();
    state.future.push(next);
  }
}

// How long a cycle is and how many there are, which the player needs to know
// where cycle boundaries fall.
function timing() {
  return { cycle: state.made.piece.cycleDuration, loops: state.made.piece.loops };
}

// --- Showing it -------------------------------------------------------------------

// Redraw everything from the state.
function show() {
  const { derived } = state.made;
  const name = state.name;
  const edited = state.history.length > 0;
  document.title = `${name} · RanDAW`;
  $("title").textContent = name;
  $("meta").textContent =
    `${derived.loops} cycles × ${derived.cycle_duration.toFixed(2)} s = ${derived.total_duration.toFixed(2)} s` +
    ` · ${derived.layers.length} layers · ${derived.lcm} pulses per cycle${edited ? " · edited" : ""}`;

  if (derived.layers.length > MAX_LAYERS) {
    // Refuse to draw rather than draw only some: a layer you can hear but not
    // see would make the rest of the picture untrustworthy. It still plays,
    // and notices() says why the drawing is missing.
    view = null;
    $("figure").hidden = true;
    $("text-grid").textContent = "";
  } else {
    $("figure").hidden = false;
    view = createView(derived, $("stage"), {
      onBeat: (layer, beat) => edit((s) => toggleBeat(s, layer, beat)),
      onSeek: (cycles) => { player.seek(cycles); refresh(); },
      // Narrow screens show fewer cycles at once, so each one is wider.
      maxPerPage: narrow() ? 2 : 4,
    });
    if (state.selected) view.highlight(state.selected.layer, state.selected.step);
    $("text-grid").textContent = view.textGrid();
  }
  $("prev").disabled = $("next").disabled = view === null || view.pages === 1;

  renderEditor({
    container: $("editor"),
    spec: state.spec,
    derived,
    samples: sampleNames,
    selected: state.selected,
    history: { canUndo: state.history.length > 0, canRedo: state.future.length > 0 },
    actions: { edit, select, undo, redo },
  });

  showFingerprint();
  refresh();
}

// The audio fingerprint under "The grid as text", once the sound is made.
function showFingerprint() {
  if (state.made.wav === null) return;
  const print = fnv1a(state.made.wav);
  $("fingerprint").textContent = print;
  document.documentElement.dataset.audioFingerprint = print;
}

// Choose a sequence step to edit (step null clears the choice).
function select(layer, step) {
  state.selected = step === null ? null : { layer, step };
  show();
}

// Bring the drawing and the clock up to date with the player. The player
// counts in cycles; this piece's cycle length turns that into seconds.
function refresh() {
  const { cycleDuration, loops, totalDuration } = state.made.piece;
  const t = (player.cyclePosition() % loops) * cycleDuration;
  if (view !== null) {
    view.show(t);
    $("window").textContent = view.pageLabel();
  }
  $("clock").textContent = `${t.toFixed(2)} / ${totalDuration.toFixed(2)} s`;
  $("play").textContent = player.isPlaying() ? "Pause" : "Play";
  $("pending").hidden = !player.isSwapPending();
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

// Turning a phone round changes how much room the drawing has, and so how
// many cycles fit on a page. Redraw when that crosses the line -- only then,
// since a resize fires many times while it happens.
const narrow = () => window.innerWidth < 700;
let wasNarrow = narrow();
window.addEventListener("resize", () => {
  if (narrow() !== wasNarrow && state.made) {
    wasNarrow = narrow();
    show();
  }
});

// --- Keeping the piece between visits -----------------------------------------

// The piece is saved in the browser's own storage after every edit, so a
// reload -- or Safari quietly closing the tab -- does not lose it. That
// storage belongs to this browser alone and can be cleared, which is why
// Save piece is still the way to keep something. Wrapped in try, because
// some browsers refuse storage altogether (private windows, for instance).
function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ name: state.name, spec: state.spec }));
  } catch {
    // no storage: nothing to do
  }
}
function loadDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null");
    return draft && typeof draft.name === "string" ? draft : null;
  } catch {
    return null;
  }
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

// --- Controls ---------------------------------------------------------------------

$("play").addEventListener("click", togglePlay);
$("prev").addEventListener("click", () => changePage(-1));
$("next").addEventListener("click", () => changePage(1));

document.addEventListener("keydown", (e) => {
  // Undo and redo: Ctrl+Z / Ctrl+Y on Windows and Linux, ⌘Z / ⇧⌘Z on a Mac.
  // Left alone inside a text field, which has its own undo.
  const command = e.ctrlKey || e.metaKey;
  const typing = e.target.closest("input, textarea, select");
  if (command && !typing && (e.key === "z" || e.key === "Z" || e.key === "y")) {
    e.preventDefault();
    if (e.key === "y" || e.shiftKey) redo();
    else undo();
    return;
  }
  // Leave other keys alone while something like a button or menu has focus,
  // so space presses that button rather than doing two things at once.
  if (e.target.closest("button, select, input, label, textarea")) return;
  if (e.code === "Space") {
    e.preventDefault();  // stop the page scrolling
    togglePlay();
  } else if (e.code === "ArrowLeft") changePage(-1);
  else if (e.code === "ArrowRight") changePage(1);
});

// The menu lists the examples, plus one extra entry at the top for a piece
// that is not an example (one opened from a file, saved into this page, or
// carried on from last time). Reusing that one entry keeps them from piling up.
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
  if (example && open(example.spec, example.name)) {
    other.remove();
    saveDraft();
  }
});

$("open").addEventListener("change", async () => {
  const file = $("open").files[0];
  if (!file) return;
  const name = file.name.replace(/\.json$/i, "");
  try {
    if (open(readSpec(await file.text(), file.name), name)) {
      showOther(`Opened: ${name}`);
      saveDraft();
    }
  } catch (e) {
    if (!(e instanceof SpecError)) throw e;
    say(e.message, "error");
  }
  $("open").value = "";  // so choosing the same file again still counts as a change
});

$("download").addEventListener("click", () => {
  soundReady();
  download(state.made.wav, `${state.name}.wav`, "audio/wav");
});
$("save-piece").addEventListener("click", () => {
  download(formatSpec(state.spec), `${state.name}.json`, "application/json");
});
$("save-page").addEventListener("click", () => {
  download(pageWithPiece(PRISTINE, state.name, state.spec), `${state.name}.html`, "text/html");
});

// --- Start -------------------------------------------------------------------------

// Which piece to open first: ?example=name in the address, else the piece
// saved into this page, else whatever was being edited last time, else the
// first example.
const params = new URLSearchParams(location.search);
const embedded = readBlock("randaw-piece");  // null, or { name, spec }
const asked = examples.find((x) => x.name === params.get("example"));
const draft = asked || embedded ? null : loadDraft();
if (asked) {
  $("examples").value = asked.name;
  open(asked.spec, asked.name);
} else if (embedded) {
  showOther(`Piece: ${embedded.name}`);
  open(embedded.spec, embedded.name);
} else if (draft && open(draft.spec, draft.name)) {
  showOther(`Last edited: ${draft.name}`);
} else {
  $("examples").value = examples[0].name;
  open(examples[0].spec, examples[0].name);
}

// ?t=3.2 shows a still frame at 3.2 seconds, without sound -- for linking to
// a moment, and for the automated checks, which have no speakers.
if (params.has("t") && state.made) {
  const t = parseFloat(params.get("t"));
  if (!Number.isNaN(t)) {
    player.seek(t / state.made.piece.cycleDuration);
    $("play").disabled = true;
    $("hint").textContent = `Still frame at ${t.toFixed(2)} s — remove ?t= from the address to play`;
    refresh();
  }
}
document.documentElement.dataset.ready = "1";
