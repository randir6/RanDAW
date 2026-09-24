// Arithmetic that has to agree with the Python version to the last digit.
//
// JavaScript and Python mostly do sums the same way -- both use the same
// 64-bit floating-point numbers underneath -- but they disagree on a few
// small things, and each disagreement would quietly change a note or a
// sample somewhere. Everything in this file exists because of one of them:
//
//   1. Remainder of a negative number.  Python: -1 % 7 is 6.
//                                        JavaScript: -1 % 7 is -1.
//   2. Rounding a half.                 Python: round(2.5) is 2 (to even).
//                                        JavaScript: Math.round(2.5) is 3.
//   3. Rounding to decimal places.       Same difference, in round(x, 6).
//
// The Python version was the answer key while this engine was written, and
// these are the places a straight translation got different answers.

// Python-style whole-number division and remainder, which round DOWN
// (towards minus infinity) rather than towards zero. The pair always obeys
// a == b * q + r, and r always has the same sign as b -- so -1 divided into
// sevens is "-1 sevens, remainder 6". That is what makes scale degree 0
// land one step below the root instead of producing nonsense.
export function divmod(a, b) {
  const q = Math.floor(a / b);
  return [q, a - b * q];
}

// Round to the nearest whole number, sending an exact half to the EVEN
// neighbour: 0.5 -> 0, 1.5 -> 2, 2.5 -> 2, -2.5 -> -2. Python's round()
// does this ("banker's rounding"), which avoids always nudging halves the
// same way. Math.round would send every half upwards.
export function roundHalfEven(x) {
  const below = Math.floor(x);
  // Exact: x and `below` are less than 1 apart, so the subtraction loses
  // nothing.
  const fraction = x - below;
  if (fraction > 0.5) return below + 1;
  if (fraction < 0.5) return below;
  return below % 2 === 0 ? below : below + 1;
}

// x written with exactly `places` decimals, rounding an exact half to even
// -- what Python's f"{x:.4f}" gives. JavaScript's toFixed() rounds halves
// up, so ties need handling here.
//
// A "tie" is rare but real: 1/128 is exactly 0.0078125 in binary, and to six
// places it sits precisely halfway between 0.007812 and 0.007813. Python
// picks the 2; toFixed would pick the 3.
export function toFixedHalfEven(x, places) {
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  const size = Math.abs(x);
  // toFixed(100) writes out the number's exact binary value in decimal (every
  // number this program rounds has far fewer than 100 decimal digits), so we
  // can look at precisely what comes after the digits we keep.
  const exact = size.toFixed(100);
  const point = exact.indexOf(".");
  const after = exact.slice(point + 1 + places);
  const isTie = after[0] === "5" && /^0*$/.test(after.slice(1));

  let text;
  if (isTie) {
    // Two candidates: chop the extra digits off (rounding down), or let
    // toFixed round up. Keep whichever ends in an even digit.
    const down = exact.slice(0, places === 0 ? point : point + 1 + places);
    const lastDigit = Number(down[down.length - 1]);
    text = lastDigit % 2 === 0 ? down : size.toFixed(places);
  } else {
    text = size.toFixed(places);
  }
  return sign + text;
}

// Round to a number of decimal places, as Python's round(x, places) does.
export function roundTo(x, places) {
  return Number(toFixedHalfEven(x, places));
}

// Greatest common divisor, by Euclid's method: the oldest algorithm still in
// everyday use, about 2,300 years old. The gcd of 12 and 18 is 6.
export function gcd(a, b) {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

// Lowest common multiple: the smallest number both divide into exactly.
// Python has math.lcm built in; JavaScript does not. Dividing before
// multiplying keeps the numbers small.
export function lcm(a, b) {
  return (a / gcd(a, b)) * b;
}
