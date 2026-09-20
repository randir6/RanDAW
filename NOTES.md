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

## Decisions worth remembering

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
