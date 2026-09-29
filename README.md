# RanDAW — polyrhythm sequence generator

Makes audio loops from overlaid polyrhythmic layers and writes them to WAV,
for dragging into a sampler or DAW (Koala, Loopy, Ableton, AUM). Not a
plugin — make a loop, export it, use it elsewhere.

**Picking this up again after a break? Read this file, then `PHASES.md` for
where the work got to.**

## Run something in thirty seconds

The program is one web page. Build it, then open it in any browser:

```bash
cd web
node build.js                 # -> web/dist/randaw.html, one self-contained file
npm test                      # 106 checks, should all pass
```

Open `web/dist/randaw.html`, pick an example, press play. One row per layer,
running through the bars, with a playhead running through all of them —
notes, rests and switched-off beats, and where they fall against each other.

From the page you can **Download WAV**, **Save piece** (a small `.json` file
that **Open…** reads back), or **Save page**: a copy of the whole page with
your piece inside, which is the one file you can email to someone. The page
needs no internet connection and nothing installed; it works on an iPad as
well as a laptop.

The seven examples, in `web/examples/`:

| Example | What it demonstrates |
|---|---|
| `tresillo` | 3-3-2 groove with a 3-beat hat cutting across it |
| `rests` | Rests that travel through the bar |
| `seven` | 7 grouped 3-2-2 on a base of 7, with a 4-beat tom pulling against it |
| `spans` | 7 and 13 beats, each spread over 2 bars of 4 |
| `phase_study` | 5 beats against 7 notes — takes 7 bars to come back round |
| `sparse_dub` | Space rather than density |
| `scales` | Change one word, the whole piece re-harmonises |

A piece is a short JSON file, one layer per line:

```json
{
  "tempo": 110,
  "base": 4,
  "bars": 6,
  "scale": "dorian",
  "layer": [
    {"beats": 5, "degrees": [1, "-", 5, 4, "-", 2, 8], "sample": "pluck.wav", "gain": 0.38},
    {"beats": 7, "over": 2, "notes": [0], "sample": "tom.wav", "gain": 0.3},
    {"beats": 8, "notes": [0], "sample": "hat.wav", "gain": 0.14, "active": [3, 6, 8]}
  ]
}
```

