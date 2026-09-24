"""Writing a Piece out as JSON, for programs rather than people.

An export has two halves:

    {
      "format": "randaw-piece", "version": 1,
      "spec":    { ... },   what the user wrote -- reads back in with --config
      "derived": { ... },   everything worked out from it -- timing, the grid
    }

The spec half ROUND-TRIPS: `--config piece.json` reads it back and renders
exactly what produced it. That is what lets a GUI save a piece and later
offer its scale, degrees and rests for editing, because they are still there.

The derived half is one-way. It is everything a display needs, fully worked
out in Python, so that nothing drawing it has to repeat any musical logic --
the browser page only draws what it is given. Repeating the scheduling in
JavaScript would mean two copies of the rules in two languages, one of them
untested.

Numbering rule inside `derived`: counts a musician would say out loud --
cycle 1, beat 3 -- start at 1, matching how beats and degrees are written
everywhere else. Positions in a list -- `layer`, `step` -- start at 0,
because they index the lists beside them.
"""

import copy
import json
from collections import defaultdict
from pathlib import Path

from polyrhythm.piece import Piece
from polyrhythm.schedule import STATUS_NOTE, grid
from polyrhythm.spec import EXPORT_FORMAT, EXPORT_VERSION, relocate_paths

# Six decimal places is a microsecond -- far finer than anyone can hear or
# see -- and keeps the file readable instead of full of 0.30000000000000004.
PLACES = 6


def _is_percussive(layer) -> bool:
    """A layer written as notes that are all 0 is a drum: it has no melody,
    just hits. Displayed as x marks rather than a row of zeros."""
    return layer.pitch_kind == "notes" and all(n in (0, None) for n in layer.notes)


def _label(layer, step: int, percussive: bool) -> str:
    """What to print at one position, in the user's own notation."""
    written = layer.written if layer.written is not None else layer.notes
    value = written[step]
    if value is None:
        return "-"
    if percussive:
        return "x"
    return str(value)


def piece_to_dict(piece: Piece, relative_to: Path | None = None) -> dict:
    """Everything about a piece, as plain dicts and lists ready for JSON.

    `relative_to` is the folder the JSON will be saved in. Paths in the spec
    are rewritten to work from there, so the file still loads after being
    written somewhere other than where its config lived.
    """
    spec = (
        relocate_paths(piece.spec, piece.base_dir, relative_to)
        if relative_to is not None
        else copy.deepcopy(piece.spec)
    )

    layers_info = []
    for index, layer in enumerate(piece.layers):
        percussive = _is_percussive(layer)
        pitches = [n for n in layer.notes if n is not None]
        written = layer.written if layer.written is not None else layer.notes
        layers_info.append(
            {
                "layer": index,
                "name": Path(layer.sample_path).stem,
                "sample": Path(layer.sample_path).name,
                "beats": layer.beats,
                "gain": layer.gain,
                "pitch_kind": layer.pitch_kind,
                "percussive": percussive,
                "scale": layer.scale,
                "root": layer.root,
                "sequence": ["-" if w is None else w for w in written],
                # Back to 1-based for anything a person reads.
                "active": (
                    sorted(b + 1 for b in layer.active_beats)
                    if layer.active_beats is not None
                    else None
                ),
                # The layer's own pitch range, so each row of a display can
                # spread its notes across the full height. A shared range would
                # flatten a narrow melody sitting next to a wide one.
                "pitch_low": min(pitches),
                "pitch_high": max(pitches),
            }
        )

    cells = []
    # defaultdict(list) is a dict that invents an empty list the first time
    # any new key is looked up, so the grouping below needs no "if the key
    # isn't there yet, create it" step.
    notes_at_pulse = defaultdict(list)
    for cell in grid(piece.layers, piece.loops):
        info = layers_info[cell.layer]
        low, high = info["pitch_low"], info["pitch_high"]
        if info["percussive"] or cell.semitones is None or high == low:
            height = 0.5
        else:
            height = (cell.semitones - low) / (high - low)

        cells.append(
            {
                "layer": cell.layer,
                "cycle": cell.cycle + 1,
                "beat": cell.beat + 1,
                "step": cell.step,
                "pulse": cell.pulse,
                "time": round(cell.pulse * piece.pulse_duration, PLACES),
                # How far through its cycle this beat falls, 0 to just under 1.
                # A display lays each cycle out across the same width, so this
                # is all it needs to place the beat -- and it is identical for
                # beats in different layers that land at the same instant.
                "offset": round(cell.beat / piece.layers[cell.layer].beats, PLACES),
                "status": cell.status,
                "semitones": cell.semitones,
                "label": _label(piece.layers[cell.layer], cell.step, info["percussive"]),
                "height": round(height, PLACES),
            }
        )
        if cell.status == STATUS_NOTE:
            notes_at_pulse[cell.pulse].append(cell.layer)

    # Instants where two or more layers sound together. Worked out here so the
    # display can simply draw them -- and so the rule for what counts as
    # "together" (exactly the same pulse) is tested in Python.
    lcm = piece.lcm_beats
    coincidences = [
        {
            "pulse": pulse,
            "time": round(pulse * piece.pulse_duration, PLACES),
            "cycle": pulse // lcm + 1,
            "offset": round((pulse % lcm) / lcm, PLACES),
            "layers": sorted(set(layers)),
        }
        for pulse, layers in sorted(notes_at_pulse.items())
        if len(set(layers)) >= 2
    ]

    return {
        "format": EXPORT_FORMAT,
        "version": EXPORT_VERSION,
        "spec": spec,
        "derived": {
            "sample_rate": piece.sample_rate,
            "loops": piece.loops,
            "lcm": lcm,
            "samples_per_pulse": piece.samples_per_pulse,
            "pulse_duration": round(piece.pulse_duration, 9),
            "cycle_duration": round(piece.cycle_duration, 9),
            "total_duration": round(piece.total_duration, 9),
            "warnings": list(piece.warnings),
            "layers": layers_info,
            "cells": cells,
            "coincidences": coincidences,
        },
    }


def write_export(piece: Piece, path: str) -> dict:
    """Write the export to a file, returning what was written."""
    out = Path(path)
    data = piece_to_dict(piece, relative_to=out.resolve().parent)
    # indent=2 makes it readable by eye, at the cost of a bigger file.
    out.write_text(json.dumps(data, indent=2) + "\n")
    return data
