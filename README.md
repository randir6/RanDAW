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
npm test                      # 77 checks, should all pass
```

Open `web/dist/randaw.html`, pick an example, press play. One row per layer,
each spanning a cycle, with a playhead running through all of them — notes,
rests and switched-off beats, and where they fall against each other.

From the page you can **Download WAV**, **Save piece** (a small `.json` file
that **Open…** reads back), or **Save page**: a copy of the whole page with
your piece inside, which is the one file you can email to someone. The page
needs no internet connection and nothing installed; it works on an iPad as
well as a laptop.

The six examples, in `web/examples/`:

| Example | What it demonstrates |
|---|---|
| `tresillo` | 3-3-2 groove with a 3-beat hat cutting across it |
| `rests` | Rests that travel through the bar |
| `seven` | 7 grouped 3-2-2, with a 4-beat tom pulling against it |
| `phase_study` | 5 beats against 7 notes — takes 7 cycles to come back round |
| `sparse_dub` | Space rather than density |
| `scales` | Change one word, the whole piece re-harmonises |

A piece is a short JSON file, one layer per line:

```json
{
  "cycle_duration": 2.2,
  "loops": 6,
  "scale": "dorian",
  "layer": [
    {"beats": 5, "degrees": [1, "-", 5, 4, "-", 2, 8], "sample": "pluck.wav", "gain": 0.38},
    {"beats": 8, "notes": [0], "sample": "hat.wav", "gain": 0.14, "active": [3, 6, 8]}
  ]
}
```

## Editing

Everything is edited in the page, and you hear each change straight away.
While a piece is playing, a change comes in at the start of the next cycle,
so the groove never stops.

- **Tap a beat** in the drawing to switch it off, or back on. It is then
  silent in every cycle (`active`).
- **Tap the strip along the top** of the drawing to jump there.
- **Under the drawing**, one card per layer: **M**ute, **S**olo, sample,
  beats, semitones or scale degrees, scale, root, gain, ⧉ to duplicate the
  layer and ✕ to remove it. An **On** row has a button per beat -- the same
  as tapping beats in the drawing, but easy to hit on a phone.
- **The Piece panel** above the cards: the piece's name (used for saved
  files), undo and redo, cycle length, loops, scale, root and
  **+ Add layer**. It also says how many cycles the whole pattern takes to
  come round, and offers to set the loops to a whole number of repeats, so
  the WAV loops on the pattern rather than restarting it part-way.
- **The step strip** shows the layer's sequence, one tile per step. Tap a
  tile to choose it -- every place that step lands lights up in the drawing,
  which is the clearest way to see a sequence phase against its beats --
  then tap a key to change it, or **rest**. **+** and **−** make the
  sequence longer or shorter. The text box beside it holds the same
  sequence for typing or pasting.
- **Undo / Redo**, also ⌘Z / Ctrl+Z. **Escape** puts the step keypad away.
- **A mix that clips** (too loud, so it distorts) says so, with a button to
  turn every layer down by the same amount, just enough to fit.
- A change that breaks a rule (a sequence of nothing but rests, say) is
  refused with a message saying why, and the last good version keeps
  playing.
- The piece is kept in the browser between visits, so a reload does not lose
  it. That is a convenience, not a save: **Save piece** or **Save page** to
  keep something.

## Glossary

The words that are easy to confuse, in the order they nest.

**Pulse** — the finest grid unit. One cycle contains LCM(all beat counts)
pulses, so 3-against-4 gives 12 pulses per cycle. Internal plumbing; you
rarely set it directly.

**Beat** — one division of a cycle *by one layer*. A 3-beat layer has three
beats per cycle, a 4-beat layer has four, and they occupy the same span of
time. Every layer has its own beats — the `beats` of a layer.

**Cycle** — one full turn of the polyrhythm, where every layer realigns on
its first beat. **The cycle is the bar.** Its length is the thing you set
(`cycle_duration`), and every layer divides it. Adding a layer subdivides the
same span rather than stretching it — that was a real bug once, caught by ear,
and there is a regression check for it now.

**Cell** — one beat of one layer in one cycle, whatever happens there: a
note, a rest, or a switched-off beat. The *grid* is every cell of a piece;
the *schedule* is just the cells that sound. A picture needs the grid,
because silence is half of a rhythm.

**Loop** — a repeat of the cycle in the output. `loops = 8` renders eight
cycles. *Note: `loops` and `cycle` mean the same unit, which is a naming wart
— `cycles` would have been clearer. Backlogged rather than renamed.*

**Sequence** — a layer's list of pitches (`notes` or `degrees`). Its length is
independent of the beat count, and that is where the interesting behaviour
comes from.

**Phasing** — what happens when a sequence is a different length from the beat
count, so it lines up differently each cycle. A 5-note sequence on a 3-beat
layer takes 15 beats to return to the start. Not a time unit — a *behaviour*.
Give the sequence a length equal to the beat count (or a multiple) and you get
a plainly composed pattern instead. Both are the same mechanism.

**Section** — **not built.** A span of cycles sharing a variant of the piece,
so a piece could be four bars with the same skeleton and different detail.
Top of the backlog in `NOTES.md`.

**Drift** — **not built.** Gradual timing shift so layers slowly fall out of
alignment rather than repeating exactly. Note that sections and drift are two
answers to the same musical question (variation over time), and it is worth
deciding which you want before building either.

**Layer** — a beat count, a pitch sequence, one sample, a gain, and optionally
which of its own beats sound.

**Note** — a pitch written as a semitone offset. `0` is unison, `12` an octave
up. Right for drums, where a scale means nothing.

**Degree** — a pitch written as a position in a scale, counting from 1 as
musicians do. In major, `1, 3, 5` is a major triad. `8` is the octave above
`1`; below `1` they run downwards. A layer uses `notes` **or** `degrees`,
never both — two separate fields so that adding a scale can never silently
reinterpret a drum layer's numbers.

**Rest** — `"-"` in a sequence. Sounds nothing at that position. It *travels
with the sequence*, so when the sequence and beat count differ it lands on a
different beat each cycle.

**Active beats** — which of a layer's own beats sound, counting from 1. Fixed:
an inactive beat is silent on the same beat *every* cycle. That is the
difference from a rest, and it is the distinction worth keeping straight.

**Spec and Piece** — the spec is what you wrote (degrees, scale, `"-"`,
beats counted from 1); the Piece is what it means once worked out
(semitones, positions from 0, exact timing). A saved `.json` piece is a spec.
Saving always saves the spec, since a Piece has forgotten which scale its
semitones came from.

**Root** — a semitone offset applied to a whole layer. Deliberately not a key
name like "D", because these are pitch shifts applied to samples whose own
pitch is unknown, so naming a key would be a fiction.

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
    view.js          drawing a piece in step notation. Draws only.
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
  examples/          the six example pieces
  test/              the checks — run with `npm test`
samples/             six synthetic one-shots, built into the page
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

`make_samples.py` is the one Python file left: the record of how the six
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

Phases 1–11 are done: N layers, cycle-based tempo, the schedule/audio split,
beat skipping, scales, rests, the spec/Piece split, JSON export, a
visualiser that plays in time with its drawing, the whole engine in one
self-contained web page that runs on a laptop, iPad or phone — and live
editing in that page, with mute, solo and undo.

Next up is sections (12): variations across cycles. Drift, effects and MIDI
follow. See `PHASES.md`.

**Things worth knowing before picking up:**

1. **The page is tested in Chromium; Safari only by hand.** It has played on
   an iPhone. The audio fingerprint under "The grid as text" should read the
   same on every device for the same piece.
2. **Rest behaviour is under question** — see Open questions at the top of
   `NOTES.md`. The `rests` example is the quickest way in.
3. **Sections is top of the backlog.** It is probably the largest musical gap.
4. **Nobody has run this with real samples yet.** Everything so far is
   verified against synthetic one-shots, which proves the maths but not the
   music.

## Checking nothing is broken

`npm test` (in `web/`) runs three sets of checks:

- **engine** — the rules, stated directly: timing, rests, switched-off
  beats, wrapping tails, reading and saving pieces, and the traps specific
  to JavaScript.
- **parity** — the answer key. The Python engine's results for the six
  examples and 600 random pieces were recorded in `test/fixtures/`, and the
  JavaScript engine must match them exactly: same verdict, same grid,
  byte-identical WAV.
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
  M, picks a step and a key, types a sequence, undoes, reloads, edits while
  playing) and checks the page's audio against the same edit made in Node.

The browser checks drive Chrome through its debugging protocol
(`test/browser.js`, no library) and are skipped if no Chromium is installed.

The habit that has caught the most: compare results **byte for byte**, not
"close enough". It proved the schedule/audio split, the loop rewrite, that
scales changed nothing downstream — and it caught a one-step difference in
70 samples out of 582,480 that no listening test would ever have found.
