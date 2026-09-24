"""The spec: a piece exactly as the user wrote it.

A spec is a plain dictionary in the shape of the TOML config files:

    {
        "cycle_duration": 2.0,
        "loops": 8,
        "scale": "dorian",
        "layer": [
            {"beats": 8, "notes": [0, "-", 0], "sample": "kick.wav", "active": [1, 4, 7]},
            {"beats": 5, "degrees": [1, 3, 5], "sample": "pluck.wav", "gain": 0.4},
        ],
    }

It keeps things the way you wrote them -- degrees rather than semitones, beats
counted from 1, rests as "-", paths relative to the file. That is deliberate:
the spec is the half of the picture that has to survive being saved and
loaded again, and a GUI can only let you change a scale if the scale is still
there to change.

Turning a spec into something playable is `piece.build_piece()`'s job. This
module handles reading specs from files, checking them, and building layers
from their entries.

TOML and JSON are simply two ways of writing the same dictionary down. TOML
is for people (it allows comments); JSON is for programs (the standard library
can write it as well as read it).
"""

import copy
import json
import os
import tomllib
from pathlib import Path

from polyrhythm.layer import REST, Layer, make_layer
from polyrhythm.scales import SCALES, scale_names

# Written into exported JSON so a file can say what it is. A version number
# costs nothing now and means a future change of shape can be detected rather
# than silently misread.
EXPORT_FORMAT = "randaw-piece"
EXPORT_VERSION = 1

# Listing the permitted keys lets us reject typos. Without this, writing
# `cycle_durations = 2.0` would be silently ignored and you would spend ten
# minutes wondering why the tempo never changed.
TOP_LEVEL_KEYS = {
    "cycle_duration",
    "pulse_duration",
    "loops",
    "out",
    "sample_rate",
    "max_duration",
    "scale",
    "root",
    "layer",
}
LAYER_KEYS = {"beats", "notes", "degrees", "sample", "gain", "active", "scale", "root"}

# Settings a spec may carry, and the type each must be. Used for both the
# whitelist check and the type check, so they can't disagree.
SETTING_TYPES = {
    "cycle_duration": float,
    "pulse_duration": float,
    "loops": int,
    "out": str,
    "sample_rate": int,
    "max_duration": float,
}


class SpecError(Exception):
    """Anything wrong with what the user asked for.

    One exception type for every front end to catch -- a bad TOML file, a bad
    --layer string and (later) a bad value typed into the GUI all arrive as
    this, with a message meant for a person to read. A custom type rather
    than catching Exception, so real bugs are not swallowed along with it.
    """


# --- Reading from files ----------------------------------------------------------


def read_spec(path: str) -> tuple[dict, Path]:
    """Read a spec from a .toml or .json file.

    Returns the spec and the directory it came from. Paths inside a spec are
    relative to the file, not to wherever the program happens to be running,
    so a config and its samples can be moved together -- which means the
    directory has to travel alongside the spec.

    A JSON file may be either a bare spec or a full export (with the derived
    timing and grid alongside); an export is unwrapped to its spec half.
    """
    spec_path = Path(path)
    try:
        # Both parsers want the file opened in BINARY mode ("rb") and decode
        # the UTF-8 themselves rather than guessing at an encoding.
        with open(spec_path, "rb") as f:
            if spec_path.suffix.lower() == ".json":
                data = json.load(f)
            else:
                data = tomllib.load(f)
    except FileNotFoundError:
        raise SpecError(f"config file not found: {path}") from None
    except tomllib.TOMLDecodeError as e:
        raise SpecError(f"{path} is not valid TOML: {e}") from None
    except json.JSONDecodeError as e:
        raise SpecError(f"{path} is not valid JSON: {e}") from None

    if not isinstance(data, dict):
        raise SpecError(f"{path}: expected a table of settings at the top level")

    if data.get("format") == EXPORT_FORMAT:
        if data.get("version") != EXPORT_VERSION:
            raise SpecError(
                f"{path}: written by a different version of this tool "
                f"(format version {data.get('version')!r}, expected {EXPORT_VERSION})"
            )
        data = data.get("spec")
        if not isinstance(data, dict):
            raise SpecError(f"{path}: export has no spec in it")

    return data, spec_path.parent


