"""Reading a piece from a TOML file.

TOML rather than JSON because these files are written by hand, and TOML
supports comments -- being able to write `active = [1, 4, 7]  # tresillo`
next to the number matters for something you tweak by ear. It also needs no
new dependency: `tomllib` has been in the standard library since Python 3.11.

The trade is that tomllib only READS. If something ever needs to write these
files (a GUI saving a project, say), that will need either a small extra
dependency or a hand-rolled writer.

An example of the shape:

    cycle_duration = 2.0
    loops = 8
    out = "tresillo.wav"

    [[layer]]
    beats = 8
    notes = [0, "-", 0, 0]
    sample = "../samples/kick.wav"
    gain = 0.75
    active = [1, 4, 7]

`[[layer]]` with double brackets is TOML's "array of tables": repeat the
block and you get a list of layers. "-" inside a note or degree sequence is
a rest -- that position sounds nothing.
"""

import tomllib
from pathlib import Path

from polyrhythm.layer import REST, Layer, make_layer
from polyrhythm.scales import SCALES, scale_names

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

# Settings a config may carry, and the type each must be. Used for both the
# whitelist check and the type check, so they can't disagree.
SETTING_TYPES = {
    "cycle_duration": float,
    "pulse_duration": float,
    "loops": int,
    "out": str,
    "sample_rate": int,
    "max_duration": float,
}


class ConfigError(Exception):
    """Raised for anything wrong with a config file.

    A custom exception type so the caller can catch exactly this and print it
    plainly, rather than catching Exception and swallowing real bugs too.
    """


def _require_int_list(value, what: str) -> list[int]:
    """TOML hands back whatever was written, so check before trusting it.

    isinstance(x, bool) is checked first because in Python `True` IS an int
    (bool subclasses int), so `notes = [true]` would otherwise sneak through
    as the number 1.
    """
    if not isinstance(value, list) or any(
        isinstance(n, bool) or not isinstance(n, int) for n in value
    ):
        raise ConfigError(f"{what} must be a list of whole numbers, got {value!r}")
    return value


def _require_sequence(value, what: str) -> list[int | None]:
    """Like the above, but for notes and degrees, where the REST marker is
    allowed alongside the numbers and becomes None.

    Not used for `active`, where a rest would be meaningless -- silencing a
    beat is exactly what `active` already does.
    """
    if not isinstance(value, list):
        raise ConfigError(f"{what} must be a list, got {value!r}")
    items: list[int | None] = []
    for item in value:
        if item == REST:
            items.append(None)
        elif isinstance(item, bool) or not isinstance(item, int):
            raise ConfigError(
                f"{what} must contain whole numbers or {REST!r} for a rest, got {item!r}"
            )
        else:
            items.append(item)
    return items


