# Phase Plan

Sequencing for the capability arc in VISION.md. Each phase aims to be small
enough to finish, and to end with something you can listen to or inspect.
Phases after the next one or two are sketches — expect them to move.

PHASE1_SPEC.md remains the spec for phase 1 as originally written.

---

## Phase 1 — Two-layer polyrhythm — DONE

N layers (tested to 3), semitone note sequences phasing against beat counts,
one sample per layer, per-layer gain, LCM-exact render length, tails that
wrap so renders loop without a click.

Verified by `qa_check.py`: onsets land 0 samples from the ideal
`t = (cycle + j/B) × T` model, pitch shifts within 1 cent.

Outstanding: nobody has run this with real samples yet. That is the honest
test of "audibly overlaid correctly".

---

## Phase 2 — Split the schedule from the audio — DONE

`polyrhythm/schedule.py` builds the event list; `render_audio()` turns it
into sound and knows nothing about layers, beat counts or polyrhythm.

```
schedule(layers, loops) -> list[Event]   # Event: layer, pulse, semitones, sample, gain
render_audio(events, total_pulses, samples_per_pulse, sample_rate) -> np.ndarray
```

`schedule.py` imports no audio library at all, which is the property that
makes it useful to a visualiser or MIDI exporter. `--dump-schedule` prints
the event list.

**Verification.** Six of seven reference renders came back byte-identical.
The seventh differed on 1 sample in 529,200, by one 16-bit LSB (-90 dBFS),
because sorting events into time order changed the order of float32
additions and one sum landed the other side of a rounding boundary. Kept
the sort: time-ordered events are the right contract, and drift will force
re-sorting anyway. Worth knowing that "byte-identical" is a strong check
but floating-point addition is not associative, so a refactor that reorders
sums will not always survive it.

The schedule now has its own checks rather than being inferred from audio.

**Settled.** Time stays in integer pulses internally — it is exact and it is
where the zero-drift property comes from — and converts to seconds at the
boundary, as `--dump-schedule` does.

---

## Phase 3 — Beat skipping (arc item 2) — DONE

`active=` on a layer lists which of its own beats sound, counting from 1:
`--layer 13:0:tom.wav:active=3,5,8`. Omitted means all of them.

Active beats rather than a pattern string, partly because a pattern carries
its own length which could disagree with the declared beat count — two
sources of truth for one fact — and partly because `active=3,5,8` beats
counting the dots in `..x.x..x.....`.

As predicted, the renderer needed no changes at all: the whole feature is
one `if` clause on the comprehension in `schedule()`. The rest of the work
was parsing and validation.

**Settled.** A note belongs to its beat position, so silencing a beat
silences that note rather than sliding the next one forward. See NOTES.md,
which also records the alternative in case the sparse melodies want it.

**Also landed.** `--layer` now takes `key=value` options in any order, since
`gain=` was no longer the only one. This is the CLI starting to creak
exactly where phase 4 predicted it would.

---

## Phase 4 — Config file — DONE

`--config groove.toml` drives a whole piece from a file. Anything also given
on the command line overrides it, so `--loops 1` previews without editing.
`configs/` holds the four grooves as working examples.

**Settled: TOML.** `tomllib` is in the standard library from Python 3.11, so
no new dependency, and TOML carries comments — which matters a lot for a file
you tweak by ear (`active = [1, 4, 7]  # tresillo`). The cost is that tomllib
only reads; if a GUI ever needs to save these, that wants either a small
writer dependency or a hand-rolled one. JSON would have given free writing
but no comments, which is the wrong trade while a human is the only author.

**Settled: paths resolve relative to the config file**, not the shell, so a
config and its samples travel together.

**Verification.** All four example configs render byte-identical to the
command lines that produced the same grooves.

**Also landed.** `make_layer()` now holds every layer validation rule, shared
by the CLI parser and the config loader, so the two front ends cannot drift
apart. That refactor is what makes a third front end cheap.

**Note.** Python 3.11+ is now a hard requirement, for `tomllib`.

---

## Phase 5 — Scales and keys (arc item 6)

**Goal.** Notes as scale degrees against a named scale and key, so swapping
the scale re-harmonises a layer without rewriting its notes. Raw semitones
stay available for percussion.

**Why here.** Highest musical payoff per line of code, and much more
pleasant to drive from a config file than a CLI string. Needs phase 4 first
for that reason.

**Done when.** The same layer sounds coherently different across scales, and
degrees and semitones can coexist across layers in one piece.

**Open.** Degrees are 1-indexed as musicians count them (your `1,3,5,6`).
What degree 8+ means — almost certainly the octave above degree 1. Whether
key/scale is per-layer, global with per-layer override, or both.

---

## Phase 6 — Sample sets per layer (arc item 5)

**Goal.** A layer holds several samples; each beat selects one, cycling
independently like the note sequence.

**Why here.** Needs the config file. Cheap after phase 2 — an event already
names its sample, so this mostly changes which one gets named.

**Done when.** A single layer plays different samples across its beats, and
a sample list whose length is coprime with the beat count phases against it.

**Note.** This adds a third phasing dimension — sample sequence against note
sequence against beat count. Probably delightful, possibly chaotic. Worth
listening to before deciding it is a feature.

---

## Phase 7 — Drift (arc item 3)

**Goal.** Layers that slowly fall out of phase instead of repeating exactly.

**Why here.** Deliberately after the length guard and the config file,
because drift is where the fixed-length-vs-streaming fork has to be settled
for real, and by then there will be actual experience to settle it with.

**Open.** The fork itself. Drift inside a fixed render is a transform on
event times. Drift as an endless process is a different program shape.
Do not start this phase without deciding which.

---

## Phase 8 — Per-layer effects (arc item 4)

**Goal.** Envelope/ADSR, filtering, reverb applied per layer before mixdown.

**Why here.** Effects need per-layer audio buffers, which phase 1
deliberately does not keep (a redundant buffer was removed during QA — the
right call then, and this is the phase that legitimately brings it back).

Start with envelope: it is the cheapest and fixes the bluntest thing about
the current sound, which is that every beat plays the whole sample flat.

**Open.** Reverb almost certainly means a new dependency or a hand-rolled
convolution. Ask first.

---

## Phase 9 — MIDI export

**Goal.** Write the schedule as MIDI instead of audio.

**Why here.** Could be pulled forward cheaply — after phase 2 the schedule
is most of the work, and pitch is already in semitones. Placed late only
because the audio path is where the listening happens.

**Open.** `mido` vs `pretty_midi` — a new dependency either way. How scale
degrees map to MIDI note numbers (a key/root has to become a concrete
pitch).

---

## Phase 10 — Web GUI and visualiser (arc item 7)

**Goal.** A browser view where shapes move in time with the layers, and
edits re-render.

**Shape, from the phase 2 measurements.** No real-time audio engine is
needed. Send the schedule as JSON and let the browser animate from it
against playback position of a pre-rendered WAV. Renders are 7–30 ms, so
recalculate-and-push is comfortably interactive.

The real constraint is not compute but output size: the coprime worst case
renders in 173 ms but produces a ~50 MB file. The phase 2 length guard is
what keeps that from reaching the browser.

**Open.** Web framework choice — a new dependency, so ask. Whether the GUI
edits config files directly or owns its own state and exports.

---

## Cross-cutting, not phased

- **Real samples.** Everything so far is verified with synthetic test tones.
- **Known limitations** — aliasing on large upward shifts, mono-only,
  hand-set levels — are recorded in NOTES.md with measurements.
- **`qa_check.py` grows with each phase.** It is currently the largest file
  in the project, which is the correct shape for something whose output is
  judged by ear.
