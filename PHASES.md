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

## Phase 5 — Scales and keys (arc item 6) — DONE

A layer states pitches as `notes` (semitones) OR `degrees` (against a named
scale). `configs/scales.toml` re-harmonises on one word.

```toml
scale = "dorian"       # global default
[[layer]]
degrees = [1, 3, 5, 8]
```

14 scales in `polyrhythm/scales.py`: the seven modes, two altered minors,
two pentatonics, blues, whole tone, chromatic.

**Settled: two fields, not one that changes meaning.** Had `notes` been
reinterpreted as degrees whenever a scale was present, adding a global scale
would silently have rewritten every drum layer's numbers. Separate fields
make a semitone layer provably immune, which is checked.

**Settled: `root` is a semitone offset, not a key name.** These are pitch
shifts applied to a sample whose own pitch is unknown, so calling something
"the key of D" would be a fiction. Naming keys honestly needs samples to
declare their natural pitch — a backlog item, not this phase.

**Settled: degrees are 1-based**, consistent with active beats. Degree 8 is
the octave above degree 1, and degrees below 1 run downwards — degree 0 is
one step under the root. Both fall out of Python's floor division rather
than needing a special case.

**Verification.** Degrees resolve to semitones at the layer boundary, so
nothing downstream knows scales exist: `degrees=1,3,5,8:scale=major` renders
byte-identically to `notes=0,4,7,12`, and all seven older reference renders
plus the four phase-4 configs are unchanged.

---

## Phase 6 — Rests — DONE

Replaced the planned sample-sets phase, which moved to the backlog.

`"-"` in a note or degree sequence sounds nothing there. `configs/rests.toml`
demonstrates it.

**Why this instead.** Listening to the phase 5 examples surfaced a real gap:
silence could only be expressed with `active=`, which is a fixed per-cycle
beat filter. There was no way to put a rest *in a sequence*, and a rest in a
sequence behaves quite differently — it travels, landing on a different beat
each cycle whenever the sequence and the beat count are different lengths.

**Settled: a marker, not a number.** 0 already means unison in semitones and
one step below the root as a degree, so neither notation had a spare value.
`"-5"` stays minus five; only an exact `"-"` is a rest.

**Also settled: sample sets are not worth their complexity.** Making
`samples` a third independently cycling list would give a layer three
periods — 4 beats, 12 notes, 5 samples repeats every 15 cycles, which is
unauthorable. One sample per layer, pitch-shifted, remains the model. If it
ever returns, the list should be tied to the pitch sequence's length so the
layer keeps a single period.

**Also worth recording:** the per-beat "drummer's notation" and the phasing
notation turned out to be the same model, not rival ones. A sequence whose
length matches the beat count is a composed pattern; a different length
phases. No new mechanism was needed for the former.

`schedule()` went from a comprehension to explicit loops in the process — two
separate reasons to skip a beat made the filter harder to read than the loop
it replaced. Verified byte-identical across all seven reference renders.

---

## Re-planned: get to a GUI sooner

Decided after the first session. The bottleneck on everything else is the
feedback loop — editing TOML, running the CLI and opening a WAV is slow, and
several open questions (rest behaviour, what sections should do, whether the
phasing is musically useful) are far easier to answer by *seeing* the thing
than by reasoning about it.

So drift, effects and MIDI move back, and two small prerequisites plus the
GUI itself move forward. Sections moves ahead of drift but stays behind the
GUI, because the GUI makes designing it much easier.

The visualiser was always arc item 7 in VISION.md, so this is a resequencing
rather than a change of scope.

---

## Phase 7 — Spec and Piece

*Revised after a critical review of the first draft — see "Why the plan
changed" below.*

**Goal.** Separate what the user *wrote* from what gets *rendered*, and move
both out of `generate.py`'s `main()`.

- **Spec** — what the user wrote: degrees, scale, root, 1-based active beats,
  rests as `"-"`. A plain dict in the TOML schema. TOML and JSON become two
  serialisations of the same spec. CLI `--layer` strings convert into the
  same shape, so there is one path, not two.
