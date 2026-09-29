// Checks on the engine's rules, stated directly.
//
// answers.test.js catches any change at all to what the engine makes. These
// say what it SHOULD make, in plain terms -- so a deliberate change to a rule
// (rests, say) fails a check that names the rule rather than just a changed
// fingerprint, and a change meant to improve the sound can be judged by them.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { pieceToDerived, pieceToExport } from "../src/derive.js";
import { makeLayer } from "../src/layer.js";
import { divmod, roundHalfEven, roundTo, toFixedHalfEven } from "../src/numbers.js";
import { buildPiece } from "../src/piece.js";
import { pitchShift, prepareSample, resampleLinear } from "../src/audio.js";
import { finishMix, renderAudio } from "../src/render.js";
import { degreeToSemitones } from "../src/scales.js";
import {
  CLICK_DOWNBEAT, CLICK_SAMPLE, grid, schedule, STATUS_INACTIVE, STATUS_NOTE, STATUS_REST,
} from "../src/schedule.js";
import { formatSpec, readSpec, SpecError, upgradeSpec } from "../src/spec.js";
import { decodeWav, encodeWav16, toInt16 } from "../src/wav.js";
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

test("a file is exactly as long as its bars at its tempo, so it loops in time with a DAW", () => {
  // 13 over 2 bars against 7 over 2 at 100 BPM: 364 pulses per bar, which
  // do not divide a 2.4 s bar's 105,840 samples. Timed on a whole-sample
  // pulse grid (as older pieces are) the 8 bars came out 15 ms long.
  const spec = JSON.parse(readFileSync(join(WEB, "examples", "spans.json"), "utf8"));
  const { piece: p, wav } = renderWav(spec);
  assert.equal(p.totalSamples, 8 * 2.4 * 44100);
  assert.equal(decodeWav(wav).channels[0].length, 8 * 2.4 * 44100);
  assert.equal(p.totalDuration, 19.2);
  assert.equal(p.barDuration, 2.4);
  // A tempo whose bar is not a whole number of samples: the file is rounded
  // once, to the nearest sample, rather than a little on every pulse.
  const odd = piece({ tempo: 109.091, bars: 7, layer: [{ beats: 5, notes: [0], sample: "kick.wav" }] });
  assert.equal(odd.totalSamples, Math.round((7 * 4 * 60 * 44100) / 109.091));
});

test("every example loops on its whole pattern, not part-way through it", () => {
  // An example is the first thing a person hears; its WAV should loop the
  // way the tool means loops to work.
  for (const file of readdirSync(join(WEB, "examples"))) {
    const p = piece(JSON.parse(readFileSync(join(WEB, "examples", file), "utf8")));
    const { repeat_bars: repeat } = pieceToDerived(p);
    assert.equal(p.bars % repeat, 0, `${file}: ${p.bars} bars of a pattern that repeats every ${repeat}`);
  }
});

test("every note starts on the sample nearest its exact time", () => {
  // A one-sample click as the sound, so each note shows up in the mix as a
  // single non-zero sample exactly where it was placed.
  const library = new Map([["tick.wav", { channels: [new Float32Array([1])], sampleRate: 44100 }]]);
  const layers = [7, 13, 5, 11].map((beats, i) => ({ beats, over: 1 + (i % 2), notes: [0], sample: "tick.wav" }));
  const p = buildPiece({ tempo: 97, bars: 4, layer: layers }, { samples: ["tick.wav"] });
  const mix = renderAudio(schedule(p), { ...p, library });
  const events = schedule(p);
  for (const e of events) {
    const exact = (e.pulse / p.totalPulses) * p.totalDuration * p.sampleRate;
    const at = Math.round(exact);
    assert.ok(Math.abs(at - exact) <= 0.5);
    assert.ok(mix[at] >= 1, `layer ${e.layer} beat ${e.beat}: nothing at sample ${at}`);
  }
  // Nothing anywhere else: each non-zero sample is one of those notes.
  const placed = new Set(events.map((e) => Math.round((e.pulse / p.totalPulses) * p.totalSamples)));
  mix.forEach((value, i) => { if (value !== 0) assert.ok(placed.has(i), `stray sound at sample ${i}`); });
});

test("a very fine grid keeps its tempo instead of collapsing", () => {
  // 3, 4, 5, 7, 11 and 13 need 60,060 pulses in a 2 s bar -- under 1.5
  // samples each. On a whole-sample grid that rounded down to 1 and shrank
  // the bar to 1.36 s; placing beats at their exact times has no such limit.
  const layer = [3, 4, 5, 7, 11, 13].map((beats) => ({ beats, notes: [0], sample: "hat.wav" }));
  const p = piece({ tempo: 120, bars: 2, layer });
  assert.equal(p.pulsesPerBar, 60060);
  assert.equal(p.totalDuration, 4);
  assert.deepEqual(p.warnings, []);
});

