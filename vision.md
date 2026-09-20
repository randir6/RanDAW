# Polyrhythm Sequence Generator — Vision

## What this is
A CLI tool that generates audio (and eventually MIDI) sequences built from
overlaid polyrhythmic layers, rendered to files for use in downstream
sequencers/DAWs (Koala, Loopy, Ableton, AUM). Not a plugin, not real-time —
generate, export, drag into whatever consumes it.

## Core mechanic
- A **layer** = a beat count (e.g. 3, 4, 13), a sequence of notes (pitch
  offsets applied to a sample), and a sample.
- Multiple layers run concurrently at their own beat counts, creating
  polyrhythm. The combined loop naturally resolves at the LCM of all active
  layers' beat counts (e.g. layers of 3 and 4 resolve every 12 beats).
- Each layer's note sequence loops independently over its own beat count —
  so a 3-beat layer with a 5-note sequence will phase against itself too.

## Planned capability arc (not all in v1)
1. **N layers**, not just 2 — design the data model so "2 layers" is a
   config choice, not a hardcoded assumption.
2. **Beat skipping** — a layer can define which of its own beats are
   "active" (e.g. a 13-beat layer that only sounds on beats 3, 5, 8).
   This is a filter over the layer's own beat index, independent of other
   layers.
3. **Drift over time** — sequences that slowly fall out of phase rather
   than looping identically forever. Architectural fork to decide
   consciously: is the piece always a fixed-length render, or a
   streaming/generative process with no fixed end? Even if not built yet,
   decide the intended direction before v1 locks in a fixed-length
   assumption too hard.
4. **Per-layer effects** — reverb, envelope/ADSR, filtering, etc. applied
   per layer before mixdown.

## Explicit non-goals (for now)
- No real-time playback or plugin (VST/AU) format.
- No GUI — CLI/config-file driven.
- No fixed limit on layer count baked into the core data model, even if
  early phases only test with 2.

## Tech direction (subject to revision, flag before changing)
- Python. numpy for signal generation/mixing, soundfile or pydub for WAV
  I/O and pitch-shifting, mido/pretty_midi if/when MIDI output is added.
- Output: WAV files to a folder; naming convention TBD once phase 1 works.

## Working agreement
- Ask before adding new dependencies or frameworks.
- Prefer small, testable, listenable increments over building the "final"
  architecture up front.
