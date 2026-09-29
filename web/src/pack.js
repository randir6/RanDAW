// A piece packed into as few bits as possible, for links (link.js).
//
// Writing a piece out in full (JSON) spends most of its length on things the
// reader could have guessed: that the tempo is 120, that a kick plays note 0,
// that a beat pattern spreads its hits evenly. This format builds those
// guesses in, so a link only carries what is surprising about the piece.
//
// Three kinds of cleverness, none of which changes what a piece can be:
//
// 1. Guesses first. Most values are written as a place in a short list of
//    likely ones -- tempo 120 before 100, before 110 ... -- and the first
//    place costs one bit, the next two cost three, and so on. A value on
//    no list is written out in full after a few bits saying so.
// 2. Musical shorthand. A beat pattern that spreads k hits as evenly as
//    possible over n beats, turned to start on some beat (a "Euclidean
//    rhythm": tresillo's 1, 4, 7 of 8 is 3 of 8), is written as k and the
//    turn. A melody that is a chord played up, down or up-and-back
//    (0 3 7 10 7 3 is a minor seventh, up and back) is written as the
//    chord, the shape and the starting note. Anything else is written
//    note by note, as steps from the note before.
// 3. Nothing the reader can work out. Bars, when they are exactly as long
//    as the whole pattern takes to repeat, cost one bit.
//
// The piece's skeleton comes first -- tempo, base, how many layers, and
// each layer's sample and beats -- then the detail: scale, melodies, gains,
// which beats sound, bars. link.js writes the first bits as three words, so
// the words hold the skeleton: tweak a melody or a gain and they stay the
// same; change the groove's shape and they change.
//
// The name is not in here: link.js writes it in the link as it is.
//
// The lists below are part of the format: a link made today must open the
// same piece for ever, so they are FROZEN. Changing any of them means a new
// kind of link in link.js, with this one kept for the links already made.
//
// pack() refuses (throws Unpackable) anything outside what this format
// covers, and link.js then uses its plain format instead, so no piece is
// ever changed by being put in a link.

export class Unpackable extends Error {}

// --- The frozen lists -------------------------------------------------------------

const ABSENT = Symbol("absent");
const REST = "-";

// The built-in samples, most used first.
const SAMPLES = ["kick.wav", "hat.wav", "snare.wav", "pluck.wav", "bell.wav", "tom.wav", "keys.wav",
  "marimba.wav", "click.wav"];
const SCALE_NAMES = ["major", "minor", "dorian", "phrygian", "lydian", "mixolydian", "locrian",
  "harmonic_minor", "melodic_minor", "major_pentatonic", "minor_pentatonic", "blues", "whole_tone", "chromatic"];
const TEMPOS = [120, 100, 110, 90, 130, 140, 80, 150, 160, 70, 170, 180, 60, 125, 115, 105, 95, 85, 75];
const BASES = [4, 3, 7, 5, 6, 2, 8, 9, 11, 12, 13, 10, 1];
// Chords a melody might run through: semitones for `notes`, scale degrees
// for `degrees`.
const NOTE_CHORDS = [
  [0, 3, 7, 10], [0, 4, 7], [0, 3, 7], [0, 4, 7, 10], [0, 4, 7, 11], [0, 12], [0, 7], [0, 3, 7, 10, 12],
  [0, 4, 7, 12], [0, 3, 7, 12], [0, 5, 7], [0, 2, 7], [0, 3, 5, 7, 10], [0, 2, 4, 7, 9],
];
const DEGREE_CHORDS = [
  [1, 3, 5], [1, 3, 5, 8], [1, 5], [1, 8], [1, 3, 5, 7], [1, 2, 3, 4, 5], [1, 2, 3, 4, 5, 6, 7, 8], [1, 5, 8],
];
// The ways through a chord.
const SHAPES = [
  (c) => c,                                       // up
  (c) => [...c].reverse(),                        // down
  (c) => [...c, ...[...c].reverse().slice(1, -1)],  // up and back, not repeating either end
  (c) => [...c, ...[...c].reverse().slice(1)],      // up and back to where it started
];
// The characters of a number written out in full, four bits each.
const NUMBER_CHARS = "0123456789.-e+";

