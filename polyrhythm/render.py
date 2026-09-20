"""Turning a schedule into sound.

The counterpart to schedule.py: that file decides *when*, this one makes the
noise. It has no idea what a layer or a polyrhythm is -- it just drops sounds
into a buffer at the positions it is told.
"""

import numpy as np

from polyrhythm.audio import load_sample, pitch_shift
from polyrhythm.schedule import Event


def _add_wrapped(buf: np.ndarray, start: int, audio: np.ndarray) -> None:
    """Add `audio` into `buf` at `start`, wrapping past the end back to the
    beginning. A note whose tail runs off the end carries into the next
    repeat instead of being cut off, so the render loops without a click.

    The `-> None` says this returns nothing: it MODIFIES buf in place. That's
    unusual enough to be worth stating, since most functions hand back a new
    value rather than editing their argument.
    """
    # % wraps a start position past the end back round to the beginning.
    pos = start % len(buf)

    # An empty numpy array is falsy, so `while len(audio)` means "while there
    # is audio left to place". Each pass writes as much as fits before the end
    # of the buffer, then continues from position 0 -- so a sound longer than
    # the whole buffer simply wraps more than once.
    while len(audio):
        # Slicing with [:n] takes the first n items. If the audio is shorter
        # than the space left, this takes all of it and the loop ends.
        chunk = audio[: len(buf) - pos]

        # += on a slice adds element-by-element, in place. This is MIXING:
        # overlapping sounds sum together, exactly as air pressure does.
        # Note `+=` rather than `=` -- assigning would overwrite whatever was
        # already there and silence every earlier note in that region.
        buf[pos : pos + len(chunk)] += chunk

        # Drop what we just wrote, and continue from the top of the buffer.
        audio = audio[len(chunk) :]
        pos = 0


def render_audio(
    events: list[Event], total_pulses: int, samples_per_pulse: int, sample_rate: int
) -> np.ndarray:
    """Mix a schedule down to a single float32 array.

    Knows nothing about layers, beat counts or polyrhythm -- only where each
    note lands and how it should sound. All of that lives in schedule().
    """
    # Start with silence: an array of zeros, one per sample, the full length
    # of the piece. Everything else adds into this. Allocating it up front
    # means we never have to grow it, which would be slow.
    mix = np.zeros(total_pulses * samples_per_pulse, dtype=np.float32)

    # Two caches, so repeated work happens once. A 13-beat layer over 4 loops
    # is 52 events, but they use only a handful of distinct sounds -- without
    # these we'd re-read the file and redo the pitch shift 52 times.
    #
    # The `dict[str, np.ndarray]` annotation says "keys are strings, values
    # are arrays". Documentation again, not enforcement.
    samples: dict[str, np.ndarray] = {}
    voices: dict[tuple[str, int, float], np.ndarray] = {}

    for event in events:
        # Read each file from disk at most once.
        if event.sample_path not in samples:
            samples[event.sample_path] = load_sample(event.sample_path, sample_rate)

        # A tuple as a dictionary key: these three together decide what the
        # note actually sounds like, so any event sharing all three can reuse
        # the same computed audio. Tuples work as keys because they're
        # immutable; a list would raise TypeError here.
        voice = (event.sample_path, event.semitones, event.gain)
        if voice not in voices:
            # Multiplying an array by a number scales every element at once --
            # numpy "broadcasting". No loop needed, and it runs as compiled
            # code rather than interpreted Python, so it's far faster.
            # Gain is applied BEFORE the pitch shift purely so the arithmetic
            # order stays identical to what earlier versions produced.
            voices[voice] = pitch_shift(samples[event.sample_path] * event.gain, event.semitones)

        # Convert the event's grid position into a sample position, and mix.
        _add_wrapped(mix, event.pulse * samples_per_pulse, voices[voice])

    return mix
