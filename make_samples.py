#!/usr/bin/env python3
"""Generate the synthetic sample set in samples/. Run: python3 make_samples.py

These are deliberately simple synthesised one-shots so the repo has
something to render with out of the box. Replace them with real recordings
whenever you like -- nothing depends on these specifically.

A quick primer, since the sound design below assumes it. A sound is just a
list of numbers describing how air pressure changes over time. Two ingredients
make almost any percussive hit:

  * a TONE -- a repeating wave, giving a sense of pitch, or NOISE (random
    numbers), which has no pitch and reads as a hiss or crack;
  * an ENVELOPE -- a shape multiplied over the top controlling loudness
    across time. Percussion is loud instantly then fades, which is why
    exp(-t * k) appears everywhere here.

Multiply a tone by a decaying envelope and you have a drum hit.
"""
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 44100
# __file__ is this script's own path, so .parent is the folder holding it.
# Building the path this way means the script works no matter which directory
# you run it from.
OUT = Path(__file__).parent / "samples"

# A seeded random generator. The seed (0) means the "random" numbers are the
# same on every run, so re-running this produces byte-identical snare and hat
# files rather than subtly different ones each time -- reproducibility.
rng = np.random.default_rng(0)


def t_axis(duration):
    """A time axis: the moment, in seconds, of each sample."""
    return np.linspace(0, duration, int(SR * duration), endpoint=False)


def normalise(sig, peak=0.9):
    """Scale so the loudest point sits at `peak`, leaving a little headroom
    below 1.0 so mixing several of these doesn't instantly clip."""
    # np.abs(sig).max() is the largest distance from silence in either
    # direction. Dividing by it makes the peak exactly 1.0, then we scale to
    # the target. Every element is scaled at once -- no loop.
    return (sig / np.abs(sig).max() * peak).astype(np.float32)


def kick(duration=0.3):
    t = t_axis(duration)

    # A kick's pitch DROPS sharply at the start -- that swoop is most of what
    # makes it sound like a kick. exp(-t*38) falls from 1 to near 0 fast, so
    # freq starts at 45+70=115 Hz and settles to 45 Hz.
    freq = 45 + 70 * np.exp(-t * 38)

    # Generating a sound whose frequency CHANGES needs care. You cannot write
    # sin(2*pi*freq*t) with a varying freq -- that produces the wrong result,
    # because what matters is accumulated phase, not instantaneous frequency.
    # cumsum adds up all the tiny per-sample phase steps so far, which is a
    # numerical way of integrating frequency into phase.
    body = np.sin(np.cumsum(2 * np.pi * freq / SR)) * np.exp(-t * 7)

    # A very short burst of noise for the beater attack. Decaying at 600
    # rather than 7 makes it last a few milliseconds instead of the whole hit.
    click = rng.uniform(-1, 1, len(t)) * np.exp(-t * 600) * 0.35
    return normalise(body + click)  # adding two arrays mixes the sounds


def snare(duration=0.2):
    t = t_axis(duration)
    noise = rng.uniform(-1, 1, len(t))

    # np.diff subtracts each sample from the next. Rapid changes (high
    # frequencies) survive; slow ones cancel out. That makes it a crude
    # high-pass filter -- the cheapest way to brighten noise without a real
    # filter implementation. prepend=0.0 keeps the array the same length.
    noise = np.diff(noise, prepend=0.0)

    # Two tuned partials give the snare a body pitch under the rattle.
    tone = np.sin(2 * np.pi * 185 * t) + 0.7 * np.sin(2 * np.pi * 330 * t)

    # Different decay rates per component: the tone dies faster (32) than the
    # rattle (20), so the hit starts solid and ends as noise.
    return normalise(noise * np.exp(-t * 20) * 0.8 + tone * np.exp(-t * 32) * 0.4)


def hat(duration=0.07):
    t = t_axis(duration)
    noise = rng.uniform(-1, 1, len(t))
    # Applying the crude high-pass twice cuts even more low end, which is what
    # separates a hi-hat from a snare. Very short decay (110) keeps it tight.
    noise = np.diff(noise, prepend=0.0)
    noise = np.diff(noise, prepend=0.0)
    return normalise(noise * np.exp(-t * 110))


def tom(duration=0.35):
    t = t_axis(duration)
    # Same swooping-pitch trick as the kick, higher and gentler.
    freq = 110 + 55 * np.exp(-t * 18)
    return normalise(np.sin(np.cumsum(2 * np.pi * freq / SR)) * np.exp(-t * 9))


def pluck(duration=0.5, f0=220.0):
    """Harmonic stack, higher partials decaying faster -- reads clearly as a
    pitch, which makes note sequences and pitch shifts easy to hear."""
    t = t_axis(duration)
    # Real instruments produce a fundamental plus whole-number multiples of it
    # (harmonics), quieter as they go up -- hence f0*k and amplitude 1/k. The
    # higher ones also fade faster, which is why a plucked string sounds
    # bright at the attack and mellow as it rings.
    #
    # sum() over a generator expression adds up all six arrays element-wise.
    sig = sum((1 / k) * np.sin(2 * np.pi * f0 * k * t) * np.exp(-t * (3 + k * 1.8)) for k in range(1, 7))

    # Multiplying by a fast rise from 0 to 1 softens the very first instant.
    # Starting a waveform abruptly at full amplitude produces an audible click.
    return normalise(sig * (1 - np.exp(-t * 900)))


def bell(duration=0.6, f0=330.0):
    t = t_axis(duration)
    # Bells are INHARMONIC: their partials are not whole-number multiples, so
    # 2.76 and 5.4 rather than 2 and 3. That mismatch is exactly what makes
    # metal sound like metal instead of like a string.
    sig = sum(
        amp * np.sin(2 * np.pi * f0 * ratio * t) * np.exp(-t * decay)
        for ratio, amp, decay in [(1.0, 1.0, 4), (2.76, 0.5, 7), (5.4, 0.25, 11)]
    )
    return normalise(sig)


def click(duration=0.03, f0=2000.0):
    # The metronome: a very short, bright tick, used to make the base beat
    # audible. A fast decay keeps it out of the way of everything else; no
    # randomness, so it is the same every time it is made.
    t = t_axis(duration)
    return normalise(np.sin(2 * np.pi * f0 * t) * np.exp(-t * 180) * (1 - np.exp(-t * 4000)))


def main():
    # exist_ok=True means "don't complain if the folder is already there".
    OUT.mkdir(exist_ok=True)
    # Looping over (name, signal) pairs keeps the writing logic in one place
    # instead of repeating sf.write for every sound.
    for name, sig in [
        ("kick", kick()),
        ("snare", snare()),
        ("hat", hat()),
        ("tom", tom()),
        ("pluck", pluck()),
        ("bell", bell()),
        ("click", click()),  # last, so the random sounds above are unchanged
    ]:
        path = OUT / f"{name}.wav"  # pathlib overloads / to join paths
        sf.write(path, sig, SR)
        print(f"wrote {path}  ({len(sig) / SR:.2f}s)")


if __name__ == "__main__":
    main()
