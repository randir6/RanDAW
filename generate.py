#!/usr/bin/env python3
"""The command-line front end: the bit you actually run.

Its job is everything to do with the OUTSIDE world -- reading arguments,
turning them into a spec, reporting problems, writing files. Everything
musical, including working out what a spec means, lives in the polyrhythm/
package. That separation is what lets another front end (a GUI) reuse the
core untouched.

The flow, start to finish:

    arguments / config file  ->  spec          (what the user wrote)
    spec                     ->  Piece         (build_piece: checked, resolved)
    Piece                    ->  events        (schedule: when every note happens)
    events                   ->  audio         (render_audio)
    audio                    ->  .wav file

The first line above is a "shebang": on Mac/Linux it lets the file be run
directly as ./generate.py rather than `python3 generate.py`.
"""

import argparse
from pathlib import Path

import numpy as np
import soundfile as sf

from polyrhythm.export import write_export
from polyrhythm.layer_arg import parse_layer_arg
from polyrhythm.piece import DEFAULT_CYCLE_DURATION, build_piece
from polyrhythm.render import render_audio
from polyrhythm.schedule import schedule
from polyrhythm.spec import SpecError, read_spec

DEFAULT_MAX_DURATION = 120.0


def build_parser():
    """Describe every option. argparse turns this into parsing, --help text,
    and error messages, so the description IS the implementation."""
    parser = argparse.ArgumentParser(
        description="Generate a polyrhythmic audio sequence from overlaid layers."
    )
    parser.add_argument(
        "--config",
        help="Read the piece from a TOML or JSON file. Anything also given on "
        "the command line overrides the file, so --loops 1 makes a quick preview "
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
        # `type` takes any function that converts a string. Ours returns a
        # spec entry -- the same shape as a [[layer]] block in a config -- and
        # has already checked it, so mistakes are reported immediately.
        type=parse_layer_arg,
        # Shown in --help and error messages in place of "LAYER".
        metavar="BEATS:NOTES:SAMPLE[:opt=v...]",
        help="One layer, e.g. '3:0,3,5:kick.wav' or '13:0:tom.wav:active=3,5,8'. "
        "Repeat for more layers. Notes are semitone offsets looping over the "
        "layer's own beats. Options, in any order: gain= (default 1.0), "
        "active= which beats sound counting from 1 (default all), degrees= "
        "with scale= to give pitches as scale degrees instead of semitones "
        "(leave the notes field empty, e.g. '8::pluck.wav:degrees=1,3,5:"
        "scale=dorian'), and root= to transpose by semitones. A '-' in place "
        "of a note or degree is a rest, sounding nothing at that position.",
    )
    # These default to None rather than to their real defaults so that main()
    # can tell "the user asked for this" from "nothing was said", which is what
    # makes overriding a config possible.
    parser.add_argument("--loops", type=int, help="Number of cycles to render.")
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
        "--export-json",
        metavar="FILE",
        help="Also write the piece as JSON: the spec (which --config reads back "
        "in) plus its timing and a grid of every beat, silent ones included.",
    )
    parser.add_argument(
        "--dump-schedule",
        # "store_true" makes this a flag: present means True, absent False.
        # No value follows it on the command line.
        action="store_true",
        help="Print every note the render will place, then render as usual.",
    )
    return parser


def apply_overrides(spec: dict, args) -> dict:
    """Lay the command-line settings over the spec's own.

    Returns a new dict rather than changing the one passed in -- the caller's
    spec stays as it was read. A shallow copy (`dict(spec)`) is enough here
    because only top-level keys are replaced; the layer list is shared but
    never modified.

    The result is what actually gets rendered, so it is also what an export
    should record: re-rendering from it reproduces this exact run.
    """
    spec = dict(spec)
    for key, value in [
        ("loops", args.loops),
        ("sample_rate", args.sample_rate),
        ("max_duration", args.max_duration),
    ]:
        # `is not None` rather than a truth test, because 0 is falsy and would
        # be mistaken for "not given" instead of being rejected as invalid.
        if value is not None:
            spec[key] = value

    # Tempo is handled apart from the rest because the two settings are
    # alternatives, not values to merge: naming either on the command line
    # replaces whichever the config chose.
    if args.pulse_duration is not None or args.cycle_duration is not None:
        # dict.pop(key, None) removes a key if present and does nothing if not.
        spec.pop("pulse_duration", None)
        spec.pop("cycle_duration", None)
        if args.pulse_duration is not None:
            spec["pulse_duration"] = args.pulse_duration
        else:
            spec["cycle_duration"] = args.cycle_duration
    return spec


