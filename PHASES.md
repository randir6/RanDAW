# Phase Plan

*Phases 1–9 describe the Python version, which was retired in phase 11. File
names in those sections refer to it; its code is in git history up to commit
`3fffdeb`.*

*Phases 1–11 use the older words: a **cycle** is what phase 12 calls a
**bar**, **loops** is the length in **bars**, and a **step** of a sequence is
a **position**. README.md's Glossary has today's words.*

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

## Phase 7 — Spec and Piece — DONE

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
  raises `SpecError` and returns warnings as data rather than printing them,
  because a GUI does not want stdout.

`generate.py` becomes: argparse → spec (CLI merged over file) → `build_piece`
→ `schedule` → `render_audio` → write.

**Settled.** `Piece` is single-pattern and is *not* pre-shaped for sections.
A section is meant to be an override, not a re-declaration, so a list of
Piece-shaped sections would be the wrong shape anyway. `max_duration` stays
with the caller, since it is policy rather than maths.

**Done when.** The reference renders are byte-identical, and a spec survives
TOML → dict → JSON → dict unchanged.

**How it landed.** `config.py` became `spec.py` (reading and checking a spec),
`piece.py` (`Piece` and `build_piece`) and `layer_arg.py` (a `--layer` string
to a spec entry). `layer.py` kept only the data model and its rules, so each
rule now lives in exactly one place — a duplicated notes-or-degrees check was
caught by the checks disagreeing about the wording. A spec naming both tempo
settings is refused. All 13 reference renders byte-identical.

---

## Phase 8 — The grid — DONE

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

**How it landed.** `--export-json FILE` writes `{format, version, spec,
derived}`; `--config` reads the same file back and renders byte-identically,
from any folder, because sample paths are rewritten relative to where the
JSON is saved. `derived` also carries each cell's label, height and position
in its cycle, and the list of instants where two or more layers sound
together — everything a display needs, worked out and tested in Python.
Counts said aloud (cycle, beat) are 1-based; list positions are 0-based.

## Phase 9 — Static visualiser — DONE

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

**How it landed.** `polyrhythm/visualise.py` fills in
`polyrhythm/visualiser.html`, a template of plain HTML, SVG and commented
JavaScript. Settled while building it:

- The window is four cycles, but shrinks when a layer has so many beats that
  a cell would be narrower than 20 px — a 24-beat layer gets two cycles.
- Five colours, run through a colourblind-safety validator in light and dark
  mode. Colour is never the only cue: every row is also named, and marks
  differ in shape (circle, x, bar).
- Legend glyphs are grey, not a layer's colour, so the legend never implies
  that one layer is special.
- Drums get no `seq` line unless they contain rests; a row of x's said
  nothing the row did not.
- The playhead passes *behind* the marks, so a note stays readable while it
  sounds.
- Hover any mark for its layer, cycle, beat, time and pitch. Space plays and
  pauses, clicking the grid jumps there, and the arrow keys change page.
- A collapsed text view of the grid sits under the drawing, for reading
  exact values and for screen readers.

Verified by eye on screenshots of all six example configs, plus a 5-layer
piece with a 24-beat hat, and in dark mode — each checked against the grid.
`qa_check.py` also loads a page in headless Chromium and checks it draws
exactly the notes in the grid (skipped when no Chromium is present).

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

## Re-planned again: the page becomes the program

Decided after phase 9. The GUI is the main way the tool gets used, not the
command line, and it should run on an iPad as well as a laptop -- Koala,
Loopy and AUM are all iPad apps. A Python server cannot realistically run on
an iPad; a page with the engine inside it runs anywhere with a browser, and
one file can be emailed.

So the engine moved to JavaScript, as its own phase, before live editing.
The risks and how each is handled were argued through before starting; the
short version:

- **The iPad's browser is the weakest target and cannot be tested from here.**
  Test on the real device early and every phase.
- **A rewrite introduces quiet bugs.** The Python engine was kept as the
  answer key until the JavaScript matched it exactly.
- **Browsers decode and resample audio differently.** The page reads WAV
  files and mixes sound itself, so every device produces the same bytes.
- **Module files do not load from a page opened off the disk.** Develop in
  modules; a small build script stitches them into one file.
