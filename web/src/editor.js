// The editing panel: the controls under the drawing.
//
// renderEditor() builds the whole panel from the current piece, every time the
// piece changes. That is the simplest way to guarantee the controls never
// disagree with the piece -- there is no second copy of anything to keep in
// step -- and a panel this size rebuilds in well under a millisecond.
//
// The panel changes nothing itself. Every control calls `edit` with a
// function from edit.js (spec in, new spec out); the page decides whether the
// result is valid, records it for undo, and plays it.

import {
  addLayer, duplicateLayer, effectiveRoot, effectiveScale, formatSequence, insertPosition, MAX_BARS, MAX_BASE, MAX_BEATS,
  MAX_OVER, MAX_TEMPO, MIN_TEMPO, parseSequence, removeLayer, removePosition, sequenceKey, setBeats, setLayer,
  setFollow, setOver, setPosition, setSequence, setSetting, switchPitchKind, toggleBeat, toggleMute, toggleSolo,
} from "./edit.js";
import { REST } from "./layer.js";
import { divmod } from "./numbers.js";
import { degreeToSemitones, isBlackKey, noteName, SAMPLE_PITCH, SCALES } from "./scales.js";
import { MAX_LAYERS } from "./view.js";

// Build an HTML element: h("button", { class: "x", onclick: f }, "Label").
// Attributes starting "on" become event handlers; everything else is set as
// an attribute. Children can be text or other elements.
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "value") node.value = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

// The positions, child by child, that lead from `root` down to `node` -- or
// null if `node` is not inside `root`.
function pathTo(root, node) {
  const path = [];
  while (node && node !== root) {
    const parent = node.parentElement;
    if (!parent) return null;
    path.unshift([...parent.children].indexOf(node));
    node = parent;
  }
  return node === root ? path : null;
}

// Focus the element at a path, or the nearest thing above it if the layout
// changed underneath. Only elements that can take focus are tried.
function focusAt(root, path) {
  let node = root;
  const trail = [];
  for (const index of path) {
    const next = node.children[index];
    if (!next) break;
    node = next;
    trail.push(node);
  }
  const target = trail.reverse().find((n) => n.matches("button:not(:disabled), input, select"));
  target?.focus({ preventScroll: true });
}

// A number with − and + buttons either side, and optionally a unit after.
function stepper(label, value, onChange, { min = -Infinity, max = Infinity, unit = null } = {}) {
  return h("span", { class: "stepper" },
    h("span", { class: "label" }, label),
    h("button", { type: "button", "aria-label": `${label} down`, disabled: value <= min, onclick: () => onChange(value - 1) }, "−"),
    h("span", { class: "value" }, String(value)),
    h("button", { type: "button", "aria-label": `${label} up`, disabled: value >= max, onclick: () => onChange(value + 1) }, "+"),
    unit && h("span", { class: "unit" }, unit),
  );
}

// "1 bar", "2 bars".
const bars = (n) => `${n} bar${n === 1 ? "" : "s"}`;

// A drop-down menu. `options` is a list of [value, label] pairs.
//
// If the change is refused (onChange returns false -- say, removing a scale
// a layer still needs), the menu goes back to showing what the piece really
// has, rather than the choice that did not happen.
function menu(label, value, options, onChange) {
  return h("label", { class: "field" },
    h("span", { class: "label" }, label),
    h("select", { onchange: (e) => { if (onChange(e.target.value) === false) e.target.value = value; } },
      options.map(([v, text]) => h("option", { value: v, selected: v === value }, text))),
  );
}

const SCALE_NAMES = Object.keys(SCALES).sort();

// The drum layers (by number) whose pitch settings have been unfolded. A
// drum's are folded away unless asked for; this is only how the panel looks,
// so it lives here rather than in the piece.
const pitchOpen = new Set();
const pretty = (name) => name.replaceAll("_", " ");

