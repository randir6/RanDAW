// Drawing a piece as rings: one ring per layer, going round like a clock.
//
// One turn of the circle is a bar -- or, when a layer spreads its beats over
// several bars, enough bars for every layer's span to fit (2 for a layer
// "over 2"). Each ring is cut into that layer's beats, so a 3-beat ring has
// three slices and a 4-beat ring four, all sharing the same turn. Beats in
// different rings that happen at the same instant sit on the same line out
// from the centre, and a hand sweeps round as it plays.
//
// Where the grid (view.js) is best for reading a sequence, rings show the
// shape of a polyrhythm at a glance: 3 against 4 is a triangle against a
// square.
//
// Like the grid, this only DRAWS what derive.js worked out, and offers the
// same methods to the page, so the page can switch between them freely.

import { addHatch, barsLabel, drawLayerLabel, el, layerClass, lightUp, pitchWords, textGrid, tip } from "./drawing.js";
import { NARROWEST, WIDEST } from "./view.js";

// Layout, in the drawing's own units; everything scales with the window, as
// the grid does. On a wide screen the circle sits to the right of the layer
// names. On a narrow one -- a phone held upright -- the names go in two short
// columns above it, and the whole drawing fits the width of the screen.
const WIDE_H = 720;
const GUTTER = 230;
const NARROW_W = 600;
const FACE = 64;          // the disc in the middle, showing the bar number
const RULER = 26;         // the ring around the outside: tap it to jump
const GAP = 5;            // space between rings
const MOST_BARS = 4;      // never more than this many bars in one turn

// Least common multiple, for fitting every layer's span into one turn. (The
// engine has its own in numbers.js; the drawing is kept free of engine
// imports, so it has this one-liner of its own.)
const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const lcm = (a, b) => (a / gcd(a, b)) * b;

