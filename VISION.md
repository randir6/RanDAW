# Polyrhythm Sequence Generator — Vision

## What this is
A CLI tool that generates audio (and eventually MIDI) sequences built from
overlaid polyrhythmic layers, rendered to files for use in downstream
sequencers/DAWs (Koala, Loopy, Ableton, AUM). Not a plugin, not real-time —
generate, export, drag into whatever consumes it.

## Core mechanic
- A layer = a beat count (e.g. 3, 4, 13), a sequence of notes, and one or
  more samples. Notes are scale degrees (against a scale and key) or raw
  semitone offsets where a scale is meaningless, as on percussion.
- Multiple layers run concurrently at their own beat counts, creating
  polyrhythm. The combined loop resolves at the LCM of all active layers'
  beat counts.
- Each layer's note sequence loops independently over its own beat count,
  and a layer's sample set cycles the same way — so note sequence, sample
  sequence and beat count all phase against each other.
- Tempo is set by the cycle duration — the span every layer divides into its
  own beat count — so adding a layer subdivides that span rather than
  stretching it. Fixing the pulse instead would make the cycle grow with the
  LCM and silently slow every layer already playing.
- Coprime beat counts therefore cost grid resolution rather than length:
  their LCM sets how finely the cycle must be subdivided, and once that
  approaches the sample rate the beats can no longer be placed exactly. The
  tool says so when it happens.

## Planned capability arc (not all in v1)
1. N layers, not just 2 — data model should treat "2 layers" as a config
   choice, not a hardcoded assumption.
2. Beat skipping — a layer can define which of its own beats are active
   (e.g. a 13-beat layer sounding only on beats 3, 5, 8).
3. Drift over time — sequences that slowly fall out of phase rather than
   looping identically forever. This forces an architectural fork to decide
   consciously: is a piece always a fixed-length render, or a
   streaming/generative process with no fixed end? Decide the intended
   direction before the fixed-length assumption hardens any further.
4. Per-layer effects (reverb, envelope, filtering) before mixdown.
5. Multiple samples per layer — a layer holds a sample set and each beat
   selects from it, cycling independently like the note sequence does.
   Deliberately not modelled as multiple layers: splitting a layer would
   lose the note-sequence-against-beat-count phasing that makes a layer a
   single musical idea.
6. Scales and keys — notes expressed as degrees, so a layer can be
   re-harmonised by swapping its scale or key rather than rewriting every
   note. Raw semitone offsets stay available as an escape hatch.
7. Possible long-term: a web-based GUI that visualises the polyrhythm —
   e.g. shapes moving in time with the overlaid beats. Generation stays
   headless and scriptable; a GUI would be another front end over the
   same core, not a rewrite of it.

## Non-goals for now
No real-time playback, no plugin format, no GUI in the early phases. The
GUI exclusion is a sequencing decision rather than an architectural one
(see arc item 7): the core should stay callable by something other than
the CLI, so nothing in it should assume a human is typing. As per-layer
settings multiply, config files become the primary way to drive the tool,
with the CLI kept for quick one-off renders.

## Tech direction
Python, numpy for signal generation/mixing, soundfile or pydub for WAV
I/O and pitch-shifting. Ask before adding new dependencies/frameworks.