// Everything the panel needs:
//   container   the element to build into
//   spec        the current piece, as written
//   derived     the same piece worked out (for labels, and who is audible)
//   samples     the names in the sample library
//   selected    the selected sequence position, { layer, position }, or null
//   history     { canUndo, canRedo }
//   name        what the piece is called (used for saved files)
//   maxSeconds  the longest piece the page allows
//   actions     { edit(fn), select(layer, position), undo(), redo(), rename(name) }
export function renderEditor(options) {
  const { container, spec, derived, samples, selected, history, name, maxSeconds, actions } = options;
  const { edit, select } = actions;
  // Build the panel again from the same piece, for a change that is only to
  // the panel itself (folding a section away), not to the piece.
  const redraw = () => renderEditor(options);
  const pieceScale = spec.scale ?? null;
  // A piece-wide scale can only be removed if no degree layer relies on it.
  const scaleNeeded = spec.layer.some((l) => sequenceKey(l) === "degrees" && !l.scale);

  const barSeconds = derived.bar_duration;
  // The tempo as a person would write it: 120, or 109.09.
  const tempo = String(Number(derived.tempo.toFixed(2)));
  const pieceRow = h("div", { class: "bar piece-controls" },
    h("span", { class: "panel-title" }, "Piece"),
    h("input", {
      type: "text", class: "name", value: name, spellcheck: "false", maxlength: "60",
      "aria-label": "Name of the piece, used for saved files",
      onchange: (e) => actions.rename(e.target.value),
      onkeydown: (e) => { if (e.key === "Enter") e.target.blur(); },
    }),
    h("button", { type: "button", disabled: !history.canUndo, onclick: actions.undo, title: "Undo (Ctrl+Z / ⌘Z)" }, "↶ Undo"),
    h("button", { type: "button", disabled: !history.canRedo, onclick: actions.redo, title: "Redo" }, "↷ Redo"),
    h("label", { class: "field" },
      h("span", { class: "label" }, "Tempo"),
      h("input", {
        type: "number", min: String(MIN_TEMPO), max: String(MAX_TEMPO), step: "any", value: tempo, class: "short",
        "aria-label": "Tempo in beats per minute of the base beat",
        onchange: (e) => {
          const bpm = Number(e.target.value);
          // A refused change (not a positive number, or a piece too long)
          // puts the box back to the real tempo. The min and max above only
          // limit the arrows beside the box, not what can be typed.
          if (!(bpm > 0 && edit((s) => setSetting(s, "tempo", bpm)))) {
            e.target.value = tempo;
          }
        },
      }),
      h("span", { class: "unit" }, "BPM")),
    stepper("Base", derived.base, (n) => edit((s) => setSetting(s, "base", n)),
      { min: 1, max: MAX_BASE, unit: "beats per bar" }),
    h("button", {
      type: "button", class: "toggle click", "aria-pressed": String(derived.click),
      title: "Click: hear the base beats, like a metronome", "aria-label": "Click",
      onclick: () => edit((s) => setSetting(s, "click", derived.click ? null : true)),
    }, "Click"),
    stepper("Bars", derived.bars, (n) => edit((s) => setSetting(s, "bars", n)), { min: 1, max: MAX_BARS }),
    repeatNote(),
    menu("Scale", pieceScale ?? "",
      [["", scaleNeeded ? "(none — a layer needs one)" : "none"], ...SCALE_NAMES.map((n) => [n, pretty(n)])],
      (v) => edit((s) => setSetting(s, "scale", v || null))),
    stepper("Root", spec.root ?? 0, (n) => edit((s) => setSetting(s, "root", n || null)), { min: -24, max: 24 }),
    h("button", {
      type: "button", disabled: spec.layer.length >= MAX_LAYERS,
      title: spec.layer.length >= MAX_LAYERS ? `The drawing shows at most ${MAX_LAYERS} layers` : null,
      onclick: () => edit((s) => addLayer(s, samples)),
    }, "+ Add layer"),
  );

  // How long the whole pattern takes to come round, next to Bars. If the
  // length is not a whole number of repeats, the file will restart the
  // pattern part-way through each time it loops -- so say so, and offer to fix
  // it where the fix fits the page's limits.
  function repeatNote() {
    const whole = derived.repeat_bars;
    if (whole === 1) return null;
    const length = derived.bars;
    const clean = length % whole === 0;
    // The nearest whole number of repeats: rounding the length up keeps at
    // least the length chosen; down only if up would not fit the limits.
    const fits = (n) => n >= whole && n <= MAX_BARS && n * barSeconds <= maxSeconds;
    const up = Math.ceil(length / whole) * whole;
    const down = Math.floor(length / whole) * whole;
    const suggestion = fits(up) ? up : fits(down) ? down : null;
    return h("span", { class: `repeat${clean ? "" : " uneven"}` },
      `whole pattern repeats every ${bars(whole)}`,
      !clean && suggestion !== null && h("button", {
        type: "button", title: "So the file loops on a whole number of repeats",
        onclick: () => edit((s) => setSetting(s, "bars", suggestion)),
      }, `Use ${bars(suggestion)}`));
  }

  const cards = spec.layer.map((layer, i) => layerCard(layer, i));
  // Rebuilding replaces every control, including the one that has keyboard
  // focus -- which would send someone using a keyboard back to the top of the
  // page after every press. So note where the focused control sits (its path
  // of positions down from the panel), and focus whatever sits there after.
  const path = pathTo(container, document.activeElement);
  container.replaceChildren(pieceRow, ...cards);
  if (path !== null) focusAt(container, path);

  function layerCard(layer, i) {
    const info = derived.layers[i];
    const key = sequenceKey(layer);
    const seq = layer[key];
    const isDegrees = key === "degrees";
    const isSelected = selected !== null && selected.layer === i;

    // The card has three parts. The head holds what the whole layer is: its
    // switches, sample, level, and the buttons to copy or remove it. Then
    // RHYTHM -- when it sounds -- and MELODY -- what it plays. Keeping the two
    // apart matters most for a melody, whose pitch controls were otherwise
    // lost among the beat counts.
    const head = h("div", { class: "card-head" },
      h("span", { class: "swatch", "aria-hidden": "true" }),
      h("span", { class: "switches" },
        h("button", {
          type: "button", class: "toggle", "aria-pressed": String(Boolean(layer.mute)),
          title: "Mute: silence this layer", "aria-label": `Mute layer ${i + 1}`,
          onclick: () => edit((s) => toggleMute(s, i)),
        }, "M"),
        h("button", {
          type: "button", class: "toggle", "aria-pressed": String(Boolean(layer.solo)),
          title: "Solo: hear only soloed layers", "aria-label": `Solo layer ${i + 1}`,
          onclick: () => edit((s) => toggleSolo(s, i)),
        }, "S")),
      menu("Sample", layer.sample, samples.map((n) => [n, n.replace(/\.wav$/i, "")]),
        (v) => edit((s) => setLayer(s, i, "sample", v))),
      h("label", { class: "field" },
        h("span", { class: "label" }, "Gain"),
        h("input", {
          type: "range", min: "0", max: "1.5", step: "0.01", value: String(layer.gain ?? 1),
          "aria-label": `Gain of layer ${i + 1}`,
          // `input` fires while dragging: just update the number shown.
          // `change` fires on letting go: that is the edit, one undo step.
          oninput: (e) => { e.target.nextSibling.textContent = Number(e.target.value).toFixed(2); },
          onchange: (e) => {
            if (!edit((s) => setLayer(s, i, "gain", Number(e.target.value)))) {
              e.target.value = String(layer.gain ?? 1);
              e.target.nextSibling.textContent = (layer.gain ?? 1).toFixed(2);
            }
          },
        }),
        h("span", { class: "value" }, (layer.gain ?? 1).toFixed(2))),
      h("span", { class: "card-actions" },
      h("button", {
        type: "button", class: "duplicate", disabled: spec.layer.length >= MAX_LAYERS,
        title: spec.layer.length >= MAX_LAYERS ? `The drawing shows at most ${MAX_LAYERS} layers` : "Duplicate this layer",
        "aria-label": `Duplicate layer ${i + 1}`,
        onclick: () => edit((s) => duplicateLayer(s, i)),
      }, "⧉"),
      h("button", {
        type: "button", class: "remove", disabled: spec.layer.length === 1,
        title: "Remove this layer", "aria-label": `Remove layer ${i + 1}`,
        onclick: () => edit((s) => removeLayer(s, i)),
      }, "✕")),
    );

    // --- Rhythm: how many beats, over how many bars, and which of them sound.

    const rhythmRow = h("div", { class: "section-row" },
      h("span", { class: "section-title" }, "Rhythm"),
      stepper("Beats", layer.beats, (n) => edit((s) => setBeats(s, i, n)), { min: 1, max: MAX_BEATS }),
      stepper("over", info.over, (n) => edit((s) => setOver(s, i, n)),
        { min: 1, max: MAX_OVER, unit: info.over === 1 ? "bar" : "bars" }),
    );

    // One button per beat, pressed when the beat is on: the same as tapping
    // beats in the drawing, but big enough to hit on a phone however many
    // beats there are, and usable from a keyboard or a screen reader.
    const on = new Set(info.active ?? Array.from({ length: layer.beats }, (_, b) => b + 1));
    const beatRow = h("div", { class: "beats-on", role: "group", "aria-label": `Beats of layer ${i + 1} that sound` },
      h("span", { class: "label" }, "On"),
      Array.from({ length: layer.beats }, (_, b) => b + 1).map((beat) =>
        h("button", {
          type: "button", class: "beat", "aria-pressed": String(on.has(beat)),
          title: `Beat ${beat}: ${on.has(beat) ? "on" : "off"} every time round`,
          onclick: () => edit((s) => toggleBeat(s, i, beat)),
        }, String(beat))),
      followChoice(layer, i, seq),
    );

    // --- Melody: the pitch settings, the sequence, and the keypad.

    const strip = sequenceRow(layer, i, seq, info, isSelected);
    const melody = h("div", { class: "section melody" },
      pitchRow(layer, i, key, isDegrees, info),
      strip,
      isSelected && keypad(layer, i, selected.position));

    return h("div", { class: `card l${i}${info.audible ? "" : " silent"}`, "data-layer": i },
      head,
      h("div", { class: "section rhythm" }, rhythmRow, beatRow),
      melody);
  }

  // Whether a switched-off beat holds the sequence back ("hits") or not
  // ("beats"). Offered only when the sequence has more than one value in it,
  // since a sequence of the same note sounds the same either way -- which is
  // most drum layers.
  function followChoice(layer, i, seq) {
    if (new Set(seq).size < 2) return null;
    const follow = layer.follow ?? "beats";
    const option = (value, text, title) => h("button", {
      type: "button", class: "toggle", "aria-pressed": String(follow === value), title,
      onclick: () => { if (follow !== value) edit((s) => setFollow(s, i, value)); },
    }, text);
    return h("span", { class: "follow", role: "group", "aria-label": `What the sequence of layer ${i + 1} follows` },
      h("span", { class: "label" }, "Notes follow"),
      option("beats", "beats",
        "Notes follow beats: every beat moves the sequence on, so a switched-off beat silences the note on it"),
      option("hits", "hits",
        "Notes follow hits: only beats that sound move the sequence on, so every note is heard in turn"));
  }

  // How the layer's pitches are written, and against what scale and root. A
  // drum -- every position 0 -- has no use for these, so they fold away
  // behind one button until asked for.
  function pitchRow(layer, i, key, isDegrees, info) {
    const title = h("span", { class: "section-title" }, info.percussive ? "Hits" : "Melody");
    const folded = info.percussive && !pitchOpen.has(i);
    if (folded) {
      return h("div", { class: "section-row" }, title,
        h("button", {
          type: "button", class: "unfold", "aria-expanded": "false",
          title: "Show the pitch settings, to give this layer a melody",
          onclick: () => { pitchOpen.add(i); redraw(); },
        }, "Drum hits · pitch ▸"));
    }
    return h("div", { class: "section-row" }, title,
      menu("Pitch", key, [["notes", "semitones"], ["degrees", "scale degrees"]],
        (v) => edit((s) => switchPitchKind(s, i, v))),
      isDegrees && menu("Scale", layer.scale ?? "",
        [["", pieceScale ? `piece (${pretty(pieceScale)})` : "(choose one)"], ...SCALE_NAMES.map((n) => [n, pretty(n)])],
        (v) => edit((s) => setLayer(s, i, "scale", v || null))),
      isDegrees && stepper("Root", layer.root ?? spec.root ?? 0,
        (n) => edit((s) => setLayer(s, i, "root", n)), { min: -24, max: 24 }),
      info.percussive && h("button", {
        type: "button", class: "unfold", "aria-expanded": "true", title: "Fold the pitch settings away",
        onclick: () => { pitchOpen.delete(i); redraw(); },
      }, "◂"),
    );
  }

  // The sequence: one tile per position, read one position per beat (or per
  // hit, for a layer following its hits).
  function sequenceRow(layer, i, seq, info, isSelected) {
    const labels = info.sequence_labels;
    const tiles = seq.map((value, position) =>
      h("button", {
        type: "button",
        class: `tile${value === REST ? " rest" : ""}${isSelected && selected.position === position ? " selected" : ""}`,
        "aria-label": `Position ${position + 1}: ${value === REST ? "rest" : value}`,
        onclick: () => select(i, isSelected && selected.position === position ? null : position),
      }, labels[position]));
    const at = isSelected ? selected.position : seq.length - 1;
    return h("div", { class: "sequence-row" },
      h("span", { class: "label" }, "Sequence"),
      ...tiles,
      h("button", {
        type: "button", class: "grow", title: "Add a position (a copy of the selected one)",
        onclick: () => { edit((s) => insertPosition(s, i, at)); select(i, at + 1); },
      }, "+"),
      h("button", {
        type: "button", class: "grow", disabled: seq.length === 1, title: "Remove the selected position",
        onclick: () => { edit((s) => removePosition(s, i, at)); select(i, null); },
      }, "−"),
      sequenceField(seq, i),
      h("span", { class: "repeat" },
        info.repeat_bars === 1 ? "same every bar" : `repeats every ${bars(info.repeat_bars)}`),
    );
  }
  // The same sequence as text, for typing or pasting a long one. Changes on
  // Enter or on leaving the field; a mistake is explained beside it.
  function sequenceField(seq, i) {
    const error = h("span", { class: "field-error", role: "status" });
    const input = h("input", {
      type: "text", class: "sequence", value: formatSequence(seq), spellcheck: "false",
      "aria-label": `Sequence of layer ${i + 1}, as text`,
      onchange: (e) => {
        try {
          const values = parseSequence(e.target.value);
          error.textContent = "";
          edit((s) => setSequence(s, i, values));
        } catch (err) {
          error.textContent = err.message;
        }
      },
      onkeydown: (e) => { if (e.key === "Enter") e.target.blur(); },
    });
    return h("span", { class: "sequence-wrap" }, input, error);
  }

  // The keypad for the selected position: a piano keyboard, one octave wide,
  // and a rest.
  //
  // For a degree layer the octave runs from degree 1 to the 1 above, in the
  // octave the position is already in (so an octave shift is kept when
  // another degree is chosen). Keys in the scale are labelled with their
  // degree and can be pressed; the rest are shown, greyed, so the shape of
  // the scale -- where its gaps fall -- is there to see. In a seven-note scale
  // the notes of the home chord (1, 3 and 5) are marked.
  //
  // For a semitone layer every key can be pressed, labelled with its shift.
  //
  // Where the sample's own pitch is known (the built-in sounds), each key
  // also names its note, and the keyboard is laid out as a real one. For any
  // other sample it is laid out as if the sample were a C.
  function keypad(layer, i, position) {
    const key = sequenceKey(layer);
    const value = layer[key][position];
    const setTo = (v) => edit((s) => setPosition(s, i, position, v));
    const current = value === REST ? null : value;
    const pitch = SAMPLE_PITCH[layer.sample] ?? null;
    const layout = pitch ?? 60;
    const name = (semitones) => (pitch === null ? null : noteName(pitch + semitones));

    // The keys from `low` to `high` semitones, and for each: the value it
    // writes (or null if it cannot be chosen), and its label.
    let low, octave, sounding, keyFor;
    if (key === "degrees") {
      const scale = effectiveScale(spec, layer);
      const root = effectiveRoot(spec, layer);
      const span = SCALES[scale].length;
      const base = current === null ? 0 : Math.floor((current - 1) / span) * span;
      const degreeAt = new Map();
      for (let d = base + 1; d <= base + span + 1; d++) degreeAt.set(degreeToSemitones(d, scale, root), d);
      low = degreeToSemitones(base + 1, scale, root);
      octave = (up) => setTo(current === null ? 1 + (up ? span : -span) : current + (up ? span : -span));
      sounding = current === null ? null : degreeToSemitones(current, scale, root);
      keyFor = (s) => {
        const d = degreeAt.get(s) ?? null;
        const step = d === null ? null : divmod(d - 1, span)[1];
        return { value: d, text: d === null ? "" : String(d), chord: span === 7 && [0, 2, 4].includes(step),
          words: d === null ? `${name(s) ?? "semitone"}, not in the scale` : `Degree ${d}` };
      };
    } else {
      const n = current ?? 0;
      low = n - divmod(layout + n, 12)[1];  // the C at or below
      octave = (up) => setTo(n + (up ? 12 : -12));
      sounding = current;
      keyFor = (s) => ({ value: s, text: s > 0 ? `+${s}` : String(s), chord: false,
        words: `${s > 0 ? "+" : ""}${s} semitones` });
    }
    // Start and end on a white key, as a keyboard does.
    let high = low + 12;
    while (isBlackKey(layout + low)) low -= 1;
    while (isBlackKey(layout + high)) high += 1;

    const whites = [];
    for (let s = low; s <= high; s++) if (!isBlackKey(layout + s)) whites.push(s);
    const keys = [];
    for (let s = low; s <= high; s++) {
      const black = isBlackKey(layout + s);
      const k = keyFor(s);
      const note = name(s);
      keys.push(h("button", {
        type: "button",
        class: `key ${black ? "black" : "white"}${k.value === null ? " out" : ""}${k.chord ? " chord" : ""}${k.value === current ? " on" : ""}`,
        disabled: k.value === null,
        "data-value": k.value ?? null,
        "aria-label": note && k.value !== null ? `${k.words}, ${note}` : k.words,
        "aria-pressed": k.value === null ? null : String(k.value === current),
        // A black key sits over the line between two white ones: placed by
        // how many white keys come before it, as a share of the width.
        style: black ? `left: ${(100 * whites.filter((w) => w < s).length) / whites.length}%; width: ${64 / whites.length}%` : null,
        onclick: k.value === null ? null : () => setTo(k.value),
      },
      h("span", { class: "degree" }, k.text),
      note && h("span", { class: "note" }, note)));
    }

    const now = current === null ? "rest" : name(sounding);
    return h("div", { class: "keypad", role: "group", "aria-label": `Position ${position + 1} of layer ${i + 1}` },
      h("div", { class: "keypad-row" },
        h("span", { class: "label" }, `Position ${position + 1}`),
        now && h("span", { class: "now" }, now),
        h("button", { type: "button", title: "An octave down", onclick: () => octave(false) }, "▼ oct"),
        h("button", { type: "button", title: "An octave up", onclick: () => octave(true) }, "▲ oct"),
        h("button", { type: "button", class: value === REST ? "on" : null, onclick: () => setTo(REST) }, "rest"),
        h("button", { type: "button", onclick: () => select(i, null) }, "Done")),
      h("div", { class: "piano", style: `--whites: ${whites.length}` }, keys),
    );
  }
}
