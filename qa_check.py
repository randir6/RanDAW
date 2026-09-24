#!/usr/bin/env python3
"""Verification for the polyrhythm generator. Run: python3 qa_check.py

Black-box: everything below drives generate.py as a subprocess and measures
the resulting audio, so the checks stay honest if the internals change.

The timing model here is derived independently of render.py: a cycle lasts T,
and a layer with B beats divides that same T into B equal parts, hitting at
t = (cycle + j/B) * T. That is what "polyrhythm" means, and it is what the
renderer has to reproduce.

Why derive it independently? If the test worked out expected positions by
calling the same code it is testing, it would agree with any bug that code
had. Writing the model out separately from the musical definition means the
two have to agree for a real reason.

There is no test framework here (no pytest) -- just a check() function and
plain Python. One fewer dependency, and nothing hidden.
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from polyrhythm.layer import Layer, make_layer
from polyrhythm.layer_arg import parse_layer_arg
from polyrhythm.piece import build_piece
from polyrhythm.scales import SCALES, degree_to_semitones
from polyrhythm.export import piece_to_dict
from polyrhythm.schedule import STATUS_INACTIVE, STATUS_NOTE, STATUS_REST, grid, schedule
from polyrhythm.spec import SpecError, read_spec
from polyrhythm.visualise import _json_for_script_tag

SR = 44100
PULSE = 0.15
# 16-bit audio stores 2**16 = 65536 levels spanning -1..+1, so the smallest
# representable step is 1/32768. Comparing two renders more tightly than this
# is meaningless -- the format cannot express a smaller difference.
QUANTUM = 1 / 32768  # output is 16-bit PCM; tolerances can't be tighter

ROOT = Path(__file__).parent
# A throwaway directory for test files, somewhere the OS cleans up. Keeps
# generated clutter out of the repo.
tmp = Path(tempfile.mkdtemp(prefix="polyrhythm-qa-"))
# Collected rather than raised, so one failure doesn't hide the other 30.
failures = []


def check(label, condition, detail=""):
    """Record a pass/fail. `condition` is already-evaluated True/False, so
    every check runs regardless of what came before."""
    print(f"[{'PASS' if condition else 'FAIL'}] {label}{'  ' + detail if detail else ''}")
    if not condition:
        failures.append(label)


def _expect_value_error(fn):
    """True if calling fn() raises ValueError. Lets a check() line test that
    something is REJECTED without a try/except wrapped around every one."""
    try:
        fn()
    except ValueError:
        return True
    return False


def run(*cli_args):
    """Run generate.py as a separate process, exactly as a user would.

    The *  in `*cli_args` collects any number of arguments into a tuple, and
    the * inside the list spreads them back out -- so run("--loops", "4")
    becomes [python, "generate.py", "--loops", "4"].

    sys.executable is the path to the Python running this script, rather than
    hardcoding "python3", so the subprocess uses the same interpreter and
    therefore the same installed numpy and soundfile.

    Testing through the command line rather than by importing functions means
    these checks stay valid even if the internals are rearranged -- which is
    what let the phase 2 refactor be verified rather than hoped about.
    """
    return subprocess.run(
        # capture_output keeps stdout/stderr instead of printing them;
        # text=True returns strings rather than raw bytes.
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
    """Measure the strongest pitch present, in Hz.

    This is how the pitch-shift checks stay honest: instead of trusting the
    code's arithmetic, they listen to the output and measure what came back.

    An FFT converts a stretch of audio from "amplitude over time" into
    "strength at each frequency". The loudest bin in that result is the
    dominant pitch.
    """
    # Boolean indexing: the inner comparison makes an array of True/False, and
    # using it as an index keeps only the True positions. Here it strips
    # near-silence so trailing quiet doesn't dilute the measurement.
    window = window[np.abs(window) > 1e-4]
    if len(window) < 64:
        return 0.0  # too little signal to say anything meaningful

    # A Hann window tapers the excerpt to zero at both ends. Without it the
    # abrupt cut looks like a click to the FFT and smears energy across the
    # spectrum, blurring the peak we are trying to find.
    spectrum = np.abs(np.fft.rfft(window * np.hanning(len(window))))
    # rfftfreq gives the frequency each bin represents; argmax finds the index
    # of the largest value. Together: "the frequency of the loudest bin".
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
    # Cents: 1200 to an octave, so 100 per semitone. Pitch error is measured
    # this way because hearing is ratio-based -- 10 Hz out matters enormously
    # at 100 Hz and is inaudible at 5 kHz, whereas cents mean the same thing
    # everywhere. Under about 5 cents is imperceptible; we allow 15 to leave
    # room for FFT bin resolution.
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
    ("--cycle-duration 0 is rejected", ["--layer", f"1:0:{impulse}", "--loops", "1", "--cycle-duration", "0"], 2, "must be > 0"),
    ("an over-long render is refused with its length", ["--layer", f"3:0:{impulse}", "--layer", f"4:0:{impulse}", "--loops", "100", "--cycle-duration", "5"], 2, "over the"),
]:
    r = run(*args, "--out", str(tmp / "err.wav"))
    output = r.stdout + r.stderr
    check(label, r.returncode == code and expect in output, f"exit {r.returncode}")

# --- Cycle-based tempo ------------------------------------------------------
# The cycle is the span every layer divides into its own beat count, so adding
# a layer must subdivide that span rather than stretch it. Fixing the PULSE
# instead makes the cycle grow with the LCM, which silently slows every layer
# already present -- the bug this check exists to catch.
CYCLE = 2.0
cycle_samples = int(CYCLE * SR)
two = render([f"3:0:{impulse}:gain=0.4", f"4:0:{impulse}:gain=0.4"], 2, "cyc2.wav",
             "--cycle-duration", str(CYCLE))
three = render([f"3:0:{impulse}:gain=0.3", f"4:0:{impulse}:gain=0.3", f"5:0:{impulse}:gain=0.3"],
               2, "cyc3.wav", "--cycle-duration", str(CYCLE))
check("--cycle-duration renders exactly the requested span",
      len(two) == len(three) == 2 * cycle_samples, f"{len(two)} samples for 2 x {CYCLE}s")

kick_hits = {int(round((c + j / 3) * cycle_samples)) for c in range(2) for j in range(3)}
check("adding a layer leaves the existing layers' timing untouched",
      kick_hits <= set(np.nonzero(two)[0].tolist())
      and kick_hits <= set(np.nonzero(three)[0].tolist()),
      "3-beat layer lands identically with and without a 5-beat layer present")

# --- Schedule ---------------------------------------------------------------
# The schedule is what later phases operate on -- skipping filters it, drift
# moves it, MIDI exports it, the visualiser draws it -- so check it directly
# rather than only inferring it from the audio it produced.
sched_layers = [
    Layer(beats=3, notes=[0, 3, 7, 10, 5], sample_path="a.wav", gain=0.5),
    Layer(beats=4, notes=[0, -5], sample_path="b.wav", gain=0.8),
]
events = schedule(sched_layers, loops=2)

check("schedule emits one event per layer beat per loop",
      len(events) == 2 * (3 + 4), f"{len(events)} events")
check("schedule comes back in time order",
      all(a.pulse <= b.pulse for a, b in zip(events, events[1:])))

# LCM(3,4)=12, so the 3-beat layer steps 4 pulses and the 4-beat layer 3.
want = ({(0, c * 12 + j * 4) for c in range(2) for j in range(3)}
        | {(1, c * 12 + j * 3) for c in range(2) for j in range(4)})
check("every event lands on its own layer's beat grid",
      {(e.layer, e.pulse) for e in events} == want)

# Occurrences 0..5 of the 3-beat layer index a 5-note sequence as 0,1,2,3,4,0.
first_layer = [e.semitones for e in events if e.layer == 0]
check("note sequence phases across loops in the schedule itself",
      first_layer == [0, 3, 7, 10, 5, 0], f"{first_layer}")

check("events carry their layer's sample and gain",
      all(e.sample_path == "a.wav" and e.gain == 0.5 for e in events if e.layer == 0)
      and all(e.sample_path == "b.wav" and e.gain == 0.8 for e in events if e.layer == 1))

# --- Beat skipping ----------------------------------------------------------
# A layer names which of its OWN beats sound, counting from 1 the way
# musicians do. Everything else about the layer is unchanged.
skipped = schedule([Layer(beats=13, notes=[0], sample_path="a.wav", gain=1.0,
                          active_beats={2, 4, 7})], loops=1)
check("active beats keep only the beats named",
      [e.pulse for e in skipped] == [2, 4, 7],
      "beats 3,5,8 (1-based) -> pulses 2,4,7 (0-based)")

# Silencing beats must not slide the survivors along: a skipped beat leaves a
# gap, it does not close one up.
full = schedule([Layer(beats=8, notes=[0], sample_path="a.wav", gain=1.0)], loops=1)
sparse = schedule([Layer(beats=8, notes=[0], sample_path="a.wav", gain=1.0,
                         active_beats={0, 3, 6})], loops=1)
check("skipped beats leave gaps rather than shifting the rest",
      [e.pulse for e in sparse] == [0, 3, 6]
      and set(e.pulse for e in sparse) <= set(e.pulse for e in full))

# Listing every beat must be identical to not using the option at all --
# otherwise the feature would have changed the default behaviour.
all_listed = schedule([Layer(beats=5, notes=[0, 3], sample_path="a.wav", gain=1.0,
                             active_beats={0, 1, 2, 3, 4})], loops=2)
default = schedule([Layer(beats=5, notes=[0, 3], sample_path="a.wav", gain=1.0)], loops=2)
check("listing all beats matches leaving active= off entirely",
      all_listed == default, f"{len(default)} events either way")

# A note belongs to its beat POSITION, so silencing a beat silences its note
# rather than sliding the next note forward. Beats 1 and 3 of a 4-beat layer
# are note indices 0 and 2, so +0 and +24 -- not +0 and +12.
notes_kept = schedule([Layer(beats=4, notes=[0, 12, 24, 36], sample_path="a.wav",
                             gain=1.0, active_beats={0, 2})], loops=1)
check("notes stay attached to their beat, they do not shuffle up",
      [e.semitones for e in notes_kept] == [0, 24],
      f"{[e.semitones for e in notes_kept]} (not [0, 12])")

# Through the CLI, end to end.
sparse_audio = render([f"8:0:{impulse}:active=1,4,7"], 1, "sparse.wav",
                      "--cycle-duration", "2.0")
check("beat skipping works through the command line",
      len(np.nonzero(sparse_audio)[0]) == 3,
      f"{len(np.nonzero(sparse_audio)[0])} onsets from 8 beats")

# The two options are independent and order should not matter.
one_way = render([f"4:0:{impulse}:gain=0.5:active=1,3"], 1, "opt1.wav", "--cycle-duration", "1.0")
other_way = render([f"4:0:{impulse}:active=1,3:gain=0.5"], 1, "opt2.wav", "--cycle-duration", "1.0")
check("gain= and active= can be written in either order",
      np.array_equal(one_way, other_way) and abs(one_way.max() - 0.5) < 2 * QUANTUM)

for label, args, code, expect in [
    ("active beat above the beat count is rejected",
     ["--layer", f"4:0:{impulse}:active=5", "--loops", "1"], 2, "outside 1..4"),
    ("active beat 0 is rejected (beats count from 1)",
     ["--layer", f"4:0:{impulse}:active=0", "--loops", "1"], 2, "outside 1..4"),
    ("non-numeric active beats are reported",
     ["--layer", f"4:0:{impulse}:active=x", "--loops", "1"], 2, "whole numbers"),
    ("an unknown option is named, not silently treated as a path",
     ["--layer", f"4:0:{impulse}:gian=0.5", "--loops", "1"], 2, "unknown option"),
    ("a repeated option is rejected",
     ["--layer", f"4:0:{impulse}:gain=0.5:gain=0.2", "--loops", "1"], 2, "more than once"),
]:
    r = run(*args, "--out", str(tmp / "err.wav"))
    check(label, r.returncode == code and expect in (r.stdout + r.stderr), f"exit {r.returncode}")

# --- Config files -----------------------------------------------------------
# The point of a config is that it is another way to say the same thing, so
# the check that matters is that it produces exactly the same audio.
cfg_dir = tmp / "configs"
cfg_dir.mkdir()


def write_config(name, text):
    path = cfg_dir / name
    path.write_text(text)
    return path


# "../impulse.wav" is relative to the CONFIG, which sits one level down.
same_config = write_config("same.toml", f"""
cycle_duration = 2.0
loops = 2

