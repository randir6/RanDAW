"""What a layer IS, and how to read one from a command-line string.

This module is deliberately the "boring" one: it holds the data and the
parsing, and knows nothing about audio or timing.
"""

import argparse
from dataclasses import dataclass

# A module-level constant. Written in CAPITALS by convention to say "this is
# a fixed value, don't reassign it" -- Python doesn't enforce that, it's a
# message to humans. Defined once here so the string "gain=" isn't typed out
# in three places where a typo could silently break parsing.
GAIN_PREFIX = "gain="


# @dataclass is a "decorator": it takes the class below and adds methods to it
# automatically. Without it we'd have to hand-write an __init__ that assigns
# all four fields, plus a __repr__ so printing a Layer shows something useful.
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
    # A field with a default. Because it has one, it must come after all the
    # fields that don't -- otherwise Python couldn't tell which argument was
    # which when you write Layer(3, [0], "kick.wav").
    gain: float = 1.0


def parse_layer_arg(spec: str) -> Layer:
    """Parse "BEATS:NOTES:SAMPLE_PATH[:gain=G]".

    The `-> Layer` above is another hint, saying this function hands back a
    Layer. Square brackets in the format string mean "optional part".

    Raises ArgumentTypeError rather than ValueError so argparse prints these
    messages instead of replacing them with its own generic text.
    """
    # try/except: attempt the code in `try`, and if it raises the named kind
    # of error, run `except` instead of crashing. Everything in here can fail
    # on malformed input, so one try block covers the lot.
    try:
        # Splitting "3:0,3,5:kick.wav" on ":" with maxsplit=2 gives exactly
        # three pieces: it stops splitting after the second colon, so any
        # further colons stay inside the third piece (the path).
        # Assigning three names at once like this is "tuple unpacking" -- it
        # raises ValueError if there aren't exactly three pieces, which is
        # itself a useful check.
        beats_str, notes_str, rest = spec.split(":", maxsplit=2)

        # int() converts text to a whole number, raising ValueError on junk.
        beats = int(beats_str)

        # A "list comprehension": build a list by running an expression over
        # every item of something. This is the compact form of:
        #     notes = []
        #     for n in notes_str.split(","):
        #         notes.append(int(n))
        notes = [int(n) for n in notes_str.split(",")]
    except ValueError:
        # `from None` suppresses the "during handling of the above exception,
        # another occurred" chain that Python would otherwise print. The
        # underlying ValueError adds noise here -- our message is clearer.
        raise argparse.ArgumentTypeError(
            f"invalid layer {spec!r}: expected BEATS:NOTES:SAMPLE_PATH[:gain=G], "
            f"e.g. '3:0,3,5:kick.wav' or '3:0,3,5:kick.wav:gain=0.8'"
            # !r inside an f-string inserts the repr() of the value, i.e. with
            # quotes shown. Useful in errors so "3:0 " is visibly not "3:0".
        ) from None

    # Only a trailing ":gain=..." is treated as a gain, so sample paths that
    # themselves contain a colon still parse correctly.
    #
    # rpartition splits ONCE at the LAST occurrence and always returns three
    # values: everything before, the separator itself, everything after. If
    # the separator isn't found you get ("", "", original). We don't need the
    # separator, and `_` is the conventional name for "a value I must accept
    # but will not use".
    head, _, last_field = rest.rpartition(":")

    if last_field.startswith(GAIN_PREFIX):
        sample_path = head
        try:
            # Slicing: last_field[5:] is everything from index 5 onward, so
            # using len(GAIN_PREFIX) drops exactly the "gain=" part.
            gain = float(last_field[len(GAIN_PREFIX) :])
        except ValueError:
            raise argparse.ArgumentTypeError(
                f"invalid layer {spec!r}: gain "
                f"{last_field[len(GAIN_PREFIX):]!r} is not a number"
            ) from None
    else:
        # No gain suffix, so the whole remainder was the path. Assigning two
        # names from a comma-separated pair is tuple unpacking again.
        sample_path, gain = rest, 1.0

    # Validate AFTER parsing, so the messages can quote the actual values.
    # These are boundary checks: this is where input from outside the program
    # arrives, so this is where it gets verified.
    if beats < 1:
        raise argparse.ArgumentTypeError(
            f"invalid layer {spec!r}: beat count must be >= 1, got {beats}"
        )
    if gain < 0:
        raise argparse.ArgumentTypeError(
            f"invalid layer {spec!r}: gain must be >= 0, got {gain}"
        )
    # An empty string is "falsy" in Python, so `not sample_path` is True for
    # "" -- the idiomatic way to write "if this is empty".
    if not sample_path:
        raise argparse.ArgumentTypeError(f"invalid layer {spec!r}: no sample path")

    # Passing arguments by name (beats=beats) rather than by position. Slower
    # to type, but impossible to get the order wrong, and it reads clearly.
    return Layer(beats=beats, notes=notes, sample_path=sample_path, gain=gain)
