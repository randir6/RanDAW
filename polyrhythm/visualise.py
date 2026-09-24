"""Building the self-contained HTML visualiser for a piece.

The page itself lives in visualiser.html, next to this file. This module only
fills it in: the piece's derived data (from export.py) and the rendered audio
go into it, and out comes one .html file with nothing external -- no server,
no internet, no install. Open it in a browser and press play.

All the musical working-out happened in Python before it gets here. The page
only draws and plays what it is given.
"""

import base64
import html
import io
import json
from pathlib import Path

import numpy as np
import soundfile as sf

from polyrhythm.export import piece_to_dict
from polyrhythm.piece import Piece

# The visualiser shows at most this many layers, for now.
#
# This limit belongs to the visualiser ONLY. VISION.md rules out a layer limit
# in the core data model, so a Piece, a Layer and the renderer all stay
# unlimited -- a six-layer piece still renders perfectly well as audio. And
# the page lays its rows out from however many layers it is given rather than
# from this number, so raising it is a one-line change.
MAX_LAYERS = 5

# Past this size, embedding the audio makes a file that is slow to open and
# awkward to share. A warning rather than a refusal: it still works.
LARGE_FILE_BYTES = 20_000_000

TEMPLATE = Path(__file__).with_name("visualiser.html")


class VisualiseError(Exception):
    """This piece cannot be visualised, though it may still render as audio."""


def check_visualisable(piece: Piece) -> None:
    """Refuse, rather than quietly leave something out.

    Showing the first five layers of six would put a layer on the page you
    can hear but not see, and then the page could not be trusted about
    anything else either.
    """
    if len(piece.layers) > MAX_LAYERS:
        raise VisualiseError(
            f"the visualiser shows at most {MAX_LAYERS} layers and this piece has "
            f"{len(piece.layers)}. The audio renders fine without --visualise."
        )


def wav_bytes(mix: np.ndarray, sample_rate: int) -> bytes:
    """The audio as the bytes of a WAV file, without touching the disk.

    io.BytesIO is an in-memory stand-in for a file: soundfile writes into it
    exactly as it would into a real one, and getvalue() hands back the bytes.
    """
    buffer = io.BytesIO()
    sf.write(buffer, mix, sample_rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


def _json_for_script_tag(data) -> str:
    """JSON that is safe to place inside an HTML <script> block.

    A sample called "</script>.wav" would otherwise end the block early and
    spill the rest of the data into the page as HTML. Writing <, > and & as
    \\u003c-style escapes is still valid JSON -- JSON.parse turns them back
    into the same characters -- but the HTML parser never sees a tag.
    """
    text = json.dumps(data, separators=(",", ":"))
    return text.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def render_html(piece: Piece, audio: bytes, title: str) -> str:
    """The finished page, as one string."""
    check_visualisable(piece)
    full = piece_to_dict(piece)
    # Only the derived half goes in. The page has no use for the spec, and
    # leaving it out means a shared file does not carry the paths to your
    # sample folders.
    data = {"format": full["format"], "version": full["version"], "derived": full["derived"]}

    page = TEMPLATE.read_text()
    # base64 turns arbitrary bytes into plain letters and digits, which can sit
    # inside a text file. It costs a third more space than the raw bytes.
    return (
        page.replace("{{PIECE_JSON}}", _json_for_script_tag(data))
        .replace("{{AUDIO_B64}}", base64.b64encode(audio).decode("ascii"))
        # html.escape turns & < > and quotes into their safe HTML forms, so a
        # title can never be mistaken for markup.
        .replace("{{TITLE}}", html.escape(title))
    )


def write_html(piece: Piece, audio: bytes, path: str, title: str) -> int:
    """Write the page and return its size in bytes."""
    page = render_html(piece, audio, title)
    Path(path).write_text(page, encoding="utf-8")
    return len(page.encode("utf-8"))