// Set up a ring drawing of one piece in the given <svg>. The same options,
// and the same returned methods, as createView() in view.js.
export function createRingView(d, svg, { onBeat = null, onSeek = null, maxPerPage = 4, width = WIDEST } = {}) {
  const nLayers = d.layers.length;
  // The page asks for fewer bars per page on a narrow screen; that is the
  // sign to stack.
  const narrow = maxPerPage < 4;
  const W = narrow ? NARROW_W : Math.round(Math.max(NARROWEST, Math.min(WIDEST, width)));
  // Where each layer's name goes, and the space left for the circle.
  const labelAt = narrow
    ? (i) => [22 + (i % 2) * 290, 24 + Math.floor(i / 2) * 56]
    : (i) => [22, 30 + i * 100];
  const circleTop = narrow ? 24 + Math.ceil(nLayers / 2) * 56 + 8 : 0;
  const outer = narrow ? W / 2 - 10 : Math.min(WIDE_H / 2, (W - GUTTER) / 2) - 10;
  const H = narrow ? circleTop + 2 * outer + 20 : WIDE_H;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  // Let a stacked drawing shrink to the screen, rather than scroll sideways.
  svg.classList.toggle("fit", narrow);

  // How many bars one turn shows: enough for every layer's span to come
  // round whole, but never so many that the rings get crowded.
  const whole = d.layers.reduce((running, l) => lcm(running, l.over), 1);
  const turnBars = whole <= MOST_BARS ? whole : Math.max(...d.layers.map((l) => l.over));
  const turns = Math.ceil(d.bars / turnBars);

  // Each cell and coincidence, grouped by the turn it appears in.
  const turnOf = (bar) => Math.floor((bar - 1) / turnBars);
  const cellsByTurn = Array.from({ length: turns }, () => []);
  for (const c of d.cells) cellsByTurn[turnOf(c.bar)].push(c);
  const togetherByTurn = Array.from({ length: turns }, () => []);
  for (const k of d.coincidences) togetherByTurn[turnOf(k.bar)].push(k);

  // Where things go. The centre of the circle, and the radii: the ruler ring
  // on the outside, then one ring per layer (the first layer outermost),
  // then the face in the middle.
  const cx = narrow ? W / 2 : GUTTER + (W - GUTTER) / 2;
  const cy = narrow ? circleTop + outer + 10 : H / 2;
  const rings = outer - RULER - 8;
  const T = (rings - FACE) / nLayers;         // each ring's thickness
  const ringOut = (i) => rings - i * T;
  const ringIn = (i) => ringOut(i) - T + GAP;

  // An angle for a moment in the turn: 0 of the way round is straight up (12
  // o'clock), and it goes clockwise. Screen y runs downwards, which is why
  // adding to the angle goes clockwise here.
  const TURN = 2 * Math.PI;
  const angleOf = (bar, offset, turn) => (TURN * (bar - 1 - turn * turnBars + offset)) / turnBars - Math.PI / 2;
  const at = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const point = (r, a) => at(r, a).map((v) => v.toFixed(2)).join(" ");
  // The angle one beat of a layer takes up.
  const beatAngle = (layer) => (TURN * d.layers[layer].over) / d.layers[layer].beats / turnBars;

  // A slice of a ring, from angle a0 to a1: the outer arc one way, the inner
  // arc back. An SVG arc cannot draw a whole circle, so a slice that goes all
  // the way round is drawn as two halves.
  function slice(rIn, rOut, a0, a1) {
    if (a1 - a0 >= TURN - 1e-9) {
      const mid = a0 + Math.PI;
      return `${slice(rIn, rOut, a0, mid)} ${slice(rIn, rOut, mid, a0 + TURN)}`;
    }
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return `M ${point(rOut, a0)} A ${rOut} ${rOut} 0 ${large} 1 ${point(rOut, a1)} ` +
      `L ${point(rIn, a1)} A ${rIn} ${rIn} 0 ${large} 0 ${point(rIn, a0)} Z`;
  }

  let currentTurn = -1;
  let picked = null;   // the highlighted sequence position: { layer, position }, or null
  let placed = [];     // [{layer, position, node}] for everything that belongs to a position
  let marks = [];      // [{node, time}] for notes in this turn
  let togethers = [];  // [{node, time}] for coincidence lines in this turn
  let hand = null;
  let face = null;

  function drawTurn(turn) {
    currentTurn = turn;
    svg.replaceChildren();
    marks = [];
    togethers = [];
    placed = [];
    addHatch(svg);

    // Back to front, as in the grid: rings, joining lines, the hand, notes.
    const back = el("g", {}, svg);
    const joins = el("g", {}, svg);
    const under = el("g", {}, svg);
    const front = el("g", {}, svg);

    // Names down the left, outermost ring first.
    el("text", { x: 22, y: 22, class: "sub" }, back, "rings, from the outside in");
    for (let i = 0; i < nLayers; i++) {
      const g = el("g", { class: layerClass(d, i) }, back);
      drawLayerLabel(g, d.layers[i], ...labelAt(i), narrow ? 1 : 3);
      // Each ring's own background, a circle drawn as a thick line.
      el("circle", {
        cx, cy, r: (ringOut(i) + ringIn(i)) / 2, "stroke-width": T - GAP, class: "ring-bg",
      }, g);
    }

    // The ruler ring around the outside, with the bar numbers on it.
    const ruler = el("circle", { cx, cy, r: outer - RULER / 2, "stroke-width": RULER, class: "ruler-ring" }, back);
    tip(ruler, "Tap here to jump to this point");
    for (let slot = 0; slot < turnBars; slot++) {
      const bar = turn * turnBars + slot + 1;
      if (bar > d.bars) break;
      const a = angleOf(bar, 0, turn);
      const [x, y] = at(outer - RULER / 2, a + 0.12);
      el("text", { x, y, class: "bar-label ring-bar-label" }, back, `bar ${bar}`);
      // A line from the centre where each bar starts, and fainter ones at
      // each base beat within it.
      const [x0, y0] = at(FACE, a);
      const [x1, y1] = at(rings, a);
      el("line", { x1: x0, y1: y0, x2: x1, y2: y1, class: "bar-line" }, back);
      for (let beat = 1; beat < d.base; beat++) {
        const b = angleOf(bar, beat / d.base, turn);
        const [bx0, by0] = at(FACE, b);
        const [bx1, by1] = at(rings, b);
        el("line", { x1: bx0, y1: by0, x2: bx1, y2: by1, class: "base-line" }, back);
      }
    }

    // Every beat in this turn: its slice of the ring, then its mark.
    const turnEnd = angleOf(turn * turnBars + 1, turnBars, turn);
    for (const c of cellsByTurn[turn]) {
      const info = d.layers[c.layer];
      const a0 = angleOf(c.bar, c.offset, turn);
      // A beat of a layer over more bars than the turn holds stops at the end.
      const a1 = Math.min(a0 + beatAngle(c.layer), turnEnd);
      const rIn = ringIn(c.layer), rOut = ringOut(c.layer);
      // A small gap between slices, the same width all the way out.
      const trim = Math.min((a1 - a0) * 0.2, 1.5 / rIn);
      const tappable = { "data-layer": c.layer, "data-beat": c.beat };
      const band = el("path", {
        d: slice(rIn, rOut, a0 + trim, a1 - trim), class: `band ${c.status}`, ...tappable,
      }, el("g", { class: layerClass(d, c.layer) }, back));
      placed.push({ layer: c.layer, position: c.position, node: band });
      const g = el("g", { class: layerClass(d, c.layer) }, front);

      // Notes sit where the beat starts, further out the higher they are, as
      // they sit higher in a row of the grid.
      const room = (rOut + rIn) / 2 * (a1 - a0);
      const r = Math.max(6, Math.min(13, (T - GAP) * 0.3, room * 0.4));
      const pad = r + 3;
      const radius = rIn + pad + c.height * (rOut - rIn - 2 * pad);
      const [x, y] = at(radius, a0);
      const where = `${info.name} · bar ${c.bar}, beat ${c.beat} of ${info.beats} · ${c.time.toFixed(2)} s`;
      if (c.status === "note") {
        const m = el("g", { class: info.percussive ? "mark hit" : "mark note", ...tappable }, g);
        placed.push({ layer: c.layer, position: c.position, node: m });
        if (info.percussive) {
          const s = r * 0.62;
          el("circle", { cx: x, cy: y, r }, m);  // invisible, but easier to hover
          el("line", { x1: x - s, y1: y - s, x2: x + s, y2: y + s }, m);
          el("line", { x1: x - s, y1: y + s, x2: x + s, y2: y - s }, m);
        } else {
          el("circle", { cx: x, cy: y, r }, m);
          el("text", { x, y: y + 0.5, "font-size": Math.min(14, r * 1.05) }, m, c.label);
        }
        tip(m, `${where} · ${pitchWords(info, c)}`);
        marks.push({ node: m, time: c.time });
      } else if (c.status === "rest") {
        const rest = el("rect", { x: x - 6, y: y - 3, width: 12, height: 6, rx: 1, class: "rest-glyph", ...tappable }, g);
        placed.push({ layer: c.layer, position: c.position, node: rest });
        tip(rest, `${where} · rest`);
      } else {
        tip(band, `${where} · beat switched off`);
      }
    }

    // Layers sounding together: a line out from the centre, across every
    // ring involved.
    for (const k of togetherByTurn[turn]) {
      const a = angleOf(k.bar, k.offset, turn);
      const [x0, y0] = at(ringIn(Math.max(...k.layers)) + 4, a);
      const [x1, y1] = at(ringOut(Math.min(...k.layers)) - 4, a);
      const line = el("line", { x1: x0, y1: y0, x2: x1, y2: y1, class: "together" }, joins);
      togethers.push({ node: line, time: k.time });
    }

    // The face in the middle says which bar is playing; the hand sweeps.
    el("circle", { cx, cy, r: FACE - 8, class: "ring-face" }, under);
    face = el("text", { x: cx, y: cy, class: "ring-face-label" }, under, "");
    hand = el("line", { x1: cx, y1: cy, x2: cx, y2: cy - outer + RULER, class: "playhead" }, under);
    document.documentElement.dataset.notesDrawn = marks.length;
    applyHighlight();
  }

  // Outline every place one position of a layer's sequence lands this turn.
  function highlight(layer, position) {
    picked = layer === null ? null : { layer, position };
    applyHighlight();
  }
  function applyHighlight() {
    for (const { layer, position, node } of placed) {
      node.classList.toggle("picked", picked !== null && picked.layer === layer && picked.position === position);
    }
  }

  // Taps: a beat switches it off or on; the ruler ring jumps there.
  svg.onclick = (e) => {
    const beat = e.target.closest("[data-beat]");
    if (beat && onBeat) {
      onBeat(Number(beat.dataset.layer), Number(beat.dataset.beat));
      return;
    }
    if (e.target.closest(".ruler-ring") && onSeek) {
      // From screen pixels to the drawing's units, then to an angle round
      // from 12 o'clock, then to how far through the turn that is.
      const box = svg.getBoundingClientRect();
      const scale = W / box.width;
      const x = (e.clientX - box.left) * scale - cx;
      const y = (e.clientY - box.top) * scale - cy;
      const round = ((Math.atan2(y, x) + Math.PI / 2 + TURN) % TURN) / TURN;
      onSeek(Math.min(d.bars, currentTurn * turnBars + round * turnBars));
    }
  };

  // Turn the hand and light up whatever is sounding at time t (seconds).
  function show(t) {
    const barIndex = Math.min(d.bars - 1, Math.floor(t / d.bar_duration));
    const turn = Math.floor(barIndex / turnBars);
    if (turn !== currentTurn) drawTurn(turn);
    const a = angleOf(1, t / d.bar_duration, turn);
    const [x, y] = at(outer - RULER, a);
    hand.setAttribute("x2", x);
    hand.setAttribute("y2", y);
    face.textContent = `bar ${barIndex + 1}`;
    lightUp(marks, t);
    lightUp(togethers, t);
  }

  svg.setAttribute("aria-label",
    `Rings of beats for ${nLayers} layers over ${d.bars} bars. The same grid is available as text below.`);
  document.documentElement.dataset.window = turnBars;

  return {
    show,
    highlight,
    pageLabel: () => barsLabel(currentTurn * turnBars + 1, turnBars, d.bars),
    textGrid: () => textGrid(d, turnBars),
    pages: turns,
    width: W,
    maxPerPage,
    pageStart: (delta) => ((currentTurn + delta + turns) % turns) * turnBars,
  };
}
