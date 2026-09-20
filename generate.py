#!/usr/bin/env python3
import argparse
from pathlib import Path

import numpy as np
import soundfile as sf

from polyrhythm.layer import parse_layer_arg
from polyrhythm.render import lcm_of_beats, render

DEFAULT_CYCLE_DURATION = 2.0
DEFAULT_MAX_DURATION = 120.0


def build_parser():
    parser = argparse.ArgumentParser(
        description="Generate a polyrhythmic audio sequence from overlaid layers."
    )
    parser.add_argument(
        "--layer",
        dest="layers",
        action="append",
        required=True,
        type=parse_layer_arg,
        metavar="BEATS:NOTES:SAMPLE[:gain=G]",
        help="One layer, e.g. '3:0,3,5:kick.wav' or '4:0,-2:snare.wav:gain=0.7'. "
        "Repeat for more layers. Notes are semitone offsets and loop over the "
        "layer's own beats. Gain defaults to 1.0 (unity).",
    )
    parser.add_argument("--loops", type=int, required=True, help="Number of LCM cycles to render.")
    parser.add_argument("--out", required=True, help="Output WAV path.")

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
        default=DEFAULT_MAX_DURATION,
        help=f"Refuse to render longer than this many seconds. "
        f"Default: {DEFAULT_MAX_DURATION:.0f}",
    )
    parser.add_argument("--sample-rate", type=int, default=44100)
    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()

    if args.loops < 1:
        parser.error(f"--loops must be >= 1, got {args.loops}")

    lcm_beats = lcm_of_beats(args.layers)

    if args.pulse_duration is not None:
        if args.pulse_duration <= 0:
            parser.error(f"--pulse-duration must be > 0, got {args.pulse_duration}")
        samples_per_pulse = int(round(args.pulse_duration * args.sample_rate))
        requested_cycle = None
    else:
        requested_cycle = (
            args.cycle_duration if args.cycle_duration is not None else DEFAULT_CYCLE_DURATION
        )
        if requested_cycle <= 0:
            parser.error(f"--cycle-duration must be > 0, got {requested_cycle}")
        samples_per_pulse = int(round(requested_cycle * args.sample_rate / lcm_beats))

    if samples_per_pulse < 1:
        parser.error(
            f"a {requested_cycle}s cycle split across an LCM of {lcm_beats} pulses leaves "
            f"under one sample per pulse; lengthen --cycle-duration or choose beat counts "
            f"sharing more common factors"
        )

    cycle_duration = lcm_beats * samples_per_pulse / args.sample_rate
    if requested_cycle is not None and abs(cycle_duration - requested_cycle) > requested_cycle / 100:
        print(
            f"warning: cycle rounded to {cycle_duration:.4f}s from {requested_cycle:.4f}s -- "
            f"an LCM of {lcm_beats} does not divide the sample rate evenly"
        )

    total_duration = args.loops * cycle_duration
    if total_duration > args.max_duration:
        parser.error(
            f"that would render {total_duration:.1f}s of audio "
            f"({args.loops} loops of a {cycle_duration:.2f}s cycle), over the "
            f"{args.max_duration:.0f}s limit. Render a shorter file with fewer --loops "
            f"or a shorter --cycle-duration, or raise --max-duration."
        )

    missing = [layer.sample_path for layer in args.layers if not Path(layer.sample_path).is_file()]
    if missing:
        parser.error("sample file not found: " + ", ".join(missing))

    try:
        mix = render(
            layers=args.layers,
            loops=args.loops,
            samples_per_pulse=samples_per_pulse,
            sample_rate=args.sample_rate,
        )
    except sf.LibsndfileError as e:
        raise SystemExit(f"could not read sample: {e}")

    peak = float(np.abs(mix).max())
    if peak > 1.0:
        print(
            f"warning: mix peaked at {peak:.2f} and was clipped -- "
            f"scale the layers down, e.g. add ':gain={0.99 / peak:.2f}' to each"
        )
        mix = np.clip(mix, -1.0, 1.0)

    sf.write(args.out, mix, args.sample_rate)
    print(
        f"wrote {args.out}: {len(mix)} samples ({len(mix) / args.sample_rate:.2f}s, "
        f"{args.loops} x {cycle_duration:.3f}s cycle, peak {min(peak, 1.0):.2f})"
    )


if __name__ == "__main__":
    main()
