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
// shape of a polyrhythm at a glance. Like the grid, this only DRAWS what
// derive.js worked out, and offers the same methods to the page, so the page
// can switch between drawings freely. The clock face itself is clock.js.

import { clockFace, FACE } from "./clock.js";
import { addHatch, drawLayerLabel, drawMark, el, layerClass, lightUp, showPicked, tip, whereWords } from "./drawing.js";

const GAP = 5;  // space between rings
const TURN = 2 * Math.PI;

// Set up a ring drawing of one piece in the given <svg>. The same options,
// and the same returned methods, as createView() in view.js.
export function createRingView(d, svg, { onBeat = null, onSeek = null, maxPerPage, width } = {}) {
  const nLayers = d.layers.length;
  const clock = clockFace(d, svg, { maxPerPage, width });
  const { angleOf, at, turnBars } = clock;

  // One ring per layer, the first layer outermost, down to the face.
  const T = (clock.inner - FACE) / nLayers;  // each ring's thickness
  const ringOut = (i) => clock.inner - i * T;
  const ringIn = (i) => ringOut(i) - T + GAP;
  // The angle one beat of a layer takes up.
  const beatAngle = (layer) => (TURN * d.layers[layer].over) / d.layers[layer].beats / turnBars;
  const point = (r, a) => at(r, a).map((v) => v.toFixed(2)).join(" ");

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
  let moveHand = null;

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

    // Names, outermost ring first, and each ring's background: a circle
    // drawn as a thick line.
    el("text", { x: 22, y: 18, class: "sub" }, back, "rings, from the outside in");
    for (let i = 0; i < nLayers; i++) {
      const g = el("g", { class: layerClass(d, i) }, back);
      drawLayerLabel(g, d.layers[i], ...clock.labelAt(i), clock.narrow ? 1 : 3);
      el("circle", { cx: clock.cx, cy: clock.cy, r: (ringOut(i) + ringIn(i)) / 2, "stroke-width": T - GAP, class: "ring-bg" }, g);
    }
    clock.drawFrame(back, turn, clock.inner);

    // Every beat in this turn: its slice of the ring, then its mark.
    const turnEnd = angleOf(turn * turnBars + 1, turnBars, turn);
    for (const c of clock.cellsByTurn[turn]) {
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

      // Notes sit where the beat starts, further out the higher they are, as
      // they sit higher in a row of the grid.
      const room = ((rOut + rIn) / 2) * (a1 - a0);
      const r = Math.max(6, Math.min(13, (T - GAP) * 0.3, room * 0.4));
      const pad = r + 3;
      const [x, y] = at(rIn + pad + c.height * (rOut - rIn - 2 * pad), a0);
      const g = el("g", { class: layerClass(d, c.layer) }, front);
      const mark = drawMark(g, info, c, x, y, r, tappable, whereWords(info, c));
      if (mark) placed.push({ layer: c.layer, position: c.position, node: mark });
      if (c.status === "note") marks.push({ node: mark, time: c.time });
      if (c.status === "inactive") tip(band, `${whereWords(info, c)} · beat switched off`);
    }

    // Layers sounding together: a line out from the centre, across every
    // ring involved.
    for (const k of clock.togetherByTurn[turn]) {
      const a = angleOf(k.bar, k.offset, turn);
      const line = clock.line(ringIn(Math.max(...k.layers)) + 4, ringOut(Math.min(...k.layers)) - 4, a, "together", joins);
      togethers.push({ node: line, time: k.time });
    }

    moveHand = clock.drawHand(under);
    document.documentElement.dataset.notesDrawn = marks.length;
    showPicked(placed, picked);
  }

  // Taps: a beat switches it off or on; the ruler ring jumps there.
  svg.onclick = (e) => {
    const beat = e.target.closest("[data-beat]");
    if (beat && onBeat) {
      onBeat(Number(beat.dataset.layer), Number(beat.dataset.beat));
      return;
    }
    const bars = clock.seekFrom(e, currentTurn);
    if (bars !== null && onSeek) onSeek(bars);
  };

  svg.setAttribute("aria-label",
    `Rings of beats for ${nLayers} layers over ${d.bars} bars. The same grid is available as text below.`);

  return {
    // Turn the hand and light up whatever is sounding at time t (seconds).
    show(t) {
      const turn = clock.turnAt(t);
      if (turn !== currentTurn) drawTurn(turn);
      moveHand(t, turn);
      lightUp(marks, t);
      lightUp(togethers, t);
    },
    // Outline every place one position of a layer's sequence lands this turn.
    highlight(layer, position) {
      picked = layer === null ? null : { layer, position };
      showPicked(placed, picked);
    },
    ...clock.pageMethods(() => currentTurn),
  };
}