def main():
    parser = build_parser()
    # Reads sys.argv, applies every rule above, and exits with a usage message
    # if anything is wrong. Note that --layer strings are already checked spec
    # entries by the time they land here.
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
            spec, base_dir = read_spec(args.config)
        except SpecError as e:
            parser.error(str(e))
        source = args.config
    else:
        # A command line's layers become a spec of the same shape a config file
        # produces, so from here on there is only one path.
        spec, base_dir, source = {"layer": args.layers}, Path("."), "command line"

    spec = apply_overrides(spec, args)

    try:
        piece = build_piece(spec, base_dir, source)
    except SpecError as e:
        parser.error(str(e))

    for warning in piece.warnings:
        print(f"warning: {warning}")

    # --out on the command line is relative to where you are; `out` inside a
    # config is relative to the config, like every other path in it.
    if args.out is not None:
        out_path = args.out
    elif "out" in spec:
        out_path = str(base_dir / spec["out"])
    else:
        out_path = None

    # Something has to be produced. Audio only when something needs it -- a
    # JSON export on its own never has to render a note.
    if out_path is None and args.export_json is None:
        parser.error(
            "need --out (or --export-json), on the command line or in the config"
        )

    # The length limit is policy, so it lives here in the front end rather
    # than in build_piece: a GUI might sensibly choose differently.
    max_duration = spec.get("max_duration", DEFAULT_MAX_DURATION)
    if piece.total_duration > max_duration:
        parser.error(
            f"that would render {piece.total_duration:.1f}s of audio "
            f"({piece.loops} loops of a {piece.cycle_duration:.2f}s cycle), over the "
            f"{max_duration:.0f}s limit. Render a shorter file with fewer --loops "
            f"or a shorter --cycle-duration, or raise --max-duration."
        )

    if args.export_json:
        data = write_export(piece, args.export_json)
        derived = data["derived"]
        sounding = sum(1 for c in derived["cells"] if c["status"] == "note")
        print(
            f"wrote {args.export_json}: {len(derived['cells'])} beats, "
            f"{sounding} sounding, {len(derived['coincidences'])} coincidences"
        )

    if out_path is None:
        return

    # Decide what happens when. Cheap -- well under a millisecond.
    events = schedule(piece.layers, piece.loops)

    if args.dump_schedule:
        print(f"{len(events)} events over {piece.loops} x {piece.cycle_duration:.3f}s cycle")
        # Format specs inside f-strings: {x:>9} right-aligns in 9 characters,
        # {x:6d} is an integer padded to 6, {x:+5d} always shows the sign, and
        # {x:.4f} is 4 decimal places. Together they line the columns up.
        print(f"{'time':>9}  {'pulse':>6}  {'layer':>5}  {'semis':>5}  gain  sample")
        for event in events:
            seconds = event.pulse * piece.pulse_duration
            print(
                f"{seconds:9.4f}  {event.pulse:6d}  {event.layer:5d}  {event.semitones:+5d}  "
                f"{event.gain:.2f}  {Path(event.sample_path).name}"
            )

    try:
        mix = render_audio(
            events=events,
            total_pulses=piece.total_pulses,
            samples_per_pulse=piece.samples_per_pulse,
            sample_rate=piece.sample_rate,
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
    sf.write(out_path, mix, piece.sample_rate)
    print(
        f"wrote {out_path}: {len(mix)} samples ({len(mix) / piece.sample_rate:.2f}s, "
        f"{piece.loops} x {piece.cycle_duration:.3f}s cycle, peak {min(peak, 1.0):.2f})"
    )


# True only when this file is run directly, False when it's imported by
# another module. Without the guard, importing anything from this file would
# immediately try to parse command-line arguments and render audio.
if __name__ == "__main__":
    main()
