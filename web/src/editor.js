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
  addLayer, duplicateLayer, effectiveScale, formatSequence, insertStep, MAX_BEATS, MAX_LOOPS, parseSequence,
  removeLayer, removeStep, sequenceKey, setBeats, setLayer, setSequence, setSetting, setStep,
  switchPitchKind, toggleBeat, toggleMute, toggleSolo,
} from "./edit.js";
import { REST } from "./layer.js";
import { SCALES } from "./scales.js";
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

// A number with − and + buttons either side.
function stepper(label, value, onChange, { min = -Infinity, max = Infinity } = {}) {
  return h("span", { class: "stepper" },
    h("span", { class: "label" }, label),
    h("button", { type: "button", "aria-label": `${label} down`, disabled: value <= min, onclick: () => onChange(value - 1) }, "−"),
    h("span", { class: "value" }, String(value)),
    h("button", { type: "button", "aria-label": `${label} up`, disabled: value >= max, onclick: () => onChange(value + 1) }, "+"),
  );
}

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
const pretty = (name) => name.replaceAll("_", " ");

// Everything the panel needs:
//   container   the element to build into
//   spec        the current piece, as written
//   derived     the same piece worked out (for labels, and who is audible)
//   samples     the names in the sample library
//   selected    the selected sequence step, { layer, step }, or null
//   history     { canUndo, canRedo }
//   name        what the piece is called (used for saved files)
//   actions     { edit(fn), select(layer, step), undo(), redo(), rename(name) }
export function renderEditor({ container, spec, derived, samples, selected, history, name, actions }) {
  const { edit, select } = actions;
  const pieceScale = spec.scale ?? null;
  // A piece-wide scale can only be removed if no degree layer relies on it.
  const scaleNeeded = spec.layer.some((l) => sequenceKey(l) === "degrees" && !l.scale);

  const cycle = derived.cycle_duration;
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
      h("span", { class: "label" }, "Cycle"),
      h("input", {
        type: "number", min: "0.1", max: "30", step: "0.1", value: cycle.toFixed(2), class: "short",
        "aria-label": "Cycle length in seconds",
        onchange: (e) => {
          const seconds = Number(e.target.value);
          // A refused change (not a positive number, or a piece too long)
          // puts the box back to the real cycle length.
          if (!(seconds > 0 && edit((s) => setSetting(s, "cycle_duration", seconds)))) {
            e.target.value = cycle.toFixed(2);
          }
        },
      }),
      h("span", { class: "unit" }, "s")),
    stepper("Loops", spec.loops, (n) => edit((s) => setSetting(s, "loops", n)), { min: 1, max: MAX_LOOPS }),
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

  // How long the whole pattern takes to come round, next to Loops. If the
  // loops do not cover a whole number of repeats, the file will restart the
  // pattern part-way through each time it loops -- so say so, and offer to fix
  // it where the fix fits the page's limits.
  function repeatNote() {
    const whole = derived.repeat_cycles;
    if (whole === 1) return null;
    const clean = spec.loops % whole === 0;
    // The nearest whole number of repeats: rounding the loops up keeps at
    // least the length chosen; down only if up would not fit the limits.
    const fits = (n) => n >= whole && n <= MAX_LOOPS && n * cycle <= 120;
    const up = Math.ceil(spec.loops / whole) * whole;
    const down = Math.floor(spec.loops / whole) * whole;
    const suggestion = fits(up) ? up : fits(down) ? down : null;
    return h("span", { class: `repeat${clean ? "" : " uneven"}` },
      `whole pattern: ${whole} cycles`,
      !clean && suggestion !== null && h("button", {
        type: "button", title: "So the file loops on a whole number of repeats",
        onclick: () => edit((s) => setSetting(s, "loops", suggestion)),
      }, `Use ${suggestion} loops`));
  }

  const cards = spec.layer.map((layer, i) => layerCard(layer, i));
  container.replaceChildren(pieceRow, ...cards);

  function layerCard(layer, i) {
    const info = derived.layers[i];
    const key = sequenceKey(layer);
    const seq = layer[key];
    const isDegrees = key === "degrees";
    const isSelected = selected !== null && selected.layer === i;

    const head = h("div", { class: "card-head" },
      h("span", { class: "swatch", "aria-hidden": "true" }),
      h("span", { class: "switches" },
        h("button", {
          type: "button", class: "toggle", "aria-pressed": String(Boolean(layer.mute)),
          title: "Mute: silence this layer", onclick: () => edit((s) => toggleMute(s, i)),
        }, "M"),
        h("button", {
          type: "button", class: "toggle", "aria-pressed": String(Boolean(layer.solo)),
          title: "Solo: hear only soloed layers", onclick: () => edit((s) => toggleSolo(s, i)),
        }, "S")),
      menu("Sample", layer.sample, samples.map((n) => [n, n.replace(/\.wav$/i, "")]),
        (v) => edit((s) => setLayer(s, i, "sample", v))),
      stepper("Beats", layer.beats, (n) => edit((s) => setBeats(s, i, n)), { min: 1, max: MAX_BEATS }),
      menu("Pitch", key, [["notes", "semitones"], ["degrees", "scale degrees"]],
        (v) => edit((s) => switchPitchKind(s, i, v))),
      isDegrees && menu("Scale", layer.scale ?? "",
        [["", pieceScale ? `piece (${pretty(pieceScale)})` : "(choose one)"], ...SCALE_NAMES.map((n) => [n, pretty(n)])],
        (v) => edit((s) => setLayer(s, i, "scale", v || null))),
      isDegrees && stepper("Root", layer.root ?? spec.root ?? 0,
        (n) => edit((s) => setLayer(s, i, "root", n)), { min: -24, max: 24 }),
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
      }, "✕"),
    );

    // The step strip: one tile per step of the sequence.
    const labels = info.sequence_labels;
    const tiles = seq.map((value, step) =>
      h("button", {
        type: "button",
        class: `tile${value === REST ? " rest" : ""}${isSelected && selected.step === step ? " selected" : ""}`,
        "aria-label": `Step ${step + 1}: ${value === REST ? "rest" : value}`,
        onclick: () => select(i, isSelected && selected.step === step ? null : step),
      }, labels[step]));
    const at = isSelected ? selected.step : seq.length - 1;
    const strip = h("div", { class: "steps" },
      h("span", { class: "label" }, "Steps"),
      ...tiles,
      h("button", {
        type: "button", class: "grow", title: "Add a step (a copy of the selected one)",
        onclick: () => { edit((s) => insertStep(s, i, at)); select(i, at + 1); },
      }, "+"),
      h("button", {
        type: "button", class: "grow", disabled: seq.length === 1, title: "Remove the selected step",
        onclick: () => { edit((s) => removeStep(s, i, at)); select(i, null); },
      }, "−"),
      sequenceField(seq, i),
      h("span", { class: "repeat" },
        info.repeat_cycles === 1 ? "same every cycle" : `comes round every ${info.repeat_cycles} cycles`),
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
          title: `Beat ${beat}: ${on.has(beat) ? "on" : "off"} in every cycle`,
          onclick: () => edit((s) => toggleBeat(s, i, beat)),
        }, String(beat))),
    );

    return h("div", { class: `card l${i}${info.audible ? "" : " silent"}`, "data-layer": i },
      head, beatRow, strip, isSelected && keypad(layer, i, selected.step));
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

  // The keypad for the selected step: scale degrees for a degree layer, a
  // semitone stepper for a note layer, and a rest for both.
  function keypad(layer, i, step) {
    const key = sequenceKey(layer);
    const value = layer[key][step];
    const setTo = (v) => edit((s) => setStep(s, i, step, v));
    const current = value === REST ? null : value;
    let keys;
    if (key === "degrees") {
      const span = SCALES[effectiveScale(spec, layer)].length;
      // Degrees shown in the octave the step is already in, so an octave
      // shift is kept when another degree is chosen.
      const base = current === null ? 0 : Math.floor((current - 1) / span) * span;
      keys = [
        h("button", { type: "button", onclick: () => setTo(current === null ? 1 - span : current - span) }, "▼ oct"),
        ...Array.from({ length: span + 1 }, (_, n) => base + n + 1).map((d) =>
          h("button", { type: "button", class: d === current ? "on" : null, onclick: () => setTo(d) }, String(d))),
        h("button", { type: "button", onclick: () => setTo(current === null ? 1 + span : current + span) }, "▲ oct"),
      ];
    } else {
      const n = current ?? 0;
      keys = [
        h("button", { type: "button", onclick: () => setTo(n - 12) }, "−12"),
        h("button", { type: "button", onclick: () => setTo(n - 1) }, "−1"),
        h("span", { class: "value" }, current === null ? "rest" : `${n > 0 ? "+" : ""}${n}`),
        h("button", { type: "button", onclick: () => setTo(n + 1) }, "+1"),
        h("button", { type: "button", onclick: () => setTo(n + 12) }, "+12"),
        h("button", { type: "button", onclick: () => setTo(0) }, "0"),
      ];
    }
    return h("div", { class: "keypad", role: "group", "aria-label": `Step ${step + 1} of layer ${i + 1}` },
      h("span", { class: "label" }, `Step ${step + 1}`),
      ...keys,
      h("button", { type: "button", class: value === REST ? "on" : null, onclick: () => setTo(REST) }, "rest"),
      h("button", { type: "button", onclick: () => select(i, null) }, "Done"),
    );
  }
}
