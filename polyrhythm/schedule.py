import math
from dataclasses import dataclass

from polyrhythm.layer import Layer


@dataclass(frozen=True)
class Event:
    """One note: which layer it came from, where it lands on the shared pulse
    grid, and everything needed to sound it.

    Deliberately self-contained -- a consumer can render it, export it as
    MIDI or draw it without needing the Layer it came from.
    """

    layer: int
    pulse: int
    semitones: int
    sample_path: str
    gain: float


def lcm_of_beats(layers: list[Layer]) -> int:
    return math.lcm(*(layer.beats for layer in layers))


def schedule(layers: list[Layer], loops: int) -> list[Event]:
    """Every note in the piece, in time order.

    The shared timeline is divided into pulses: the finest grid on which every
    layer's beats land. A layer with `beats` beats fires once every
    (lcm_beats // beats) pulses, so all layers complete one full loop in the
    same span -- that's what makes it a polyrhythm rather than beats of
    different lengths playing side by side.

    A layer's note sequence keeps running across loops instead of restarting,
    so a 5-note sequence on a 3-beat layer also phases against its own beats.
    """
    lcm_beats = lcm_of_beats(layers)
    events = [
        Event(
            layer=layer_idx,
            pulse=loop_idx * lcm_beats + beat_idx * (lcm_beats // layer.beats),
            semitones=layer.notes[(loop_idx * layer.beats + beat_idx) % len(layer.notes)],
            sample_path=layer.sample_path,
            gain=layer.gain,
        )
        for layer_idx, layer in enumerate(layers)
        for loop_idx in range(loops)
        for beat_idx in range(layer.beats)
    ]
    events.sort(key=lambda event: (event.pulse, event.layer))
    return events
