#!/usr/bin/env python3
"""The command-line front end: the bit you actually run.

Its job is everything to do with the OUTSIDE world -- reading arguments,
checking them, catching bad input, writing the file. The musical logic all
lives in the polyrhythm/ package. Keeping that separation means a different
front end (a config file reader, a web UI) can reuse the core untouched.

The first line above is a "shebang": on Mac/Linux it lets the file be run
directly as ./generate.py rather than `python3 generate.py`.
"""

import argparse
from pathlib import Path

import numpy as np
import soundfile as sf

from polyrhythm.config import ConfigError, load_config
from polyrhythm.layer import parse_layer_arg
from polyrhythm.render import render_audio
from polyrhythm.schedule import lcm_of_beats, schedule

DEFAULT_CYCLE_DURATION = 2.0
DEFAULT_MAX_DURATION = 120.0


def build_parser():
    """Describe every option. argparse turns this into parsing, --help text,
    and error messages, so the description IS the implementation."""
    parser = argparse.ArgumentParser(
        description="Generate a polyrhythmic audio sequence from overlaid layers."
    )
    parser.add_argument(
        "--config",
        help="Read the piece from a TOML file. Anything also given on the "
        "command line overrides the file, so --loops 1 makes a quick preview "
        "without editing it. Paths inside the file resolve relative to the "
        "file itself.",
    )
    parser.add_argument(
        "--layer",
        # Without this the value would land in args.layer; we want args.layers
        # because it collects several.
        dest="layers",
        # "append" means each --layer adds to a list rather than replacing the
        # previous one. This is what makes N layers work with no code change.
        action="append",
        # Not required, because --config is the alternative. Which of the two
        # was supplied is checked in main().
        # `type` takes any function that converts a string. Our parser returns
        # a Layer, so args.layers arrives as a list of Layer objects with the
        # parsing and validation already done.
        type=parse_layer_arg,
        # Shown in --help and error messages in place of "LAYER".
        metavar="BEATS:NOTES:SAMPLE[:gain=G][:active=B,...]",
        help="One layer, e.g. '3:0,3,5:kick.wav' or '13:0:tom.wav:active=3,5,8'. "
        "Repeat for more layers. Notes are semitone offsets and loop over the "
        "layer's own beats. gain= defaults to 1.0 (unity). active= lists which "
        "of the layer's own beats sound, counting from 1; all of them by default.",
    )
    # These default to None rather than to their real defaults so that main()
    # can tell "the user asked for this" from "nothing was said", which is what
    # makes overriding a config possible.
    parser.add_argument("--loops", type=int, help="Number of LCM cycles to render.")
    parser.add_argument("--out", help="Output WAV path.")

    # A mutually exclusive group: argparse refuses if both are given, since
    # they set the same underlying quantity two different ways.
    tempo = parser.add_mutually_exclusive_group()
    tempo.add_argument(
        "--cycle-duration",
        type=float,
        help=f"Seconds for one full polyrhythm cycle: the span every layer "
        f"divides into its own beat count. Adding a layer subdivides this span "
        f"rather than stretching it. Default: {DEFAULT_CYCLE_DURATION}",
    )
    tempo.add_argument(
        "--pulse-duration",
        type=float,
        help="Low-level alternative: seconds per pulse (the LCM grid step). "
        "Cycle length then follows from the layers' LCM, so adding a layer "
        "changes the felt tempo of every other layer.",
    )

    parser.add_argument(
        "--max-duration",
        type=float,
        help=f"Refuse to render longer than this many seconds. "
        f"Default: {DEFAULT_MAX_DURATION:.0f}",
    )
    parser.add_argument("--sample-rate", type=int)
    parser.add_argument(
        "--dump-schedule",
        # "store_true" makes this a flag: present means True, absent False.
        # No value follows it on the command line.
        action="store_true",
        help="Print every note the render will place, then render as usual.",
    )
    return parser


