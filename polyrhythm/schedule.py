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

    events = []

    # Written as plain nested loops rather than a comprehension. It started as
    # one, but a second reason to skip a beat turned the filter into something
    # harder to read than the loop it replaced. `continue` says "skip this one"
    # far more plainly than a compound condition.
    #
    # enumerate() yields (position, item) pairs, so we get each layer's index
    # without having to count manually.
    for layer_idx, layer in enumerate(layers):
        # How many pulses pass between this layer's own beats. The division is
        # always exact, because the LCM is by definition a multiple of every
        # layer's beat count. `//` is floor division, giving a whole number --
        # plain `/` would give 4.0, a float, which cannot be used as an index.
        pulses_per_beat = lcm_beats // layer.beats

        for loop_idx in range(loops):
            for beat_idx in range(layer.beats):
                # Reason to skip #1: beat skipping. This beat of the layer is
                # silenced, so it never becomes an event at all.
                #
                # Note what this does NOT do -- it doesn't touch the note
                # counter below. The note a beat plays is decided by its
                # position in the sequence whether or not it sounds, so
                # silencing beat 2 silences that beat's note rather than
                # sliding the next note into its place. Muting a step on a
                # drum machine rather than deleting it. See NOTES.md for the
                # alternative, which is on the backlog.
                if layer.active_beats is not None and beat_idx not in layer.active_beats:
                    continue

                # Count this layer's beats from the very start, continuing
                # across loops rather than restarting, so a 3-beat layer's
                # second cycle begins at beat 3 of the sequence.
                occurrence = loop_idx * layer.beats + beat_idx

                # `%` is the remainder after division, wrapping the counter
                # back to 0 when it runs off the end. With 5 notes the indices
                # go 0,1,2,3,4,0,1,2...
                #
                # Because the counter keeps running, a 5-note sequence on a
                # 3-beat layer lines up differently each cycle -- the sequence
                # phases against the beat count. Give the sequence a length
                # equal to the beat count, or a multiple of it, and you get a
                # plainly composed pattern instead. Both are the same model.
                semitones = layer.notes[occurrence % len(layer.notes)]

                # Reason to skip #2: a rest. None marks a position in the
                # sequence that sounds nothing.
                #
                # Worth seeing how this differs from beat skipping above. An
                # inactive beat is silent on the same beat every single cycle.
                # A rest travels with the SEQUENCE, so when the sequence and
                # the beat count are different lengths, the silence lands on a
                # different beat each time round.
                if semitones is None:
                    continue

                events.append(
                    Event(
                        layer=layer_idx,
                        # Two parts added: whole cycles already elapsed, plus
                        # the step reached within this cycle.
                        pulse=loop_idx * lcm_beats + beat_idx * pulses_per_beat,
                        semitones=semitones,
                        # Copied onto the event rather than referenced, so it
                        # can be rendered or exported without the Layer.
                        sample_path=layer.sample_path,
                        gain=layer.gain,
                    )
                )

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
