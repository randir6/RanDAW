// Drawing a piece in step notation.
//
// One row per layer; each row spans a cycle and is divided into that layer's
// beats, so beats in different rows that happen at the same instant line up
// vertically. That alignment is the polyrhythm made visible.
//
// This module only DRAWS. Everything it shows -- which beat sounds, its label,
// how high it sits, which layers coincide -- arrives already worked out in
// `d`, the derived data from derive.js. If drawing ever seems to need a
// musical decision, that decision belongs in the engine instead.

// The visualiser shows at most this many layers, for now. The limit belongs
// to the drawing ONLY: the engine and the audio are unlimited, and the rows
// are laid out from however many layers there are, so raising it means
// changing this number and adding a colour to the page's palette.
export const MAX_LAYERS = 5;

// Layout. The drawing is sized in its own units (1600 wide) and the browser
// scales it to the window, so none of these numbers depend on screen size.
const W = 1600, GUTTER = 210, RIGHT = 22, TOP = 40, ROW_H = 120, ROW_GAP = 12;
const AREA = W - GUTTER - RIGHT;
const MIN_CELL = 20;      // narrower than this and a labelled note will not fit
const GUTTER_CHARS = 25;  // about as many small characters as fit in the gutter
const GLOW = 0.13;        // seconds a note stays lit after it starts

// SVG elements need their own "namespace", hence the long address passed to
// createElementNS -- a quirk of how browsers tell SVG from HTML.
const SVG_NS = "http://www.w3.org/2000/svg";

function el(name, attrs = {}, parent = null, text = null) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== null) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

// A hover tooltip. The browser shows an SVG <title> when the pointer rests on
// its parent, with no code needed to position it.
function tip(node, text) {
  el("title", {}, node, text);
}