def main():
    parser = build_parser()
    # Reads sys.argv, applies every rule above, and exits with a usage message
    # if anything is wrong. Note that --layer strings are already Layer
    # objects by the time they land here.
    args = parser.parse_args()

    # parser.error() prints the message plus usage and exits with status 2.
    # Exit codes matter for scripting: 0 means success, anything else failure,
    # and 2 is the convention for "you used this command wrong".
    if args.config and args.layers:
        parser.error("use --config or --layer, not both")
    if not args.config and not args.layers:
        parser.error("need either --config FILE or at least one --layer")

    if args.config:
        try:
            layers, settings = load_config(args.config)
        except ConfigError as e:
            parser.error(str(e))
    else:
        layers, settings = args.layers, {}

    # Resolve each setting: what the command line said, else what the file
    # said, else the built-in default. `is not None` throughout rather than a
    # truth test, because 0 is falsy and would be mistaken for "not given".
    def setting(name, cli_value, default):
        if cli_value is not None:
            return cli_value
        return settings.get(name, default)

    loops = setting("loops", args.loops, None)
    if loops is None:
        parser.error("need --loops, on the command line or in the config")
    out_path = setting("out", args.out, None)
    if out_path is None:
        parser.error("need --out, on the command line or in the config")
    sample_rate = setting("sample_rate", args.sample_rate, 44100)
    max_duration = setting("max_duration", args.max_duration, DEFAULT_MAX_DURATION)

    if loops < 1:
        parser.error(f"--loops must be >= 1, got {loops}")

    lcm_beats = lcm_of_beats(layers)

    # Tempo is handled apart from the rest because the two settings are
    # alternatives, not values to merge: naming either one on the command line
    # replaces whichever the config chose.
    if args.pulse_duration is not None or args.cycle_duration is not None:
        pulse_duration, requested_cycle = args.pulse_duration, args.cycle_duration
    else:
        pulse_duration = settings.get("pulse_duration")
        requested_cycle = settings.get("cycle_duration")

    if pulse_duration is not None:
        if pulse_duration <= 0:
            parser.error(f"pulse duration must be > 0, got {pulse_duration}")
        samples_per_pulse = int(round(pulse_duration * sample_rate))
        requested_cycle = None
    else:
        if requested_cycle is None:
            requested_cycle = DEFAULT_CYCLE_DURATION
        if requested_cycle <= 0:
            parser.error(f"cycle duration must be > 0, got {requested_cycle}")
        # Share the cycle out across the grid. This is the line that makes
        # adding a layer subdivide the cycle rather than stretch it: a bigger
        # LCM produces a finer grid, not a longer piece.
        samples_per_pulse = int(round(requested_cycle * sample_rate / lcm_beats))

    if samples_per_pulse < 1:
        parser.error(
            f"a {requested_cycle}s cycle split across an LCM of {lcm_beats} pulses leaves "
            f"under one sample per pulse; lengthen --cycle-duration or choose beat counts "
            f"sharing more common factors"
        )

    # Work back from the rounded integer to the cycle length we'll ACTUALLY
    # produce, which may differ slightly from what was asked for.
    cycle_duration = lcm_beats * samples_per_pulse / sample_rate
    if requested_cycle is not None and abs(cycle_duration - requested_cycle) > requested_cycle / 100:
        # Only complain past 1% -- below that it's inaudible, and warning
        # about the inaudible teaches people to ignore warnings.
        print(
            f"warning: cycle rounded to {cycle_duration:.4f}s from {requested_cycle:.4f}s -- "
            f"an LCM of {lcm_beats} does not divide the sample rate evenly"
        )

    total_duration = loops * cycle_duration
    if total_duration > max_duration:
        parser.error(
            f"that would render {total_duration:.1f}s of audio "
            f"({loops} loops of a {cycle_duration:.2f}s cycle), over the "
            f"{max_duration:.0f}s limit. Render a shorter file with fewer --loops "
            f"or a shorter --cycle-duration, or raise --max-duration."
        )

    # Check every file exists BEFORE rendering, so a typo fails immediately
    # rather than part-way through the work.
    missing = [layer.sample_path for layer in layers if not Path(layer.sample_path).is_file()]
    if missing:
        # join() glues a list of strings together with the given separator.
        parser.error("sample file not found: " + ", ".join(missing))

    # Decide what happens when. Cheap -- well under a millisecond.
    events = schedule(layers, loops)

    if args.dump_schedule:
        print(f"{len(events)} events over {loops} x {cycle_duration:.3f}s cycle")
        # Format specs inside f-strings: {x:>9} right-aligns in 9 characters,
        # {x:6d} is an integer padded to 6, {x:+5d} always shows the sign, and
        # {x:.4f} is 4 decimal places. Together they line the columns up.
        print(f"{'time':>9}  {'pulse':>6}  {'layer':>5}  {'semis':>5}  gain  sample")
        for event in events:
            seconds = event.pulse * samples_per_pulse / sample_rate
            print(
                f"{seconds:9.4f}  {event.pulse:6d}  {event.layer:5d}  {event.semitones:+5d}  "
                f"{event.gain:.2f}  {Path(event.sample_path).name}"
            )

    try:
        mix = render_audio(
            events=events,
            total_pulses=loops * lcm_beats,
            samples_per_pulse=samples_per_pulse,
            sample_rate=sample_rate,
        )
    except sf.LibsndfileError as e:
        # The file exists (we checked) but isn't readable audio -- a renamed
        # text file, say. Turn the library's raw error into a plain sentence.
        raise SystemExit(f"could not read sample: {e}")

    # Samples above 1.0 can't be stored and would distort. float() converts
    # numpy's own float type to a plain Python one for tidier formatting.
    peak = float(np.abs(mix).max())
    if peak > 1.0:
        print(
            f"warning: mix peaked at {peak:.2f} and was clipped -- "
            # 0.99 rather than 1.0 so following this advice actually clears
            # the warning instead of landing exactly on the boundary again.
            f"scale the layers down, e.g. add ':gain={0.99 / peak:.2f}' to each"
        )
        # Force everything into range. Crude (it flattens the peaks, which is
        # audible as distortion) but better than the alternative, which is
        # values wrapping around into loud noise.
        mix = np.clip(mix, -1.0, 1.0)

    # soundfile picks 16-bit PCM for .wav by default, which is what we want
    # for samplers like Koala. See NOTES.md -- it's a library default we rely
    # on rather than something this line states.
    sf.write(out_path, mix, sample_rate)
    print(
        f"wrote {out_path}: {len(mix)} samples ({len(mix) / sample_rate:.2f}s, "
        f"{loops} x {cycle_duration:.3f}s cycle, peak {min(peak, 1.0):.2f})"
    )


# True only when this file is run directly, False when it's imported by
# another module. Without the guard, importing anything from this file would
# immediately try to parse command-line arguments and render audio.
if __name__ == "__main__":
    main()
