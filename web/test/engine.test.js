// Checks on the engine's rules, stated directly.
//
// parity.test.js proves the engine does what the Python version did. These
// say what that IS, in plain terms -- so the rules stay written down once the
// Python version is gone, and a deliberate change to one of them (rests, say)
// fails a check that names the rule rather than just a changed fingerprint.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { pieceToDerived, pieceToExport } from "../src/derive.js";
import { makeLayer } from "../src/layer.js";
import { divmod, roundHalfEven, roundTo, toFixedHalfEven } from "../src/numbers.js";
import { buildPiece } from "../src/piece.js";
import { finishMix, renderAudio } from "../src/render.js";
import { degreeToSemitones } from "../src/scales.js";
import {
  CLICK_DOWNBEAT, CLICK_SAMPLE, grid, schedule, STATUS_INACTIVE, STATUS_NOTE, STATUS_REST,
} from "../src/schedule.js";
import { formatSpec, readSpec, SpecError, upgradeSpec } from "../src/spec.js";
import { decodeWav, encodeWav16 } from "../src/wav.js";
import { fingerprint, LIBRARY, renderWav, WEB } from "./helpers.js";

const SAMPLES = LIBRARY.keys();
const piece = (spec) => buildPiece(spec, { samples: LIBRARY.keys() });
const refused = (spec, words) => assert.throws(() => piece(spec), (e) => e instanceof SpecError && e.message.includes(words));
// A piece-like object for grid() and schedule(), straight from layers.
const plain = (layers, bars, pulsesPerBar) => ({ layers, bars, pulsesPerBar });

// --- Arithmetic that must match Python -------------------------------------------

test("remainders of negative numbers round down, as Python's do", () => {
  assert.deepEqual(divmod(-1, 7), [-1, 6]);
  assert.deepEqual(divmod(-8, 7), [-2, 6]);
  assert.deepEqual(divmod(15, 7), [2, 1]);
});

test("halves round to the even neighbour", () => {
  assert.deepEqual([0.5, 1.5, 2.5, -0.5, -2.5, 2.4, 2.6].map(roundHalfEven), [0, 2, 2, 0, -2, 2, 3]);
  // 1/128 is exactly halfway between two 6-place decimals.
  assert.equal(toFixedHalfEven(1 / 128, 6), "0.007812");
  assert.equal(toFixedHalfEven(3 / 128, 6), "0.023438");
  assert.equal(roundTo(0.1 + 0.2, 6), 0.3);
});

test("scale degrees below 1 run downwards into the octave below", () => {
  assert.equal(degreeToSemitones(1, "major"), 0);
  assert.equal(degreeToSemitones(8, "major"), 12);
  assert.equal(degreeToSemitones(0, "major"), -1);   // the leading tone below
  assert.equal(degreeToSemitones(-6, "major"), -12);
});

// --- Timing -----------------------------------------------------------------------

test("the tempo and the base set the bar", () => {
  // 4 beats at 120 BPM is 2 seconds; 7 beats at 150 BPM is 2.8.
  const kick = { beats: 4, notes: [0], sample: "kick.wav" };
  assert.equal(piece({ tempo: 120, base: 4, bars: 1, layer: [kick] }).barDuration, 2);
  assert.equal(piece({ tempo: 150, base: 7, bars: 3, layer: [kick] }).barDuration, 2.8);
  // With neither given: 120 BPM, 4 beats to the bar.
  const p = piece({ bars: 1, layer: [kick] });
  assert.deepEqual([p.tempo, p.base, p.barDuration, p.click], [120, 4, 2, false]);
});

test("the base beats always land on the grid, so the click can sound on them", () => {
  // A lone 3-beat layer on a 4-beat base needs the bar in 12 pulses. An
  // older piece left the base out, and needed only 3.
  const three = { beats: 3, notes: [0], sample: "kick.wav" };
  assert.equal(piece({ bars: 1, layer: [three] }).pulsesPerBar, 12);
  assert.equal(piece({ loops: 1, layer: [three] }).pulsesPerBar, 3);
});