// Set up a drawing of one piece in the given <svg>. Returns an object whose
// methods the page calls: show(t) to move the playhead, pageAt() and so on.
//
// This is a "factory function": everything declared inside it is private to
// this one drawing, and the returned object is the only way in. Loading a new
// piece makes a new view, so nothing left over from the last one can leak in.
export function createView(d, svg) {
  const nLayers = d.layers.length;
  const H = TOP + nLayers * (ROW_H + ROW_GAP) + 6;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  // How many cycles to show side by side on one page. Up to four, but fewer when a layer
  // has so many beats that four cycles would squash each below MIN_CELL wide.
  const maxBeats = Math.max(...d.layers.map((l) => l.beats));
  let perPage = 4;
  while (perPage > 1 && AREA / perPage / maxBeats < MIN_CELL) perPage -= 1;
  perPage = Math.min(perPage, d.loops);
  const BAR_W = AREA / perPage;
  const pages = Math.ceil(d.loops / perPage);

  // Each cell and coincidence, grouped by the page it appears on, so drawing
  // a page does not have to search the whole piece.
  const pageOf = (cycle) => Math.floor((cycle - 1) / perPage);
  const cellsByPage = Array.from({ length: pages }, () => []);
  for (const c of d.cells) cellsByPage[pageOf(c.cycle)].push(c);
  const togetherByPage = Array.from({ length: pages }, () => []);
  for (const k of d.coincidences) togetherByPage[pageOf(k.cycle)].push(k);

  // Where things go on screen.
  const rowTop = (layer) => TOP + layer * (ROW_H + ROW_GAP);
  const barX = (slot) => GUTTER + slot * BAR_W;
  const xOf = (cycle, offset, page) => barX(cycle - 1 - page * perPage) + offset * BAR_W;
  // A note's size depends on how much room its layer has per beat.
  const radius = (layer) => Math.max(8, Math.min(14, (BAR_W / d.layers[layer].beats) * 0.4));
  const yOf = (layer, height) => {
    const pad = radius(layer) + 7;
    // height runs 0 (lowest pitch) to 1 (highest); screen y runs downwards,
    // so it is flipped with 1 - height.
    return rowTop(layer) + pad + (1 - height) * (ROW_H - 2 * pad);
  };

  function pitchWords(info, c) {
    if (info.percussive) return "hit";
    const semis = c.semitones >= 0 ? `+${c.semitones}` : `${c.semitones}`;
    return info.pitch_kind === "degrees"
      ? `degree ${c.label} of ${info.scale} (${semis} semitones)`
      : `${semis} semitones`;
  }

  let currentPage = -1;
  let marks = [];      // [{node, time}] for notes on the current page
  let togethers = [];  // [{node, time}] for coincidence lines on the current page
  let playhead = null;

  function drawPage(page) {
    currentPage = page;
    svg.replaceChildren();  // empty it and start again
    marks = [];
    togethers = [];

    // The diagonal hatching used for switched-off beats.
    const defs = el("defs", {}, svg);
    const pat = el("pattern", {
      id: "hatch", width: 7, height: 7, patternUnits: "userSpaceOnUse",
      patternTransform: "rotate(45)",
    }, defs);
    el("line", { x1: 0, y1: 0, x2: 0, y2: 7, class: "hatch-line" }, pat);

    // Drawn in layers, back to front: rows, then the lines joining
    // coincident notes, then the playhead, then the notes on top -- so a
    // note under the playhead stays readable while it sounds.
    const back = el("g", {}, svg);
    const joins = el("g", {}, svg);
    const under = el("g", {}, svg);
    const front = el("g", {}, svg);

    // Rows, with each layer's name and description in the left gutter.
    for (let i = 0; i < nLayers; i++) {
      const info = d.layers[i];
      const g = el("g", { class: `l${i}` }, back);
      el("rect", { x: 4, y: rowTop(i), width: W - 8, height: ROW_H, rx: 10, class: "row-bg" }, g);
      el("circle", { cx: 22, cy: rowTop(i) + 26, r: 7, class: "swatch" }, g);
      el("text", { x: 36, y: rowTop(i) + 31, class: "name" }, g, info.name);
      const kind = info.percussive ? "drum hits"
        : info.pitch_kind === "degrees" ? `${info.scale} degrees` : "semitones";
      const lines = [`${info.beats} beats · ${kind}`];
      // A drum's sequence is only worth printing when it has rests in it --
      // otherwise it is just "x", which the row already shows.
      if (!info.percussive || info.sequence_labels.includes("-")) {
        lines.push(`seq ${info.sequence_labels.join(" ")}`);
      }
      if (info.active) lines.push(`on: ${info.active.join(" ")}`);
      lines.forEach((text, n) => {
        // The gutter is a fixed width, so a long line is cut short with "…"
        // rather than running into the grid. Hovering shows it in full.
        const short = text.length > GUTTER_CHARS ? `${text.slice(0, GUTTER_CHARS - 1)}…` : text;
        const node = el("text", { x: 22, y: rowTop(i) + 56 + n * 20, class: "sub" }, g, short);
        if (short !== text) tip(node, text);
      });
    }

    // Cycle numbers and the bar lines between cycles.
    for (let slot = 0; slot < perPage; slot++) {
      const cycle = page * perPage + slot + 1;
      if (cycle > d.loops) break;
      el("text", { x: barX(slot) + 8, y: TOP - 14, class: "cycle-label" }, back, `cycle ${cycle}`);
    }
    for (let slot = 0; slot <= perPage; slot++) {
      el("line", { x1: barX(slot), y1: TOP - 6, x2: barX(slot), y2: H - 4, class: "bar-line" }, back);
    }

    // Every beat on this page: its time band, then its mark.
    for (const c of cellsByPage[page]) {
      const info = d.layers[c.layer];
      const x0 = xOf(c.cycle, c.offset, page);
      const w = BAR_W / info.beats;
      // Bands go in the back layer and marks in the front one; each sits in
      // its own group carrying the layer class, which gives it its colour.
      const band = el("rect", {
        x: x0 + 1.5, y: rowTop(c.layer) + 5, width: Math.max(1, w - 3), height: ROW_H - 10,
        class: `band ${c.status}`,
      }, el("g", { class: `l${c.layer}` }, back));
      const g = el("g", { class: `l${c.layer}` }, front);

      const where = `${info.name} · cycle ${c.cycle}, beat ${c.beat} · ${c.time.toFixed(2)} s`;
      if (c.status === "note") {
        const r = radius(c.layer);
        const y = yOf(c.layer, c.height);
        const m = el("g", { class: info.percussive ? "mark hit" : "mark note" }, g);
        if (info.percussive) {
          const s = r * 0.62, ym = rowTop(c.layer) + ROW_H / 2;
          el("circle", { cx: x0, cy: ym, r }, m);  // invisible, but easier to hover
          el("line", { x1: x0 - s, y1: ym - s, x2: x0 + s, y2: ym + s }, m);
          el("line", { x1: x0 - s, y1: ym + s, x2: x0 + s, y2: ym - s }, m);
        } else {
          el("circle", { cx: x0, cy: y, r }, m);
          el("text", { x: x0, y: y + 0.5, "font-size": Math.min(14, r * 1.05) }, m, c.label);
        }
        tip(m, `${where} · ${pitchWords(info, c)}`);
        marks.push({ node: m, time: c.time });
      } else if (c.status === "rest") {
        const ym = rowTop(c.layer) + ROW_H / 2;
        const r = el("rect", { x: x0 - 6, y: ym - 3, width: 12, height: 6, rx: 1, class: "rest-glyph" }, g);
        tip(r, `${where} · rest`);
      } else {
        tip(band, `${where} · beat switched off`);
      }
    }

    // Lines joining layers that sound at the same instant, drawn from the
    // uppermost to the lowest row involved.
    for (const k of togetherByPage[page]) {
      const x = xOf(k.cycle, k.offset, page);
      const first = Math.min(...k.layers), last = Math.max(...k.layers);
      const line = el("line", {
        x1: x, y1: rowTop(first) + 8, x2: x, y2: rowTop(last) + ROW_H - 8, class: "together",
      }, joins);
      togethers.push({ node: line, time: k.time });
    }

    playhead = el("line", { x1: GUTTER, y1: TOP - 6, x2: GUTTER, y2: H - 4, class: "playhead" }, under);
    document.documentElement.dataset.notesDrawn = marks.length;
  }

  // Move the playhead and light up whatever is sounding at time t (seconds).
  function show(t) {
    const cycleIndex = Math.min(d.loops - 1, Math.floor(t / d.cycle_duration));
    const page = Math.floor(cycleIndex / perPage);
    if (page !== currentPage) drawPage(page);

    const frac = t / d.cycle_duration - cycleIndex;
    const x = barX(cycleIndex - page * perPage) + frac * BAR_W;
    playhead.setAttribute("x1", x);
    playhead.setAttribute("x2", x);
    for (const m of marks) m.node.classList.toggle("on", t >= m.time && t - m.time < GLOW);
    for (const k of togethers) k.node.classList.toggle("on", t >= k.time && t - k.time < GLOW);
  }

  // The time a click at screen position (clientX) points to, or null if the
  // click was outside the grid. The click arrives in screen pixels; the
  // drawing is in its own units, so scale by how wide it currently appears.
  function timeAtClick(clientX) {
    const box = svg.getBoundingClientRect();
    const x = (clientX - box.left) * (W / box.width);
    if (x < GUTTER || x > GUTTER + AREA) return null;
    const slot = Math.floor((x - GUTTER) / BAR_W);
    const frac = (x - GUTTER - slot * BAR_W) / BAR_W;
    return (currentPage * perPage + slot + frac) * d.cycle_duration;
  }

  // "cycles 5–8 of 12", for the page being shown.
  function pageLabel() {
    if (perPage === d.loops) return `cycles 1–${d.loops}`;
    const first = currentPage * perPage + 1;
    return `cycles ${first}–${Math.min(d.loops, first + perPage - 1)} of ${d.loops}`;
  }

  // The same grid written out as text, one line per layer per page.
  function textGrid() {
    const nameWidth = Math.max(...d.layers.map((l) => l.name.length)) + 2;
    const lines = [];
    for (let page = 0; page < pages; page++) {
      const firstCycle = page * perPage + 1;
      const lastCycle = Math.min(d.loops, firstCycle + perPage - 1);
      lines.push(`cycles ${firstCycle}–${lastCycle}`);
      for (let i = 0; i < nLayers; i++) {
        const bars = [];
        for (let cycle = firstCycle; cycle <= lastCycle; cycle++) {
          const beats = cellsByPage[page]
            .filter((c) => c.layer === i && c.cycle === cycle)
            .sort((a, b) => a.beat - b.beat)
            .map((c) => (c.status === "note" ? c.label : c.status === "rest" ? "-" : "."));
          bars.push(beats.join(" "));
        }
        lines.push(`  ${d.layers[i].name.padEnd(nameWidth)}| ${bars.join(" | ")} |`);
      }
      lines.push("");
    }
    lines.push("x = drum hit   - = rest   . = beat switched off");
    return lines.join("\n");
  }

  svg.setAttribute("aria-label",
    `Step notation for ${nLayers} layers over ${d.loops} cycles. The same grid is available as text below.`);
  document.documentElement.dataset.window = perPage;

  return {
    show,
    timeAtClick,
    pageLabel,
    textGrid,
    pages,
    // The start time of the page `delta` pages away from the current one,
    // wrapping round at either end.
    pageStart: (delta) => ((currentPage + delta + pages) % pages) * perPage * d.cycle_duration,
  };
}
