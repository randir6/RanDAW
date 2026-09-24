#!/usr/bin/env python3
"""Record what the PYTHON engine makes of a set of pieces: the answer key.

The JavaScript engine is a port of the Python one. The checks in
parity.test.js run the same pieces through JavaScript and must get exactly
these answers -- the same grid, and a byte-identical WAV file.

Two sets of pieces:

  * examples -- the six pieces in web/examples/. Their full derived data is
    stored, so a mismatch can be diffed field by field.
  * fuzz -- several hundred random pieces, about a third of them deliberately
    broken in some way. For these only fingerprints (hashes) are stored, to
    keep the file small. Random pieces reach corners nobody would think to
    write a test for: odd beat counts, negative degrees, awkward gains, rests
    in strange places, sample rates that force resampling.

Run from the repository root:  python3 web/test/make_fixtures.py
The output is committed, so the JavaScript checks keep working once the
Python version is retired.
"""

import copy
import hashlib
import io
import json
import random
import struct
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from polyrhythm.export import piece_to_dict  # noqa: E402
from polyrhythm.piece import build_piece  # noqa: E402
from polyrhythm.render import render_audio  # noqa: E402
from polyrhythm.scales import SCALES  # noqa: E402
from polyrhythm.schedule import schedule  # noqa: E402
from polyrhythm.spec import SpecError  # noqa: E402

SAMPLES = ROOT / "samples"
SAMPLE_NAMES = sorted(p.name for p in SAMPLES.glob("*.wav"))
OUT = Path(__file__).parent / "fixtures"


def canonical(value) -> str:
    """One exact text form of a JSON value, identical in both languages.

    Needed because the two write numbers differently -- Python says 1.0 where
    JavaScript says 1 -- so comparing JSON text would fail on equal values.
    Numbers become the 16 hex digits of their 64-bit binary form, and text
    becomes the hex of its UTF-8 bytes, which leaves nothing to disagree on.
    """
    if value is None:
        return "n"
    if value is True:
        return "t"
    if value is False:
        return "f"
    if isinstance(value, (int, float)):
        return "d" + struct.pack(">d", float(value)).hex()
    if isinstance(value, str):
        return "s" + value.encode("utf-8").hex() + ";"
    if isinstance(value, list):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(canonical(k) + ":" + canonical(value[k]) for k in sorted(value)) + "}"
    raise TypeError(f"cannot canonicalise {value!r}")


def fingerprint(value) -> str:
    return hashlib.sha256(canonical(value).encode("ascii")).hexdigest()


def run(spec, max_seconds=None):
    """What generate.py would do: build, schedule, render, clip, write WAV.
    Returns None for a piece longer than max_seconds, without rendering it."""
    piece = build_piece(copy.deepcopy(spec), base_dir=SAMPLES, source="piece")
    if max_seconds is not None and piece.total_duration > max_seconds:
        return None
    derived = piece_to_dict(piece)["derived"]
    mix = render_audio(
        events=schedule(piece.layers, piece.loops),
        total_pulses=piece.total_pulses,
        samples_per_pulse=piece.samples_per_pulse,
        sample_rate=piece.sample_rate,
    )
    mix = np.clip(mix, -1.0, 1.0)
    buffer = io.BytesIO()
    sf.write(buffer, mix, piece.sample_rate, format="WAV", subtype="PCM_16")
    wav = buffer.getvalue()
    return piece, derived, wav


# --- Random pieces ---------------------------------------------------------------


def random_sequence(rng, low, high):
    length = rng.randint(1, 9)
    seq = [rng.randint(low, high) for _ in range(length)]
    for i in range(length):
        if rng.random() < 0.15:
            seq[i] = "-"
    if all(s == "-" for s in seq):
        seq[0] = rng.randint(low, high)
    return seq