test("a layer's timing does not change when another layer is added", () => {
  // Adding a 5-beat layer subdivides the bar rather than stretching it. (A
  // real bug once, caught by ear.)
  const onsets = (layers) => {
    const p = piece({ tempo: 120, bars: 1, layer: layers });
    return schedule(p).filter((e) => e.layer === 0).map((e) => e.pulse * p.pulseDuration);
  };
  const kick = { beats: 4, notes: [0], sample: "kick.wav" };
  const alone = onsets([kick]);
  const withFive = onsets([kick, { beats: 5, notes: [0], sample: "hat.wav" }]);
  alone.forEach((t, i) => assert.ok(Math.abs(t - withFive[i]) < 1e-4, `beat ${i}: ${t} vs ${withFive[i]}`));
});

test("the grid has one cell per layer, bar and beat; the schedule is its notes", () => {
  const layers = [
    makeLayer({ beats: 3, notes: [0, null, 7, 5, 3], sample: "a" }),
    makeLayer({ beats: 4, notes: [2], sample: "b", active: [1, 3] }),
  ];
  const cells = grid(plain(layers, 2, 12));
  assert.equal(cells.length, 2 * (3 + 4));
  assert.equal(new Set(cells.map((c) => `${c.layer}/${c.bar}/${c.beat}`)).size, cells.length);
  assert.deepEqual(
    schedule(plain(layers, 2, 12)).map((e) => [e.layer, e.beat, e.pulse]),
    cells.filter((c) => c.status === STATUS_NOTE).map((c) => [c.layer, c.beat, c.pulse]),
  );
});

test("a rest travels with the sequence; a switched-off beat stays put", () => {
  // Rest at position 1 of 5 on a 3-beat layer: beats 1, 6 and 11 of the
  // piece, which are beat 1 of bar 0, beat 0 of bar 2, beat 2 of bar 3.
  const layers = [
    makeLayer({ beats: 3, notes: [0, null, 7, 5, 3], sample: "a" }),
    makeLayer({ beats: 4, notes: [2], sample: "b", active: [1, 3] }),
  ];
  const cells = grid(plain(layers, 4, 12));
  const rests = cells.filter((c) => c.layer === 0 && c.status === STATUS_REST).map((c) => [c.bar, c.beat]);
  assert.deepEqual(rests, [[0, 1], [2, 0], [3, 2]]);
  const off = cells.filter((c) => c.layer === 1 && c.status === STATUS_INACTIVE).map((c) => [c.bar, c.beat]);
  assert.deepEqual(off, [[0, 1], [0, 3], [1, 1], [1, 3], [2, 1], [2, 3], [3, 1], [3, 3]]);
});

test("a switched-off beat silences its note rather than shifting the melody", () => {
  const p = piece({ bars: 1, layer: [{ beats: 4, notes: [0, 12, 24, 36], sample: "pluck.wav", active: [1, 3] }] });
  assert.deepEqual(schedule(p).map((e) => e.semitones), [0, 24]);
  // Where a switched-off beat meets a rest, the switch wins: it is drawn as
  // switched off, not as a rest.
  const cells = pieceToDerived(piece({ bars: 1, layer: [{ beats: 2, notes: [0, "-"], sample: "kick.wav", active: [1] }] })).cells;
  assert.deepEqual(cells.map((c) => c.status), [STATUS_NOTE, STATUS_INACTIVE]);
});

// --- Layers over more than one bar ---------------------------------------------------

test("a layer over 2 bars spreads its beats evenly across both", () => {
  // 7 beats over 2 bars of 4: the bar is cut in 28 pulses (lcm of 7 and 4),
  // and the 7 beats fall 8 pulses apart -- 4 in the first bar, 3 in the next.
  const p = piece({ bars: 4, layer: [{ beats: 7, over: 2, notes: [0], sample: "pluck.wav" }] });
  assert.equal(p.pulsesPerBar, 28);
  const d = pieceToDerived(p);
  const firstSpan = d.cells.filter((c) => c.bar <= 2);
  assert.deepEqual(firstSpan.map((c) => c.pulse), [0, 8, 16, 24, 32, 40, 48]);
  assert.deepEqual(firstSpan.map((c) => c.bar), [1, 1, 1, 1, 2, 2, 2]);
  assert.deepEqual(firstSpan.map((c) => c.beat), [1, 2, 3, 4, 5, 6, 7]);
  // Beat 1 comes round at the start of bar 3, not bar 2.
  assert.deepEqual(d.cells.filter((c) => c.beat === 1).map((c) => c.bar), [1, 3]);
});

