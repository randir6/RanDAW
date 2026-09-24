"""Working out WHEN every note happens. No audio anywhere in this file.

This is the musical heart of the project. Keeping it free of numpy and
soundfile isn't tidiness for its own sake: a MIDI exporter or a browser
visualiser wants this timing information and has no use for waveforms, so
they can import this module without dragging in the audio machinery.

Two views of the same thing come out of here:

  * the GRID -- every beat of every layer in every cycle, including the ones
    that stay silent. What a picture of the piece needs.
  * the SCHEDULE -- only the beats that actually sound. What the renderer
    needs.

Both come from one loop (`_walk` below), so they cannot disagree about where
anything falls.
"""

import math
from collections.abc import Iterator
from dataclasses import dataclass

from polyrhythm.layer import Layer

# What happened at one position in the grid. Plain strings rather than
# anything cleverer, because they go straight into JSON for the visualiser.
# Prefixed STATUS_ so they cannot be confused with layer.REST, which is the
# "-" marker a person types -- a different thing at a different stage.
STATUS_NOTE = "note"          # this beat sounds
STATUS_REST = "rest"          # the sequence has a rest here: travels with the sequence
STATUS_INACTIVE = "inactive"  # this beat is switched off: same place every cycle


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
    beat: int   # which of its layer's beats, counting from 0 within the cycle
    pulse: int  # position on the shared grid (see _walk() below)
    semitones: int
    sample_path: str
    gain: float


@dataclass(frozen=True)
class Cell:
    """One beat of one layer in one cycle -- sounding or not.

    The grid is a list of these. Unlike an Event, a Cell exists for a silent
    beat too, which is the whole point: you cannot draw a rest, or see where
    it falls against the other layers, from a list that leaves it out.
    """

    layer: int
    cycle: int  # which cycle, counting from 0
    beat: int   # which of the layer's beats within that cycle, from 0
    pulse: int  # absolute position on the shared grid
    step: int   # which position in the layer's sequence this beat reads
    status: str  # STATUS_NOTE, STATUS_REST or STATUS_INACTIVE
    # The resolved pitch. None for a rest; for an inactive beat, the pitch it
    # WOULD have played, kept so a display can show it greyed out if it likes.
    semitones: int | None


def lcm_of_beats(layers) -> int:
    """Lowest common multiple of all the layers' beat counts.

    LCM is the smallest number every input divides into exactly: for 3 and 4
    it's 12, since that's the first number both 3 and 4 go into.

    The * in `math.lcm(*(...))` is "unpacking": math.lcm wants separate
    arguments, lcm(3, 4, 5), but we have a sequence. The star spreads the
    sequence out into individual arguments. Without it we'd be passing one
    generator object and math.lcm would reject it.
    """
    return math.lcm(*(layer.beats for layer in layers))


def _walk(layers, loops: int) -> Iterator[Cell]:
    """Visit every beat of every layer in every cycle, saying what happens there.

    This is the single loop both the grid and the schedule are built from.

    It is a GENERATOR: `yield` hands back one Cell and pauses the function
    right there, resuming from the same spot when the next Cell is asked for.
    Nothing is stored along the way, and each caller decides what to keep --
    grid() keeps everything, schedule() keeps only the notes.

    The shared timeline is divided into pulses: the finest grid on which every
    layer's beats land. A layer with `beats` beats fires once every
    (lcm_beats // beats) pulses, so all layers complete one full loop in the
    same span -- that's what makes it a polyrhythm rather than beats of
    different lengths playing side by side.

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

    # Plain nested loops. enumerate() yields (position, item) pairs, so we get
    # each layer's index without having to count manually.
    for layer_idx, layer in enumerate(layers):
        # How many pulses pass between this layer's own beats. The division is
        # always exact, because the LCM is by definition a multiple of every
        # layer's beat count. `//` is floor division, giving a whole number --
        # plain `/` would give 4.0, a float, which cannot be used as an index.
        pulses_per_beat = lcm_beats // layer.beats

        for loop_idx in range(loops):
            for beat_idx in range(layer.beats):
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
                step = occurrence % len(layer.notes)
                semitones = layer.notes[step]

                # What happens here. The order of these tests matters: a beat
                # that is switched off is silent whatever the sequence says.
                #
                # STATUS_INACTIVE -- beat skipping. The same beat is silent every
                # cycle. Note that it does NOT hold the sequence back: the note
                # this beat would have played is simply not heard, rather than
                # sliding forward onto the next beat. Muting a step on a drum
                # machine rather than deleting it. The alternative is on the
                # backlog in NOTES.md.
                #
                # STATUS_REST -- a None in the sequence. A rest travels with the
                # SEQUENCE, so when the sequence and the beat count are
                # different lengths, the silence lands on a different beat
                # each time round. (Whether that is the right behaviour is an
                # open question in NOTES.md.)
                if layer.active_beats is not None and beat_idx not in layer.active_beats:
                    status = STATUS_INACTIVE
                elif semitones is None:
                    status = STATUS_REST
                else:
                    status = STATUS_NOTE

                yield Cell(
                    layer=layer_idx,
                    cycle=loop_idx,
                    beat=beat_idx,
                    # Two parts added: whole cycles already elapsed, plus the
                    # step reached within this cycle.
                    pulse=loop_idx * lcm_beats + beat_idx * pulses_per_beat,
                    step=step,
                    status=status,
                    semitones=semitones,
                )


def grid(layers, loops: int) -> list[Cell]:
    """Every beat of every layer in every cycle, silent ones included, in
    time order. What a picture of the piece is drawn from."""
    cells = list(_walk(layers, loops))
    # Same ordering rule as schedule() below, so the two line up.
    cells.sort(key=lambda cell: (cell.pulse, cell.layer))
    return cells


def schedule(layers, loops: int) -> list[Event]:
    """Every note in the piece, in time order. What the renderer plays.

    Built from the same walk as the grid, keeping only the beats that sound.
    """
    events = [
        Event(
            layer=cell.layer,
            beat=cell.beat,
            pulse=cell.pulse,
            semitones=cell.semitones,
            # Copied onto the event rather than referenced, so it can be
            # rendered or exported without the Layer.
            sample_path=layers[cell.layer].sample_path,
            gain=layers[cell.layer].gain,
        )
        for cell in _walk(layers, loops)
        if cell.status == STATUS_NOTE
    ]

    # Built layer by layer, so re-sort into time order: a schedule should
    # read like a timeline. `key` tells sort what to compare -- here a tuple,
    # which compares left to right, so events at the same pulse are then
    # ordered by layer to keep the result predictable rather than depending on
    # whatever order the sort happened to encounter them.
    #
    # `lambda` is just a small unnamed function: `lambda e: e.pulse` means
    # "given e, give me e.pulse".
    #
    # .sort() rearranges the list in place and returns None -- which is why
    # this is its own statement rather than `events = events.sort(...)`, a
    # classic Python trap that would leave `events` set to None.
    events.sort(key=lambda event: (event.pulse, event.layer))
    return events