def random_layer(rng, top_scale):
    beats = rng.choice([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 16, 24])
    layer = {"beats": beats, "sample": rng.choice(SAMPLE_NAMES)}
    if rng.random() < 0.55:
        layer["notes"] = [0] if rng.random() < 0.3 else random_sequence(rng, -24, 24)
    else:
        layer["degrees"] = random_sequence(rng, -8, 16)
        if top_scale is None or rng.random() < 0.4:
            layer["scale"] = rng.choice(sorted(SCALES))
    if rng.random() < 0.3:
        layer["root"] = rng.randint(-12, 12)
    if rng.random() < 0.8:
        layer["gain"] = rng.choice([1, round(rng.uniform(0.0, 1.4), 3), round(rng.uniform(0.0, 1.0), 2)])
    if rng.random() < 0.35:
        k = rng.randint(1, beats)
        layer["active"] = sorted(rng.sample(range(1, beats + 1), k))
    return layer


def random_spec(rng):
    spec = {}
    top_scale = rng.choice(sorted(SCALES)) if rng.random() < 0.4 else None
    if rng.random() < 0.8:
        spec["cycle_duration"] = round(rng.uniform(0.25, 2.0), 3)
    else:
        spec["pulse_duration"] = round(rng.uniform(0.01, 0.2), 4)
    spec["loops"] = rng.randint(1, 3)
    if rng.random() < 0.2:
        spec["sample_rate"] = rng.choice([22050, 32000, 48000])
    if top_scale is not None:
        spec["scale"] = top_scale
    if rng.random() < 0.2:
        spec["root"] = rng.randint(-7, 7)
    spec["layer"] = [random_layer(rng, top_scale) for _ in range(rng.randint(1, 5))]
    return spec


# Ways to break a piece. Each takes a valid-looking spec and damages it once.
# Values that are whole numbers written with a decimal point (4.0) are left
# out on purpose: JSON cannot tell 4.0 from 4, so JavaScript accepts them
# where Python refuses, and that difference is harmless.
def _layer(spec, rng):
    return rng.choice(spec["layer"])


def _both_pitch_kinds(layer):
    layer.setdefault("notes", [0])
    layer.setdefault("degrees", [1])


def _active_past_end(layer):
    layer["active"] = [layer["beats"] + 1]


def _degrees_without_scale(spec, layer):
    layer.pop("notes", None)
    layer.pop("scale", None)
    layer["degrees"] = [1, 5]
    spec.pop("scale", None)