test("13 over 2 bars against 7 over 2 bars: only the downbeat of each span is shared", () => {
  const d = pieceToDerived(piece(JSON.parse(readFileSync(join(WEB, "examples", "spans.json"), "utf8"))));
  // Layers 1 (the 7) and 2 (the 13) meet only where both spans start.
  const meet = d.coincidences.filter((k) => k.layers.includes(1) && k.layers.includes(2));
  assert.deepEqual(meet.map((k) => k.bar), [1, 3, 5, 7]);
  assert.ok(meet.every((k) => k.offset === 0));
});

test("a layer that runs past the end of the piece stops part-way through its span", () => {
  // 3 bars of a layer over 2: one whole span, then half of the next.
  const d = pieceToDerived(piece({ bars: 3, layer: [{ beats: 4, over: 2, notes: [0], sample: "kick.wav" }] }));
  assert.equal(d.cells.length, 6);
});

// --- The click ------------------------------------------------------------------------

test("the click is off unless asked for, and sounds every base beat when on", () => {
  const spec = { tempo: 120, base: 3, bars: 2, layer: [{ beats: 2, notes: [0], sample: "kick.wav" }] };
  assert.equal(schedule(piece(spec)).filter((e) => e.sample === CLICK_SAMPLE).length, 0);
  const p = piece({ ...spec, click: true });
  const clicks = schedule(p).filter((e) => e.sample === CLICK_SAMPLE);
  assert.deepEqual(clicks.map((e) => e.pulse * p.pulseDuration), [0, 1, 2, 3, 4, 5].map((beat) => beat * 0.5));
  // Higher on beat 1 of each bar, so the bar can be heard.
  assert.deepEqual(clicks.map((e) => e.semitones), [CLICK_DOWNBEAT, 0, 0, CLICK_DOWNBEAT, 0, 0]);
  // It is sound only: the drawing's grid is the same either way.
  assert.deepEqual(pieceToDerived(p).cells, pieceToDerived(piece(spec)).cells);
});

test("the click needs its sample, and a switch for a value", () => {
  const spec = { bars: 1, click: true, layer: [{ beats: 2, notes: [0], sample: "kick.wav" }] };
  assert.throws(() => buildPiece(spec, { samples: ["kick.wav"] }), /unknown sample click.wav/);
  refused({ ...spec, click: "yes" }, "click must be true or false");
});

// --- Older pieces ---------------------------------------------------------------------

test("an older piece is upgraded to tempo, base and bars", () => {
  const layer = [{ beats: 4, notes: [0], sample: "kick.wav" }];
  assert.deepEqual(upgradeSpec({ cycle_duration: 2.2, loops: 6, layer }),
    { tempo: 109.091, base: 4, bars: 6, layer });
  // A pulse duration fixed the grid step: 4 pulses of 0.5 s is a 2 s bar.
  assert.deepEqual(upgradeSpec({ pulse_duration: 0.5, loops: 1, layer }), { tempo: 120, base: 4, bars: 1, layer });
  // With no timing at all, the old default: a 2-second bar.
  assert.deepEqual(upgradeSpec({ loops: 3, layer }), { tempo: 120, base: 4, bars: 3, layer });
  // A current piece is left exactly as it is.
  const current = { tempo: 90, bars: 2, layer };
  assert.equal(upgradeSpec(current), current);
});

test("an older piece and its upgrade sound identical when the tempo comes out exact", () => {
  const old = JSON.parse(readFileSync(join(WEB, "test", "fixtures", "legacy_examples", "tresillo.json"), "utf8"));
  assert.deepEqual(renderWav(upgradeSpec(old)).wav, renderWav(old).wav);
});

// --- Sound -------------------------------------------------------------------------

test("a note's tail wraps round to the start, so the loop has no click", () => {
  // One bell, near the end of a very short piece: its tail must reappear at
  // the start of the buffer rather than being cut off.
  const p = piece({ tempo: 600, bars: 1, layer: [{ beats: 4, notes: ["-", "-", "-", 0], sample: "bell.wav" }] });
  const mix = renderAudio(schedule(p), { ...p, library: LIBRARY });
  const start = mix.subarray(0, 1000).reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  assert.ok(start > 0.01, `start of the buffer is silent (peak ${start}); the tail did not wrap`);
});

