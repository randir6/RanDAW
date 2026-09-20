#!/usr/bin/env python3
"""Generate the synthetic sample set in samples/. Run: python3 make_samples.py

These are deliberately simple synthesised one-shots so the repo has
something to render with out of the box. Replace them with real recordings
whenever you like -- nothing depends on these specifically.
"""
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 44100
OUT = Path(__file__).parent / "samples"
rng = np.random.default_rng(0)


def t_axis(duration):
    return np.linspace(0, duration, int(SR * duration), endpoint=False)


def normalise(sig, peak=0.9):
    return (sig / np.abs(sig).max() * peak).astype(np.float32)


def kick(duration=0.3):
    t = t_axis(duration)
    freq = 45 + 70 * np.exp(-t * 38)  # pitch drops 115 Hz -> 45 Hz
    body = np.sin(np.cumsum(2 * np.pi * freq / SR)) * np.exp(-t * 7)
    click = rng.uniform(-1, 1, len(t)) * np.exp(-t * 600) * 0.35
    return normalise(body + click)


def snare(duration=0.2):
    t = t_axis(duration)
    noise = rng.uniform(-1, 1, len(t))
    noise = np.diff(noise, prepend=0.0)  # crude high-pass for some crack
    tone = np.sin(2 * np.pi * 185 * t) + 0.7 * np.sin(2 * np.pi * 330 * t)
    return normalise(noise * np.exp(-t * 20) * 0.8 + tone * np.exp(-t * 32) * 0.4)


def hat(duration=0.07):
    t = t_axis(duration)
    noise = rng.uniform(-1, 1, len(t))
    noise = np.diff(noise, prepend=0.0)
    noise = np.diff(noise, prepend=0.0)  # twice: brighter still
    return normalise(noise * np.exp(-t * 110))


def tom(duration=0.35):
    t = t_axis(duration)
    freq = 110 + 55 * np.exp(-t * 18)
    return normalise(np.sin(np.cumsum(2 * np.pi * freq / SR)) * np.exp(-t * 9))


def pluck(duration=0.5, f0=220.0):
    """Harmonic stack, higher partials decaying faster -- reads clearly as a
    pitch, which makes note sequences and pitch shifts easy to hear."""
    t = t_axis(duration)
    sig = sum((1 / k) * np.sin(2 * np.pi * f0 * k * t) * np.exp(-t * (3 + k * 1.8)) for k in range(1, 7))
    return normalise(sig * (1 - np.exp(-t * 900)))  # soften the very attack


def bell(duration=0.6, f0=330.0):
    t = t_axis(duration)
    sig = sum(
        amp * np.sin(2 * np.pi * f0 * ratio * t) * np.exp(-t * decay)
        for ratio, amp, decay in [(1.0, 1.0, 4), (2.76, 0.5, 7), (5.4, 0.25, 11)]
    )
    return normalise(sig)


def main():
    OUT.mkdir(exist_ok=True)
    for name, sig in [
        ("kick", kick()),
        ("snare", snare()),
        ("hat", hat()),
        ("tom", tom()),
        ("pluck", pluck()),
        ("bell", bell()),
    ]:
        path = OUT / f"{name}.wav"
        sf.write(path, sig, SR)
        print(f"wrote {path}  ({len(sig) / SR:.2f}s)")


if __name__ == "__main__":
    main()