def load_config(path: str) -> tuple[list[Layer], dict]:
    """Read a config file into layers and settings.

    Returns a plain dict of settings rather than applying them, so the caller
    decides how they combine with anything given on the command line.
    """
    config_path = Path(path)
    try:
        # tomllib requires a file opened in BINARY mode ("rb"). It decodes the
        # UTF-8 itself, and refuses a text-mode handle rather than guessing at
        # an encoding.
        with open(config_path, "rb") as f:
            data = tomllib.load(f)
    except FileNotFoundError:
        raise ConfigError(f"config file not found: {path}") from None
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"{path} is not valid TOML: {e}") from None

    unknown = set(data) - TOP_LEVEL_KEYS
    if unknown:
        # sorted() so the message is stable rather than in set order, which
        # varies between runs and makes errors hard to compare.
        raise ConfigError(
            f"{path}: unknown setting(s) {', '.join(sorted(unknown))}. "
            f"Expected any of: {', '.join(sorted(TOP_LEVEL_KEYS))}"
        )

    if "layer" not in data or not data["layer"]:
        raise ConfigError(f"{path}: no layers. Add at least one [[layer]] block.")

    settings = {}
    for key, expected in SETTING_TYPES.items():
        if key not in data:
            continue
        value = data[key]
        # An int where a float is wanted is fine -- `loops = 4` and
        # `cycle_duration = 2` are both reasonable to write -- so widen ints
        # rather than rejecting them. The bool guard applies here too.
        if expected is float and isinstance(value, int) and not isinstance(value, bool):
            value = float(value)
        if isinstance(value, bool) or not isinstance(value, expected):
            raise ConfigError(
                f"{path}: {key} must be {expected.__name__}, got {value!r}"
            )
        settings[key] = value

    # `scale` and `root` at the top level are defaults for any layer written
    # in degrees. They are handled apart from the settings above because they
    # are consumed here, when layers are built, rather than passed on to the
    # renderer -- degrees become semitones before anything downstream sees
    # them. A layer stating pitches as `notes` ignores both entirely, which
    # is what stops a global scale from quietly reinterpreting the drums.
    default_scale = data.get("scale")
    if default_scale is not None and not isinstance(default_scale, str):
        raise ConfigError(f"{path}: scale must be a name, got {default_scale!r}")
    if default_scale is not None and default_scale not in SCALES:
        raise ConfigError(
            f"{path}: unknown scale {default_scale!r}; expected one of: {scale_names()}"
        )
    default_root = data.get("root", 0)
    if isinstance(default_root, bool) or not isinstance(default_root, int):
        raise ConfigError(f"{path}: root must be a whole number of semitones, got {default_root!r}")

    # Paths are resolved relative to the CONFIG FILE, not the working
    # directory, so a config and its samples can be moved together and still
    # work from anywhere. `out` follows the same rule for consistency.
    base = config_path.parent
    if "out" in settings:
        settings["out"] = str(base / settings["out"])

    layers = []
    for index, entry in enumerate(data["layer"], start=1):
        # `where` gives every error below a precise location, which is most of
        # what makes a config file pleasant rather than infuriating.
        where = f"{path}: layer {index}"
        if not isinstance(entry, dict):
            raise ConfigError(f"{where} must be a [[layer]] block")

        unknown = set(entry) - LAYER_KEYS
        if unknown:
            raise ConfigError(
                f"{where}: unknown key(s) {', '.join(sorted(unknown))}. "
                f"Expected any of: {', '.join(sorted(LAYER_KEYS))}"
            )
        missing = {"beats", "sample"} - set(entry)
        if missing:
            raise ConfigError(f"{where}: missing {', '.join(sorted(missing))}")
        if "notes" not in entry and "degrees" not in entry:
            raise ConfigError(f"{where}: missing notes (semitones) or degrees (with a scale)")

        if isinstance(entry["beats"], bool) or not isinstance(entry["beats"], int):
            raise ConfigError(f"{where}: beats must be a whole number, got {entry['beats']!r}")
        if not isinstance(entry["sample"], str):
            raise ConfigError(f"{where}: sample must be a path string")

        notes = _require_sequence(entry["notes"], f"{where}: notes") if "notes" in entry else None
        degrees = (
            _require_sequence(entry["degrees"], f"{where}: degrees") if "degrees" in entry else None
        )
        active = (
            _require_int_list(entry["active"], f"{where}: active") if "active" in entry else None
        )

        # A layer's own scale wins over the file-wide one. The global default
        # reaches a layer only when that layer is written in degrees, so a
        # drum layer using notes is never touched by it.
        scale = entry.get("scale", default_scale if degrees is not None else None)
        if scale is not None and not isinstance(scale, str):
            raise ConfigError(f"{where}: scale must be a name, got {scale!r}")
        root = entry.get("root", default_root)
        if isinstance(root, bool) or not isinstance(root, int):
            raise ConfigError(f"{where}: root must be a whole number of semitones, got {root!r}")

        gain = entry.get("gain", 1.0)
        if isinstance(gain, bool) or not isinstance(gain, (int, float)):
            raise ConfigError(f"{where}: gain must be a number, got {gain!r}")

        try:
            # The same validation the command line uses -- one set of rules.
            layers.append(
                make_layer(
                    beats=entry["beats"],
                    sample_path=str(base / entry["sample"]),
                    notes=notes,
                    degrees=degrees,
                    scale=scale,
                    root=root,
                    gain=float(gain),
                    active=active,
                )
            )
        except ValueError as e:
            raise ConfigError(f"{where}: {e}") from None

    return layers, settings