- **Plain JavaScript can sprawl as the UI grows.** One state object, one
  function that draws from it; revisit only if it hurts, and ask first.
- **Hand-written config files lose their comments.** Accepted: the GUI takes
  over editing, and pieces are saved as JSON.
- **The dead end:** running inside AUM as a plugin, or sending it live MIDI,
  needs native iOS code whichever language the engine is in.

---

## Phase 10 — The engine in JavaScript — DONE

**Goal.** Everything the Python version does, in one self-contained page:
open it, pick a piece, play it, download the WAV.

**How it landed.** `web/src/` holds the engine as plain JavaScript modules,
one per Python module and commented to the same standard. `web/build.js`
stitches them, the six built-in samples and the example pieces into
`web/dist/randaw.html` -- one 337 kB file that works offline and needs
nothing installed. (The phase 9 pages were 2 MB each, because they carried
their audio; this one carries the samples and makes the audio itself.)

The page opens any of the examples or a saved JSON piece, and can download
the WAV, save the piece as JSON, or **save a copy of itself** with the
current piece inside -- the one file you can email.

**The answer key.** `web/test/make_fixtures.py` ran the Python engine over
the six examples and 600 random pieces (about a third deliberately broken in
one of 61 ways) and recorded the answers. The JavaScript engine matches all
of them exactly: the same verdict on every piece, the same grid number for
number, and a **byte-identical WAV** for every one of the 379 that render.
The browser page makes the same bytes again, checked in headless Chromium
by an audio fingerprint the page shows under "The grid as text".

**What a straight translation got wrong**, each found by the answer key:

- **Remainders of negative numbers.** Python's `-1 % 7` is 6, JavaScript's
  is -1. Degrees below 1 depend on the Python behaviour.
- **Rounding halves.** Python rounds 2.5 to 2 (to even), JavaScript to 3.
  This affects the tempo maths and the six-decimal values in the grid.
- **Names every object inherits.** In JavaScript, `"toString" in SCALES` is
  true; a scale called toString must still be refused.
- **How the audio library wrote 16-bit samples.** A first guess (scale and
  round down) matched 428,000 random test values but still left 70 samples
  one step out in a real piece. The true rule -- round to 32 bits, keep the
  top 16 -- was found by probing the library at the boundaries, and then
  matched two million values exactly.

The checks were themselves checked: seven bugs planted on purpose (each of
the above undone, plus a pinned rest and unsorted events) were each caught.

**Also settled.**

- `sample` in a piece is now a *name* from the page's sample library, not a
  file path -- a web page cannot reach into folders on your disk.
- `out` and `max_duration` are no longer piece settings. Where the file goes
  is the browser's business; the length limit (120 s) is the page's policy.
- The Python version is frozen: kept only until you have tried the page on
  your own devices, then retired. `qa_check.py` still passes against it.

---

## Phase 11 — Live editing — DONE

**Goal.** Change the piece in the page and hear the change.

**Decided before starting.**

- **Edits land on the next cycle boundary.** The loop keeps playing and the
  new version comes in on the next downbeat, like a sampler -- restarting on
  every change would break the groove.
- **Samples: a menu of the built-in set.** Adding your own comes later.
- **Tapping a beat toggles `active`** -- silence this beat, every cycle,
  which is unambiguous. Tapping the strip along the top jumps playback, since
  a tap cannot mean both.
- **Rests are set in the sequence**, not by tapping the drawing, because
  whether a tap in cycle 3 should also move silences in other cycles is
  exactly the open question about rests.
- **A step strip rather than only typing.** One tile per sequence step, a
  keypad for the chosen step, and a text box holding the same sequence.
- **Mute and solo**, saved in the piece as `"mute": true` / `"solo": true`,
  as a DAW keeps them in the project. Solo wins over mute.
- **Undo and redo.** Adding and removing layers.

**How it landed.**

- **The Python version was retired first** (commit `a7e080e`), once the page
  had played on a phone. Its recorded answers stay as the parity checks.
- **`edit.js`** holds every change as a plain function, spec in, new spec out.
  Undo is a list of old specs; the rules are checked by `buildPiece` as
  always, so an edit that breaks one is refused with the engine's own message
  and the last good version keeps playing.