def relocate_paths(spec: dict, from_dir: Path, to_dir: Path) -> dict:
    """A copy of the spec whose relative paths still work from `to_dir`.

    Needed when a spec is written somewhere other than where it came from:
    "../samples/kick.wav" is right next to configs/tresillo.toml but wrong
    next to a JSON file saved in the repo root. os.path.relpath works out the
    new relative route between two directories.

    copy.deepcopy makes a fully independent copy, lists inside dicts inside
    lists included, so changing the copy can never reach back into the
    original. A plain .copy() would share the inner lists.
    """
    moved = copy.deepcopy(spec)

    def fix(p: str) -> str:
        if os.path.isabs(p):
            return p
        return os.path.relpath(Path(from_dir) / p, Path(to_dir))

    for entry in moved.get("layer", []):
        if isinstance(entry, dict) and isinstance(entry.get("sample"), str):
            entry["sample"] = fix(entry["sample"])
    if isinstance(moved.get("out"), str):
        moved["out"] = fix(moved["out"])
    return moved


# --- Checking what a spec contains ---------------------------------------------


def _require_int_list(value, what: str) -> list[int]:
    """A spec hands back whatever was written, so check before trusting it.

    isinstance(x, bool) is checked first because in Python `True` IS an int
    (bool subclasses int), so `active = [true]` would otherwise sneak through
    as the number 1.
    """
    if not isinstance(value, list) or any(
        isinstance(n, bool) or not isinstance(n, int) for n in value
    ):
        raise SpecError(f"{what} must be a list of whole numbers, got {value!r}")
    return value


def _require_sequence(value, what: str) -> list[int | None]:
    """Like the above, but for notes and degrees, where the REST marker is
    allowed alongside the numbers and becomes None.

    Not used for `active`, where a rest would be meaningless -- silencing a
    beat is exactly what `active` already does.
    """
    if not isinstance(value, list):
        raise SpecError(f"{what} must be a list, got {value!r}")
    items: list[int | None] = []
    for item in value:
        if item == REST:
            items.append(None)
        elif isinstance(item, bool) or not isinstance(item, int):
            raise SpecError(
                f"{what} must contain whole numbers or {REST!r} for a rest, got {item!r}"
            )
        else:
            items.append(item)
    return items


def check_settings(spec: dict, source: str) -> dict:
    """Check the top level of a spec and return its settings, correctly typed.

    `source` is only for error messages -- a file name, or "command line" --
    so a person can tell where the mistake is.
    """
    if not isinstance(spec, dict):
        raise SpecError(f"{source}: expected a table of settings")

    unknown = set(spec) - TOP_LEVEL_KEYS
    if unknown:
        # sorted() so the message is stable rather than in set order, which
        # varies between runs and makes errors hard to compare.
        raise SpecError(
            f"{source}: unknown setting(s) {', '.join(sorted(unknown))}. "
            f"Expected any of: {', '.join(sorted(TOP_LEVEL_KEYS))}"
        )

    if not isinstance(spec.get("layer"), list) or not spec["layer"]:
        raise SpecError(f"{source}: no layers. Add at least one [[layer]] block.")

    settings = {}
    for key, expected in SETTING_TYPES.items():
        if key not in spec:
            continue
        value = spec[key]
        # An int where a float is wanted is fine -- `cycle_duration = 2` is a
        # reasonable thing to write -- so widen ints rather than rejecting
        # them. The bool guard applies here too.
        if expected is float and isinstance(value, int) and not isinstance(value, bool):
            value = float(value)
        if isinstance(value, bool) or not isinstance(value, expected):
            raise SpecError(f"{source}: {key} must be {expected.__name__}, got {value!r}")
        settings[key] = value

    # The two tempo settings are alternative ways of saying the same thing.
    # Given both, one would have to silently lose, so refuse instead.
    if "cycle_duration" in settings and "pulse_duration" in settings:
        raise SpecError(f"{source}: give cycle_duration or pulse_duration, not both")

    # `scale` and `root` at the top level are defaults for any layer written
    # in degrees. A layer stating pitches as `notes` ignores both, which is
    # what stops a global scale from quietly reinterpreting the drums.
    scale = spec.get("scale")
    if scale is not None and not isinstance(scale, str):
        raise SpecError(f"{source}: scale must be a name, got {scale!r}")
    if scale is not None and scale not in SCALES:
        raise SpecError(f"{source}: unknown scale {scale!r}; expected one of: {scale_names()}")
    root = spec.get("root", 0)
    if isinstance(root, bool) or not isinstance(root, int):
        raise SpecError(f"{source}: root must be a whole number of semitones, got {root!r}")
    settings["scale"] = scale
    settings["root"] = root

    return settings


