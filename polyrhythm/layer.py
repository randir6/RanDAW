"""What a layer IS, and the rules a layer must obey.

This module is deliberately the "boring" one: it holds the data and the
validation, and knows nothing about audio, timing, files or the command line.
Reading a layer from text lives elsewhere -- `layer_arg.py` for the
`--layer` syntax, `spec.py` for config files and JSON -- and all of those end
up calling `make_layer()` below, so there is exactly one set of rules.
"""

from dataclasses import dataclass

from polyrhythm.scales import SCALES, degree_to_semitones, scale_names

# Written in a sequence where a pitch would go, this means "sound nothing
# here". It has to be a marker rather than a number because 0 is already a
# legitimate value in both notations -- unison in semitones, and one step
# below the root as a degree.
REST = "-"


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
    # Semitone offsets, e.g. [0, 3, 5]. None marks a rest: that position in
    # the sequence sounds nothing. By the time a Layer exists, scale degrees
    # have already been resolved to semitones, so this is the only pitch
    # representation the scheduler and renderer ever see.
    notes: list[int | None]
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
    # even though people write 1-based numbers the way musicians count. That
    # conversion happens once, in make_layer below. Converting at the boundary
    # and using one convention everywhere inside is the reliable way to avoid
    # off-by-one bugs.
    #
    # The default is None rather than an empty set for a specific Python
    # reason: a mutable default like `= set()` would be created ONCE and
    # shared by every Layer, so adding to one layer's set would silently
    # affect all the others. None sidesteps the trap entirely.
    active_beats: set[int] | None = None

    # --- What the user wrote, kept for display only ---------------------------
    # None of the fields below affect the sound. `notes` above is already the
    # final answer. These exist so something drawing the piece can show the
    # user's own notation -- "degree 3 of dorian" rather than "3 semitones" --
    # which would otherwise be lost the moment degrees were resolved.
    #
    # `written` is the sequence exactly as given (degrees or semitones, with
    # None for rests). None here means "same as notes", which is what a Layer
    # built directly -- as the checks do -- gets without having to say so.
    written: list[int | None] | None = None
    pitch_kind: str = "notes"  # "notes" or "degrees"
    scale: str | None = None
    root: int = 0


def make_layer(
    beats: int,
    sample_path: str,
    notes: list[int | None] | None = None,
    degrees: list[int | None] | None = None,
    scale: str | None = None,
    root: int = 0,
    gain: float = 1.0,
    active: list[int] | None = None,
) -> Layer:
    """Validate the pieces of a layer and build one.

    Every way of describing a layer ends up here, so the rules live in exactly
    one place and cannot drift apart as the front ends grow. Raises plain
    ValueError; each caller wraps it with its own context (which --layer
    string, or which entry in which file).

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
        written, pitch_kind = list(degrees), "degrees"
        # Degrees become semitones, and rests stay rests. A conditional
        # expression inside a comprehension: VALUE_IF if TEST else VALUE_ELSE,
        # evaluated for every item.
        notes = [None if d is None else degree_to_semitones(d, scale, root) for d in degrees]
    elif scale is not None:
        # A scale alongside raw semitones means someone expected the numbers
        # to be degrees. Better to say so than to silently ignore the scale.
        raise ValueError("scale given but pitches are notes (semitones); use degrees instead")
    else:
        written, pitch_kind = list(notes), "notes"

    if not notes:
        raise ValueError("note sequence must not be empty")
    # all() is True for an empty sequence, but the check above has already
    # ruled that out, so this can only mean every position is a rest.
    if all(n is None for n in notes):
        raise ValueError("sequence is all rests, so the layer would never sound")
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
        beats=beats,
        notes=notes,
        sample_path=sample_path,
        gain=gain,
        active_beats=active,
        written=written,
        pitch_kind=pitch_kind,
        scale=scale,
        root=root,
    )
