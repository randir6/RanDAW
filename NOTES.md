# Working Notes

Running notes on known limitations and decisions. Not a spec — VISION.md and
PHASE1_SPEC.md are the spec, and stay as written.

## Known limitations (phase 1)

These are consequences of deliberate choices, not bugs. Each one is worth
revisiting when the relevant phase arrives.

### Upward pitch shifts alias
Pitch shifting is done by resampling (speed-change, like varispeed on tape),
which is the numpy-only approach chosen to avoid a librosa dependency before
phase 1 was proven. There is no anti-aliasing filter, so frequencies pushed
above Nyquist fold back down instead of disappearing.

Measured: an 8 kHz tone shifted +24 semitones should land at 32 kHz, above the
22.05 kHz Nyquist limit. It comes back at 12.1 kHz.

In practice: fine for shifts of a few semitones, increasingly gritty on bright
samples shifted up a long way. Revisit alongside phase 4 (per-layer effects),
where a proper resampler or a real pitch-shifter would live.

### Pitch and duration are coupled
Same cause. A note shifted up is shorter, a note shifted down is longer;
+12 semitones plays at half the length, -12 at double. This is musically
useful as often as it is not, but it is not "true" pitch shifting.

### Mono only
Stereo inputs are downmixed by averaging L and R, and output is always mono.
Hard-panned content loses 6 dB in the process (measured: a tone at 0.9 in the
left channel only arrives at 0.45). Correlated stereo content is unaffected.

No decision has been made about whether the tool should be stereo-aware. Worth
settling before per-layer effects, since panning is an obvious per-layer
parameter.

### Output is 16-bit PCM
This is `soundfile`'s default for WAV rather than an explicit choice. It
happens to be the right call for the downstream targets (Koala, Loopy), but it
is a library default we are relying on, not a decision the code states.

### Levels are set by hand
Per-layer `gain=` with no auto-normalization, chosen deliberately for control.
Consequence: adding layers or stacking overlapping tails can clip, and the fix
is to dial gains down yourself. The clipping warning suggests a specific value
that resolves it.

### Very high LCMs lose grid resolution
Beats land on an integer grid of pulses, `LCM` of them per cycle. A cycle of
C seconds at sample rate R therefore needs `LCM <= C * R` for at least one
sample per pulse, and comfortably fewer than that to place beats accurately.

Measured at a 2s cycle, 44.1 kHz: 3/4/5/7/11 (LCM 4620) renders a 1.990s
cycle, 0.5% off and inaudible. Adding a 13 (LCM 60060) leaves 1.47 samples
per pulse, which rounds to 1 and collapses the cycle to 1.36s — the tool
warns when the rounded cycle differs from the requested one by over 1%.

Fixable if it ever bites, by computing each event's position directly from
its fractional position in the cycle instead of snapping to a pulse grid.
Not worth doing until someone actually wants six coprime layers.

## Backlog

Ideas deliberately not built, kept here so they are not lost. Nothing in
this list is committed to, and none of it is in the phase plan.

### Sections — variations across cycles (high priority)

Treat a cycle as a bar, and let a piece be a sequence of sections that share
a polyrhythmic base but vary what sits on top: which beats are active, which
scale, which notes, gains, maybe samples. Four bars with the same skeleton
and different detail is most of what turns a loop into an arrangement, and
it is the largest musical gap in the tool as it stands.

Design notes from thinking it through, so the work does not start cold:

- **The schedule is already the right seam.** A section produces its own
  events and they get offset by the cycles already elapsed. `render_audio`
  would not change at all, the same way beat skipping did not touch it.
- **The LCM must be computed across every section, not per section.** If
  section 2 introduces a layer with a different beat count, the pulse grid
  changes, and a grid that changed mid-piece would break the timing
  guarantees. Take the LCM of all beat counts in the whole piece up front.
- **Variation is best expressed as an override, not a re-declaration.**
  Repeating every layer per section would be miserable to write and easy to
  get inconsistent. Something closer to: declare the layers once, then
  per-section state only what differs.
- **Section length wants to be in cycles**, since the cycle is the bar.
- **Interacts with drift (phase 7).** Sections are deliberate variation;
  drift is gradual variation. They are different answers to the same
  musical problem and it is worth deciding whether they coexist or whether
  one makes the other redundant before building the second one.

### Smaller items

- **Samples declaring their own root pitch.** Would let `key = "D"` mean
  something real rather than assuming every sample is a C, and would make
  `root` a musical setting rather than an offset.

