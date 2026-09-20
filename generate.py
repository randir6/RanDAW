#!/usr/bin/env python3
import argparse

import numpy as np
import soundfile as sf

from polyrhythm.layer import parse_layer_arg
from polyrhythm.render import render


def parse_args():
    parser = argparse.ArgumentParser(
        description="Generate a polyrhythmic audio sequence from overlaid layers."
    )
    parser.add_argument(
        "--layer",
        dest="layers",
        action="append",
        required=True,
        type=parse_layer_arg,
        metavar="BEATS:NOTES:SAMPLE_PATH",
        help="One layer, e.g. '3:0,3,5:kick.wav'. Repeat for more layers.",
    )
    parser.add_argument("--loops", type=int, required=True, help="Number of LCM cycles to render.")
    parser.add_argument("--out", required=True, help="Output WAV path.")
    parser.add_argument(
        "--pulse-duration",
        type=float,
        default=0.15,
        help="Duration in seconds of one pulse -- the finest shared beat "
        "subdivision (LCM grid), not any single layer's own beat spacing. "
        "Default: 0.15",
    )
    parser.add_argument("--sample-rate", type=int, default=44100)
    return parser.parse_args()


def main():
    args = parse_args()

    if len(args.layers) < 1:
        raise SystemExit("need at least one --layer")

    samples_per_pulse = int(round(args.pulse_duration * args.sample_rate))

    mix = render(
        layers=args.layers,
        loops=args.loops,
        samples_per_pulse=samples_per_pulse,
        sample_rate=args.sample_rate,
    )

    peak = np.abs(mix).max() if len(mix) else 0.0
    if peak > 1.0:
        print(f"warning: mix peaked at {peak:.2f}, clipping to [-1, 1]")
        mix = np.clip(mix, -1.0, 1.0)

    sf.write(args.out, mix, args.sample_rate)
    print(f"wrote {args.out}: {len(mix)} samples ({len(mix) / args.sample_rate:.2f}s)")


if __name__ == "__main__":
    main()