[[layer]]
beats = 3
notes = [0, 5]
sample = "../impulse.wav"
gain = 0.4
active = [1, 3]

[[layer]]
beats = 4
notes = [0]
sample = "../impulse.wav"
gain = 0.25
""")

from_config = run("--config", str(same_config), "--out", str(tmp / "cfg.wav"))
from_cli = render([f"3:0,5:{impulse}:gain=0.4:active=1,3", f"4:0:{impulse}:gain=0.25"],
                  2, "cli.wav", "--cycle-duration", "2.0")
check("a config renders byte-identically to the equivalent command line",
      from_config.returncode == 0
      and np.array_equal(sf.read(tmp / "cfg.wav", dtype="float32")[0], from_cli),
      "same layers, both routes")

check("sample paths resolve relative to the config file, not the shell",
      from_config.returncode == 0, "'../impulse.wav' found from a config one level down")

# Overriding is what makes a config practical: preview without editing it.
run("--config", str(same_config), "--loops", "1", "--out", str(tmp / "ovr.wav"))
check("a command-line value overrides the config",
      len(sf.read(tmp / "ovr.wav", dtype="float32")[0]) == int(2.0 * SR),
      "--loops 1 against loops = 2 in the file")

bad_configs = [
    ("unknown setting is named", 'cycle_durations = 2.0\nloops = 1\n[[layer]]\nbeats = 1\nnotes = [0]\nsample = "../impulse.wav"\n', "unknown setting"),
    ("unknown layer key is named", 'loops = 1\n[[layer]]\nbeats = 1\nnotes = [0]\nsample = "../impulse.wav"\ngian = 0.5\n', "unknown key"),
    ("missing layer key is named", 'loops = 1\n[[layer]]\nbeats = 1\nnotes = [0]\n', "missing sample"),
    ("no layers at all is caught", 'loops = 1\ncycle_duration = 2.0\n', "no layers"),
    ("wrong type for a setting is caught", 'loops = "four"\n[[layer]]\nbeats = 1\nnotes = [0]\nsample = "../impulse.wav"\n', "must be int"),
    ("wrong type for notes is caught", 'loops = 1\n[[layer]]\nbeats = 1\nnotes = ["a"]\nsample = "../impulse.wav"\n', "whole numbers or"),
    ("layer rules are shared with the CLI", 'loops = 1\n[[layer]]\nbeats = 4\nnotes = [0]\nsample = "../impulse.wav"\nactive = [9]\n', "outside 1..4"),
    ("malformed TOML is reported as such", 'loops = = 1\n', "not valid TOML"),
]
for label, text, expect in bad_configs:
    path = write_config("bad.toml", text)
    r = run("--config", str(path), "--out", str(tmp / "err.wav"))
    check(label, r.returncode == 2 and expect in (r.stdout + r.stderr), f"exit {r.returncode}")

r = run("--config", str(tmp / "nope.toml"), "--out", str(tmp / "err.wav"))
check("a missing config file is reported plainly",
      r.returncode == 2 and "not found" in (r.stdout + r.stderr))

r = run("--config", str(same_config), "--layer", f"1:0:{impulse}", "--out", str(tmp / "err.wav"))
check("--config and --layer together is refused",
      r.returncode == 2 and "not both" in (r.stdout + r.stderr))

r = run("--out", str(tmp / "err.wav"), "--loops", "1")
check("neither --config nor --layer is refused",
      r.returncode == 2 and "need either" in (r.stdout + r.stderr))

no_out = write_config("noout.toml", 'loops = 1\n[[layer]]\nbeats = 1\nnotes = [0]\nsample = "../impulse.wav"\n')
r = run("--config", str(no_out))
check("a config without an output path says so",
      r.returncode == 2 and "need --out" in (r.stdout + r.stderr))

# --- Scales and degrees -----------------------------------------------------
# Degrees are 1-based as musicians count them, so in major 1/3/5 must be the
# root, a major third and a perfect fifth: 0, 4 and 7 semitones.
check("degree 1/3/5 in major is a major triad",
      [degree_to_semitones(d, "major") for d in (1, 3, 5)] == [0, 4, 7])
check("degree 1/3/5 in minor flattens the third",
      [degree_to_semitones(d, "minor") for d in (1, 3, 5)] == [0, 3, 7])

# Past the end of a scale, degrees wrap into the next octave; below 1 they
# run downwards. Both fall out of floor division rather than special cases.
check("degree 8 is the octave above degree 1",
      degree_to_semitones(8, "major") == 12)
check("degree 15 is two octaves up",
      degree_to_semitones(15, "major") == 24)
check("degree 0 is one step BELOW the root",
      degree_to_semitones(0, "major") == -1, "the leading tone underneath")
check("degree -6 is the octave below",
      degree_to_semitones(-6, "major") == -12)

# Scales of other lengths must wrap on their own length, not on seven.
check("a five-note scale wraps after five degrees",
      degree_to_semitones(6, "minor_pentatonic") == 12
      and degree_to_semitones(1, "minor_pentatonic") == 0)

check("root transposes every degree equally",
      [degree_to_semitones(d, "minor", root=3) for d in (1, 3, 5)] == [3, 6, 10])

check("every named scale starts on its root and stays inside an octave",
      all(iv[0] == 0 and all(0 <= x < 12 for x in iv) and iv == sorted(set(iv))
          for iv in SCALES.values()),
      f"{len(SCALES)} scales")

# Degrees resolve to semitones at the layer boundary, so the same piece
# written either way must produce identical audio.
by_degree = render([f"4::{tmp}/sine440.wav:degrees=1,3,5,8:scale=major"], 1, "deg.wav",
                   "--cycle-duration", "2.0")
by_semitone = render([f"4:0,4,7,12:{tmp}/sine440.wav"], 1, "semi.wav",
                     "--cycle-duration", "2.0")
check("degrees and the semitones they resolve to render identically",
      np.array_equal(by_degree, by_semitone), "major 1,3,5,8 == 0,4,7,12")

# Swapping the scale must change the audio and nothing else.
minor_ver = render([f"4::{tmp}/sine440.wav:degrees=1,3,5,8:scale=minor"], 1, "min.wav",
                   "--cycle-duration", "2.0")
check("changing the scale changes the pitches",
      not np.array_equal(by_degree, minor_ver) and len(by_degree) == len(minor_ver))

for label, args, expect in [
    ("degrees without a scale are refused",
     ["--layer", f"4::{impulse}:degrees=1,3"], "degrees need a scale"),
    ("an unknown scale lists the real ones",
     ["--layer", f"4::{impulse}:degrees=1:scale=klingon"], "unknown scale"),
    ("notes and degrees together are refused",
     ["--layer", f"4:0:{impulse}:degrees=1:scale=major"], "not both"),
    ("neither notes nor degrees is refused",
     ["--layer", f"4::{impulse}"], "either notes"),
    ("a scale alongside plain semitones is flagged",
     ["--layer", f"4:0,4:{impulse}:scale=major"], "use degrees instead"),
]:
    r = run(*args, "--loops", "1", "--out", str(tmp / "err.wav"))
    check(label, r.returncode == 2 and expect in (r.stdout + r.stderr), f"exit {r.returncode}")

# In a config: a global scale applies to layers written in degrees, and must
# leave layers written in semitones completely alone.
scale_cfg = write_config("scale.toml", f"""
cycle_duration = 2.0
loops = 1
scale = "minor"

