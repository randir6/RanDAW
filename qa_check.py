#!/usr/bin/env python3
"""Verification for the polyrhythm generator. Run: python3 qa_check.py

Black-box: everything below drives generate.py as a subprocess and measures
the resulting audio, so the checks stay honest if the internals change.

The timing model here is derived independently of render.py: a cycle lasts T,
and a layer with B beats divides that same T into B equal parts, hitting at
t = (cycle + j/B) * T. That is what "polyrhythm" means, and it is what the
renderer has to reproduce.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 44100
PULSE = 0.15
QUANTUM = 1 / 32768  # output is 16-bit PCM; tolerances can't be tighter

ROOT = Path(__file__).parent
tmp = Path(tempfile.mkdtemp(prefix="polyrhythm-qa-"))
failures = []


def check(label, condition, detail=""):
    print(f"[{'PASS' if condition else 'FAIL'}] {label}{'  ' + detail if detail else ''}")
    if not condition:
        failures.append(label)


def run(*cli_args):
    return subprocess.run(
        [sys.executable, "generate.py", *cli_args], capture_output=True, text=True, cwd=ROOT
    )


def render(layer_specs, loops, name, *extra):
    out = tmp / name
    args = []
    for spec in layer_specs:
        args += ["--layer", spec]
    args += ["--loops", str(loops), "--out", str(out)]
    args += list(extra) if extra else ["--pulse-duration", str(PULSE)]
    result = run(*args)
    if result.returncode != 0:
        raise SystemExit(f"render failed: {result.stdout}{result.stderr}")
    return sf.read(out, dtype="float32")[0]


def sine(freq, dur=0.2, amp=0.9):
    t = np.linspace(0, dur, int(SR * dur), endpoint=False)
    return (np.sin(2 * np.pi * freq * t) * amp).astype(np.float32)


def dominant_freq(window):
    window = window[np.abs(window) > 1e-4]
    if len(window) < 64:
        return 0.0
    spectrum = np.abs(np.fft.rfft(window * np.hanning(len(window))))
    return np.fft.rfftfreq(len(window), 1 / SR)[np.argmax(spectrum)]


impulse = tmp / "impulse.wav"
sf.write(impulse, np.array([1.0], dtype=np.float32), SR)
sf.write(tmp / "sine440.wav", sine(440), SR)


# --- Timing -----------------------------------------------------------------
def expected_onsets(beat_counts, loops):
    lcm = int(np.lcm.reduce(beat_counts))
    cycle = lcm * round(PULSE * SR)
    hits = {
        int(round((c + j / B) * cycle))
        for B in beat_counts
        for c in range(loops)
        for j in range(B)
    }
    return sorted(hits), cycle


for beats, loops in [([3, 4], 4), ([13, 7], 1), ([5, 8], 2)]:
    specs = [f"{b}:0:{impulse}:gain=0.5" for b in beats]
    audio = render(specs, loops, f"t{beats[0]}v{beats[1]}.wav")
    expected, cycle = expected_onsets(beats, loops)
    actual = sorted(np.nonzero(audio)[0].tolist())
    check(
        f"{beats[0]}v{beats[1]}: onsets match the ideal t=(cycle + j/B)*T model",
        actual == expected,
        f"{len(actual)} onsets, 0 sample error" if actual == expected else "MISMATCH",
    )
    check(
        f"{beats[0]}v{beats[1]}: length == loops * LCM * samples_per_pulse",
        len(audio) == loops * int(np.lcm.reduce(beats)) * round(PULSE * SR),
        f"{len(audio)} samples",
    )

# Layers coincide on each cycle's downbeat; at gain 0.5 each that sums to 1.0.
audio = render([f"3:0:{impulse}:gain=0.5", f"4:0:{impulse}:gain=0.5"], 4, "amp.wav")
_, cycle = expected_onsets([3, 4], 4)
downbeats = {c * cycle for c in range(4)}
onsets = np.nonzero(audio)[0].tolist()
check(
    "two layers at gain=0.5 sum to 1.0 where they coincide, 0.5 where they don't",
    all(
        abs(audio[i] - (1.0 if i in downbeats else 0.5)) < 2 * QUANTUM for i in onsets
    ),
)

# --- Per-layer gain ---------------------------------------------------------
loud = render([f"1:0:{impulse}:gain=0.8"], 1, "loud.wav")
quiet = render([f"1:0:{impulse}:gain=0.2"], 1, "quiet.wav")
check(
    "per-layer gain scales amplitude (0.8 vs 0.2 -> 4x)",
    abs(loud.max() - 0.8) < 2 * QUANTUM and abs(quiet.max() - 0.2) < 2 * QUANTUM,
    f"{loud.max():.3f} vs {quiet.max():.3f}",
)
check(
    "gain defaults to unity when omitted",
    abs(render([f"1:0:{impulse}"], 1, "unity.wav").max() - 1.0) < 2 * QUANTUM,
)

# --- Pitch ------------------------------------------------------------------
beat = int(0.5 * SR)
audio = render(
    [f"4:0,12,-12,7:{tmp}/sine440.wav"], 1, "pitch.wav", "--pulse-duration", "0.5"
)
for i, (semis, want) in enumerate([(0, 440.0), (12, 880.0), (-12, 220.0), (7, 440 * 2 ** (7 / 12))]):
    got = dominant_freq(audio[i * beat : (i + 1) * beat])
    cents = 1200 * np.log2(got / want) if got > 0 else 9999
    check(f"pitch shift {semis:+d} st -> {want:.0f} Hz", abs(cents) < 15, f"{got:.0f} Hz ({cents:+.1f} cents)")

# 3 beats against a 5-note sequence: the sequence keeps running across loops,
# so loop 2 starts on note index 3 rather than restarting at 0.
audio = render([f"3:0,12,24,-12,7:{tmp}/sine440.wav"], 2, "phase.wav", "--pulse-duration", "0.5")
want = [440.0, 880.0, 1760.0, 220.0, 440 * 2 ** (7 / 12), 440.0]
got = [dominant_freq(audio[i * beat : (i + 1) * beat]) for i in range(6)]
check(
    "note sequence phases against beat count (does not reset each loop)",
    all(abs(1200 * np.log2(g / w)) < 15 for g, w in zip(got, want)),
    f"{[round(f) for f in got]} Hz",
)

# --- Loop seamlessness ------------------------------------------------------
# A note whose tail runs past the end must wrap to the start, not be cut off.
# With a sample 2.5x the buffer length, every input sample must still land
# somewhere, so the totals match. Truncating would lose ~60% of the energy.
tail = np.full(int(SR * 0.25), 0.2, dtype=np.float32)
sf.write(tmp / "tail.wav", tail, SR)
audio = render([f"1:0:{tmp}/tail.wav"], 1, "wrap.wav", "--pulse-duration", "0.1")
check(
    "note tails wrap around the loop instead of being truncated",
    abs(audio.sum() - tail.sum()) < 1.0,
    f"buffer {len(audio)} samples holds all {len(tail)} input samples "
    f"(sum {audio.sum():.1f} vs {tail.sum():.1f}; truncating would give "
    f"{tail[:len(audio)].sum():.1f})",
)

# --- Input validation -------------------------------------------------------
for label, args, code, expect in [
    ("--loops 0 is rejected", ["--layer", f"1:0:{impulse}", "--loops", "0"], 2, "must be >= 1"),
    ("--loops -2 is rejected", ["--layer", f"1:0:{impulse}", "--loops", "-2"], 2, "must be >= 1"),
    ("missing sample file is reported", ["--layer", "1:0:nope.wav", "--loops", "1"], 2, "not found"),
    ("malformed layer explains the format", ["--layer", "3:0,3,5", "--loops", "1"], 2, "BEATS:NOTES:SAMPLE_PATH"),
    ("beats=0 is rejected", ["--layer", f"0:0:{impulse}", "--loops", "1"], 2, "beat count must be >= 1"),
    ("bad gain is reported", ["--layer", f"1:0:{impulse}:gain=x", "--loops", "1"], 2, "not a number"),
    ("--bpm 0 is rejected", ["--layer", f"1:0:{impulse}", "--loops", "1", "--bpm", "0"], 2, "must be > 0"),
]:
    r = run(*args, "--out", str(tmp / "err.wav"))
    output = r.stdout + r.stderr
    check(label, r.returncode == code and expect in output, f"exit {r.returncode}")

# --bpm and --pulse-duration are two spellings of the same number.
by_bpm = render([f"1:0:{impulse}"], 1, "bpm.wav", "--bpm", "60")
by_secs = render([f"1:0:{impulse}"], 1, "secs.wav", "--pulse-duration", "1.0")
check("--bpm 60 == --pulse-duration 1.0", len(by_bpm) == len(by_secs) == SR, f"{len(by_bpm)} samples")

print()
if failures:
    print(f"{len(failures)} FAILED: " + "; ".join(failures))
    sys.exit(1)
print("all checks passed")
