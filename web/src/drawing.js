// What every way of drawing a piece shares: making SVG elements, the hatching
// for switched-off beats, each layer's name and description, how a pitch is
// described in words, lighting notes as they sound, and the grid as text.
//
// The drawings themselves are view.js (rows running left to right) and
// rings.js (a ring per layer, going round like a clock). Both only DRAW:
// everything they show arrives already worked out in `d`, the derived data
// from derive.js.

// SVG elements need their own "namespace", hence the long address passed to
// createElementNS -- a quirk of how browsers tell SVG from HTML.
const SVG_NS = "http://www.w3.org/2000/svg";

// Seconds a note stays lit after it starts.
export const GLOW = 0.13;

// About as many small characters as fit beside a drawing on one line.
const LABEL_CHARS = 25;

// Make an SVG element, set its attributes, and optionally its text and where
// it goes: el("circle", { cx: 5, cy: 5, r: 3 }, parent).
export function el(name, attrs = {}, parent = null, text = null) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== null) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

// A hover tooltip. The browser shows an SVG <title> when the pointer rests on
// its parent, with no code needed to position it.
export function tip(node, text) {
  el("title", {}, node, text);
}

// The diagonal hatching used for switched-off beats, defined once per
// drawing so anything can fill with url(#hatch).
export function addHatch(svg) {
  const defs = el("defs", {}, svg);
  const pat = el("pattern", {
    id: "hatch", width: 7, height: 7, patternUnits: "userSpaceOnUse",
    patternTransform: "rotate(45)",
  }, defs);
  el("line", { x1: 0, y1: 0, x2: 0, y2: 7, class: "hatch-line" }, pat);
}

// A layer's colour class, plus "silent" when it cannot be heard.
export function layerClass(d, i) {
  return d.layers[i].audible === false ? `l${i} silent` : `l${i}`;
}

// A layer's name and description, drawn with its top-left at (x, y) inside
// `g`: a colour swatch and the name, why it is silent if it is, then up to
// three short lines -- its beats, its sequence, which beats are on.
// `maxLines` keeps it shorter where space is tight.
export function drawLayerLabel(g, info, x, y, maxLines = 3) {
  el("circle", { cx: x, cy: y + 26, r: 7, class: "swatch" }, g);
  const name = el("text", { x: x + 14, y: y + 31, class: "name" }, g, info.name);
  // Say why a layer is silent, in words as well as by fading it.
  const why = info.mute && !info.solo ? "muted" : info.solo ? "solo" : info.audible ? "" : "silenced by solo";
  if (why) el("tspan", { class: "state", dx: 8 }, name, why);
  const kind = info.percussive ? "drum hits"
    : info.pitch_kind === "degrees" ? `${info.scale} degrees` : "semitones";
  const lines = [info.over === 1 ? `${info.beats} beats` : `${info.beats} beats over ${info.over} bars`];
  // The sequence, after what kind of values it holds. A drum's sequence is
  // only worth printing when it has rests in it -- otherwise it is just
  // "x", which the drawing already shows.
  if (!info.percussive || info.sequence_labels.includes("-")) {
    lines.push(`${kind}: ${info.sequence_labels.join(" ")}`);
  } else {
    lines.push(kind);
  }
  if (info.active) lines.push(`on: ${info.active.join(" ")}`);
  lines.slice(0, maxLines).forEach((text, n) => {
    // The space is a fixed width, so a long line is cut short with "…"
    // rather than running into the drawing. Hovering shows it in full.
    const short = text.length > LABEL_CHARS ? `${text.slice(0, LABEL_CHARS - 1)}…` : text;
    const node = el("text", { x, y: y + 56 + n * 20, class: "sub" }, g, short);
    if (short !== text) tip(node, text);
  });
}

// A note's pitch in words, for its tooltip.
export function pitchWords(info, c) {
  if (info.percussive) return "hit";
  const semis = c.semitones >= 0 ? `+${c.semitones}` : `${c.semitones}`;
  return info.pitch_kind === "degrees"
    ? `degree ${c.label} of ${info.scale} (${semis} semitones)`
    : `${semis} semitones`;
}

// Light up whatever is sounding at time t (seconds): notes, and the lines
// joining layers that sound together. Each is { node, time }.
export function lightUp(things, t) {
  for (const k of things) k.node.classList.toggle("on", t >= k.time && t - k.time < GLOW);
}

// The grid written out as text, `perPage` bars to a block, one line per
// layer, each bar between | marks. A layer over several bars shows, in each
// bar, the beats that start in it. The same whichever drawing is showing,
// so a screen reader always gets it.
export function textGrid(d, perPage) {
  const nameWidth = Math.max(...d.layers.map((l) => l.name.length)) + 2;
  const lines = [];
  for (let firstBar = 1; firstBar <= d.bars; firstBar += perPage) {
    const lastBar = Math.min(d.bars, firstBar + perPage - 1);
    lines.push(firstBar === lastBar ? `bar ${firstBar}` : `bars ${firstBar}–${lastBar}`);
    d.layers.forEach((info, i) => {
      const bars = [];
      for (let bar = firstBar; bar <= lastBar; bar++) {
        const beats = d.cells
          .filter((c) => c.layer === i && c.bar === bar)
          .sort((a, b) => a.pulse - b.pulse)
          .map((c) => (c.status === "note" ? c.label : c.status === "rest" ? "-" : "."));
        bars.push(beats.join(" "));
      }
      // Silent layers (muted, or silenced by a solo) say so, as the drawing does.
      const silent = info.audible === false ? "  (silent)" : "";
      lines.push(`  ${info.name.padEnd(nameWidth)}| ${bars.join(" | ")} |${silent}`);
    });
    lines.push("");
  }
  lines.push("x = drum hit   - = rest   . = beat switched off");
  return lines.join("\n");
}

// "bars 5–8 of 12", or "bar 3 of 8", for a page starting at `first` (from 1)
// and `perPage` bars long.
export function barsLabel(first, perPage, total) {
  const last = Math.min(total, first + perPage - 1);
  const span = first === last ? `bar ${first}` : `bars ${first}–${last}`;
  return perPage >= total ? span : `${span} of ${total}`;
}
