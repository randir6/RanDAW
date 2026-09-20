# RanDAW — polyrhythm sequence generator

Generates audio loops built from overlaid polyrhythmic layers and writes them
to WAV, for dragging into a sampler or DAW (Koala, Loopy, Ableton, AUM). Not
real-time, not a plugin — generate, export, use elsewhere.

**Picking this up again after a break? Read this file, then `PHASES.md` for
where the work got to.**

## Run something in thirty seconds

```bash
pip install -r requirements.txt        # numpy + soundfile, Python 3.11+
python3 generate.py --config configs/tresillo.toml --out tresillo.wav
python3 qa_check.py                    # 85 checks, should all pass
```

Six example configs in `configs/`, all commented and meant to be edited:

| File | What it demonstrates |
|---|---|
| `tresillo.toml` | 3-3-2 groove with a 3-beat hat cutting across it |
| `seven.toml` | 7 grouped 3-2-2, with a 4-beat tom pulling against it |
| `phase_study.toml` | 5 beats against 7 notes — takes 7 cycles to come back round |
| `sparse_dub.toml` | Space rather than density |
| `scales.toml` | Change one word, the whole piece re-harmonises |
| `rests.toml` | Rests that travel through the bar |

The CLI does the same thing for quick one-offs:

```bash
python3 generate.py --layer "8:0:samples/kick.wav:active=1,4,7" \
                    --layer "3:0:samples/hat.wav:gain=0.2" \
                    --loops 4 --out quick.wav
```

`--dump-schedule` prints every note a render will place, with times. It is the
fastest way to see what a config actually does without listening.

## Glossary

The words that are easy to confuse, in the order they nest.

**Pulse** — the finest grid unit. One cycle contains LCM(all beat counts)
pulses, so 3-against-4 gives 12 pulses per cycle. Internal plumbing; you
rarely set it directly.

**Beat** — one division of a cycle *by one layer*. A 3-beat layer has three
beats per cycle, a 4-beat layer has four, and they occupy the same span of
time. Every layer has its own beats. This is the number at the front of a
`--layer` spec.

**Cycle** — one full turn of the polyrhythm, where every layer realigns on
its first beat. **The cycle is the bar.** Its length is the thing you set
(`cycle_duration`), and every layer divides it. Adding a layer subdivides the
same span rather than stretching it — that was a real bug once, caught by ear,
and there is a regression check for it now.

**Loop** — a repeat of the cycle in the output. `loops = 8` renders eight
cycles. *Note: `loops` and `cycle` mean the same unit, which is a naming wart
— `--cycles` would have been clearer. Backlogged rather than renamed, since
every config uses it.*

**Sequence** — a layer's list of pitches (`notes` or `degrees`). Its length is
independent of the beat count, and that is where the interesting behaviour
comes from.

**Phasing** — what happens when a sequence is a different length from the beat
count, so it lines up differently each cycle. A 5-note sequence on a 3-beat
layer takes 15 beats to return to the start. Not a time unit — a *behaviour*.
Give the sequence a length equal to the beat count (or a multiple) and you get
a plainly composed pattern instead. Both are the same mechanism.

**Section** — **not built.** A span of cycles sharing a config variant, so a
piece could be four bars with the same skeleton and different detail. Top of
the backlog in `NOTES.md`.

**Drift** — **not built.** Gradual timing shift so layers slowly fall out of
alignment rather than repeating exactly. Phase 7. Note that sections and drift
are two answers to the same musical question (variation over time), and it is
worth deciding which you want before building either.

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

**Root** — a semitone offset applied to a whole layer. Deliberately not a key
name like "D", because these are pitch shifts applied to samples whose own
pitch is unknown, so naming a key would be a fiction.

## How the code is laid out

```
generate.py          the CLI — argument parsing, validation, writing the file
polyrhythm/
  schedule.py        WHEN every note happens. No audio here at all.
  render.py          turns a schedule into sound. Knows nothing about layers.
  layer.py           what a layer is + parsing one from a --layer string
  scales.py          scale degrees to semitones. Plain integer arithmetic.
  config.py          reading a piece from TOML
qa_check.py          85 checks, run as a plain script (no pytest)
make_samples.py      regenerates samples/ — reproducible, seeded RNG
configs/             example pieces
samples/             six synthetic one-shots so it works out of the box
```

**The one rule worth protecting:** dependencies flow one way, from
`generate.py` inward. Nothing in `polyrhythm/` imports the CLI. That is what
makes a second front end (the config reader was one; a web UI would be
another) cheap to add.

**The key seam:** `schedule()` decides *when*, `render_audio()` makes the
*sound*. Beat skipping, rests, scales and drift are all operations on the
schedule, so none of them touch the audio path. The schedule is also ~400×
cheaper to compute than the audio, which is what makes an interactive front
end viable later without a real-time engine.

The source is commented far more heavily than normal, on purpose — this is a
learning project. Read `schedule.py` first; it has a worked 3-against-4
diagram and is where the whole idea lives.

## Which document is which

- **`README.md`** (this) — orientation and vocabulary.
- **`VISION.md`** — what the project is for and the capability arc. The spec.
- **`PHASE1_SPEC.md`** — the original phase 1 spec, kept as written.
- **`PHASES.md`** — the plan, and what each finished phase settled and why.
  **Read this to find out where the work got to.**
- **`NOTES.md`** — known limitations (with measurements), the backlog, and
  decisions worth remembering. Read the backlog before proposing new work.

## Where things stand

Phases 1–6 are done: N layers, cycle-based tempo, the schedule/audio split,
beat skipping, TOML configs, scales, and rests. Phase 7 is drift, 8 is
per-layer effects, 9 MIDI export, 10 a web visualiser.

**Three things worth knowing before picking up:**

1. **Rest behaviour is under question** — see Open questions at the top of
   `NOTES.md`. Understand it before building on it.
2. **Sections is top of the backlog**, above the remaining numbered phases.
   It is probably the largest musical gap.
3. **Nobody has run this with real samples yet.** Everything so far is
   verified against synthetic one-shots, which proves the maths but not the
   music.

## Checking nothing is broken

`python3 qa_check.py` drives `generate.py` as a subprocess and measures the
audio that comes out, so the checks stay honest if the internals change. It
derives its timing model independently of the renderer, on the principle that
a test computing expectations with the code under test will agree with that
code's bugs.

The habit that has caught the most: keep a set of reference renders before a
refactor and compare them byte for byte afterwards. It proved the
schedule/audio split, the loop rewrite, and that scales changed nothing
downstream. Beware that floating-point addition is not associative, so a
change that reorders sums can shift a sample by one 16-bit step without
anything being wrong.