// --- Bits ---------------------------------------------------------------------------

// A list of bits (0s and 1s), written a value at a time.
class Writer {
  bits = [];
  bit(b) {
    this.bits.push(b ? 1 : 0);
  }
  uint(n, width) {
    for (let i = width - 1; i >= 0; i--) this.bit((n >> i) & 1);
  }
  // Exp-Golomb code of order k, for n >= 0: small numbers cost few bits
  // (with k = 0: 0 costs 1 bit, 1-2 cost 3, 3-6 cost 5, ...) and there is
  // no largest number.
  eg(n, k = 0) {
    if (!Number.isInteger(n) || n < 0) throw new Unpackable(`not a count: ${n}`);
    const m = n + 2 ** k;
    const width = Math.floor(Math.log2(m)) + 1;
    for (let i = 0; i < width - k - 1; i++) this.bit(0);
    this.uint(m, width);
  }
  // Any whole number: 0, -1, 1, -2, 2 ... in that order.
  signed(n, k = 0) {
    if (!Number.isInteger(n)) throw new Unpackable(`not a whole number: ${n}`);
    this.eg(n >= 0 ? 2 * n : -2 * n - 1, k);
  }
  // A value as its place in a list of likely values; off the list, the
  // list's length and then `other` writes it out.
  pick(value, list, other = null) {
    const i = list.indexOf(value);
    if (i >= 0) return this.eg(i);
    if (!other) throw new Unpackable(`not one of the known values: ${String(value)}`);
    this.eg(list.length);
    other(value);
  }
}

// Reads the bits back. Past the end reads as zeros, so a link can leave
// trailing zeros out.
class Reader {
  constructor(bits) {
    this.bits = bits;
    this.at = 0;
  }
  bit() {
    // Zeros past the end, but not for ever: a mangled link must fail, not loop.
    if (this.at > this.bits.length + 64) throw new Unpackable("the link ends too soon");
    return this.bits[this.at++] ?? 0;
  }
  uint(width) {
    let n = 0;
    for (let i = 0; i < width; i++) n = n * 2 + this.bit();
    return n;
  }
  eg(k = 0) {
    let zeros = 0;
    while (this.bit() === 0) {
      if (++zeros > 40) throw new Unpackable("the link is not a piece");
    }
    this.at--;
    return this.uint(zeros + k + 1) - 2 ** k;
  }
  signed(k = 0) {
    const n = this.eg(k);
    return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
  }
  pick(list, other = null) {
    const i = this.eg();
    if (i < list.length) return list[i];
    if (i > list.length || !other) throw new Unpackable("the link is not a piece");
    return other();
  }
}

// --- Pieces of a piece -------------------------------------------------------------

