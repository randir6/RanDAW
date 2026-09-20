"""Reading sample files, and bending their pitch.

Everything here treats audio as a numpy array of numbers between -1.0 and
+1.0, one number per sample. At 44100 samples per second, a one-second sound
is an array of 44100 floats. "Sample" is unfortunately overloaded in audio:
it means both "a short sound file you trigger" and "one single measurement of
a waveform". Here it usually means the second.
"""

import numpy as np
import soundfile as sf


def _resample_linear(data: np.ndarray, new_length: int) -> np.ndarray:
    """Stretch or squash an array to a new length, inventing in-between values.

    The leading underscore is a convention meaning "internal to this module" --
    other files shouldn't import it. Python doesn't prevent them; it's a
    social contract, like a door marked 'staff only'.
    """
    if new_length == len(data):
        return data  # nothing to do, and returning early avoids pointless work

    # np.linspace(start, stop, num) gives `num` evenly spaced numbers.
    # endpoint=False excludes the stop value, so 0..1 in 4 steps is
    # [0, 0.25, 0.5, 0.75] rather than [0, 0.33, 0.67, 1.0]. That matters
    # because samples represent equal-length slices of time, not fenceposts.
    #
    # We describe both the old and new arrays as positions along the same
    # 0-to-1 timeline, which is what lets us map between them.
    old_x = np.linspace(0.0, 1.0, num=len(data), endpoint=False)
    new_x = np.linspace(0.0, 1.0, num=new_length, endpoint=False)

    # np.interp looks up each new_x position in the old curve and estimates
    # the value by drawing a straight line between the two nearest old points.
    # Crude but fast; a studio-grade resampler would fit smooth curves instead.
    #
    # .astype(np.float32) converts the result: np.interp returns float64
    # (double precision), and we keep everything float32 to halve the memory
    # and stay consistent with what soundfile hands us.
    return np.interp(new_x, old_x, data).astype(np.float32)


def load_sample(path: str, target_sample_rate: int) -> np.ndarray:
    """Load a WAV file as a mono float32 array at target_sample_rate."""
    # dtype="float32" asks soundfile to convert whatever is on disk (usually
    # 16-bit integers) into floats between -1 and 1. always_2d=True forces the
    # shape to be (samples, channels) even for mono, so the next line works
    # the same either way instead of needing a special case.
    data, native_sample_rate = sf.read(path, dtype="float32", always_2d=True)

    # axis=1 means "collapse across channels", averaging left and right into
    # one. axis=0 would instead average across time and give one number per
    # channel, which would be nonsense here. Picturing the array as a table --
    # rows are moments in time, columns are channels -- axis=1 is "squash each
    # row down to a single value".
    mono = data.mean(axis=1)

    # A file recorded at 48000 Hz played back assuming 44100 would be too slow
    # and too low, so rescale its length to compensate.
    if native_sample_rate != target_sample_rate:
        ratio = target_sample_rate / native_sample_rate
        mono = _resample_linear(mono, int(round(len(mono) * ratio)))
    return mono


def pitch_shift(sample: np.ndarray, semitones: int) -> np.ndarray:
    """Shift pitch by resampling (speed-change style): duration changes
    with pitch, since this is the numpy-only approach agreed for phase 1
    (no librosa dependency yet)."""
    if semitones == 0:
        return sample  # the common case: skip the work and any rounding error

    # Western tuning splits an octave into 12 equal steps, and an octave is a
    # doubling of frequency. So one semitone multiplies frequency by the
    # twelfth root of 2, and n semitones by 2**(n/12):
    #   +12 -> 2.0   (twice the frequency, one octave up)
    #    -12 -> 0.5  (one octave down)
    #     +7 -> 1.498 (a perfect fifth)
    # ** is "to the power of", and / on two ints gives a float in Python 3.
    ratio = 2.0 ** (semitones / 12.0)

    # Playing a sound through FEWER samples makes it finish sooner, which
    # raises its pitch -- like spinning a record faster. Hence dividing.
    # max(1, ...) guards against an extreme upward shift rounding the length
    # down to zero, which would produce an empty array.
    new_length = max(1, int(round(len(sample) / ratio)))
    return _resample_linear(sample, new_length)