[[layer]]
beats = 2
degrees = [1, 3]
sample = "../impulse.wav"

[[layer]]
beats = 2
notes = [0, 3]
sample = "../impulse.wav"
""")
layers_cfg = build_piece(*read_spec(str(scale_cfg))).layers
check("a global scale reaches the layer written in degrees",
      layers_cfg[0].notes == [0, 3], f"minor 1,3 -> {layers_cfg[0].notes}")
check("a global scale leaves a semitone layer untouched",
      layers_cfg[1].notes == [0, 3], "notes pass through unchanged")

bad_scale_cfg = write_config("badscale.toml",
    'loops = 1\nscale = "klingon"\n[[layer]]\nbeats = 1\ndegrees = [1]\nsample = "../impulse.wav"\n')
r = run("--config", str(bad_scale_cfg), "--out", str(tmp / "err.wav"))
check("a config naming an unknown scale is refused",
      r.returncode == 2 and "unknown scale" in (r.stdout + r.stderr))

# --- Rests ------------------------------------------------------------------
# "-" in a sequence means "sound nothing here". It has to be a marker rather
# than a number, because 0 already means unison in semitones and one step
# below the root as a degree.
rest_sched = schedule([Layer(beats=4, notes=[0, None, 7, None], sample_path="a.wav")], loops=1)
check("a rest produces no event at all",
      [e.pulse for e in rest_sched] == [0, 2], "4 beats, 2 rests -> 2 events")

check("a layer of nothing but rests is refused",
      _expect_value_error(lambda: make_layer(beats=2, sample_path="a.wav", notes=[None, None])),
      "would never sound")

# The important distinction: an inactive BEAT is silent on the same beat every
# cycle, but a rest travels with the SEQUENCE, so when the sequence and the
# beat count are different lengths it lands somewhere new each time round.
travelling = schedule(
    [Layer(beats=4, notes=[0, None, 0, 0, 0, 0], sample_path="a.wav")], loops=3
)
silent_beats = sorted(set(range(12)) - {e.pulse for e in travelling})
check("a rest moves between cycles when the sequence length differs from the beats",
      silent_beats == [1, 7], f"silent at beats {silent_beats}, not the same beat each cycle")

fixed = schedule([Layer(beats=4, notes=[0], sample_path="a.wav", active_beats={0, 2, 3})], loops=3)
silent_fixed = sorted(set(range(12)) - {e.pulse for e in fixed})
check("an inactive beat is silent in the same place every cycle",
      silent_fixed == [1, 5, 9], f"silent at beats {silent_fixed}, every 4")

# Rests work the same way through both notations and both front ends.
check("a rest inside degrees survives the scale conversion",
      make_layer(beats=3, sample_path="a.wav", degrees=[1, None, 3], scale="major").notes
      == [0, None, 4])

by_rest = render([f"4:0,-,7,-:{impulse}"], 1, "rest.wav", "--cycle-duration", "2.0")
check("rests reach the audio through the command line",
      len(np.nonzero(by_rest)[0]) == 2, f"{len(np.nonzero(by_rest)[0])} onsets from 4 beats")

rest_cfg = write_config("rest.toml", """
cycle_duration = 2.0
loops = 1
[[layer]]
beats = 4
notes = [0, "-", 7, "-"]
sample = "../impulse.wav"
""")
r = run("--config", str(rest_cfg), "--out", str(tmp / "restcfg.wav"))
check("rests reach the audio through a config file",
      r.returncode == 0
      and np.array_equal(sf.read(tmp / "restcfg.wav", dtype="float32")[0], by_rest))

for label, args, expect in [
    ("a bad token in a sequence names the rest marker",
     ["--layer", f"4:0,x,7:{impulse}"], "or '-' for a rest"),
    ("'-' is still rejected where a beat number belongs",
     ["--layer", f"4:0:{impulse}:active=1,-"], "whole numbers"),
]:
    r = run(*args, "--loops", "1", "--out", str(tmp / "err.wav"))
    check(label, r.returncode == 2 and expect in (r.stdout + r.stderr), f"exit {r.returncode}")

# "-5" must stay the number minus five rather than being read as a rest.
check("a negative number is not mistaken for the rest marker",
      parse_layer_arg(f"3:-5,0,-:{impulse}")["notes"] == [-5, 0, "-"])

# --- Spec and Piece ----------------------------------------------------------
# A spec is what the user wrote; a Piece is what it means. The spec has to
# survive being written out and read back unchanged -- that is what will let
# a GUI save a piece and still offer its scale for editing.
for config_file in sorted((ROOT / "configs").glob("*.toml")):
    spec, _ = read_spec(str(config_file))
    check(f"spec round-trips through JSON unchanged: {config_file.name}",
          json.loads(json.dumps(spec)) == spec)

piece_spec = {
    "cycle_duration": 2.0, "loops": 3, "scale": "dorian",
    "layer": [
        {"beats": 3, "degrees": [1, "-", 5], "sample": str(impulse)},
        {"beats": 4, "notes": [0], "sample": str(impulse), "gain": 0.5},
    ],
}
piece = build_piece(piece_spec)
check("a Piece knows its own timing",
      piece.lcm_beats == 12 and abs(piece.cycle_duration - 2.0) < 1e-9
      and abs(piece.total_duration - 6.0) < 1e-9 and piece.total_pulses == 36,
      f"LCM {piece.lcm_beats}, {piece.cycle_duration}s x {piece.loops}")

check("a Layer remembers what was written, not only what it resolved to",
      piece.layers[0].written == [1, None, 5] and piece.layers[0].pitch_kind == "degrees"
      and piece.layers[0].scale == "dorian" and piece.layers[0].notes == [0, None, 7])

piece_spec["loops"] = 99
check("a Piece keeps its own copy of the spec",
      piece.spec["loops"] == 3, "changing the caller's dict afterwards has no effect")


def _refused(spec_dict, expect):
    try:
        build_piece(spec_dict)
    except SpecError as e:
        return expect in str(e)
    return False


try:
    piece.loops = 5
    frozen = False
except Exception:
    frozen = True
check("a Piece cannot be altered once built", frozen)

check("a spec giving both tempo settings is refused rather than one silently winning",
      _refused({"cycle_duration": 2.0, "pulse_duration": 0.1, "loops": 1,
                "layer": [{"beats": 1, "notes": [0], "sample": str(impulse)}]}, "not both"))

rounded = build_piece({"cycle_duration": 2.0, "loops": 1, "layer": [
    {"beats": b, "notes": [0], "sample": str(impulse)} for b in (3, 4, 5, 7, 11, 13)]})
check("warnings come back as data rather than being printed",
      any("rounded" in w for w in rounded.warnings), f"{len(rounded.warnings)} warning(s)")

# --- The grid ---------------------------------------------------------------
# The schedule only lists what sounds. The grid lists every beat of every
# layer in every cycle, silent ones included, because a picture of the piece
# needs the silences as much as the notes -- and where each falls relative to
# the other layers.
g_layers = [
    Layer(beats=3, notes=[0, None, 7, 5, 3], sample_path="a.wav"),          # rests travel
    Layer(beats=4, notes=[2], sample_path="b.wav", active_beats={0, 2}),   # beats 2, 4 off
]
cells = grid(g_layers, loops=2)
check("the grid has exactly one cell per layer x cycle x beat",
      len(cells) == 2 * (3 + 4)
      and len({(c.layer, c.cycle, c.beat) for c in cells}) == len(cells),
      f"{len(cells)} cells")

check("the schedule is exactly the grid's sounding cells",
      [(e.layer, e.beat, e.pulse, e.semitones) for e in schedule(g_layers, 2)]
      == [(c.layer, c.beat, c.pulse, c.semitones) for c in cells if c.status == STATUS_NOTE])

# The rest is sequence position 1 of 5, read every 5th beat: occurrences 1, 6
# and 11, which over a 3-beat layer are beat 1 of cycle 0, beat 0 of cycle 2
# and beat 2 of cycle 3. Four cycles are needed to see it move twice.
rest_beats = [(c.cycle, c.beat) for c in grid(g_layers, loops=4)
              if c.layer == 0 and c.status == STATUS_REST]
check("a rest in the grid moves with the sequence",
      rest_beats == [(0, 1), (2, 0), (3, 2)], f"rests at (cycle, beat) {rest_beats}")
off_beats = [(c.cycle, c.beat) for c in cells if c.layer == 1 and c.status == STATUS_INACTIVE]
check("an inactive beat sits in the same place every cycle",
      off_beats == [(0, 1), (0, 3), (1, 1), (1, 3)], f"inactive at {off_beats}")

check("each event knows which of its layer's beats it is",
      [e.beat for e in schedule(g_layers, 1) if e.layer == 0] == [0, 2])

# The JSON export, which a display draws from without repeating any logic.
exp_piece = build_piece({
    "cycle_duration": 2.0, "loops": 2, "scale": "major",
    "layer": [
        {"beats": 3, "degrees": [1, 3, 5], "sample": str(impulse)},
        {"beats": 4, "notes": [0, "-", 0, 0], "sample": str(impulse)},
        {"beats": 4, "notes": [0, 7], "sample": str(impulse), "active": [1, 3]},
    ],
})
exported = piece_to_dict(exp_piece)
d_cells, d_layers = exported["derived"]["cells"], exported["derived"]["layers"]

check("cells are labelled in the user's own notation",
      [c["label"] for c in d_cells if c["layer"] == 0 and c["cycle"] == 1] == ["1", "3", "5"]
      and {c["label"] for c in d_cells if c["layer"] == 1} == {"x", "-"}
      and {c["label"] for c in d_cells if c["layer"] == 2} == {"0", "7"},
      "degrees as degrees, a drum as x, a rest as -")

check("counts a musician says aloud start at 1 in the export",
      d_cells[0]["cycle"] == 1 and d_cells[0]["beat"] == 1
      and max(c["cycle"] for c in d_cells) == 2)

heights = [c["height"] for c in d_cells if c["layer"] == 0 and c["cycle"] == 1]
check("pitch height spans each layer's own range",
      heights == [0.0, 0.571429, 1.0] and all(c["height"] == 0.5 for c in d_cells if c["layer"] == 1),
      f"major 1,3,5 -> {heights}; drums flat at 0.5")

check("an inactive beat keeps its would-be pitch but is marked inactive",
      [c["status"] for c in d_cells if c["layer"] == 2 and c["cycle"] == 1]
      == ["note", "inactive", "note", "inactive"])

# 3 against 4 against 4: the only instants where 2+ layers sound together.
co = [(c["cycle"], c["offset"], c["layers"]) for c in exported["derived"]["coincidences"]]
check("coincidences are exactly the instants where two or more layers sound",
      co == [(1, 0.0, [0, 1, 2]), (1, 0.5, [1, 2]), (2, 0.0, [0, 1, 2]), (2, 0.5, [1, 2])],
      f"{len(co)} coincidences")

check("beats that sound together share an offset, so they line up when drawn",
      all(len({c["offset"] for c in d_cells if c["pulse"] == k["pulse"]}) == 1
          for k in exported["derived"]["coincidences"]))

# Round trip through the command line: export, read the JSON back as a config
# from a DIFFERENT folder, and the audio must be identical.
json_dir = tmp / "elsewhere"
json_dir.mkdir()
run("--config", str(same_config), "--export-json", str(json_dir / "p.json"))
check("--export-json alone writes no audio",
      (json_dir / "p.json").is_file() and not list(json_dir.glob("*.wav")))
r = run("--config", str(json_dir / "p.json"), "--out", str(tmp / "from_json.wav"))
check("an exported piece renders byte-identically when read back in",
      r.returncode == 0
      and np.array_equal(sf.read(tmp / "from_json.wav", dtype="float32")[0],
                         sf.read(tmp / "cfg.wav", dtype="float32")[0]),
      "sample paths rewritten so the JSON works from its own folder")

# --- The visualiser -----------------------------------------------------------
# The page is one self-contained file. These checks look at the file Python
# writes; the browser check at the end looks at what a browser makes of it.
vis_layers = ["--layer", f"3:0,-,7:{impulse}:gain=0.3",
              "--layer", f"4:0:{impulse}:gain=0.3:active=1,3"]
vis_page = tmp / "vis.html"
r = run(*vis_layers, "--loops", "2", "--out", str(tmp / "vis.wav"), "--visualise", str(vis_page))
page_text = vis_page.read_text() if vis_page.is_file() else ""
# Any src= or href= pointing at the network would break the page offline.
check("--visualise writes one self-contained page",
      # The audio shows up as one enormous run of base64 letters and digits.
      r.returncode == 0 and "{{" not in page_text
      and re.search(r"[A-Za-z0-9+/]{100000,}", page_text)
      and not re.search(r"""(src|href)\s*=\s*["']?https?:""", page_text),
      f"{len(page_text) / 1e3:.0f} kB, audio and data embedded, nothing fetched")

