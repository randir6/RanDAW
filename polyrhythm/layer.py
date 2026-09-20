from dataclasses import dataclass


@dataclass
class Layer:
    beats: int
    notes: list[int]
    sample_path: str


def parse_layer_arg(spec: str) -> Layer:
    """Parse "BEATS:NOTES:SAMPLE_PATH", e.g. "3:0,3,5:kick.wav"."""
    try:
        beats_str, notes_str, sample_path = spec.split(":", maxsplit=2)
        beats = int(beats_str)
        notes = [int(n) for n in notes_str.split(",")]
    except ValueError as e:
        raise ValueError(
            f"invalid --layer spec {spec!r}, expected BEATS:NOTES:SAMPLE_PATH "
            f"e.g. '3:0,3,5:kick.wav'"
        ) from e

    if beats < 1:
        raise ValueError(f"layer beat count must be >= 1, got {beats}")
    if not notes:
        raise ValueError("layer note sequence must not be empty")

    return Layer(beats=beats, notes=notes, sample_path=sample_path)