- **Note sequence that advances only on sounding beats.** Currently a note
  belongs to its beat position, so skipping a beat silences that note. The
  alternative advances the sequence only when a beat sounds, so every note
  is heard in turn and skipping becomes a rhythmic mask over a melody that
  keeps running. Both are musically useful and they are genuinely different.
  Would need the note counter in `schedule()` to change, not just a filter,
  so probably a per-layer choice like `notes_follow=beats|hits`.
- **One-shot render mode.** Tails currently wrap so files loop seamlessly,
  which means a render opens with the tail of its own last note. Fine for
  loops, wrong for a one-shot. Needs a flag.
- **Auto-normalise option.** Levels are set by hand on purpose, but a
  `--normalise` that scales the finished mix to just under 0 dB would save
  dialling gains in by trial and error.
- **Sample-accurate event placement.** Beats snap to an integer pulse grid,
  which loses resolution at very high LCMs (see above). Computing each
  event's position from its fractional position in the cycle would remove
  the limit entirely.
- **Stereo.** Everything is mono. Panning is an obvious per-layer parameter
  and would want settling before per-layer effects land.
- **Explicit output bit depth.** 16-bit PCM is currently soundfile's default
  rather than a stated choice.
- **Per-note velocity.** Gain is per-layer. Per-event gain would allow
  accents, and `Event` already carries a gain field that could vary.
- **A `beat` field on `Event`.** Would make `--dump-schedule` readable
  without mental arithmetic, and a visualiser will want it.
- **BPM referenced to a named layer.** `--cycle-duration` is the honest
  control, but "put layer 2 at 120 bpm" is how a musician would ask.

## Decisions worth remembering

- **Pitches are `notes` (semitones) or `degrees` (against a scale), never one
  field that changes meaning.** A single field reinterpreted whenever a scale
  was present would have let a global scale silently rewrite every drum
  layer's numbers. Two fields make a semitone layer provably immune.
- **`root` is a semitone offset, not a key name.** We pitch-shift samples
  whose own pitch is unknown, so "the key of D" would be a fiction. Naming
  keys honestly needs samples to declare their natural pitch.
- **Degrees resolve to semitones in `make_layer`**, so schedule, render and
  the event list never learn that scales exist. The whole feature lives at
  the boundary.

- **Skipping a beat silences its note; it does not shuffle the melody up.**
  A layer's note sequence is indexed by beat position whether or not that
  beat sounds, so `active=1,3` on a 4-beat layer with notes `0,12,24,36`
  plays `0` and `24`, not `0` and `12`. Like muting a step on a drum machine
  rather than deleting it.

  Both behaviours are useful; the other one is on the backlog below.
- **Active beats count from 1**, as musicians count, and convert to 0-based
  indices once at parse time. Phase 5's scale degrees will be 1-indexed for
  the same reason.

- **The schedule is the core, audio is one consumer.** `schedule()` produces
  the event list and `render_audio()` sounds it. Beat skipping filters the
  list, drift moves it, MIDI exports it and a visualiser would draw it, so
  none of those need to touch the audio path. Measured before splitting: the
  schedule costs ~0.02 ms against ~7.5 ms for the audio.
- **Events sort into time order, at the cost of exact byte-identity.**
  Reordering float32 additions moved one sample of 529,200 by a single
  16-bit LSB (-90 dBFS) in one reference render. Accepted deliberately.

- **Tempo is the cycle, not the pulse.** `--cycle-duration` sets how long one
  full polyrhythm cycle lasts, and every layer divides that span. An earlier
  `--bpm` set the *pulse* instead, which meant adding a 5-beat layer took the
  LCM from 12 to 60 and slowed a 120 bpm kick to 24 bpm without changing any
  setting the user had touched. Caught by ear, not by the tests — there is
  now a regression check that a layer's onsets are unchanged by the addition
  of another layer. `--pulse-duration` survives as the low-level control.
- **Renders refuse to exceed `--max-duration`** (default 120s) and say how
  long they would have been. Mostly reachable via `--pulse-duration` now,
  since cycle-based tempo makes length explicit.

- **Loop tails wrap.** A note whose tail runs past the end of the render wraps
  around to the start, so the file loops without a click. The trade: the very
  beginning of a render contains the tail of its own last note. Correct for
  looping, wrong for a one-shot render — there is no flag for that yet.
- **`--layer` is self-contained** (`BEATS:NOTES:SAMPLE[:gain=G]`) rather than
  the spec's `--sample1`/`--sample2`, which would not extend past two layers.
- **A "pulse" is the LCM grid**, the finest subdivision on which every layer's
  beats land — not any single layer's beat spacing.
