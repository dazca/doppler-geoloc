"""Audio synthesizer: Doppler-shifted harmonic (prop) / broadband (jet) sources, 1/r, plus noise.

Received instantaneous frequency f(t) and amplitude 1/R(t_e) are computed at a control rate with an
INDEPENDENT forward model (dense emission-time grid, exact uniform-wind propagation, f/F0 = dt_e/dt_rx),
not with the Newton solver used by the search,
interpolated to the audio rate, and the phase is integrated: phi = 2*pi*cumsum(f)/fs.
No ground reflection (Lloyd's mirror) and no atmospheric absorption by default.
"""
import numpy as np
from scipy import signal

from .doppler import C_DEFAULT


def propagation_tau(D, c, wind=None):
    """Travel time for separation D = r_obs - r_src (emission) in a uniform wind (exact for uniform medium):
    |D - w*tau| = c*tau  ->  tau = (-(D.w) + sqrt((D.w)^2 + (c^2-|w|^2)|D|^2)) / (c^2-|w|^2)."""
    R = np.linalg.norm(D, axis=-1)
    if wind is None or not np.any(wind):
        return R / c
    w = np.asarray(wind, float)
    Dw = D @ w
    w2 = w @ w
    return (-Dw + np.sqrt(Dw * Dw + (c * c - w2) * R * R)) / (c * c - w2)


def received_by_emission_grid(track, obs, t_rx, c=C_DEFAULT, wind=None, dt_e=0.02):
    """Independent forward model: sample emission times densely, propagate (optionally with wind),
    invert t_rx(t_e) by interpolation; f/F0 = dt_e/dt_rx.  Returns (ratio, R, t_e)."""
    t_rx = np.asarray(t_rx, float)
    te_g = np.arange(t_rx.min() - 40.0, t_rx.max() + 1.0, dt_e)
    p, _, _ = track.eval(te_g)
    D = obs - p
    trx_g = te_g + propagation_tau(D, c, wind)
    ratio_g = 1.0 / np.gradient(trx_g, te_g)
    te = np.interp(t_rx, trx_g, te_g)
    R = np.interp(t_rx, trx_g, np.linalg.norm(D, axis=-1))
    return np.interp(t_rx, trx_g, ratio_g), R, te


def source_signal(track, obs, T_start, duration, fs, F0, category, c=C_DEFAULT, level=1.0,
                  harm_amps=(1.0, 0.7, 0.5, 0.35, 0.25, 0.15), ctrl_rate=50.0, r_ref=1000.0, excess_db_per_km=6.0,
                  wind=None, rng=None):
    rng = rng or np.random.default_rng(0)
    n = int(round(duration * fs))
    t_ctrl = np.arange(0.0, duration + 2.0 / ctrl_rate, 1.0 / ctrl_rate)
    ratio, R, te = received_by_emission_grid(track, obs, T_start + t_ctrl, c, wind)
    valid = (te >= track.t0) & (te <= track.t1)
    # fade 10 s at track ends instead of a hard cut
    fade = np.clip(np.minimum(te - track.t0, track.t1 - te) / 10.0, 0.0, 1.0)
    # spherical spreading + lumped excess attenuation (air absorption, ground effect, refraction)
    amp_c = level * r_ref / np.maximum(R, 50.0) * 10 ** (-excess_db_per_km * R / 1000.0 / 20.0) * fade * valid
    if not np.any(amp_c > 1e-4):
        return np.zeros(n)
    t = np.arange(n) / fs
    amp = np.interp(t, t_ctrl, amp_c)
    if category == "jet":
        # broadband roar (low-passed noise, shape fixed) + a Doppler-shifted fan tone
        noise = signal.lfilter(*signal.butter(2, [100, 1500], btype="band", fs=fs), rng.standard_normal(n))
        f = np.interp(t, t_ctrl, F0 * ratio)
        ph = 2 * np.pi * np.cumsum(f) / fs
        return amp * (2.0 * noise + 0.3 * np.sin(ph))
    f = np.interp(t, t_ctrl, F0 * ratio)
    ph = 2 * np.pi * np.cumsum(f) / fs
    out = np.zeros(n)
    for k, a in enumerate(harm_amps, start=1):
        if k * F0 * 1.5 < fs / 2:
            out += a * np.sin(k * ph + rng.uniform(0, 2 * np.pi))
    # engine broadband component
    bb = signal.lfilter(*signal.butter(2, [60, 1200], btype="band", fs=fs), rng.standard_normal(n))
    return amp * (out + 0.3 * bb)


def background_noise(n, fs, level=0.02, rng=None, clutter=True):
    """White + brown noise; optional clutter: stationary hum tones and random broadband bursts (gusts)."""
    rng = rng or np.random.default_rng(1)
    white = rng.standard_normal(n)
    brown = signal.lfilter([1.0], [1.0, -0.995], rng.standard_normal(n))
    brown /= np.std(brown) + 1e-12
    x = level * (white + 2.0 * brown)
    if clutter:
        t = np.arange(n) / fs
        for f in (231.0, 462.0):
            x += 0.15 * level * np.sin(2 * np.pi * f * t)
        b, a = signal.butter(2, [80, 2000], btype="band", fs=fs)
        for _ in range(int(n / fs / 40)):
            L = int(rng.uniform(0.5, 3.0) * fs)
            i = rng.integers(0, max(1, n - L))
            x[i:i + L] += 3 * level * signal.lfilter(b, a, rng.standard_normal(L)) * np.hanning(L)
    return x


def synth_scene(sources, obs, T_start, duration, fs=8000, c=C_DEFAULT, noise_level=0.02, seed=0, wind=None):
    """sources: list of dicts {track, F0, category, level}."""
    rng = np.random.default_rng(seed)
    n = int(round(duration * fs))
    x = background_noise(n, fs, noise_level, rng)
    for s in sources:
        x += source_signal(s["track"], obs, T_start, duration, fs, s["F0"], s["category"], c,
                           level=s.get("level", 1.0), wind=wind, rng=rng)
    return x


def write_wav(path, x, fs):
    from scipy.io import wavfile
    peak = np.max(np.abs(x)) + 1e-12
    wavfile.write(path, fs, (x / peak * 0.9 * 32767).astype(np.int16))
