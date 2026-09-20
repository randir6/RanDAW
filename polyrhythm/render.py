import math

import numpy as np

from polyrhythm.audio import load_sample, pitch_shift
from polyrhythm.layer import Layer


def lcm_of_beats(layers: list[Layer]) -> int:
    return math.lcm(*(layer.beats for layer in layers))


def render(layers: list[Layer], loops: int, samples_per_pulse: int, sample_rate: int) -> np.ndarray:
    """Render all layers to a single mixed-down float32 array.

    The shared timeline is divided into pulses: the finest grid on which
    every layer's beats land. A layer with `beats` beats fires once every
    (lcm_beats // beats) pulses, so all layers complete one full loop in
    the same wall-clock span -- that's what makes it a polyrhythm rather
    than beats of different lengths playing side by side.
    """
    lcm_beats = lcm_of_beats(layers)
    total_pulses = loops * lcm_beats
    total_samples = total_pulses * samples_per_pulse

    mix = np.zeros(total_samples, dtype=np.float32)

    for layer in layers:
        sample = load_sample(layer.sample_path, sample_rate)
        pulses_per_beat = lcm_beats // layer.beats
        layer_buf = np.zeros(total_samples, dtype=np.float32)

        for loop_idx in range(loops):
            for beat_idx in range(layer.beats):
                occurrence = loop_idx * layer.beats + beat_idx
                semitones = layer.notes[occurrence % len(layer.notes)]
                note_audio = pitch_shift(sample, semitones)

                pulse_idx = loop_idx * lcm_beats + beat_idx * pulses_per_beat
                start = pulse_idx * samples_per_pulse
                end = min(start + len(note_audio), total_samples)
                if end > start:
                    layer_buf[start:end] += note_audio[: end - start]

        mix += layer_buf

    mix /= len(layers)
    return mix