test("the base beats always land on the grid, so the click can sound on them", () => {
  // A lone 3-beat layer on a 4-beat base needs the bar in 12 pulses.
  const three = { beats: 3, notes: [0], sample: "kick.wav" };
  assert.equal(piece({ bars: 1, layer: [three] }).pulsesPerBar, 12);
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

test("a layer following its hits plays every note in turn, whatever beats are off", () => {
  const spec = (follow) => ({ bars: 2, layer: [{ beats: 4, notes: [0, 12, 24], sample: "pluck.wav", active: [1, 2, 4], follow }] });
  // Following beats, the 24 falls on switched-off beat 3 in the first bar,
  // and on the 0 in the second: each time, that note is simply lost.
  assert.deepEqual(schedule(piece(spec("beats"))).map((e) => e.semitones), [0, 12, 0, 12, 24, 12]);
  // Following hits, the three notes run on over the three hits of each bar.
  assert.deepEqual(schedule(piece(spec("hits"))).map((e) => e.semitones), [0, 12, 24, 0, 12, 24]);
  // A switched-off beat shows the note it would play if switched back on:
  // the next one due.
  const off = grid(piece(spec("hits"))).filter((c) => c.status === STATUS_INACTIVE);
  assert.deepEqual(off.map((c) => [c.bar, c.position, c.semitones]), [[0, 2, 24], [1, 2, 24]]);
});

test("a rest still takes its turn when a layer follows its hits", () => {
  const spec = { bars: 1, layer: [{ beats: 4, notes: [0, "-", 7], sample: "pluck.wav", active: [1, 3, 4], follow: "hits" }] };
  const cells = grid(piece(spec));
  assert.deepEqual(cells.map((c) => c.status), [STATUS_NOTE, STATUS_INACTIVE, STATUS_REST, STATUS_NOTE]);
  assert.deepEqual(cells.map((c) => c.position), [0, 1, 1, 2]);
});

test("with every beat on, following hits sounds exactly like following beats", () => {
  const spec = JSON.parse(readFileSync(join(WEB, "examples", "scales.json"), "utf8"));
  const hits = { ...spec, layer: spec.layer.map((l) => (l.active ? l : { ...l, follow: "hits" })) };
  assert.equal(fingerprint(renderWav(hits).wav), fingerprint(renderWav(spec).wav));
});

test("follow must be beats or hits", () => {
  refused({ bars: 1, layer: [{ beats: 4, notes: [0], sample: "kick.wav", follow: "notes" }] }, 'follow must be "beats" or "hits"');
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

test("an older piece plays once upgraded, and is refused if it cannot be", () => {
  // tresillo as it was saved before phase 12.
  const old = {
    cycle_duration: 2.0, loops: 8,
    layer: [
      { beats: 8, notes: [0], sample: "kick.wav", gain: 0.75, active: [1, 4, 7] },
      { beats: 3, notes: [0], sample: "hat.wav", gain: 0.2 },
    ],
  };
  // The engine reads only today's words; upgrading gives the same piece.
  refused(old, "cycle_duration is an older setting");
  const p = piece(upgradeSpec(old));
  assert.deepEqual([p.tempo, p.bars, p.barDuration], [120, 8, 2]);
  // An older setting that makes no sense is left for the engine to refuse,
  // saying what to write instead.
  refused({ ...old, cycle_duration: 0 }, 'cycle_duration is an older setting, and 0 cannot be turned into today\'s; give "tempo"');
  refused(upgradeSpec({ ...old, cycle_duration: 0 }), "cycle_duration is an older setting");
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

// --- The sound --------------------------------------------------------------------
//
// What correct sound IS, stated directly, so that a better resampler or
// encoder can be judged against these rather than against the old bytes.

// A sine tone: `seconds` long, at `hz`, sampled at `rate`.
const tone = (hz, seconds = 1, rate = 44100) =>
  Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));

// A tone's pitch, measured: count its upward zero crossings, placing each
// exactly by drawing a line between the samples either side of it.
function measureHz(sound, rate = 44100) {
  const crossings = [];
  for (let i = 1; i < sound.length; i++) {
    if (sound[i - 1] < 0 && sound[i] >= 0) crossings.push(i - 1 + -sound[i - 1] / (sound[i] - sound[i - 1]));
  }
  return ((crossings.length - 1) * rate) / (crossings.at(-1) - crossings[0]);
}
// How far apart two pitches are, in cents: hundredths of a semitone.
const cents = (a, b) => 1200 * Math.log2(a / b);

test("a pitch shift of 0 leaves the sound exactly as it was", () => {
  const a = tone(440, 0.1);
  assert.equal(pitchShift(a, 0), a);
});

test("pitch shifts land within a cent of equal temperament", () => {
  const a = tone(440);
  for (const semitones of [-12, -5, -1, 1, 7, 12, 19]) {
    const want = 440 * 2 ** (semitones / 12);
    const got = measureHz(pitchShift(a, semitones));
    assert.ok(Math.abs(cents(got, want)) < 1, `${semitones}: ${got.toFixed(2)} Hz, wanted ${want.toFixed(2)}`);
  }
});

test("pitch and length move together, like changing a record's speed", () => {
  const a = tone(440);  // 44100 samples
  assert.equal(pitchShift(a, 12).length, 22050);
  assert.equal(pitchShift(a, -12).length, 88200);
  assert.equal(pitchShift(a, 7).length, Math.round(44100 / 2 ** (7 / 12)));
});

test("resampling keeps a straight line straight and starts where the sound starts", () => {
  const ramp = Float32Array.from({ length: 101 }, (_, i) => i / 100);
  for (const length of [51, 150, 333]) {
    const out = resampleLinear(ramp, length);
    assert.equal(out.length, length);
    assert.equal(out[0], 0);
    // Position i of the new sound sits at i/length of the way along, where
    // the ramp's value is (i/length) x 1.01 -- as long as it is inside it.
    for (let i = 0; i < length; i++) {
      const want = Math.min(1, (i / length) * 1.01);
      assert.ok(Math.abs(out[i] - want) < 1e-6, `${length}: position ${i} is ${out[i]}, wanted ${want}`);
    }
  }
});

test("a sample recorded at another rate keeps its pitch and length", () => {
  const at48k = { channels: [tone(1000, 1, 48000)], sampleRate: 48000 };
  const ready = prepareSample(at48k, 44100);
  assert.equal(ready.length, 44100);
  assert.ok(Math.abs(cents(measureHz(ready), 1000)) < 1);
});

test("notes at the same moment add together, each scaled by its layer's gain", () => {
  const library = new Map([["one.wav", { channels: [new Float32Array([1, 0.5])], sampleRate: 44100 }]]);
  const events = [
    { pulse: 0, semitones: 0, sample: "one.wav", gain: 0.25 },
    { pulse: 0, semitones: 0, sample: "one.wav", gain: 0.5 },
    { pulse: 1, semitones: 0, sample: "one.wav", gain: 1 },
  ];
  const mix = renderAudio(events, { totalPulses: 2, totalSamples: 4, sampleRate: 44100, library });
  assert.deepEqual([...mix], [0.75, 0.375, 1, 0.5]);
});

test("16-bit samples: silence is 0, full scale is the extremes, and nothing is off by more than a step", () => {
  assert.deepEqual([0, 0.5, -0.5, 1, -1, 2, -2].map(toInt16), [0, 16384, -16384, 32767, -32768, 32767, -32768]);
  // The rule: round down to the step below, except that a value within
  // 2^-17 of a step counts as reaching it (see wav.js for why).
  assert.equal(toInt16(1 / 32768), 1);
  assert.equal(toInt16(1 / 32768 - 2 ** -33), 1);
  assert.equal(toInt16(1 / 32768 - 2 ** -30), 0);
  // Any value survives writing and reading back to within one step.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const values = Float32Array.from({ length: 20000 }, random);
  const back = decodeWav(encodeWav16(values, 44100)).channels[0];
  values.forEach((v, i) => assert.ok(Math.abs(back[i] - v) < 1 / 32768, `${v} came back as ${back[i]}`));
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
  // Following hits, the sequence moves on only as many positions a span as
  // beats sound: 6 positions on 4 beats is 3 bars; with 3 of the 4 on, 2.
  const hits = (follow, active) => pieceToDerived(piece({
    bars: 1, layer: [{ beats: 4, notes: [0, 1, 2, 3, 4, 5], sample: "pluck.wav", active, follow }],
  })).repeat_bars;
  assert.equal(hits("beats", [1, 2, 3]), 3);
  assert.equal(hits("hits", [1, 2, 3]), 2);
  assert.equal(hits("hits", [1, 2, 3, 4]), 3);
  // With no beat on at all, nothing moves: the pattern is one span long.
  assert.equal(hits("hits", []), 1);
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
