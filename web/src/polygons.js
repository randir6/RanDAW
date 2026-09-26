// Drawing a piece as shapes: each layer's beats joined up round a circle.
//
// On a clock face (clock.js), every beat of a layer is a corner, so a 3-beat
// layer is a triangle and a 4-beat layer a square, and where two shapes
// share a corner, those layers sound together. Two outlines per layer:
//
//   * faint and dashed, through EVERY beat -- the layer's regular pulse;
//   * solid and lightly filled, through only the beats that SOUND -- the
//     rhythm you actually hear. Switching beats off bends the shape: the
//     tresillo's 3-3-2 kick is a lopsided triangle inside an octagon.
//
// Each layer's shape sits a little inside the one before, so corners that
// land together stay visible side by side. Like the other drawings, this
// only DRAWS what derive.js worked out.

import { clockFace, FACE } from "./clock.js";
import { addHatch, drawLayerLabel, drawMark, el, layerClass, lightUp, showPicked, tip, whereWords } from "./drawing.js";

// Set up a shape drawing of one piece in the given <svg>. The same options,
// and the same returned methods, as createView() in view.js.
export function createPolygonView(d, svg, { onBeat = null, onSeek = null, maxPerPage, width } = {}) {
  const nLayers = d.layers.length;
  const clock = clockFace(d, svg, { maxPerPage, width });
  const { angleOf, at } = clock;

  // Each layer's shape a step inside the one before, first layer outermost.
  const outerShape = clock.inner - 14;
  const step = Math.min(18, (outerShape - FACE - 60) / Math.max(1, nLayers - 1));
  const radiusOf = (i) => outerShape - i * step;
  const pointsOf = (list, r) => list.map((a) => at(r, a).map((v) => v.toFixed(2)).join(",")).join(" ");

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

    // Back to front: guide and shapes, joining lines, the hand, then marks.
    const back = el("g", {}, svg);
    const joins = el("g", {}, svg);
    const under = el("g", {}, svg);
    const front = el("g", {}, svg);

    el("text", { x: 22, y: 18, class: "sub" }, back, "shapes: each layer's beats joined up");
    el("circle", { cx: clock.cx, cy: clock.cy, r: outerShape, class: "ring-guide" }, back);
    clock.drawFrame(back, turn, clock.inner);

    const cells = clock.cellsByTurn[turn];
    for (let i = 0; i < nLayers; i++) {
      const info = d.layers[i];
      const g = el("g", { class: layerClass(d, i) }, back);
      drawLayerLabel(g, info, ...clock.labelAt(i), clock.narrow ? 1 : 3);

      // This layer's beats in this turn, in time order, and their angles.
      const mine = cells.filter((c) => c.layer === i);
      const r = radiusOf(i);
      const angles = mine.map((c) => angleOf(c.bar, c.offset, turn));
      // A turn the piece ends part-way through leaves the shape open.
      const whole = mine.length === (info.beats * clock.turnBars) / info.over;
      const outline = whole ? "polygon" : "polyline";
      if (angles.length >= 2) {
        el(outline, { points: pointsOf(angles, r), class: "poly-pulse" }, g);
      }
      const heard = mine.map((c, n) => [c, angles[n]]).filter(([c]) => c.status === "note");
      if (heard.length >= 2) {
        el(outline, { points: pointsOf(heard.map(([, a]) => a), r), class: "poly-heard" }, g);
      }

      // A mark at every corner. Room for it depends on how close the
      // corners are.
      const gap = (2 * Math.PI * r * info.over) / (info.beats * clock.turnBars);
      const size = Math.max(6, Math.min(12, gap * 0.35));
      const top = el("g", { class: layerClass(d, i) }, front);
      mine.forEach((c, n) => {
        const [x, y] = at(r, angles[n]);
        const tappable = { "data-layer": c.layer, "data-beat": c.beat };
        let mark = drawMark(top, info, c, x, y, size, tappable, whereWords(info, c));
        if (c.status === "inactive") {
          // A switched-off beat: an empty corner, still tappable to turn it on.
          mark = el("circle", { cx: x, cy: y, r: Math.max(4, size * 0.55), class: "poly-off", ...tappable }, top);
          tip(mark, `${whereWords(info, c)} · beat switched off`);
        }
        placed.push({ layer: c.layer, position: c.position, node: mark });
        if (c.status === "note") marks.push({ node: mark, time: c.time });
      });
    }

    // Layers sounding together: a short line across their corners.
    for (const k of clock.togetherByTurn[turn]) {
      const a = angleOf(k.bar, k.offset, turn);
      const line = clock.line(radiusOf(Math.max(...k.layers)) - 10, radiusOf(Math.min(...k.layers)) + 10, a, "together", joins);
      togethers.push({ node: line, time: k.time });
    }

    moveHand = clock.drawHand(under);
    document.documentElement.dataset.notesDrawn = marks.length;
    showPicked(placed, picked);
  }

  // Taps: a corner switches that beat off or on; the ruler ring jumps there.
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
    `Shapes of beats for ${nLayers} layers over ${d.bars} bars. The same grid is available as text below.`);

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
