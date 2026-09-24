"""Reading a layer from the compact `--layer` command-line syntax.

    BEATS:NOTES:SAMPLE_PATH[:gain=G][:active=B,...][:degrees=D,...][:scale=S][:root=R]

The result is a spec entry -- the same dictionary shape a [[layer]] block in a
TOML file produces -- not a finished Layer. That way the command line and
config files feed one path into `piece.build_piece()`, and a piece typed on
the command line can be exported and reloaded exactly like one from a file.

Raises argparse.ArgumentTypeError rather than ValueError, because argparse
prints that type's message as-is but replaces any other with generic text of
its own. That makes this module the one place in the package that knows
argparse exists -- a small leak of command-line concerns, kept deliberately
contained here.
"""

import argparse
from pathlib import Path

from polyrhythm.layer import REST
from polyrhythm.spec import SpecError, layer_from_spec

# The optional `key=value` fields allowed on the end of a --layer spec.
# Kept as a tuple (immutable) since it never changes at runtime, and listed in
# one place so the parser and the error messages can't drift apart.
LAYER_OPTIONS = ("gain", "active", "degrees", "scale", "root")


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
    """Turn "3,5,8" into [3, 5, 8]. Active beats are always real numbers --
    silencing a beat is what active= is FOR, so a rest here would be noise."""
    try:
        return [int(n) for n in value.split(",")]
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"invalid layer {spec!r}: active beats {value!r} must be whole numbers, "
            f"e.g. 'active=3,5,8'"
        ) from None


def _parse_sequence(value: str, spec: str, what: str) -> list:
    """Turn "0,-,7" into [0, "-", 7], for notes and degrees alike.

    The rest marker is kept as "-" rather than turned into None, because this
    is still a spec -- what the user wrote -- and "-" is how a spec says rest.
    It becomes None later, when the spec is built into a Layer.

    The marker is compared as an exact string, so "-" is a rest while "-5" is
    still the number minus five -- no ambiguity between the two.
    """
    items: list = []
    for token in value.split(","):
        token = token.strip()
        if token == REST:
            items.append(REST)
            continue
        try:
            items.append(int(token))
        except ValueError:
            raise argparse.ArgumentTypeError(
                f"invalid layer {spec!r}: {what} {token!r} must be a whole number "
                f"or {REST!r} for a rest"
            ) from None
    return items


def parse_layer_arg(spec: str) -> dict:
    """Parse one --layer string into a spec entry, checking it on the way.

    The `-> dict` above is a hint saying this hands back a dictionary. Square
    brackets in the format string mean "optional part", and the optional
    parts may appear in any order.
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

    # Build the entry with only the keys that were actually given, exactly as
    # a [[layer]] block would contain only the lines someone wrote. An empty
    # notes field ("8::pluck.wav:degrees=1,3,5") means the pitches come from
    # degrees= instead, so no "notes" key at all.
    entry: dict = {"beats": beats, "sample": sample_path}
    if notes_str:
        entry["notes"] = _parse_sequence(notes_str, spec, "note")
    if "degrees" in options:
        entry["degrees"] = _parse_sequence(options["degrees"], spec, "degree")
    if "gain" in options:
        entry["gain"] = _parse_gain(options["gain"], spec)
    if "active" in options:
        entry["active"] = _parse_active(options["active"], spec)
    if "scale" in options:
        entry["scale"] = options["scale"]
    if "root" in options:
        entry["root"] = _parse_root(options["root"], spec)

    # Check it now, by building a Layer and throwing it away, so a mistake is
    # reported against the string that caused it rather than surfacing later
    # with less context. All the actual rules live in make_layer, reached via
    # the same function a config file uses.
    try:
        layer_from_spec(entry, base_dir=Path("."), where=f"invalid layer {spec!r}")
    except SpecError as e:
        raise argparse.ArgumentTypeError(str(e)) from None

    return entry