test("an over-loud mix is clipped and its peak reported", () => {
  const { peak, mix } = finishMix(Float32Array.from([0.5, -1.7, 2.5]));
  assert.equal(peak, 2.5);
  assert.deepEqual([...mix], [0.5, -1, 1]);
});

test("WAV files survive a round trip, and stereo is averaged to mono", () => {
  const values = Float32Array.from([0, 0.5, -0.5, 0.25, -1, 0.999969482421875]);
  const back = decodeWav(encodeWav16(values, 44100));
  assert.equal(back.sampleRate, 44100);
  assert.deepEqual([...back.channels[0]], [...values]);

  // A hand-made stereo file: left 0.5, right -0.25, for two frames.
  const bytes = new Uint8Array(44 + 8);
  const view = new DataView(bytes.buffer);
  const text = (at, s) => [...s].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 44, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, 48000, true); view.setUint32(28, 192000, true); view.setUint16(32, 4, true);
  view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, 8, true);
  for (const at of [44, 48]) { view.setInt16(at, 16384, true); view.setInt16(at + 2, -8192, true); }
  const stereo = decodeWav(bytes);
  assert.equal(stereo.channels.length, 2);
  assert.equal(stereo.sampleRate, 48000);
  assert.deepEqual([...stereo.channels[1]], [-0.25, -0.25]);
});

// --- Specs ----------------------------------------------------------------------

test("a saved piece reads back in and renders identically", () => {
  const spec = JSON.parse(readFileSync(join(WEB, "examples", "rests.json"), "utf8"));
  const saved = JSON.stringify(pieceToExport(piece(spec)));
  const again = readSpec(saved, "saved.json");
  assert.deepEqual(again, spec);
  assert.equal(fingerprint(pieceToDerived(piece(again))), fingerprint(pieceToDerived(piece(spec))));
  assert.deepEqual(renderWav(again).wav, renderWav(spec).wav);
});

test("the example files are exactly what saving them would write", () => {
  for (const file of readdirSync(join(WEB, "examples"))) {
    const text = readFileSync(join(WEB, "examples", file), "utf8");
    assert.equal(formatSpec(JSON.parse(text)), text, file);
  }
});

test("reading refuses what it cannot use, saying why", () => {
  assert.throws(() => readSpec("{not json", "x.json"), /not valid JSON/);
  assert.throws(() => readSpec("[1, 2]", "x.json"), /expected a piece/);
  assert.throws(() => readSpec('{"format": "randaw-piece", "version": 99, "spec": {}}', "x.json"), /different version/);
});

test("the refusals a person is most likely to meet read clearly", () => {
  const layer = { beats: 3, notes: [0], sample: "kick.wav" };
  refused({ bars: 1, layer: [{ ...layer, sample: "kik.wav" }] }, "unknown sample kik.wav. This page has: bell.wav");
  refused({ bars: 1, layer: [layer], tempos: 2 }, "unknown setting(s) tempos");
  refused({ layer: [layer] }, "need bars");
  refused({ bars: 1, layer: [{ ...layer, notes: ["-"] }] }, "all rests");
  refused({ bars: 1, layer: [{ ...layer, active: [4] }] }, "active beat 4 is outside 1..3");
  refused({ bars: 1, layer: [{ ...layer, degrees: [1] }] }, "either notes or degrees, not both");
  refused({ bars: 1, tempo: 0, layer: [layer] }, "tempo must be > 0");
  refused({ bars: 1, base: 0, layer: [layer] }, "base must be at least 1");
  refused({ bars: 1, layer: [{ ...layer, over: 0 }] }, "over must be at least 1 bar");
  refused({ bars: 1, layer: [{ ...layer, over: 1.5 }] }, "over must be a whole number");
});

test("the same thing said in both the current and the older words is refused", () => {
  const layer = [{ beats: 3, notes: [0], sample: "kick.wav" }];
  refused({ loops: 1, cycle_duration: 2, pulse_duration: 0.1, layer }, "cycle_duration or pulse_duration, not both");
  refused({ bars: 1, tempo: 120, cycle_duration: 2, layer }, "give tempo, or the older");
  refused({ bars: 1, loops: 1, layer }, "give bars, or its older name loops, not both");
});

