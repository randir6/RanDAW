import argparse
from dataclasses import dataclass

GAIN_PREFIX = "gain="


@dataclass
class Layer:
    beats: int
    notes: list[int]
    sample_path: str
    gain: float = 1.0


def parse_layer_arg(spec: str) -> Layer:
    """Parse "BEATS:NOTES:SAMPLE_PATH[:gain=G]".

    Raises ArgumentTypeError rather than ValueError so argparse prints these
    messages instead of replacing them with its own generic text.
    """
    try:
        beats_str, notes_str, rest = spec.split(":", maxsplit=2)
        beats = int(beats_str)
        notes = [int(n) for n in notes_str.split(",")]
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"invalid layer {spec!r}: expected BEATS:NOTES:SAMPLE_PATH[:gain=G], "
            f"e.g. '3:0,3,5:kick.wav' or '3:0,3,5:kick.wav:gain=0.8'"
        ) from None

    # Only a trailing ":gain=..." is treated as a gain, so sample paths that
    # themselves contain a colon still parse correctly.
    head, _, last_field = rest.rpartition(":")
    if last_field.startswith(GAIN_PREFIX):
        sample_path = head
        try:
            gain = float(last_field[len(GAIN_PREFIX):])
        except ValueError:
            raise argparse.ArgumentTypeError(
                f"invalid layer {spec!r}: gain "
                f"{last_field[len(GAIN_PREFIX):]!r} is not a number"
            ) from None
    else:
        sample_path, gain = rest, 1.0

    if beats < 1:
        raise argparse.ArgumentTypeError(
            f"invalid layer {spec!r}: beat count must be >= 1, got {beats}"
        )
    if gain < 0:
        raise argparse.ArgumentTypeError(
            f"invalid layer {spec!r}: gain must be >= 0, got {gain}"
        )
    if not sample_path:
        raise argparse.ArgumentTypeError(f"invalid layer {spec!r}: no sample path")

    return Layer(beats=beats, notes=notes, sample_path=sample_path, gain=gain)
