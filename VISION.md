# Polyrhythm Sequence Generator — Vision

## What this is
A CLI tool that generates audio (and eventually MIDI) sequences built from
overlaid polyrhythmic layers, rendered to files for use in downstream
sequencers/DAWs (Koala, Loopy, Ableton, AUM). Not a plugin, not real-time —
generate, export, drag into whatever consumes it.

## Core mechanic
- A layer = a beat count (e.g. 3, 4, 13), a sequence of notes (pitch
  offsets applied to a sample), and a sample.
- Multiple layers run concurrently at their own beat counts, creating
  polyrhythm. The combined loop resolves at the LCM of all active layers'
  beat counts.
- Each layer's note sequence loops independently over its own beat count.

## Planned capability arc (not all in v1)
1. N layers, not just 2 — data model should treat "2 layers" as a config
   choice, not a hardcoded assumption.
2. Beat skipping — a layer can define which of its own beats are active
   (e.g. a 13-beat layer sounding only on beats 3, 5, 8).
3. Drift over time — sequences that slowly fall out of phase rather than
   looping identically forever.
4. Per-layer effects (reverb, envelope, filtering) before mixdown.
5. Possible future: per-note sample switching (not just pitch-shifting
   one sample), likely modeled as multiple layers.

## Non-goals for now
No real-time playback, no plugin format, no GUI.

## Tech direction
Python, numpy for signal generation/mixing, soundfile or pydub for WAV
I/O and pitch-shifting. Ask before adding new dependencies/frameworks.
