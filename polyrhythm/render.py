import math

import numpy as np

from polyrhythm.audio import load_sample, pitch_shift
from polyrhythm.layer import Layer


def lcm_of_beats(layers: list[Layer]) -> int:
    return math.lcm(*(layer.beats for layer in layers))


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


def render(
    layers: list[Layer], loops: int, samples_per_pulse: int, sample_rate: int
) -> np.ndarray:
    """Render all layers to a single mixed-down float32 array.

    The shared timeline is divided into pulses: the finest grid on which
    every layer's beats land. A layer with `beats` beats fires once every
    (lcm_beats // beats) pulses, so all layers complete one full loop in
    the same wall-clock span -- that's what makes it a polyrhythm rather
    than beats of different lengths playing side by side.
    """
    lcm_beats = lcm_of_beats(layers)
    total_samples = loops * lcm_beats * samples_per_pulse

    mix = np.zeros(total_samples, dtype=np.float32)

    for layer in layers:
        sample = load_sample(layer.sample_path, sample_rate) * layer.gain
        shifted = {semitones: pitch_shift(sample, semitones) for semitones in set(layer.notes)}
        pulses_per_beat = lcm_beats // layer.beats

        for loop_idx in range(loops):
            for beat_idx in range(layer.beats):
                occurrence = loop_idx * layer.beats + beat_idx
                pulse_idx = loop_idx * lcm_beats + beat_idx * pulses_per_beat
                _add_wrapped(
                    mix,
                    pulse_idx * samples_per_pulse,
                    shifted[layer.notes[occurrence % len(layer.notes)]],
                )

    return mix