const bitsFor = (n) => Math.max(1, Math.ceil(Math.log2(n + 1)));
const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const lcm = (a, b) => (a / gcd(a, b)) * b;
// Likely beat counts for a layer: the same as the layer before, then the base
// and twice it, then the usual cross-rhythms.
const likelyBeats = (previous, base) => unique([previous ?? base, base, 2 * base, 3, 4, 5, 7, 16, 6, 8, 12, 9, 11, 13, 2]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const unique = (list) => [...new Set(list)];

// A number of any kind, written out as text.
function writeNumber(w, n) {
  if (typeof n !== "number" || !Number.isFinite(n)) throw new Unpackable(`not a number: ${n}`);
  for (const c of String(n)) w.uint(NUMBER_CHARS.indexOf(c), 4);
  w.uint(15, 4);
}
function readNumber(r) {
  let text = "";
  for (let c = r.uint(4); c !== 15; c = r.uint(4)) {
    if (c >= NUMBER_CHARS.length || text.length > 30) throw new Unpackable("the link is not a piece");
    text += NUMBER_CHARS[c];
  }
  const n = Number(text);
  if (text === "" || !Number.isFinite(n)) throw new Unpackable("the link is not a piece");
  return n;
}

// The positions (from 1) of k hits spread as evenly as possible over n
// beats, the first on beat 1, turned on by `turn` beats.
function euclid(k, n, turn) {
  const hits = [];
  for (let i = 0; i < n; i++) {
    if (Math.floor((i * k) / n) !== Math.floor(((i - 1) * k) / n) || (i === 0 && k > 0)) hits.push(i);
  }
  return hits.map((i) => ((i + turn) % n) + 1).sort((a, b) => a - b);
}

// Which beats sound: all of them (one bit), an even spread (the number of
// hits and the turn), or one bit per beat.
function writeActive(w, active, beats) {
  w.bit(active !== ABSENT);
  if (active === ABSENT) return;
  if (!Array.isArray(active)) throw new Unpackable("active is not a list");
  for (let turn = 0; turn < beats; turn++) {
    if (active.length && same(euclid(active.length, beats, turn), active)) {
      w.bit(0);
      w.eg(active.length - 1);
      w.uint(turn, bitsFor(beats - 1));
      return;
    }
  }
  const on = new Set(active);
  const listed = Array.from({ length: beats }, (_, i) => i + 1).filter((b) => on.has(b));
  if (!same(listed, active)) throw new Unpackable("active is not in order");
  w.bit(1);
  for (let b = 1; b <= beats; b++) w.bit(on.has(b));
}
function readActive(r, beats) {
  if (beats > 4096) throw new Unpackable("the link is not a piece");
  if (!r.bit()) return ABSENT;
  if (!r.bit()) {
    const k = r.eg() + 1;
    const turn = r.uint(bitsFor(beats - 1));
    if (k > beats || turn >= Math.max(beats, 1)) throw new Unpackable("the link is not a piece");
    return euclid(k, beats, turn);
  }
  return Array.from({ length: beats }, (_, i) => (r.bit() ? i + 1 : 0)).filter(Boolean);
}

// A melody. `home` is where notes start from: 0 for notes, 1 for degrees.
function writeSequence(w, seq, chords, home) {
  if (!Array.isArray(seq) || seq.length === 0) throw new Unpackable("empty sequence");
  // One note, as all drum layers have.
  if (seq.length === 1 && seq[0] !== REST) {
    w.eg(0);
    return w.signed(seq[0] - home);
  }
  // A chord, up, down or up and back, starting anywhere.
  if (!seq.includes(REST) && seq.every(Number.isInteger)) {
    for (let c = 0; c < chords.length; c++) {
      for (let s = 0; s < SHAPES.length; s++) {
        const shape = SHAPES[s](chords[c]);
        const shift = seq[0] - shape[0];
        if (same(shape.map((x) => x + shift), seq)) {
          w.eg(1);
          w.eg(c);
          w.uint(s, 2);
          return w.signed(shift - home + chords[c][0]);
        }
      }
    }
  }
  // Note by note: each as a step from the last note (a rest is its own
  // symbol, and costs about as little as staying on the same note).
  w.eg(2);
  w.eg(seq.length - 1, 1);
  let last = home;
  for (const x of seq) {
    if (x === REST) {
      w.eg(1, 1);
      continue;
    }
    if (!Number.isInteger(x)) throw new Unpackable(`not a whole number: ${x}`);
    const step = x - last;
    w.eg(step === 0 ? 0 : step > 0 ? 2 * step : -2 * step + 1, 1);
    last = x;
  }
}
function readSequence(r, chords, home) {
  const how = r.eg();
  if (how === 0) return [r.signed() + home];
  if (how === 1) {
    const chord = chords[r.eg()];
    if (!chord) throw new Unpackable("the link is not a piece");
    const shape = SHAPES[r.uint(2)](chord);
    const shift = r.signed() + home - chord[0];
    return shape.map((x) => x + shift);
  }
  if (how !== 2) throw new Unpackable("the link is not a piece");
  const length = r.eg(1) + 1;
  if (length > 4096) throw new Unpackable("the link is not a piece");
  const seq = [];
  let last = home;
  for (let i = 0; i < length; i++) {
    const code = r.eg(1);
    if (code === 1) {
      seq.push(REST);
      continue;
    }
    last += code === 0 ? 0 : code % 2 === 0 ? code / 2 : -(code - 1) / 2;
    seq.push(last);
  }
  return seq;
}

// A gain: most are whole hundredths, many of them multiples of five.
function writeGain(w, gain) {
  if (gain === ABSENT) return w.eg(3);
  const hundredths = Math.round(gain * 100);
  if (hundredths / 100 === gain && hundredths % 5 === 0 && hundredths < 160) {
    w.eg(0);
    return w.uint(hundredths / 5, 5);
  }
  if (hundredths / 100 === gain && hundredths >= 0 && hundredths < 128) {
    w.eg(1);
    return w.uint(hundredths, 7);
  }
  w.eg(2);
  writeNumber(w, gain);
}
function readGain(r) {
  const how = r.eg();
  if (how === 0) return (r.uint(5) * 5) / 100;
  if (how === 1) return r.uint(7) / 100;
  if (how === 2) return readNumber(r);
  if (how === 3) return ABSENT;
  throw new Unpackable("the link is not a piece");
}

// Present, true or false: for click, mute and solo.
const FLAGS = [ABSENT, true, false];
const valueOr = (object, key) => (Object.hasOwn(object, key) ? object[key] : ABSENT);

const TOP_KEYS = ["tempo", "base", "bars", "click", "sample_rate", "scale", "root", "layer"];
const LAYER_KEYS = ["beats", "over", "notes", "degrees", "sample", "gain", "active", "scale", "root", "mute", "solo"];

// How many bars until every layer's pattern comes round together.
function repeatBars(layers) {
  return layers.reduce((all, l) => {
    const length = (l.notes ?? l.degrees).length;
    return lcm(all, (lcm(length, l.beats) / l.beats) * (l.over ?? 1));
  }, 1);
}

// --- The piece ----------------------------------------------------------------------

// The piece's spec as a list of bits, skeleton first. Throws Unpackable for
// a piece this format does not cover.
export function pack(spec) {
  const w = new Writer();
  for (const key of Object.keys(spec)) if (!TOP_KEYS.includes(key)) throw new Unpackable(`key ${key}`);
  const { tempo, base, bars, layer } = spec;
  if (tempo === undefined || base === undefined || bars === undefined || !Array.isArray(layer) || !layer.length) {
    throw new Unpackable("missing tempo, base, bars or layers");
  }
  // The skeleton.
  w.pick(tempo, TEMPOS, (t) => writeNumber(w, t));
  w.pick(base, BASES, (b) => w.eg(b));
  w.eg(layer.length - 1, 1);
  let previous;
  for (const l of layer) {
    for (const key of Object.keys(l)) if (!LAYER_KEYS.includes(key)) throw new Unpackable(`key ${key}`);
    if (Object.hasOwn(l, "notes") === Object.hasOwn(l, "degrees")) throw new Unpackable("notes or degrees");
    w.pick(l.sample, SAMPLES);
    w.pick(l.beats, likelyBeats(previous, base), (b) => w.eg(b));
    previous = l.beats;
    w.pick(valueOr(l, "over"), [ABSENT, 2, 3, 4], (o) => w.eg(o));
  }
  // The detail.
  w.pick(valueOr(spec, "click"), FLAGS);
  w.pick(valueOr(spec, "sample_rate"), [ABSENT, 44100, 48000], (n) => w.eg(n));
  w.pick(valueOr(spec, "scale"), [ABSENT, ...SCALE_NAMES]);
  w.pick(valueOr(spec, "root"), [ABSENT, 0], (n) => w.signed(n));
  for (const l of layer) {
    const degrees = Object.hasOwn(l, "degrees");
    w.bit(degrees);
    writeSequence(w, degrees ? l.degrees : l.notes, degrees ? DEGREE_CHORDS : NOTE_CHORDS, degrees ? 1 : 0);
    writeGain(w, valueOr(l, "gain"));
    writeActive(w, valueOr(l, "active"), l.beats);
    // The rarely used settings: one bit says whether any follow.
    const extras = ["scale", "root", "mute", "solo"].some((key) => Object.hasOwn(l, key));
    w.bit(extras);
    if (extras) {
      w.pick(valueOr(l, "scale"), [ABSENT, ...SCALE_NAMES]);
      w.pick(valueOr(l, "root"), [ABSENT, 12, -12, 0], (n) => w.signed(n));
      w.pick(valueOr(l, "mute"), FLAGS);
      w.pick(valueOr(l, "solo"), FLAGS);
    }
  }
  w.pick(bars, unique([repeatBars(layer), 8, 4, 16, 2, 1, 6, 12, 32]), (b) => w.eg(b));
  return w.bits;
}

// The spec packed into these bits. Throws Unpackable if they are not one
// (cut short, mangled); what comes back is still to be checked as a piece
// like any other.
export function unpack(bits) {
  const r = new Reader(bits);
  const tempo = r.pick(TEMPOS, () => readNumber(r));
  const base = r.pick(BASES, () => r.eg());
  const count = r.eg(1) + 1;
  if (count > 64) throw new Unpackable("the link is not a piece");
  const skeleton = [];
  for (let i = 0; i < count; i++) {
    const sample = r.pick(SAMPLES);
    const beats = r.pick(likelyBeats(skeleton.at(-1)?.beats, base), () => r.eg());
    const over = r.pick([ABSENT, 2, 3, 4], () => r.eg());
    skeleton.push({ sample, beats, over });
  }
  const click = r.pick(FLAGS);
  const sampleRate = r.pick([ABSENT, 44100, 48000], () => r.eg());
  const scale = r.pick([ABSENT, ...SCALE_NAMES]);
  const root = r.pick([ABSENT, 0], () => r.signed());
  const layer = skeleton.map(({ sample, beats, over }) => {
    // In the order a saved piece lists them.
    const l = { beats };
    if (over !== ABSENT) l.over = over;
    const degrees = r.bit();
    l[degrees ? "degrees" : "notes"] = readSequence(r, degrees ? DEGREE_CHORDS : NOTE_CHORDS, degrees ? 1 : 0);
    l.sample = sample;
    const gain = readGain(r);
    if (gain !== ABSENT) l.gain = gain;
    const active = readActive(r, beats);
    if (active !== ABSENT) l.active = active;
    if (r.bit()) {
      const extras = {
        scale: r.pick([ABSENT, ...SCALE_NAMES]),
        root: r.pick([ABSENT, 12, -12, 0], () => r.signed()),
        mute: r.pick(FLAGS),
        solo: r.pick(FLAGS),
      };
      for (const [key, value] of Object.entries(extras)) if (value !== ABSENT) l[key] = value;
    }
    return l;
  });
  const bars = r.pick(unique([repeatBars(layer), 8, 4, 16, 2, 1, 6, 12, 32]), () => r.eg());
  const spec = { tempo, base, bars };
  if (click !== ABSENT) spec.click = click;
  if (sampleRate !== ABSENT) spec.sample_rate = sampleRate;
  if (scale !== ABSENT) spec.scale = scale;
  if (root !== ABSENT) spec.root = root;
  spec.layer = layer;
  return spec;
}
