"""What a layer IS, and how to read one from a command-line string.

This module is deliberately the "boring" one: it holds the data and the
parsing, and knows nothing about audio or timing.
"""

import argparse
from dataclasses import dataclass

from polyrhythm.scales import SCALES, degree_to_semitones, scale_names

# The optional `key=value` fields allowed on the end of a --layer spec.
# Kept as a tuple (immutable) since it never changes at runtime, and listed in
# one place so the parser and the error messages can't drift apart.
LAYER_OPTIONS = ("gain", "active", "degrees", "scale", "root")


# @dataclass is a "decorator": it takes the class below and adds methods to it
# automatically. Without it we'd have to hand-write an __init__ that assigns
# all the fields, plus a __repr__ so printing a Layer shows something useful.
# The decorator generates both from the field list, so the class body just
# declares WHAT a layer is.
@dataclass
class Layer:
    # These are type hints: `beats: int` says beats should be a whole number.
    # Python does NOT enforce this at runtime -- you could assign a string and
    # it would happily accept it. They exist to document intent and to let
    # editors and checkers catch mistakes before you run the code.
    beats: int
    notes: list[int]  # semitone offsets, e.g. [0, 3, 5]
    sample_path: str
    # Fields with defaults. Because they have them, they must come after all
    # the fields that don't -- otherwise Python couldn't tell which argument
    # was which when you write Layer(3, [0], "kick.wav").
    gain: float = 1.0

    # Which of this layer's own beats actually sound. None means "all of
    # them", which keeps the common case simple and makes a layer written
    # before this feature existed behave exactly as it did.
    #
    # Stored 0-BASED (first beat is 0) to match how Python indexes everything,
    # even though the command line takes 1-based numbers the way musicians
    # count. That conversion happens once, at parse time, below. Converting at
    # the boundary and using one convention everywhere inside is the reliable
    # way to avoid off-by-one bugs.
    #
    # The default is None rather than an empty set for a specific Python
    # reason: a mutable default like `= set()` would be created ONCE and
    # shared by every Layer, so adding to one layer's set would silently
    # affect all the others. None sidesteps the trap entirely.
    active_beats: set[int] | None = None


def make_layer(
    beats: int,
    sample_path: str,
    notes: list[int] | None = None,
    degrees: list[int] | None = None,
    scale: str | None = None,
    root: int = 0,
    gain: float = 1.0,
    active: list[int] | None = None,
) -> Layer:
    """Validate the pieces of a layer and build one.

    Both the command line and the config file end up here, so the rules live
    in exactly one place and cannot drift apart as the two front ends grow.
    Raises plain ValueError; each caller wraps it with its own context (which
    --layer string, or which entry in which file).

    A layer states its pitches EITHER as `notes` (raw semitones, right for
    drums and anything where a scale is meaningless) OR as `degrees` against
    a named scale. Two separate fields rather than one field that changes
    meaning, so that adding a scale somewhere can never silently reinterpret
    a drum layer's numbers.

    Degrees are resolved to semitones right here, which is why nothing
    downstream -- schedule, render, the event list -- knows scales exist.

    `active` and `degrees` both arrive 1-BASED, as the user writes them.
    """
    if beats < 1:
        raise ValueError(f"beat count must be >= 1, got {beats}")

    # Exactly one of the two. `is None` rather than a truth test so that an
    # explicitly empty list is caught below as empty rather than as absent.
    if notes is None and degrees is None:
        raise ValueError("needs either notes (semitones) or degrees (with a scale)")
    if notes is not None and degrees is not None:
        raise ValueError("give either notes or degrees, not both")

    if degrees is not None:
        if scale is None:
            raise ValueError(f"degrees need a scale; try one of: {scale_names()}")
        if scale not in SCALES:
            raise ValueError(f"unknown scale {scale!r}; expected one of: {scale_names()}")
        if not degrees:
            raise ValueError("degree sequence must not be empty")
        # The whole feature, in one line: degrees become semitones and the
        # rest of the program carries on exactly as it did before.
        notes = [degree_to_semitones(d, scale, root) for d in degrees]
    elif scale is not None:
        # A scale alongside raw semitones means someone expected the numbers
        # to be degrees. Better to say so than to silently ignore the scale.
        raise ValueError("scale given but pitches are notes (semitones); use degrees instead")

    if not notes:
        raise ValueError("note sequence must not be empty")
    if gain < 0:
        raise ValueError(f"gain must be >= 0, got {gain}")
    if not sample_path:
        raise ValueError("no sample path")

    if active is not None:
        for n in active:
            # Chained comparison: Python allows 1 <= n <= beats, which reads
            # like the maths and is checked as one expression.
            if not 1 <= n <= beats:
                raise ValueError(f"active beat {n} is outside 1..{beats}")
        # A set comprehension (curly braces rather than square). Sets discard
        # duplicates, so [3, 3, 5] quietly means the same as [3, 5], and
        # membership testing is fast. The -1 is the 1-based-to-0-based shift.
        active = {n - 1 for n in active}

    return Layer(
        beats=beats, notes=notes, sample_path=sample_path, gain=gain, active_beats=active
    )


