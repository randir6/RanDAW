// Drawing a piece as a grid of beats.
//
// One row per layer, running left to right through the bars. Each layer's
// span of bars is divided into that layer's beats, so beats in different
// rows that happen at the same instant line up vertically. That alignment is
// the polyrhythm made visible. Faint lines mark the base beats in every bar.
//
// This module only DRAWS. Everything it shows -- which beat sounds, its label,
// how high it sits, which layers coincide -- arrives already worked out in
// `d`, the derived data from derive.js. If drawing ever seems to need a
// musical decision, that decision belongs in the engine instead.
//
// rings.js draws the same piece another way; what the two share is in
// drawing.js.

import { addHatch, barsLabel, drawLayerLabel, el, layerClass, lightUp, pitchWords, textGrid, tip } from "./drawing.js";

// The visualiser shows at most this many layers, for now. The limit belongs
// to the drawing ONLY: the engine and the audio are unlimited, and the rows
// are laid out from however many layers there are, so raising it means
// changing this number and adding a colour to the page's palette.
export const MAX_LAYERS = 5;

// Layout. The drawing is sized in its own units (1600 wide) and the browser
// scales it to the window, so none of these numbers depend on screen size.
//
// The width is chosen for the screen (see createView's `width`): the browser
// scales the drawing to fit, so a narrower layout on a smaller screen means
// the text is shrunk less and stays readable. Everything else is fixed.
export const WIDEST = 1600;
export const NARROWEST = 900;
const GUTTER = 210, RIGHT = 22, TOP = 48, ROW_H = 120, ROW_GAP = 12;
const MIN_CELL = 20;      // narrower than this and a labelled note will not fit

