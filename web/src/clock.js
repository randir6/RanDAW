// The clock face that the round drawings share: rings.js and polygons.js.
//
// It lays out the page (names down the left and the circle to the right, or
// on a narrow screen names in two short columns above), decides how many bars
// one turn of the circle shows, turns a moment in the piece into an angle,
// and draws what is the same in both: the ring around the outside (tap it to
// jump), bar numbers, lines out from the centre at each bar and base beat,
// the face in the middle, and the hand.

import { barsLabel, el, textGrid, tip } from "./drawing.js";
import { NARROWEST, WIDEST } from "./view.js";

const WIDE_H = 720;
const GUTTER = 230;
const NARROW_W = 600;
export const FACE = 64;   // the disc in the middle, showing the bar number
const RULER = 26;         // the ring around the outside: tap it to jump
const MOST_BARS = 4;      // never more than this many bars in one turn
const TURN = 2 * Math.PI;

// Least common multiple, for fitting every layer's span into one turn. (The
// engine has its own in numbers.js; the drawing is kept free of engine
// imports, so it has this one-liner of its own.)
const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const lcm = (a, b) => (a / gcd(a, b)) * b;

// Everything about the circle for one piece, given the page's options.
export function clockFace(d, svg, { maxPerPage = 4, width = WIDEST } = {}) {
  const nLayers = d.layers.length;
  // The page asks for fewer bars per page on a narrow screen; that is the
  // sign to stack the names above the circle.
  const narrow = maxPerPage < 4;
  const W = narrow ? NARROW_W : Math.round(Math.max(NARROWEST, Math.min(WIDEST, width)));
  const labelAt = narrow
    ? (i) => [22 + (i % 2) * 290, 24 + Math.floor(i / 2) * 56]
    : (i) => [22, 30 + i * 100];
  const circleTop = narrow ? 24 + Math.ceil(nLayers / 2) * 56 + 8 : 0;
  const outer = narrow ? W / 2 - 10 : Math.min(WIDE_H / 2, (W - GUTTER) / 2) - 10;
  const H = narrow ? circleTop + 2 * outer + 20 : WIDE_H;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  // Let a stacked drawing shrink to the screen, rather than scroll sideways.
  svg.classList.toggle("fit", narrow);
  const cx = narrow ? W / 2 : GUTTER + (W - GUTTER) / 2;
  const cy = narrow ? circleTop + outer + 10 : H / 2;
  // Inside the ruler ring: the space the drawing itself can use.
  const inner = outer - RULER - 8;

  // How many bars one turn shows: enough for every layer's span to come
  // round whole, but never so many that it gets crowded.
  const whole = d.layers.reduce((running, l) => lcm(running, l.over), 1);
  const turnBars = whole <= MOST_BARS ? whole : Math.max(...d.layers.map((l) => l.over));
  const turns = Math.ceil(d.bars / turnBars);

  // Each cell and coincidence, grouped by the turn it appears in.
  const turnOf = (bar) => Math.floor((bar - 1) / turnBars);
  const cellsByTurn = Array.from({ length: turns }, () => []);
  for (const c of d.cells) cellsByTurn[turnOf(c.bar)].push(c);
  const togetherByTurn = Array.from({ length: turns }, () => []);
  for (const k of d.coincidences) togetherByTurn[turnOf(k.bar)].push(k);

  // An angle for a moment in the turn: straight up (12 o'clock) is the start,
  // and it goes clockwise. Screen y runs downwards, which is why adding to
  // the angle goes clockwise here.
  const angleOf = (bar, offset, turn) => (TURN * (bar - 1 - turn * turnBars + offset)) / turnBars - Math.PI / 2;
  const at = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const line = (r0, r1, a, cls, parent) => {
    const [x1, y1] = at(r0, a);
    const [x2, y2] = at(r1, a);
    return el("line", { x1, y1, x2, y2, class: cls }, parent);
  };

  // The ruler ring, bar numbers, and lines out from the face to `reach`:
  // solid where each bar starts, faint at each base beat within it.
  function drawFrame(back, turn, reach) {
    const ruler = el("circle", { cx, cy, r: outer - RULER / 2, "stroke-width": RULER, class: "ruler-ring" }, back);
    tip(ruler, "Tap here to jump to this point");
    for (let slot = 0; slot < turnBars; slot++) {
      const bar = turn * turnBars + slot + 1;
      if (bar > d.bars) break;
      const a = angleOf(bar, 0, turn);
      const [x, y] = at(outer - RULER / 2, a + 0.12);
      el("text", { x, y, class: "bar-label ring-bar-label" }, back, `bar ${bar}`);
      line(FACE, reach, a, "bar-line", back);
      for (let beat = 1; beat < d.base; beat++) line(FACE, reach, angleOf(bar, beat / d.base, turn), "base-line", back);
    }
  }

  // The face in the middle and the hand. Returns a function that moves them
  // to time t (seconds).
  function drawHand(under) {
    el("circle", { cx, cy, r: FACE - 8, class: "ring-face" }, under);
    const face = el("text", { x: cx, y: cy, class: "ring-face-label" }, under, "");
    const hand = el("line", { x1: cx, y1: cy, x2: cx, y2: cy - inner, class: "playhead" }, under);
    return (t, turn) => {
      const [x, y] = at(outer - RULER, angleOf(1, t / d.bar_duration, turn));
      hand.setAttribute("x2", x);
      hand.setAttribute("y2", y);
      face.textContent = `bar ${Math.min(d.bars, Math.floor(t / d.bar_duration) + 1)}`;
    };
  }

  // Where a tap on the ruler ring means, in bars from the start, or null if
  // the tap was somewhere else.
  function seekFrom(e, turn) {
    if (!e.target.closest(".ruler-ring")) return null;
    // From screen pixels to the drawing's units, then to an angle round from
    // 12 o'clock, then to how far through the turn that is.
    const box = svg.getBoundingClientRect();
    const scale = W / box.width;
    const x = (e.clientX - box.left) * scale - cx;
    const y = (e.clientY - box.top) * scale - cy;
    const round = ((Math.atan2(y, x) + Math.PI / 2 + TURN) % TURN) / TURN;
    return Math.min(d.bars, turn * turnBars + round * turnBars);
  }

  // Which turn time t (seconds) falls in.
  const turnAt = (t) => Math.floor(Math.min(d.bars - 1, Math.floor(t / d.bar_duration)) / turnBars);

  // The methods every drawing gives the page that depend only on the turn.
  const pageMethods = (currentTurn) => ({
    pageLabel: () => barsLabel(currentTurn() * turnBars + 1, turnBars, d.bars),
    textGrid: () => textGrid(d, turnBars),
    pages: turns,
    width: W,
    maxPerPage,
    pageStart: (delta) => ((currentTurn() + delta + turns) % turns) * turnBars,
  });

  document.documentElement.dataset.window = turnBars;

  return {
    narrow, labelAt, cx, cy, inner, turnBars, cellsByTurn, togetherByTurn,
    angleOf, at, line, drawFrame, drawHand, seekFrom, turnAt, pageMethods,
  };
}
