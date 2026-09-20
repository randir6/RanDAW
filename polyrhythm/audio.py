import numpy as np
import soundfile as sf


def _resample_linear(data: np.ndarray, new_length: int) -> np.ndarray:
    if new_length == len(data):
        return data
    old_x = np.linspace(0.0, 1.0, num=len(data), endpoint=False)
    new_x = np.linspace(0.0, 1.0, num=new_length, endpoint=False)
    return np.interp(new_x, old_x, data).astype(np.float32)


def load_sample(path: str, target_sample_rate: int) -> np.ndarray:
    """Load a WAV file as a mono float32 array at target_sample_rate."""
    data, native_sample_rate = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if native_sample_rate != target_sample_rate:
        ratio = target_sample_rate / native_sample_rate
        mono = _resample_linear(mono, int(round(len(mono) * ratio)))
    return mono


def pitch_shift(sample: np.ndarray, semitones: int) -> np.ndarray:
    """Shift pitch by resampling (speed-change style): duration changes
    with pitch, since this is the numpy-only approach agreed for phase 1
    (no librosa dependency yet)."""
    if semitones == 0:
        return sample
    ratio = 2.0 ** (semitones / 12.0)
    new_length = max(1, int(round(len(sample) / ratio)))
    return _resample_linear(sample, new_length)