test("JavaScript's inherited names are not mistaken for real ones", () => {
  // Every JavaScript object quietly inherits properties like "toString" and
  // "constructor", and JSON can even name a key "__proto__". None of them
  // may pass for a scale, a setting or a layer field.
  const layer = { beats: 3, degrees: [1], sample: "kick.wav" };
  refused({ bars: 1, layer: [{ ...layer, scale: "constructor" }] }, 'unknown scale "constructor"');
  refused({ bars: 1, scale: "toString", layer: [layer] }, 'unknown scale "toString"');
  refused(JSON.parse('{"bars": 1, "__proto__": 1, "layer": [{"beats": 1, "notes": [0], "sample": "kick.wav"}]}'),
    "unknown setting(s) __proto__");
  assert.throws(() => buildPiece({ bars: 1, layer: [{ beats: 1, notes: [0], sample: "toString" }] }, { samples: SAMPLES }),
    /unknown sample toString/);
});

// --- How long a pattern takes to come round ------------------------------------------

test("each layer, and the whole piece, knows how many bars until it repeats", () => {
  // rests: pluck 7 positions on 5 beats, bell 3 on 3, kick 6 on 8, hat 1 on 8.
  const d = pieceToDerived(piece(JSON.parse(readFileSync(join(WEB, "examples", "rests.json"), "utf8"))));
  assert.deepEqual(d.layers.map((l) => l.repeat_bars), [7, 1, 3, 1]);
  assert.equal(d.repeat_bars, 21);
  // Over 2 bars, a pattern takes twice as many bars: 7 positions on 7 beats
  // is one span of 2 bars; 5 positions on 7 beats is 5 spans, 10 bars.
  const over2 = (seq) => pieceToDerived(piece({ bars: 1, layer: [{ beats: 7, over: 2, notes: seq, sample: "kick.wav" }] }));
  assert.equal(over2([0, 0, 0, 0, 0, 0, 0]).repeat_bars, 2);
  assert.equal(over2([0, 0, 0, 0, 0]).repeat_bars, 10);
});

// --- Mute and solo -------------------------------------------------------------------

const band = (extra = {}) => ({
  bars: 1,
  layer: [
    { beats: 3, notes: [0], sample: "kick.wav", ...extra.a },
    { beats: 4, notes: [0], sample: "hat.wav", ...extra.b },
    { beats: 2, notes: [0], sample: "tom.wav", ...extra.c },
  ],
});
const sounding = (spec) => {
  const p = piece(spec);
  return [...new Set(schedule(p).map((e) => e.layer))];
};

test("a muted layer is silent but still drawn", () => {
  const spec = band({ b: { mute: true } });
  assert.deepEqual(sounding(spec), [0, 2]);
  const d = pieceToDerived(piece(spec));
  assert.equal(d.cells.filter((c) => c.layer === 1).length, 4, "the muted layer's beats are still in the grid");
  assert.deepEqual(d.layers.map((l) => l.audible), [true, false, true]);
});

test("solo silences every layer that is not soloed, and wins over mute", () => {
  assert.deepEqual(sounding(band({ c: { solo: true } })), [2]);
  assert.deepEqual(sounding(band({ a: { solo: true }, c: { solo: true } })), [0, 2]);
  assert.deepEqual(sounding(band({ a: { mute: true, solo: true } })), [0]);
});

test("only layers you can hear count as sounding together", () => {
  // Kick (3) and hat (4) meet only on the downbeat; the tom (2) meets the hat
  // on beat 3 as well. Muting the hat leaves kick and tom on the downbeat.
  const layersAt = (spec) => pieceToDerived(piece(spec)).coincidences.map((k) => k.layers);
  assert.deepEqual(layersAt(band()), [[0, 1, 2], [1, 2]]);
  assert.deepEqual(layersAt(band({ b: { mute: true } })), [[0, 2]]);
});

test("a muted layer is left out of the downloaded audio", () => {
  const alone = renderWav({ bars: 1, layer: [{ beats: 3, notes: [0], sample: "kick.wav" }] }).wav;
  const muted = renderWav(band({ b: { mute: true }, c: { mute: true } })).wav;
  assert.deepEqual(muted, alone);
});

test("mute and solo must be true or false", () => {
  refused(band({ a: { mute: "yes" } }), "mute must be true or false");
  refused(band({ a: { solo: 1 } }), "solo must be true or false");
});
