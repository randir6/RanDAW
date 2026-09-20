import numpy as np

from polyrhythm.audio import load_sample, pitch_shift
from polyrhythm.schedule import Event


def _add_wrapped(buf: np.ndarray, start: int, audio: np.ndarray) -> None:
    """Add `audio` into `buf` at `start`, wrapping past the end back to the
    beginning. A note whose tail runs off the end carries into the next
    repeat instead of being cut off, so the render loops without a click.
    """
    pos = start % len(buf)
    while len(audio):
        chunk = audio[: len(buf) - pos]
        buf[pos : pos + len(chunk)] += chunk
        audio = audio[len(chunk) :]
        pos = 0


def render_audio(
    events: list[Event], total_pulses: int, samples_per_pulse: int, sample_rate: int
) -> np.ndarray:
    """Mix a schedule down to a single float32 array.

    Knows nothing about layers, beat counts or polyrhythm -- only where each
    note lands and how it should sound. All of that lives in schedule().
    """
    mix = np.zeros(total_pulses * samples_per_pulse, dtype=np.float32)

    samples: dict[str, np.ndarray] = {}
    voices: dict[tuple[str, int, float], np.ndarray] = {}

    for event in events:
        if event.sample_path not in samples:
            samples[event.sample_path] = load_sample(event.sample_path, sample_rate)

        voice = (event.sample_path, event.semitones, event.gain)
        if voice not in voices:
            voices[voice] = pitch_shift(samples[event.sample_path] * event.gain, event.semitones)

        _add_wrapped(mix, event.pulse * samples_per_pulse, voices[voice])

    return mix