That reads: 110 beats per minute, 4 beats to the bar, 6 bars long. A pluck
plays 5 beats in every bar, a tom 7 beats spread over every 2 bars, a hat 8
beats a bar with only the 3rd, 6th and 8th sounding. The words are defined
in the [Glossary](#glossary) below.

## Editing

Everything is edited in the page, and you hear each change straight away.
While a piece is playing, a change comes in at the start of the next bar,
so the groove never stops.

- **Tap a beat** in the drawing to switch it off, or back on. It is then
  silent every time the layer comes round (`active`).
- **Tap the strip along the top** of the drawing to jump there.
- **Grid | Rings | Polygons** switches how the piece is drawn. The grid runs
  each layer left to right, and is the best way to read a sequence. Rings put
  each layer on a ring going round like a clock -- one turn is a bar, or two
  for layers over 2 bars. Polygons join each layer's beats into a shape: 3
  against 4 is a triangle against a square, a dashed outline through every
  beat and a solid one through the beats that sound, so switching beats off
  bends the shape. Taps work the same in all three; in the round ones, the
  ring around the outside is the one to tap to jump. The page remembers which
  you chose.
- **The Piece panel**: the piece's name (used for saved files), undo and
  redo, **Tempo** (BPM), **Base** (beats per bar), **Click** (hear the base
  beats, like a metronome — off unless you turn it on), **Bars** (how long
  the file is), scale, root and **+ Add layer**. It also says how many bars
  the whole pattern takes to repeat, and offers to set the length to a whole
  number of repeats, so the WAV loops on the pattern rather than restarting
  it part-way.
- **Under it**, one card per layer: **M**ute, **S**olo, sample, **Beats**
  and **over** how many bars they spread, semitones or scale degrees, scale,
  root, gain, ⧉ to duplicate the layer and ✕ to remove it. An **On** row has
  a button per beat — the same as tapping beats in the drawing, but easy to
  hit on a phone.
- **The Sequence row** shows the layer's notes and rests, one tile per
  position. Tap a tile to choose it — every place that position lands
  lights up in the drawing, which is the clearest way to see a sequence
  phase against its beats — then tap a key to change it, or **rest**. **+**
  and **−** make the sequence longer or shorter. The text box beside it
  holds the same sequence for typing or pasting. Beside it: how many bars
  until this layer repeats.
- **Undo / Redo**, also ⌘Z / Ctrl+Z. **Escape** puts the position keypad away.
- **A mix that clips** (too loud, so it distorts) says so, with a button to
  turn every layer down by the same amount, just enough to fit.
- A change that breaks a rule (a sequence of nothing but rests, say) is
  refused with a message saying why, and the last good version keeps
  playing.
- The piece is kept in the browser between visits, so a reload does not lose
  it. That is a convenience, not a save: **Save piece** or **Save page** to
  keep something.

## Glossary

These are the words the page, the saved files, the code and its comments
all use, and they mean exactly this. In the order they build on each other:

| Word | Means | In a saved piece |
|---|---|---|
| **Tempo** | Beats per minute of the base beat. | `"tempo": 120` (120 if left out) |
| **Base** | How many beats make a bar: the meter everything sits on. A setting of the piece, not a layer. | `"base": 4` (4 if left out) |
| **Bar** | One bar of the base. At 120 BPM with a base of 4, a bar is 2 seconds. | |
| **Beat** | One of a layer's divisions of its span of bars. Every layer has its own beats. | `"beats": 7` |
| **Over** | How many bars a layer's beats are spread across: "7 beats over 2 bars". | `"over": 2` (1 if left out) |
| **Sequence** | A layer's notes and rests, read one **position** per beat. | `"notes"` or `"degrees"` |
| **Repeats every N bars** | When a layer's pattern — or the whole piece's — comes back round to where it started. | |
| **Length** | The whole file, in bars. | `"bars": 8` |
| **Click** | The base beats made audible, higher on beat 1 of each bar. Off unless turned on. | `"click": true` |
| **Section** | *Not built.* A run of bars sharing a variant of the piece. | |

More on each, and the rest of the words:

**Tempo and base** set the bar, and the bar is the unit everything else is
counted in. 4 beats at 120 BPM is a 2-second bar; 7 beats at 150 BPM is 2.8.
Adding a layer never changes the bar: it only divides it more finely.

**Beat** — one division by one layer. A 3-beat layer and a 4-beat layer
both fill the same bar, so their beats are different lengths: that is the
polyrhythm. The base's beats are just one more grid over the same bar,
drawn as faint lines and heard as the click.

**Over** — a layer can spread its beats over more than one bar. 13 beats in
one bar of 4 are crowded; 13 over 2 bars are the same rhythm at half the
speed. The layer comes back to its first beat every 2 bars, while the base
carries on counting bars underneath.

**Sequence and position** — the sequence is a layer's list of pitches
(`notes` or `degrees`, with `"-"` for a rest). It is read one position per
beat, and its length is independent of the beat count, which is where the
interesting behaviour comes from.

**Repeats every N bars** — a layer's pattern repeats when its sequence and
its beats line up again: a 7-position sequence on 5 beats takes 7 bars. The
whole piece repeats when every layer has. The page offers to make the
length a whole number of repeats, so the file loops cleanly.

**Phasing** — what happens when a sequence is a different length from the
beat count, so it lines up differently each time round. A 5-note sequence on
a 3-beat layer takes 15 beats to return to the start. Not a time unit — a
*behaviour*. Give the sequence a length equal to the beat count (or a
multiple) and you get a plainly composed pattern instead. Both are the same
mechanism.

**Cell** — one beat of one layer, whatever happens there: a note, a rest,
or a switched-off beat. The *grid* is every cell of a piece; the *schedule*
is just the cells that sound. A picture needs the grid, because silence is
half of a rhythm.

**Rest** — `"-"` in a sequence. Sounds nothing at that position. It *travels
with the sequence*, so when the sequence and beat count differ it lands on a
different beat each time round.

**Active beats** — which of a layer's own beats sound, counting from 1.
Fixed: an inactive beat is silent on the same beat *every* time round. That
is the difference from a rest, and it is the distinction worth keeping
straight.

**Layer** — a beat count (over some bars), a sequence, one sample, a gain,
and optionally which of its own beats sound.

**Note** — a pitch written as a semitone offset. `0` is unison, `12` an octave
up. Right for drums, where a scale means nothing.

**Degree** — a pitch written as a place in a scale, counting from 1 as
musicians do. In major, `1, 3, 5` is a major triad. `8` is the octave above
`1`; below `1` they run downwards. A layer uses `notes` **or** `degrees`,
never both — two separate fields so that adding a scale can never silently
reinterpret a drum layer's numbers.

**Root** — a semitone offset applied to a whole layer. Deliberately not a key
name like "D", because these are pitch shifts applied to samples whose own
pitch is unknown, so naming a key would be a fiction.

**Spec and Piece** — the spec is what you wrote (degrees, scale, `"-"`,
beats counted from 1); the Piece is what it means once worked out
(semitones, positions from 0, exact timing). A saved `.json` piece is a spec.
Saving always saves the spec, since a Piece has forgotten which scale its
semitones came from.

**Section** and **drift** — *not built.* A section would be a run of bars
sharing a variant of the piece; drift a gradual timing shift so layers
slowly fall out of alignment. They are two answers to the same musical
question (variation over time), worth deciding between before building
either.

**Pulse** — *inside the engine only.* The finest grid on which every beat
of every layer, and every base beat, lands: 3 against 4 needs 12 pulses per
bar. It keeps the arithmetic exact. Nobody composes in pulses, and the page
never shows them.

### Older words

Pieces saved before phase 12 used other words. They still open, and the page
turns them into today's as it opens them (`upgradeSpec` in `spec.js`):

| Older | Today |
|---|---|
| `cycle_duration` (seconds per cycle) | `tempo`, worked out with the base: 2.2 s of 4 beats is 109.091 BPM |
| `pulse_duration` | `tempo`, the same way |
| `loops` | `bars` |
| cycle | bar |
| step (of a sequence) | position |

A piece may use one form or the other, not both. The engine still reads the
older keys directly and times them exactly as before, which is how the
checks can compare against answers recorded long ago.

## How the code is laid out

```
web/
  src/               the program, as plain JavaScript modules — no framework
    spec.js          reading a piece and checking what it says
    layer.js         what a layer is, and the rules a valid one follows
    scales.js        scale degrees to semitones
    piece.js         buildPiece(): spec in, fully worked-out Piece out
    schedule.js      WHEN every beat happens — grid() and schedule(). No audio.
    render.js        turns a schedule into sound. Knows nothing about layers.
    audio.js         preparing samples; pitch shifting
    wav.js           reading and writing WAV files, byte by byte
    numbers.js       the arithmetic that has to match Python's exactly
    derive.js        everything a drawing needs, worked out from a Piece
    view.js          drawing a piece as a grid of beats. Draws only.
    rings.js         drawing it as rings, one per layer, like a clock. Draws only.
    polygons.js      drawing it as shapes, each layer's beats joined up. Draws only.
    clock.js         the clock face rings and polygons share
    drawing.js       what all the drawings share
    player.js        playing the audio on a seamless loop
    share.js         putting a piece into a copy of the page
    draft.js         keeping the piece in the browser between visits
    files.js         saving a file from the page; base64 back to bytes
    fingerprint.js   a short hash of the audio, to compare devices
    edit.js          every change the editor can make: spec in, new spec out
    editor.js        the editing panel under the drawing
    main.js          the one piece of state, and wiring it all together
  page.html          the page template: layout and colours
  build.js           stitches it all into one file: dist/randaw.html
  examples/          the example pieces
  test/              the checks — run with `npm test`
samples/             synthetic one-shots, built into the page: kick, snare, hat,
                     tom, and for melodies pluck, keys, marimba (all three
                     tuned to A, 220 Hz) and bell (E); plus the click
make_samples.py      how those were made (Python; the only Python left)
```

**The one rule worth protecting:** the engine modules (spec, layer, scales,
piece, schedule, render, audio, wav, derive) know nothing about the page.
`main.js` is the only file that connects them to buttons. That is what lets
the checks run the engine in Node with no browser, and what would let a
different front end reuse it.

**The key seam:** `schedule()` decides *when*, `renderAudio()` makes the
*sound*. Beat skipping, rests and scales are all decisions in the schedule,
so none of them touch the audio path.

**No musical logic in the drawing.** `derive.js` works out every cell's
label, height and position and every coincidence; `view.js` only draws them.

The source is commented far more heavily than normal, on purpose — this is a
learning project. Read `schedule.js` first; it has a worked 3-against-4
diagram and is where the whole idea lives. Then `numbers.js`, for the small
ways JavaScript and Python disagree about arithmetic.

### The Python version

Phases 1–9 were built in Python; phase 10 moved the engine into the page,
and phase 11 retired the Python version once the page had been tried on a
phone. It is all in git history up to commit `3fffdeb` (`git checkout 3fffdeb`
to see it). What it did is pinned down by the recorded answers in
`web/test/fixtures/`, which the JavaScript still has to match.

`make_samples.py` is the one Python file left: the record of how the
built-in sounds were made (`pip install -r requirements.txt`, then
`python3 make_samples.py`). Nothing else needs Python.

## Which document is which

- **`README.md`** (this) — orientation and vocabulary.
- **`VISION.md`** — what the project is for and the capability arc. The spec.
- **`PHASE1_SPEC.md`** — the original phase 1 spec, kept as written.
- **`PHASES.md`** — the plan, and what each finished phase settled and why.
  **Read this to find out where the work got to.**
- **`NOTES.md`** — known limitations (with measurements), the backlog, and
  decisions worth remembering. Read the backlog before proposing new work.

## Where things stand

**Parked on 26 September 2026**, after phase 12 and some follow-ups. Everything
is committed and pushed to the branch `claude/polyrhythm-vision-setup-jfos3r`
(not merged, no pull request). All 107 checks pass.

### What works

- **The whole program is one web page** (`web/dist/randaw.html`, built by
  `node web/build.js`). It runs offline on a laptop, iPad or phone, and
  "Save page" makes a copy with your piece inside that you can email.
- **Composing:** layers with their own beat counts, spread over one or more
  bars; notes or scale degrees; rests; beats switched on and off; mute, solo,
  gain; tempo, base (beats per bar), length in bars, and an optional click.
- **Editing live** in the page while it plays, with undo and redo; each
  change comes in at the start of the next bar. The piece survives a reload.
- **Three drawings**, switched with Grid | Rings | Polygons, all tappable.
  The drawing allows for the delay of Bluetooth speakers and headphones
  where the browser reports it.
- **Output:** a WAV that loops seamlessly, and the piece as a small `.json`.
- **Sounds:** synthetic kick, snare, hat, tom; pluck, keys and marimba (all
  in A) and bell (E) for melodies; the click.

### Waiting on your decisions

In rough order of how much they matter:

1. **Exact loop length.** A file is the tempo's length only to within a few
   milliseconds per bar (8 bars of `spans` come out 15 ms long), so a loop
   can drift against a DAW at the same tempo. The fix is known and small-ish
   -- place each beat at its exact fraction of the bar -- and is written up
   in `NOTES.md`. Recommended next piece of work.
2. **Did the drawing-delay fix work on your headphones?** While playing, a
   note beside the clock should say "drawing delayed N ms to match your
   speakers". If it never appears on the iPad/iPhone, the browser there does
   not report the delay, and a manual setting would be the fallback.
3. **Rest behaviour** -- rests travel with the sequence; should they, always?
   See Open questions in `NOTES.md`.
4. **Sections** (phase 13): variation across bars, e.g. four 4-bar sections
   in a 16-bar file. The words are settled now; the design notes are in
   `NOTES.md`.
5. **Your own samples** in the page -- where they are kept, how big, whether
   "Save page" carries them. Real recordings would also want leading silence
   trimmed automatically, and maybe a per-layer nudge for feel.
6. **Hosting**, so the iPad can open the page from an address. Set up as
   GitHub Pages: `.github/workflows/pages.yml` runs the checks, builds the
   page and publishes it to https://randir6.github.io/RanDAW/ on every push
   to the default branch. It needs the repo public and Settings -> Pages ->
   Source set to "GitHub Actions".
7. Small ones: the `rests` example is 6 bars of a pattern that repeats every
   21 (the page offers "Use 21 bars"); more drawings were floated (a
   scrolling timeline like a DAW's arrangement view).

### Picking it up again

```bash
git checkout claude/polyrhythm-vision-setup-jfos3r
cd web
node build.js      # -> dist/randaw.html; open it in a browser
npm test           # 106 checks; the browser ones need Chromium (CHROMIUM=path)
```

Then read `PHASES.md` from "Phase 12" down, and the Open questions and
backlog in `NOTES.md`. Nothing needs installing but Node; Python is only for
remaking the built-in sounds (`make_samples.py`).

**Things worth knowing:**

1. **The page is tested in Chromium; Safari only by hand.** It has played on
   an iPhone. The audio fingerprint under "The grid as text" should read the
   same on every device for the same piece.
2. **Nobody has run this with real samples yet.** Everything so far is
   verified against synthetic one-shots, which proves the maths but not the
   music.
3. **Older saved pieces still open** (the words changed in phase 12); the
   page upgrades them as it opens them.

## Checking nothing is broken

`npm test` (in `web/`) runs seven sets of checks:

- **engine** — the rules, stated directly: timing, layers over several
  bars, the click, rests, switched-off beats, wrapping tails, reading,
  saving and upgrading pieces, and the traps specific to JavaScript.
- **parity** — the answer key. The Python engine's results for the six
  original examples and 600 random pieces were recorded in `test/fixtures/`,
  and the JavaScript engine must match them exactly: same verdict, same grid,
  byte-identical WAV. They are in the older words, so they also prove older
  pieces still sound exactly as they did.
- **edit** — every change the editor can make, checked without a browser.
- **fuzz** — thousands of random edits from a fixed seed; nothing may crash,
  and rules that must always hold (one cell per beat, solo beats mute,
  save-and-reload is exact, undo returns exactly) are checked after each.
- **architecture** — the engine modules never import the page's modules or
  touch the browser, so the boundary cannot wear away.
- **page** — builds the page and opens it in headless Chromium: it must load
  without error, draw every note, and render the same audio fingerprint as
  Node.
- **editing** — drives the editor as a person would (taps a beat, presses
  M, picks a position and a key, types a sequence, changes the tempo, base,
  bars and click, undoes, reloads, edits while playing) and checks the page's audio against the same edit made in Node.

The browser checks drive Chrome through its debugging protocol
(`test/browser.js`, no library) and are skipped if no Chromium is installed.

The habit that has caught the most: compare results **byte for byte**, not
"close enough". It proved the schedule/audio split, the loop rewrite, that
scales changed nothing downstream — and it caught a one-step difference in
70 samples out of 582,480 that no listening test would ever have found.