run(*vis_layers, "--loops", "2", "--out", str(tmp / "vis_plain.wav"))
check("--visualise does not change the audio",
      (tmp / "vis.wav").read_bytes() == (tmp / "vis_plain.wav").read_bytes())

six = []
for _ in range(6):
    six += ["--layer", f"2:0:{impulse}:gain=0.1"]
r = run(*six, "--loops", "1", "--visualise", str(tmp / "six.html"))
check("more than five layers is refused by the visualiser, not truncated",
      r.returncode == 2 and "at most 5 layers" in r.stderr and not (tmp / "six.html").exists())
r = run(*six, "--loops", "1", "--out", str(tmp / "six.wav"))
check("...while six layers still render as audio", r.returncode == 0)

# A name like "</script>" inside the embedded data would end the <script>
# block early. It must come out escaped, yet read back as the same text.
hostile = {"name": "</script><b>&"}
escaped = _json_for_script_tag(hostile)
check("data embedded in the page cannot close its <script> block",
      "<" not in escaped and ">" not in escaped and json.loads(escaped) == hostile)


def find_chromium():
    """A headless browser, if this machine has one. Optional: the check that
    needs it is skipped rather than failed without one."""
    if os.environ.get("CHROMIUM"):
        return os.environ["CHROMIUM"]
    found = sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome"))
    return found[-1] if found else shutil.which("chromium") or shutil.which("chromium-browser")


