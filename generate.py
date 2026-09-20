#!/usr/bin/env python3
import argparse
from pathlib import Path

import numpy as np
import soundfile as sf

from polyrhythm.layer import parse_layer_arg
from polyrhythm.render import render

DEFAULT_PULSE_DURATION = 0.15


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
        "--bpm",
        type=float,
        help="Pulses per minute. A pulse is the finest shared beat subdivision "
        "(the LCM grid), so this is not the felt tempo of any one layer.",
    )
    tempo.add_argument(
        "--pulse-duration",
        type=float,
        help=f"Pulse length in seconds, the same value --bpm sets. "
        f"Default: {DEFAULT_PULSE_DURATION}",
    )

    parser.add_argument("--sample-rate", type=int, default=44100)
    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()

    if args.loops < 1:
        parser.error(f"--loops must be >= 1, got {args.loops}")

    if args.bpm is not None:
        if args.bpm <= 0:
            parser.error(f"--bpm must be > 0, got {args.bpm}")
        pulse_duration = 60.0 / args.bpm
    elif args.pulse_duration is not None:
        pulse_duration = args.pulse_duration
    else:
        pulse_duration = DEFAULT_PULSE_DURATION

    samples_per_pulse = int(round(pulse_duration * args.sample_rate))
    if samples_per_pulse < 1:
        parser.error("pulse is shorter than one sample; lower --bpm or raise --pulse-duration")

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
        f"wrote {args.out}: {len(mix)} samples "
        f"({len(mix) / args.sample_rate:.2f}s, peak {min(peak, 1.0):.2f})"
    )


if __name__ == "__main__":
    main()