// Set up a drawing of one piece in the given <svg>. Returns an object whose
// methods the page calls: show(t) to move the playhead, highlight() to mark a
// sequence position, and so on.
//
// Two kinds of tap are reported back rather than acted on, because what they
// mean is the page's business, not the drawing's:
//   onBeat(layer, beat)  a beat was tapped (layer from 0, beat from 1)
//   onSeek(bars)         the strip along the top was tapped, at this many
//                        bars in (2.5 = halfway through the third bar)
//
// This is a "factory function": everything declared inside it is private to
// this one drawing, and the returned object is the only way in. Every change
// to the piece makes a new view, so nothing left over can leak in.
export function createView(d, svg, { onBeat = null, onSeek = null, maxPerPage = 4, width = WIDEST } = {}) {
  const W = Math.round(Math.max(NARROWEST, Math.min(WIDEST, width)));
  const AREA = W - GUTTER - RIGHT;
  const nLayers = d.layers.length;
  const H = TOP + nLayers * (ROW_H + ROW_GAP) + 6;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.classList.remove("fit");  // see rings.js

  // How many bars to show side by side on one page. Up to four, but fewer
  // when a layer packs so many beats into a bar that four bars would squash
  // each beat below MIN_CELL wide. A page that holds every layer's span of
  // bars whole (2 bars for a layer "over 2") is preferred, so a span is not
  // split across two pages.
  const densest = Math.max(...d.layers.map((l) => l.beats / l.over));
  const spansFit = (n) => d.layers.every((l) => n % l.over === 0);
  const fits = (n) => n === 1 || AREA / n / densest >= MIN_CELL;
  let perPage = Math.min(4, maxPerPage, d.bars);
  while (perPage > 1 && !fits(perPage)) perPage -= 1;
  for (let n = perPage; n > 1; n--) {
    if (spansFit(n)) { perPage = n; break; }
  }
  const BAR_W = AREA / perPage;
  const pages = Math.ceil(d.bars / perPage);

  // Each cell and coincidence, grouped by the page it appears on, so drawing
  // a page does not have to search the whole piece.
  const pageOf = (bar) => Math.floor((bar - 1) / perPage);
  const cellsByPage = Array.from({ length: pages }, () => []);
  for (const c of d.cells) cellsByPage[pageOf(c.bar)].push(c);
  const togetherByPage = Array.from({ length: pages }, () => []);
  for (const k of d.coincidences) togetherByPage[pageOf(k.bar)].push(k);

  // Where things go on screen.
  const rowTop = (layer) => TOP + layer * (ROW_H + ROW_GAP);
  const barX = (slot) => GUTTER + slot * BAR_W;
  const xOf = (bar, offset, page) => barX(bar - 1 - page * perPage) + offset * BAR_W;
  // How wide one beat of a layer is: its span of bars shared among its beats.
  const beatW = (layer) => (BAR_W * d.layers[layer].over) / d.layers[layer].beats;
  // A note's size depends on how much room its layer has per beat.
  const radius = (layer) => Math.max(8, Math.min(14, beatW(layer) * 0.4));
  const yOf = (layer, height) => {
    const pad = radius(layer) + 7;
    // height runs 0 (lowest pitch) to 1 (highest); screen y runs downwards,
    // so it is flipped with 1 - height.
    return rowTop(layer) + pad + (1 - height) * (ROW_H - 2 * pad);
  };

  let currentPage = -1;
  let picked = null;   // the highlighted sequence position: { layer, position }, or null
  let placed = [];     // [{layer, position, node}] for everything on the page that belongs to a position
  let marks = [];      // [{node, time}] for notes on the current page
  let togethers = [];  // [{node, time}] for coincidence lines on the current page
  let playhead = null;

  function drawPage(page) {
    currentPage = page;
    svg.replaceChildren();  // empty it and start again
    marks = [];
    togethers = [];
    placed = [];

    addHatch(svg);

    // Drawn in layers, back to front: rows, then the lines joining
    // coincident notes, then the playhead, then the notes on top -- so a
    // note under the playhead stays readable while it sounds.
    const back = el("g", {}, svg);
    const joins = el("g", {}, svg);
    const under = el("g", {}, svg);
    const front = el("g", {}, svg);

    // Rows, with each layer's name and description in the left gutter.
    for (let i = 0; i < nLayers; i++) {
      const g = el("g", { class: layerClass(d, i) }, back);
      el("rect", { x: 4, y: rowTop(i), width: W - 8, height: ROW_H, rx: 10, class: "row-bg" }, g);
      drawLayerLabel(g, d.layers[i], 22, rowTop(i));
    }

    // The strip along the top: tap it to jump there. Drawn first, so the bar
    // numbers sit on top of it.
    const ruler = el("rect", { x: GUTTER, y: 4, width: AREA, height: TOP - 12, rx: 6, class: "ruler" }, back);
    tip(ruler, "Tap here to jump to this point");

    // Bar numbers, the bar lines, and faint lines at the base beats between.
    for (let slot = 0; slot < perPage; slot++) {
      const bar = page * perPage + slot + 1;
      if (bar > d.bars) break;
      el("text", { x: barX(slot) + 8, y: TOP - 14, class: "bar-label" }, back, `bar ${bar}`);
      for (let beat = 1; beat < d.base; beat++) {
        const x = barX(slot) + (beat / d.base) * BAR_W;
        el("line", { x1: x, y1: TOP, x2: x, y2: H - 4, class: "base-line" }, back);
      }
    }
    for (let slot = 0; slot <= perPage; slot++) {
      el("line", { x1: barX(slot), y1: TOP - 6, x2: barX(slot), y2: H - 4, class: "bar-line" }, back);
    }

    // Every beat on this page: its time band, then its mark.
    for (const c of cellsByPage[page]) {
      const info = d.layers[c.layer];
      const x0 = xOf(c.bar, c.offset, page);
      // A beat of a layer over several bars can run past the end of the page;
      // its band stops at the edge.
      const w = Math.min(beatW(c.layer), barX(perPage) - x0);
      // Bands go in the back layer and marks in the front one; each sits in
      // its own group carrying the layer class, which gives it its colour.
      // data-layer and data-beat mark what a tap here means (see the click
      // handler below). Beats are counted from 1, as everywhere a person sees.
      const tappable = { "data-layer": c.layer, "data-beat": c.beat };
      const band = el("rect", {
        x: x0 + 1.5, y: rowTop(c.layer) + 5, width: Math.max(1, w - 3), height: ROW_H - 10,
        class: `band ${c.status}`, ...tappable,
      }, el("g", { class: layerClass(d, c.layer) }, back));
      placed.push({ layer: c.layer, position: c.position, node: band });
      const g = el("g", { class: layerClass(d, c.layer) }, front);

      const where = `${info.name} · bar ${c.bar}, beat ${c.beat} of ${info.beats} · ${c.time.toFixed(2)} s`;
      if (c.status === "note") {
        const r = radius(c.layer);
        const y = yOf(c.layer, c.height);
        const m = el("g", { class: info.percussive ? "mark hit" : "mark note", ...tappable }, g);
        placed.push({ layer: c.layer, position: c.position, node: m });
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
        const r = el("rect", { x: x0 - 6, y: ym - 3, width: 12, height: 6, rx: 1, class: "rest-glyph", ...tappable }, g);
        placed.push({ layer: c.layer, position: c.position, node: r });
        tip(r, `${where} · rest`);
      } else {
        tip(band, `${where} · beat switched off`);
      }
    }

    // Lines joining layers that sound at the same instant, drawn from the
    // uppermost to the lowest row involved.
    for (const k of togetherByPage[page]) {
      const x = xOf(k.bar, k.offset, page);
      const first = Math.min(...k.layers), last = Math.max(...k.layers);
      const line = el("line", {
        x1: x, y1: rowTop(first) + 8, x2: x, y2: rowTop(last) + ROW_H - 8, class: "together",
      }, joins);
      togethers.push({ node: line, time: k.time });
    }

    playhead = el("line", { x1: GUTTER, y1: TOP - 6, x2: GUTTER, y2: H - 4, class: "playhead" }, under);
    document.documentElement.dataset.notesDrawn = marks.length;
    applyHighlight();
  }

  // Outline every place one position of a layer's sequence lands on this
  // page. With a sequence longer or shorter than the beat count, those places
  // move each time round -- which is exactly what this makes visible.
  function highlight(layer, position) {
    picked = layer === null ? null : { layer, position };
    applyHighlight();
  }
  function applyHighlight() {
    for (const { layer, position, node } of placed) {
      node.classList.toggle("picked", picked !== null && picked.layer === layer && picked.position === position);
    }
  }

  // Taps. Assigning svg.onclick (rather than adding a listener) replaces the
  // previous view's handler, since the same <svg> is reused for every view.
  svg.onclick = (e) => {
    const beat = e.target.closest("[data-beat]");
    if (beat && onBeat) {
      onBeat(Number(beat.dataset.layer), Number(beat.dataset.beat));
      return;
    }
    if (e.target.closest(".ruler") && onSeek) {
      // The click arrives in screen pixels; the drawing is in its own units,
      // so scale by how wide it currently appears.
      const box = svg.getBoundingClientRect();
      const x = (e.clientX - box.left) * (W / box.width);
      const slot = Math.min(perPage - 1, Math.floor((x - GUTTER) / BAR_W));
      const frac = (x - GUTTER - slot * BAR_W) / BAR_W;
      onSeek(currentPage * perPage + slot + Math.max(0, Math.min(1, frac)));
    }
  };

  // Move the playhead and light up whatever is sounding at time t (seconds).
  function show(t) {
    const barIndex = Math.min(d.bars - 1, Math.floor(t / d.bar_duration));
    const page = Math.floor(barIndex / perPage);
    if (page !== currentPage) drawPage(page);

    const frac = t / d.bar_duration - barIndex;
    const x = barX(barIndex - page * perPage) + frac * BAR_W;
    playhead.setAttribute("x1", x);
    playhead.setAttribute("x2", x);
    lightUp(marks, t);
    lightUp(togethers, t);
  }

  svg.setAttribute("aria-label",
    `Grid of beats for ${nLayers} layers over ${d.bars} bars. The same grid is available as text below.`);
  document.documentElement.dataset.window = perPage;

  return {
    show,
    highlight,
    // "bars 5–8 of 12", for the page being shown.
    pageLabel: () => barsLabel(currentPage * perPage + 1, perPage, d.bars),
    // The same grid written out as text, a page to a block.
    textGrid: () => textGrid(d, perPage),
    pages,
    width: W,
    maxPerPage,
    // Where the page `delta` pages away from this one starts, in bars,
    // wrapping round at either end.
    pageStart: (delta) => ((currentPage + delta + pages) % pages) * perPage,
  };
}