- **Piece** — what gets rendered: resolved semitones, 0-based indices,
  `samples_per_pulse`, derived timing. Built by `build_piece(spec)`, which
  raises `PieceError` and returns warnings as data rather than printing them,
  because a GUI does not want stdout.

`generate.py` becomes: argparse → spec (CLI merged over file) → `build_piece`
→ `schedule` → `render_audio` → write.

**Settled.** `Piece` is single-pattern and is *not* pre-shaped for sections.
A section is meant to be an override, not a re-declaration, so a list of
Piece-shaped sections would be the wrong shape anyway. `max_duration` stays
with the caller, since it is policy rather than maths.

**Done when.** The reference renders are byte-identical, and a spec survives
TOML → dict → JSON → dict unchanged.

---

## Phase 8 — The grid

**Goal.** A view of the piece that includes the silences.

One internal loop yields **every** cell — each layer × cycle × beat — with a
status (`note`, `rest`, `inactive`), its pitch, and a label (what the user
wrote there: a degree for degree layers, a semitone for note layers).
`schedule()` keeps only the notes, so its output is unchanged. The grid keeps
everything. One loop feeding both, so the logic is not duplicated.

`Event` gains `beat`. JSON output carries the spec (the half that round-trips)
plus the derived timing, layer metadata and cells (the half that doesn't).

**Done when.** `schedule()` output is byte-identical to before; every layer ×
cycle × beat has exactly one cell; rests and inactive beats appear as cells;
the spec round-trips.

---

## Phase 9 — Static visualiser

**Goal.** `--visualise out.html`: one self-contained file with the grid and
the audio inlined. Open, press play, watch and listen.

**Purpose.** To see the whole piece: every note, rest and inactive beat, and
above all *where they fall relative to each other* across layers. The
cross-layer alignment is the point, not a side effect.

**Shape: step notation, not rings.** One row per layer. Each row spans one
cycle and is divided into that layer's beats, so columns line up in *time*:
a 3-row and a 4-row meet only on the downbeat, which is the polyrhythm made
visible — the same property the rings had, in a form that reads like drummer
notation. Several cycles side by side, so phasing and travelling rests show
up as visible patterns across bars.

**Relative placement is made explicit.** A playhead runs down through every
row at once. Where two or more layers sound on the same instant, a faint
vertical line joins them, so coincidences and near-misses read at a glance.

**Cells.** Degree layers show the degree number; drum layers whose notes are
all 0 show a hit mark `x`; other semitone layers show the number. Rests get a
rest symbol; inactive beats are dimmed and empty, so the two kinds of silence
look different.

**Pitch as height.** Each mark sits higher or lower within its row by pitch,
so melodic contour reads as a shape, the way it would on a stave. The range is
per layer — each layer's lowest and highest pitch span its own row — because a
shared range would flatten a narrow melody next to a wide one. Drum layers stay
flat.

**A window of four cycles** that pages with playback, rather than the whole
render. Horizontal density is the real limit: a 16-beat layer across 8
cycles is 128 cells, about 11 px each on a laptop — too narrow for a number.

**Layer cap: 5, in the visualiser only, and it refuses rather than
truncates** — a layer you can hear but not see would make the page
untrustworthy. VISION.md forbids a layer limit in the core data model, so
`Piece`, `Layer` and the renderer stay unlimited. The cap is one constant and
one check, with row layout computed from the layer count rather than
hard-coded, so lifting it is a one-line change.

**No musical logic in JavaScript.** Python produces the fully resolved grid;
the page only draws it. Otherwise the scheduling would be reimplemented in a
second language, untested — and every rule stays checkable in `qa_check.py`.
It also keeps the JavaScript small, which matters in a learning project that
is about to gain a second language.

**Playback through the Web Audio API, not `<audio loop>`.** The HTML audio
element leaves an audible gap at the loop point in most browsers; a looped
Web Audio buffer is sample-accurate. For a tool whose entire output is loops
— and which fixed a loop click in phase 1 — this is not optional. Animation is
driven from the audio clock, never a separate timer.

**Plain HTML, SVG and JavaScript.** No framework, no build step, no CDN, so
it works offline and there is nothing to install. Commented to the same
standard as the Python.

**`?t=3.2` renders a still frame at that moment.** Useful for linking to a
spot, and it is what makes the page verifiable here: headless Chromium, no
new dependency. It needs `--headless=new` plus render-wait flags — the naive
invocation silently wrote blank images while reporting success.

**Done when.** Screenshots at several `?t` values agree with the grid JSON,
for every example config. The open question about rest behaviour is one of
the first things to look at with it, but it is one question among many.

---

## Why the plan changed

The first draft of phases 7–9 had two faults that would have surfaced only
at the end:

1. **The event list cannot show silence.** Rests and inactive beats produce
   no events, so a visualiser meant to show the whole piece — notes and
   silences and how they sit against each other — would have been missing
   half of it. Hence the grid in phase 8.
2. **A Piece cannot round-trip.** Degrees, scale and root are resolved to
   semitones when a layer is built, by design, so a Piece can only be written
   back as semitones and the GUI could never change a scale. The half of the
   JSON that round-trips has to be the spec. Hence the split in phase 7.

Both were checked against the code rather than assumed.

---

## Phase 10 — Live editing

**Goal.** `python3 serve.py`, open localhost, change something, hear it.

**Dependency.** None needed. Python's stdlib `http.server` is entirely
adequate for one user on localhost, which sidesteps the web-framework
question. Revisit only if it actually hurts.

**Flow.** Page POSTs a piece as JSON → `build_piece` → `schedule` +
`render_audio` → respond with schedule JSON and a WAV. Renders measured at
7–30 ms, so this is comfortably interactive without any real-time audio
engine.

**Controls.** Cycle duration, loops, and per layer: beats, gain, active
beats, pitch sequence, scale, root.

**Saving.** Initially show the equivalent TOML in a panel to copy out. That
dodges the config-writing problem entirely — `tomllib` only reads — and
defers the decision about whether to add a writer.

**Open.** Whether the GUI edits config files directly or holds its own state
and exports.

---

## Phase 11 — Sections (from the backlog)

Variations across cycles: same polyrhythmic base, different active beats,
scale or notes per bar. Design notes are in NOTES.md.

**Why after the GUI.** It is the largest musical gap, but it is also the
hardest thing to design blind, and a working visualiser makes "what should
four bars of variation look like" a question you can answer by looking. Note
that phase 7 may make `Piece` section-shaped in advance so this is additive.

---

## Phase 12 — Drift (arc item 3)

Layers that slowly fall out of phase rather than repeating exactly. This is
where the fixed-length-versus-streaming fork has to be settled for real.
Sections and drift are two answers to the same musical question, so decide
whether both are wanted before building the second.

---

## Phase 13 — Per-layer effects (arc item 4)

Envelope first: every beat currently plays the whole sample flat, which is
the bluntest thing about the sound. Then filtering, reverb.

Independent of everything above, so it can be pulled forward at any point if
the sound quality starts to annoy more than the feedback loop does. Effects
need per-layer buffers, which phase 1 deliberately does not keep.

**Open.** Reverb means a new dependency or a hand-rolled convolution.

---

## Phase 14 — MIDI export

The schedule is most of the work, and pitch is already in semitones. `mido`
or `pretty_midi`, a new dependency either way.

---

## Cross-cutting, not phased

- **Real samples.** Everything so far is verified with synthetic test tones.
- **Rest behaviour** is an open question — see NOTES.md. Phase 9 is the tool
  for answering it.
- **Known limitations** — aliasing on large upward shifts, mono-only,
  hand-set levels — are recorded in NOTES.md with measurements.
- **`qa_check.py` grows with each phase.** It is the largest file in the
  project, which is the correct shape for something judged by ear.
