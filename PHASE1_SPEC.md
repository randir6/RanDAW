# Phase 1 Spec — Two-Layer Polyrhythm, No Effects

## Goal
Prove polyrhythm + note-sequence + sample playback works end to end.
No skipping, no drift, no effects.

## Scope
- Exactly 2 layers, but as a list/array, not two named variables — must
  be trivial to extend to N layers later.
- Each layer has: a beat count, a note sequence (semitone offsets, looping
  independently over its own beats), and one sample file to pitch-shift
  per beat.
- Render length = N loops of LCM(layer beat counts).
- Flat gain, full sample on every active beat.

## CLI shape (adjust naming as feels natural)
python generate.py \
  --layer 3:0,3,5 --sample1 kick.wav \
  --layer 4:0,-2,4,0 --sample2 snare.wav \
  --loops 4 --out out.wav

## Explicit exclusions
No skipping, no drift, no effects chain, no MIDI, no GUI.

## Definition of done
Running with two different beat counts produces a WAV where both rhythms
are audibly overlaid correctly. Verify render length in samples matches
loops × LCM(beat counts) × samples-per-beat. Code structure should make
adding a 3rd layer straightforward, not a rewrite.
