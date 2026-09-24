"""The Piece: everything needed to render, fully worked out.

A spec is what the user wrote. A Piece is what that means: degrees resolved to
semitones, beats counted from 0, the tempo turned into an exact number of
audio samples per pulse, the length known to the sample. Nothing about a
Piece is left to interpret.

`build_piece()` is the only way to make one, and it is the single place where
a spec is checked and resolved. The command line calls it; a GUI will call
it; neither has to know how the tempo maths works. Before this existed, that
logic lived inside the command-line program, where nothing else could reach
it -- and a second copy written for a GUI would have drifted from the first
the moment either changed.
"""

import copy
from dataclasses import dataclass
from pathlib import Path

from polyrhythm.layer import Layer
from polyrhythm.schedule import lcm_of_beats
from polyrhythm.spec import SpecError, check_settings, layer_from_spec

DEFAULT_CYCLE_DURATION = 2.0
DEFAULT_SAMPLE_RATE = 44100


# frozen=True makes a Piece read-only once built. A Piece is a set of decisions
# already made; if something needs to change, build a new one from a changed
# spec. That rule is what lets several consumers -- the renderer, the
# visualiser, a JSON export -- share one Piece without worrying that another
# of them altered it underneath.
@dataclass(frozen=True)
class Piece:
    # A tuple rather than a list: tuples cannot be added to or reordered, which
    # suits a frozen object -- a frozen dataclass stops you *reassigning*
    # `layers`, but a list inside it could still be appended to.
    layers: tuple[Layer, ...]
    loops: int
    samples_per_pulse: int
    sample_rate: int
    # The cycle length asked for, or None when the tempo was given as a pulse
    # duration instead. Kept because the cycle actually produced can differ
    # slightly after rounding, and it is worth being able to say by how much.
    requested_cycle: float | None
    # The spec this was built from, with any command-line overrides applied.
    # Kept so the piece can be written back out as something a person can
    # read and edit -- degrees and all -- rather than as resolved semitones.
    spec: dict
    # Where relative paths in the spec are measured from.
    base_dir: Path
    # Things worth telling the user that are not errors. Returned as data
    # rather than printed, because a GUI has no terminal to print to.
    warnings: tuple[str, ...] = ()

    # @property turns a method into something read like a plain attribute:
    # `piece.cycle_duration`, no brackets. Used here for values that are
    # always derived from the fields above. Computing them on demand rather
    # than storing them means they can never disagree with those fields.

    @property
    def lcm_beats(self) -> int:
        """Pulses per cycle: the finest grid every layer's beats land on."""
        return lcm_of_beats(self.layers)

    @property
    def total_pulses(self) -> int:
        return self.loops * self.lcm_beats

    @property
    def pulse_duration(self) -> float:
        """Seconds per pulse, after rounding to a whole number of samples."""
        return self.samples_per_pulse / self.sample_rate

    @property
    def cycle_duration(self) -> float:
        """Seconds per cycle as actually rendered, which may differ slightly
        from `requested_cycle` because pulses are a whole number of samples."""
        return self.lcm_beats * self.samples_per_pulse / self.sample_rate

    @property
    def total_duration(self) -> float:
        return self.loops * self.cycle_duration


def build_piece(spec: dict, base_dir: Path | str = ".", source: str = "spec") -> Piece:
    """Check a spec and resolve it into a Piece, or raise SpecError saying why not.

    `base_dir` is where the spec's relative paths start from -- the config
    file's folder, or the current folder for a command line. `source` only
    appears in error messages, so a person can tell where the mistake is.

    Deliberately NOT checked here: the length limit. How long is too long is
    a policy for each front end to decide -- a command line refuses; a GUI
    might prefer to warn -- whereas everything below is simply true or false.
    """
    base_dir = Path(base_dir)
    settings = check_settings(spec, source)

    layers = tuple(
        layer_from_spec(
            entry,
            base_dir=base_dir,
            default_scale=settings["scale"],
            default_root=settings["root"],
            where=f"{source}: layer {index}",
        )
        # enumerate(..., start=1) counts from 1, so errors say "layer 1" for
        # the first layer, as a person would.
        for index, entry in enumerate(spec["layer"], start=1)
    )

    loops = settings.get("loops")
    if loops is None:
        raise SpecError("need loops: e.g. --loops 4 on the command line, or loops = 4 in a config")
    if loops < 1:
        raise SpecError(f"loops must be >= 1, got {loops}")

    sample_rate = settings.get("sample_rate", DEFAULT_SAMPLE_RATE)
    if sample_rate < 1:
        raise SpecError(f"sample_rate must be > 0, got {sample_rate}")

    lcm_beats = lcm_of_beats(layers)
    warnings = []

    # Two ways to set the tempo; check_settings has already refused both.
    if "pulse_duration" in settings:
        pulse_duration = settings["pulse_duration"]
        if pulse_duration <= 0:
            raise SpecError(f"pulse duration must be > 0, got {pulse_duration}")
        samples_per_pulse = int(round(pulse_duration * sample_rate))
        requested_cycle = None
    else:
        requested_cycle = settings.get("cycle_duration", DEFAULT_CYCLE_DURATION)
        if requested_cycle <= 0:
            raise SpecError(f"cycle duration must be > 0, got {requested_cycle}")
        # Share the cycle out across the grid. This is the line that makes
        # adding a layer subdivide the cycle rather than stretch it: a bigger
        # LCM produces a finer grid, not a longer piece.
        samples_per_pulse = int(round(requested_cycle * sample_rate / lcm_beats))

    if samples_per_pulse < 1:
        raise SpecError(
            f"a {requested_cycle}s cycle split across an LCM of {lcm_beats} pulses leaves "
            f"under one sample per pulse; lengthen the cycle or choose beat counts "
            f"sharing more common factors"
        )

    # Work back from the rounded integer to the cycle length we'll ACTUALLY
    # produce, which may differ slightly from what was asked for. Only worth
    # mentioning past 1% -- below that it's inaudible, and warning about the
    # inaudible teaches people to ignore warnings.
    actual_cycle = lcm_beats * samples_per_pulse / sample_rate
    if requested_cycle is not None and abs(actual_cycle - requested_cycle) > requested_cycle / 100:
        warnings.append(
            f"cycle rounded to {actual_cycle:.4f}s from {requested_cycle:.4f}s -- "
            f"an LCM of {lcm_beats} does not divide the sample rate evenly"
        )

    # Check every sample exists now, so a typo fails immediately rather than
    # part-way through rendering.
    missing = [layer.sample_path for layer in layers if not Path(layer.sample_path).is_file()]
    if missing:
        # join() glues a list of strings together with the given separator.
        raise SpecError("sample file not found: " + ", ".join(missing))

    return Piece(
        layers=layers,
        loops=loops,
        samples_per_pulse=samples_per_pulse,
        sample_rate=sample_rate,
        requested_cycle=requested_cycle,
        # A private copy, so the caller changing their dict afterwards cannot
        # reach into a Piece that is supposed to be fixed.
        spec=copy.deepcopy(spec),
        base_dir=base_dir,
        warnings=tuple(warnings),
    )
