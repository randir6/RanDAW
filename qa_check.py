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
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from polyrhythm.layer import Layer
from polyrhythm.schedule import schedule

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
    ("wrong type for notes is caught", 'loops = 1\n[[layer]]\nbeats = 1\nnotes = ["a"]\nsample = "../impulse.wav"\n', "list of whole numbers"),
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

print()
if failures:
    print(f"{len(failures)} FAILED: " + "; ".join(failures))
    # A non-zero exit code is how a script reports failure to whatever ran it,
    # so this can be wired into a git hook or CI and actually block a commit.
    sys.exit(1)
print("all checks passed")