- **`editor.js`** rebuilds the panel from the piece after every change, so the
  controls can never disagree with it.
- **`player.js`** swaps versions with Web Audio scheduling: the new version
  starts exactly on the next downbeat, carrying the cycle count on, and the
  old one fades out over 15 ms so notes ringing across the boundary do not
  click. Positions are counted in cycles, since an edit can change how long a
  cycle is. A second edit before the boundary replaces the first.
- **Choosing a step outlines everywhere it lands** in the drawing -- the open
  question about travelling rests, made visible while editing.
- **The piece is kept in the browser** between visits, so a reload does not
  lose work. Save piece / Save page are still how to keep something.
- **Narrow screens** show two cycles per page and let the drawing scroll
  sideways inside its frame, rather than shrinking the labels to nothing.

**Checks.** 59, including a set that drives the editor in a real browser and
compares the page's audio against the same edit made directly -- which found
that Redo was drawn disabled after an Undo (the redraw happened before the
redo was recorded). A browser check also plays a piece, edits it mid-cycle,
and confirms the change waits for the 2 s boundary while playback carries on.

The browser checks moved from `--dump-dom` to driving Chrome over its
debugging protocol (`test/browser.js`, no library): `--dump-dom` ran on a
simulated clock and could read a page before real work had finished, which
made one check fail about one run in three under load.

---

## After phase 11: polish, measured

Work done without new decisions, each change its own commit:

- **Speed.** Measured first: an edit spent its time making sound and writing
  the WAV, not drawing. Sounds are now reused between edits and the encoder
  is faster (a one-line rule proved equal to the old one on 6.4 million
  values), halving the work -- with every WAV still byte-identical to the
  recorded answers. Then each edit redraws at once and makes its sound just
  after: from tap to screen went from 45 ms to 6 ms for tresillo, and from
  about 250 ms to 20 ms for a dense two-minute piece.
- **Phone and iPad.** No zoom when tapping a text box or quick taps; older
  Safari supported; "reduce motion" honoured. The drawing is laid out for
  the width it has (900-1600 units), so on an iPad held upright its labels
  are about twice the size they were; it redraws when the device turns.
- **Found by reading the code:** the fingerprint was rehashed on every
  redraw; two animation loops could run at once; a refused change left its
  control showing the value that did not happen; a refusal made straight
  after an edit could be wiped by that edit's sound arriving; and keyboard
  focus was thrown back to the top of the page after every press.
- **New:** an On row of beat buttons per card; duplicate layer; a name for
  the piece; how many cycles each pattern takes to come round, with a button
  to make the loops a whole number of repeats; a one-tap fix when the mix
  clips; Escape puts the step keypad away.
- **Design:** Play stands out, saving is grouped at the right, the piece's
  settings have their own panel; quiet text now meets the WCAG contrast
  standard in both themes.
- **Checks:** 77, adding thousands of random edits against rules that must
  always hold, and a check that the engine never depends on the page. A
  20-second soak of 388 random edits while playing: no errors, memory flat.
  The whole suite passes repeatedly under heavy CPU load.
- **Tidying:** draft storage and file saving moved out of `main.js` into
  `draft.js` and `files.js`.

---

## Phase 12 — Tempo, base and bars — DONE

The units of time were reviewed with the page in hand, and settled as the
words a musician would use. The glossary in README.md is the list.

**What changed for a person using it:**

- **Tempo** in BPM and a **base** (beats per bar, 4 unless changed) replace
  the cycle length in seconds. 120 BPM in 4 is a 2-second bar.
- **Bars** replaces loops for the length of the file.
- A layer's beats can spread **over** more than one bar: 7 over 2 bars, or
  13 over 2, rather than crowded into one. The new `spans` example.
- **Click**: the base beats as a metronome tick, higher on beat 1. Off
  unless turned on.
- The drawing is labelled in bars, with faint lines at the base beats. The
  Sequence row (was Steps) has positions; each layer says how many bars
  until it repeats, and the piece how many until the whole pattern does.

**What was settled, and why:**

- **The base is a setting, not a layer.** It has no sequence to edit; a
  layer on the base beats is just a layer with that many beats.