BREAKERS = [
    lambda s, r: s.update(typo_setting=1),
    lambda s, r: _layer(s, r).update(colour="red"),
    lambda s, r: s.update(layer=[]),
    lambda s, r: s.pop("layer"),
    lambda s, r: s.pop("loops"),
    lambda s, r: s.update(loops=0),
    lambda s, r: s.update(loops=-2),
    lambda s, r: s.update(loops=2.5),
    lambda s, r: s.update(loops="4"),
    lambda s, r: s.update(loops=True),
    lambda s, r: s.update(loops=None),
    lambda s, r: s.update(cycle_duration=0),
    lambda s, r: s.update(cycle_duration=-1.5),
    lambda s, r: s.update(cycle_duration="2"),
    lambda s, r: s.update(cycle_duration=2.0, pulse_duration=0.1),
    lambda s, r: s.update(pulse_duration=0.0) if "pulse_duration" in s else s.update(cycle_duration=0.0),
    lambda s, r: s.update(sample_rate=0),
    lambda s, r: s.update(sample_rate=44100.5),
    lambda s, r: s.update(scale="mixolydian_flat9"),
    lambda s, r: s.update(scale=7),
    lambda s, r: s.update(root=1.5),
    lambda s, r: s.update(root=None),
    lambda s, r: s.update(root="C"),
    lambda s, r: _layer(s, r).pop("beats"),
    lambda s, r: _layer(s, r).pop("sample"),
    lambda s, r: _layer(s, r).update(beats=0),
    lambda s, r: _layer(s, r).update(beats=-3),
    lambda s, r: _layer(s, r).update(beats=3.5),
    lambda s, r: _layer(s, r).update(beats=False),
    lambda s, r: _layer(s, r).update(sample="nope.wav"),
    lambda s, r: _layer(s, r).update(sample=""),
    lambda s, r: _layer(s, r).update(sample=12),
    lambda s, r: _layer(s, r).update(notes=[0, 1], degrees=[1, 2]),
    lambda s, r: [_layer(s, r).pop(k, None) for k in ("notes", "degrees")],
    lambda s, r: _layer(s, r).update(notes=[]),
    lambda s, r: _layer(s, r).update(notes=["-", "-"]),
    lambda s, r: _layer(s, r).update(notes=[0, "x"]),
    lambda s, r: _layer(s, r).update(notes=[0, 1.5]),
    lambda s, r: _layer(s, r).update(notes=[0, True]),
    lambda s, r: _layer(s, r).update(notes=[0, None]),
    lambda s, r: _layer(s, r).update(notes="0,3,5"),
    lambda s, r: _layer(s, r).update(notes=[0, 3], scale="major"),
    lambda s, r: _both_pitch_kinds(_layer(s, r)),
    lambda s, r: _degrees_without_scale(s, _layer(s, r)),
    lambda s, r: _layer(s, r).update(gain=-0.5),
    lambda s, r: _layer(s, r).update(gain="loud"),
    lambda s, r: _layer(s, r).update(gain=None),
    lambda s, r: _layer(s, r).update(gain=True),
    lambda s, r: _layer(s, r).update(active=[0]),
    lambda s, r: _active_past_end(_layer(s, r)),
    lambda s, r: _layer(s, r).update(active=[1, 1.5]),
    lambda s, r: _layer(s, r).update(active=[1, "-"]),
    lambda s, r: _layer(s, r).update(active=[]),
    lambda s, r: _layer(s, r).update(active=[1, 1, 1]),
    lambda s, r: _layer(s, r).update(root=2.5),
    lambda s, r: _layer(s, r).update(scale=None),
    lambda s, r: _layer(s, r).update(scale="toString"),
    lambda s, r: s["layer"].append("not a layer"),
    lambda s, r: s["layer"].append([1, 2, 3]),
    lambda s, r: s.update(cycle_duration=0.0001, loops=1),
    lambda s, r: s.update(layer=[{"beats": 97, "notes": [0], "sample": "hat.wav"},
                                 {"beats": 89, "notes": [0], "sample": "hat.wav"},
                                 {"beats": 83, "notes": [0], "sample": "hat.wav"}]),
]


def make_fuzz(count=600, seed=20260924):
    rng = random.Random(seed)
    cases = []
    while len(cases) < count:
        spec = random_spec(rng)
        if rng.random() < 0.35:
            rng.choice(BREAKERS)(spec, rng)
        try:
            result = run(spec, max_seconds=8)  # kept short so the checks are quick
        except SpecError as e:
            cases.append({"spec": spec, "ok": False, "error": str(e)})
            continue
        if result is None:
            continue
        _, derived, wav = result
        cases.append({
            "spec": spec,
            "ok": True,
            "derived": fingerprint(derived),
            "wav": hashlib.sha256(wav).hexdigest(),
        })
    return cases


def main():
    OUT.mkdir(exist_ok=True)
    examples = {}
    for path in sorted((ROOT / "web" / "examples").glob("*.json")):
        spec = json.loads(path.read_text())
        _, derived, wav = run(spec)
        examples[path.stem] = {"derived": derived, "wav": hashlib.sha256(wav).hexdigest()}
    (OUT / "examples.json").write_text(json.dumps(examples, indent=1) + "\n")

    cases = make_fuzz()
    (OUT / "fuzz.json").write_text(json.dumps(cases, separators=(",", ":")) + "\n")

    # A few values the canonical form must agree on, checked from both sides.
    probe = [0, 1, 1.0, -0.5, 0.1, 1e-06, 123456789, "kick", "é", None, True, False, [1, [2]], {"b": 1, "a": 2}]
    (OUT / "canonical.json").write_text(json.dumps({"value": probe, "fingerprint": fingerprint(probe)}) + "\n")

    ok = sum(c["ok"] for c in cases)
    print(f"examples: {len(examples)}; fuzz: {len(cases)} ({ok} valid, {len(cases) - ok} refused)")


if __name__ == "__main__":
    main()