def layer_from_spec(
    entry,
    *,
    base_dir: Path,
    default_scale: str | None = None,
    default_root: int = 0,
    where: str = "layer",
) -> Layer:
    """Build one Layer from one entry of a spec's layer list.

    The `*` in the parameter list makes everything after it keyword-only:
    callers must write `base_dir=...` rather than passing it by position.
    With several optional settings that look alike, that makes a mix-up
    impossible rather than merely unlikely.
    """
    if not isinstance(entry, dict):
        raise SpecError(f"{where} must be a [[layer]] block")

    unknown = set(entry) - LAYER_KEYS
    if unknown:
        raise SpecError(
            f"{where}: unknown key(s) {', '.join(sorted(unknown))}. "
            f"Expected any of: {', '.join(sorted(LAYER_KEYS))}"
        )
    missing = {"beats", "sample"} - set(entry)
    if missing:
        raise SpecError(f"{where}: missing {', '.join(sorted(missing))}")
    # Whether notes or degrees are present is make_layer's rule, not ours --
    # checking it here too would be a second copy with its own wording.

    if isinstance(entry["beats"], bool) or not isinstance(entry["beats"], int):
        raise SpecError(f"{where}: beats must be a whole number, got {entry['beats']!r}")
    if not isinstance(entry["sample"], str):
        raise SpecError(f"{where}: sample must be a path string")

    notes = _require_sequence(entry["notes"], f"{where}: notes") if "notes" in entry else None
    degrees = (
        _require_sequence(entry["degrees"], f"{where}: degrees") if "degrees" in entry else None
    )
    active = _require_int_list(entry["active"], f"{where}: active") if "active" in entry else None

    # A layer's own scale wins over the spec-wide one. The spec-wide default
    # reaches a layer only when that layer is written in degrees, so a drum
    # layer using notes is never touched by it.
    scale = entry.get("scale", default_scale if degrees is not None else None)
    if scale is not None and not isinstance(scale, str):
        raise SpecError(f"{where}: scale must be a name, got {scale!r}")
    root = entry.get("root", default_root)
    if isinstance(root, bool) or not isinstance(root, int):
        raise SpecError(f"{where}: root must be a whole number of semitones, got {root!r}")

    gain = entry.get("gain", 1.0)
    if isinstance(gain, bool) or not isinstance(gain, (int, float)):
        raise SpecError(f"{where}: gain must be a number, got {gain!r}")

    try:
        # The same rules every front end uses -- one place, no drift.
        return make_layer(
            beats=entry["beats"],
            sample_path=str(base_dir / entry["sample"]),
            notes=notes,
            degrees=degrees,
            scale=scale,
            root=root,
            gain=float(gain),
            active=active,
        )
    except ValueError as e:
        raise SpecError(f"{where}: {e}") from None