- **The base is part of the pulse grid** for today's pieces, so the click
  lands exactly, and switching it on never moves anything else.
- **Older pieces still open and still sound identical.** The engine reads
  `cycle_duration`, `pulse_duration` and `loops` and times them as before;
  the page upgrades such a piece to today's words when it opens it. The
  recorded Python answers still match to the byte, which is the proof.
  Upgrading can round the tempo (2.2 s in 4 is 109.091 BPM); where it comes
  out exact, the upgraded piece is byte-identical too, and there is a check.
- **Sections stay deferred.** With bars settled, a section is naturally a
  whole number of bars in a longer file; the design notes in NOTES.md are
  updated to say so.
- **Found while building it:** the file is the tempo's length only to
  within the pulse grid's rounding (15 ms over 8 bars of `spans`), so a
  loop can drift against a DAW at the same tempo. Recorded in NOTES.md as
  the top candidate for next.

**Checks:** 90. Every older example is kept in `test/fixtures/legacy_examples`
for the answer key; the examples themselves are now in today's words. New
checks cover tempo and base, spans, the click, upgrading, and refusing the
same setting given both ways; the fuzz run now changes tempo, base, bars,
click and spans too.

---

## After phase 12: sounds, timing and drawings

- **Two warmer melody sounds**, keys (a soft electric piano) and marimba,
  tuned to A like the pluck. `scales` and `spans` use them.
- **"The snare sounds late"** turned out not to be the sound: every sample
  hits within a few ms and every beat lands within 0.02 ms of its time. The
  drawing followed the moment sound was *sent*, and Bluetooth headphones add
  150-250 ms before it is *heard*. The drawing now runs behind by the delay
  the browser reports, and says so on the page. Still to confirm on the
  iPad/iPhone that Safari reports it.
- **Three drawings:** Grid, Rings (a ring per layer, round like a clock) and
  Polygons (each layer's beats joined into a shape; switched-off beats bend
  it). Shared code in `drawing.js` and `clock.js`.
- **The browser checks cannot hang any more:** every request to Chrome
  fails after 60 s instead of waiting for ever (one run hung under load).
- **Checks:** 107.

**Parked here** (26 September 2026). What is waiting on decisions, in order,
is in README.md under "Where things stand". The recommended next step is
exact loop length (see NOTES.md, "The file is not exactly the tempo's
length"), then sections.

---

## Phase 13 — Sections (from the backlog)

Variations across bars: same polyrhythmic base, different active beats,
scale or notes per bar -- a section being a whole number of bars in a longer
file. Design notes are in NOTES.md.

**Why after the GUI.** It is the largest musical gap, but it is also the
hardest thing to design blind, and a working editor makes "what should four
bars of variation look like" a question you can answer by looking.

---

## Phase 14 — Drift (arc item 3)

Layers that slowly fall out of phase rather than repeating exactly. This is
where the fixed-length-versus-streaming fork has to be settled for real --
and in a browser, live playback is available, which may settle it. Sections
and drift are two answers to the same musical question, so decide whether
both are wanted before building the second.

---

## Phase 15 — Per-layer effects (arc item 4)

Envelope first: every beat currently plays the whole sample flat, which is
the bluntest thing about the sound. Then filtering, reverb.

Browsers have filters, delay, reverb and compression built in, which the
Python version would have needed libraries for. Using them for the WAV means
rendering through the browser's own audio engine, which may not be
byte-identical across browsers; decide then whether that matters.

---

## Phase 16 — MIDI export

The schedule is most of the work, and pitch is already in semitones. Writing
a MIDI file is simple bytes, no library needed. Sending live MIDI from a web
page does not work in Safari, so on the iPad this means files, not a live
connection.

---

## Cross-cutting, not phased

- **Test on the iPad.** The page is checked in Chromium on every change, but
  Safari on iPad can only be checked on the device. The audio fingerprint
  under "The grid as text" should match between devices.
- **Hosting**, so the iPad can open the page from an address rather than a
  file. Deliberately later.
- **Real samples.** Everything so far is verified with synthetic test tones.
- **Rest behaviour** is an open question — see NOTES.md.
- **Known limitations** — aliasing on large upward shifts, mono-only,
  hand-set levels — are recorded in NOTES.md with measurements.
