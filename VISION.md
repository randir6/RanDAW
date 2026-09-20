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
6. Possible long-term: a web-based GUI that visualises the polyrhythm —
   e.g. shapes moving in time with the overlaid beats. Generation stays
   headless and scriptable; a GUI would be another front end over the
   same core, not a rewrite of it.

## Non-goals for now
No real-time playback, no plugin format, no GUI in the early phases. The
GUI exclusion is a sequencing decision rather than an architectural one
(see arc item 6): the core should stay callable by something other than
the CLI, so nothing in it should assume a human is typing.

## Tech direction
Python, numpy for signal generation/mixing, soundfile or pydub for WAV
I/O and pitch-shifting. Ask before adding new dependencies/frameworks.