def _split_options(spec: str, rest: str) -> tuple[str, dict[str, str]]:
    """Peel trailing `key=value` fields off the end, leaving the sample path.

    Works from the right so that sample paths containing colons survive, and
    so the options can be written in any order.
    """
    options: dict[str, str] = {}
    while True:
        # rpartition splits ONCE at the LAST separator and always returns
        # three values: before, the separator, after. An empty separator means
        # there was no colon left, so we're done.
        head, separator, last_field = rest.rpartition(":")
        if not separator:
            break

        # partition is the same idea from the left, splitting "gain=0.8" into
        # "gain", "=", "0.8".
        key, equals, value = last_field.partition("=")
        if not equals or not key.isidentifier():
            break  # not an option at all -- it's part of the path

        if key not in LAYER_OPTIONS:
            raise argparse.ArgumentTypeError(
                f"invalid layer {spec!r}: unknown option {key!r}, "
                f"expected one of {', '.join(k + '=' for k in LAYER_OPTIONS)}"
            )
        if key in options:
            raise argparse.ArgumentTypeError(
                f"invalid layer {spec!r}: {key}= given more than once"
            )

        options[key] = value
        rest = head  # continue leftward, looking for more options
    return rest, options


def _parse_gain(value: str, spec: str) -> float:
    """Text to number only -- whether the number is ALLOWED is make_layer's job."""
    try:
        return float(value)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"invalid layer {spec!r}: gain {value!r} is not a number"
        ) from None


def _parse_root(value: str, spec: str) -> int:
    try:
        return int(value)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"invalid layer {spec!r}: root {value!r} must be a whole number of semitones"
        ) from None


def _parse_active(value: str, spec: str) -> list[int]:
    """Turn "3,5,8" into [3, 5, 8]. Used for both active beats and degrees,
    which are both 1-based lists of whole numbers."""
    try:
        return [int(n) for n in value.split(",")]
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"invalid layer {spec!r}: active beats {value!r} must be whole numbers, "
            f"e.g. 'active=3,5,8'"
        ) from None


def parse_layer_arg(spec: str) -> Layer:
    """Parse "BEATS:NOTES:SAMPLE_PATH[:gain=G][:active=B,B,...]".

    The `-> Layer` above is another hint, saying this function hands back a
    Layer. Square brackets in the format string mean "optional part", and the
    optional parts may appear in either order.

    Raises ArgumentTypeError rather than ValueError so argparse prints these
    messages instead of replacing them with its own generic text.
    """
    # try/except: attempt the code in `try`, and if it raises the named kind
    # of error, run `except` instead of crashing.
    try:
        # Splitting "3:0,3,5:kick.wav" on ":" with maxsplit=2 gives exactly
        # three pieces: it stops splitting after the second colon, so any
        # further colons stay inside the third piece.
        # Assigning three names at once like this is "tuple unpacking" -- it
        # raises ValueError if there aren't exactly three pieces, which is
        # itself a useful check.
        beats_str, notes_str, rest = spec.split(":", maxsplit=2)

        # int() converts text to a whole number, raising ValueError on junk.
        beats = int(beats_str)

        # An empty notes field ("8::pluck.wav:degrees=1,3,5") means the
        # pitches are coming from degrees= instead. None, not [], so that
        # make_layer can tell "not given" from "given but empty".
        #
        # Otherwise: a "list comprehension", building a list by running an
        # expression over every item. The compact form of:
        #     notes = []
        #     for n in notes_str.split(","):
        #         notes.append(int(n))
        notes = [int(n) for n in notes_str.split(",")] if notes_str else None
    except ValueError:
        # `from None` suppresses the "during handling of the above exception,
        # another occurred" chain Python would otherwise print. The underlying
        # ValueError adds noise here -- our message is clearer.
        raise argparse.ArgumentTypeError(
            f"invalid layer {spec!r}: expected BEATS:NOTES:SAMPLE_PATH[:gain=G][:active=B,...], "
            f"e.g. '3:0,3,5:kick.wav' or '13:0:tom.wav:active=3,5,8'"
            # !r inside an f-string inserts the repr() of the value, i.e. with
            # quotes shown. Useful in errors so "3:0 " is visibly not "3:0".
        ) from None

    sample_path, options = _split_options(spec, rest)

    gain = _parse_gain(options["gain"], spec) if "gain" in options else 1.0
    active = _parse_active(options["active"], spec) if "active" in options else None
    degrees = _parse_active(options["degrees"], spec) if "degrees" in options else None
    root = _parse_root(options["root"], spec) if "root" in options else 0

    # All the actual rules live in make_layer, shared with the config loader.
    # We only add the context -- which --layer string went wrong. Keyword
    # arguments throughout, so the order here can never silently mismatch.
    try:
        return make_layer(
            beats=beats,
            sample_path=sample_path,
            notes=notes,
            degrees=degrees,
            scale=options.get("scale"),
            root=root,
            gain=gain,
            active=active,
        )
    except ValueError as e:
        raise argparse.ArgumentTypeError(f"invalid layer {spec!r}: {e}") from None