chromium = find_chromium()
if chromium is None:
    print("[SKIP] the page draws every note (no headless Chromium found; set CHROMIUM=path)")
else:
    # --dump-dom prints the page as it stands after its scripts have run, so the
    # attributes the page sets on itself can be read back here. ?t=0 is a still
    # frame, needing no sound card.
    dom = subprocess.run(
        [chromium, "--headless=new", "--no-sandbox", "--disable-gpu",
         "--virtual-time-budget=4000", "--dump-dom", f"file://{vis_page}?t=0"],
        capture_output=True, text=True, timeout=60,
    ).stdout
    window = re.search(r'data-window="(\d+)"', dom)
    drawn = re.search(r'data-notes-drawn="(\d+)"', dom)
    derived = piece_to_dict(build_piece({"loops": 2, "cycle_duration": 2.0, "layer": [
        {"beats": 3, "notes": [0, "-", 7], "sample": str(impulse)},
        {"beats": 4, "notes": [0], "sample": str(impulse), "active": [1, 3]},
    ]}))["derived"]
    if window:
        expected = sum(1 for c in derived["cells"]
                       if c["status"] == "note" and c["cycle"] <= int(window.group(1)))
    check("the page loads in a browser without errors and draws every note",
          'data-ready="1"' in dom and "data-error" not in dom and window and drawn
          and int(drawn.group(1)) == expected,
          f"{drawn.group(1) if drawn else '?'} notes drawn" if window else "page did not finish")

print()
if failures:
    print(f"{len(failures)} FAILED: " + "; ".join(failures))
    # A non-zero exit code is how a script reports failure to whatever ran it,
    # so this can be wired into a git hook or CI and actually block a commit.
    sys.exit(1)
print("all checks passed")
