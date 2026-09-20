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

## Phase 3 — Beat skipping (arc item 2)

**Goal.** A layer declares which of its own beats sound: a 13-beat layer
firing only on 3, 5, 8. A filter over the layer's own beat index,
independent of other layers.

**Why here.** First genuinely new musical capability, and after phase 2 it
is close to a one-line filter on the event list. Good proof the split paid
for itself.

**Done when.** Sparse patterns render correctly and the skipped beats are
audibly absent without shifting anything else in time.

**Open.** Whether skipping is a list of active beats, a list of skipped
beats, or a pattern string like `x..x.x..`. The pattern string is the most
readable at a glance and the most musician-ish.

---

## Phase 4 — Config file

**Goal.** Drive renders from a file. Keep the CLI for quick one-offs.

**Why here.** By now a layer has beats, notes, sample(s), gain and a skip
pattern, with scales and sample sets immediately after. `--layer
"4:1,3,5,6:scale=dorian:samples=a.wav,b.wav:gain=0.7:skip=x..x"` is already
past readable. A config file is also the natural save format for the
eventual GUI and the thing you would version or share.

**Done when.** A config renders identically to the equivalent CLI call, and
the file is pleasant to hand-edit.

**Open.** Format. TOML reads via stdlib `tomllib` (no new dependency) and is
nice to hand-write; JSON reads *and writes* via stdlib, which matters if a
GUI must save; YAML is friendliest but needs a dependency. Leaning JSON for
round-tripping, TOML for authoring — possibly read both.

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
