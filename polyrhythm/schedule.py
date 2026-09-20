"""Working out WHEN every note happens. No audio anywhere in this file.

This is the musical heart of the project. Keeping it free of numpy and
soundfile isn't tidiness for its own sake: a MIDI exporter or a browser
visualiser wants this timing information and has no use for waveforms, so
they can import this module without dragging in the audio machinery.
"""

import math
from dataclasses import dataclass

from polyrhythm.layer import Layer


# frozen=True makes instances read-only: once an Event exists you cannot
# change its fields. Two reasons that's worth having. First, a schedule is a
# record of decisions already made, and accidental edits would be bugs.
# Second, frozen dataclasses are "hashable", so they can go in sets and be
# used as dictionary keys -- handy later.
@dataclass(frozen=True)
class Event:
    """One note: which layer it came from, where it lands on the shared pulse
    grid, and everything needed to sound it.

    Deliberately self-contained -- a consumer can render it, export it as
    MIDI or draw it without needing the Layer it came from.
    """

    layer: int  # index into the original layer list, for grouping/colouring
    pulse: int  # position on the shared grid (see schedule() below)
    semitones: int
    sample_path: str
    gain: float


def lcm_of_beats(layers: list[Layer]) -> int:
    """Lowest common multiple of all the layers' beat counts.

    LCM is the smallest number every input divides into exactly: for 3 and 4
    it's 12, since that's the first number both 3 and 4 go into.

    The * in `math.lcm(*(...))` is "unpacking": math.lcm wants separate
    arguments, lcm(3, 4, 5), but we have a sequence. The star spreads the
    sequence out into individual arguments. Without it we'd be passing one
    generator object and math.lcm would reject it.
    """
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

    Worked example, a 3-beat layer against a 4-beat one:

        LCM(3, 4) = 12, so one cycle is 12 pulses long.
        The 3-beat layer steps 12 // 3 = 4 pulses between hits -> 0, 4, 8
        The 4-beat layer steps 12 // 4 = 3 pulses between hits -> 0, 3, 6, 9

        pulse:  0  1  2  3  4  5  6  7  8  9 10 11
        3-beat: x        .  x     .     x     .
        4-beat: x     .     .  x     .     x

    Both fill the same 12 pulses, so both complete one loop in the same
    amount of time. That is the whole trick.
    """
    lcm_beats = lcm_of_beats(layers)

    # A list comprehension with three `for` clauses. Read them top to bottom
    # as nested loops -- the first is the outermost:
    #
    #     for layer_idx, layer in enumerate(layers):
    #         for loop_idx in range(loops):
    #             for beat_idx in range(layer.beats):
    #                 events.append(Event(...))
    #
    # enumerate() yields (position, item) pairs, so we get the layer's index
    # without having to count manually.
    events = [
        Event(
            layer=layer_idx,
            # Where this beat lands. Two parts added together:
            #   loop_idx * lcm_beats     -- skip past whole completed cycles
            #   beat_idx * (lcm // beats) -- step along within this cycle
            # `//` is floor division (whole-number result). Plain `/` would
            # give a float like 4.0, and we need an exact integer index.
            # This division is always exact anyway, because the LCM is by
            # definition a multiple of every layer's beat count.
            pulse=loop_idx * lcm_beats + beat_idx * (lcm_beats // layer.beats),
            # Which note this beat plays.
            #
            # (loop_idx * layer.beats + beat_idx) counts this layer's beats
            # from the very start, continuing across loops rather than
            # restarting -- so a 3-beat layer's 2nd loop starts at beat 3.
            #
            # `% len(layer.notes)` is the remainder after division, which
            # wraps the counter back round to 0 when it runs off the end of
            # the note list. With 5 notes: 0,1,2,3,4,0,1,2...
            #
            # Because the beat counter keeps running, a 5-note sequence on a
            # 3-beat layer lines up differently on each cycle -- the note
            # sequence phases against the beat count. That's not an accident
            # of the code, it's the behaviour the vision asks for.
            semitones=layer.notes[(loop_idx * layer.beats + beat_idx) % len(layer.notes)],
            # Copied onto the event rather than referenced, so the event can
            # be rendered or exported without access to the Layer.
            sample_path=layer.sample_path,
            gain=layer.gain,
        )
        for layer_idx, layer in enumerate(layers)
        for loop_idx in range(loops)
        for beat_idx in range(layer.beats)
    ]

    # Built layer by layer above, so re-sort into time order: a schedule
    # should read like a timeline. `key` tells sort what to compare -- here a
    # tuple, which compares left to right, so events at the same pulse are
    # then ordered by layer to keep the result predictable rather than
    # depending on whatever order the sort happened to encounter them.
    #
    # `lambda` is just a small unnamed function: `lambda e: e.pulse` means
    # "given e, give me e.pulse".
    #
    # .sort() rearranges the list in place and returns None -- which is why
    # this is its own statement rather than `events = events.sort(...)`, a
    # classic Python trap that would leave `events` set to None.
    events.sort(key=lambda event: (event.pulse, event.layer))
    return events
