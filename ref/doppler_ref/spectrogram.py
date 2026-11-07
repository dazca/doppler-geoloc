"""Spectrogram per contract + whitening + bilinear sampling + curve scoring.

Spectrogram dict: {t0, dt, f0, df, nT, nF, data (float32, row-major [iT*nF+iF]), unit "dB"}
  frame iT uses samples [iT*hop, iT*hop+nperseg), periodic Hann window,
  centre time t = t0 + iT*dt with t0 = nperseg/2/fs, dt = hop/fs; bins f = f0 + iF*df, f0 = 0, df = fs/nperseg,
  dB = 10*log10(|X|^2 / sum(w^2) + 1e-12), bins with f <= fmax kept.
Whitening (per frequency bin across time): z = (S - median) / (1.4826*MAD + 1e-6), clipped to [-3, 8].
Bilinear sample at fractional (it, if); samples outside the grid contribute 0.
"""
import numpy as np
from scipy import fft as sfft


def spectrogram(x, fs, nperseg=4096, hop=1024, fmax=1000.0):
    x = np.asarray(x, np.float64)
    n = 1 + max(0, (x.size - nperseg) // hop)
    w = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(nperseg) / nperseg)
    nF = int(np.floor(fmax * nperseg / fs)) + 1
    out = np.empty((n, nF), np.float32)
    norm = np.sum(w * w)
    blk = 512
    for a in range(0, n, blk):
        idx = (np.arange(a, min(n, a + blk)) * hop)[:, None] + np.arange(nperseg)[None, :]
        X = sfft.rfft(x[idx] * w, axis=1)[:, :nF]
        out[a:a + blk] = 10 * np.log10((X.real ** 2 + X.imag ** 2) / norm + 1e-12)
    return {"t0": nperseg / 2 / fs, "dt": hop / fs, "f0": 0.0, "df": fs / nperseg,
            "nT": int(n), "nF": int(nF), "data": out.ravel(), "unit": "dB"}


def as2d(spec):
    return np.asarray(spec["data"], np.float32).reshape(spec["nT"], spec["nF"])


def whiten(spec):
    S = as2d(spec)
    med = np.median(S, axis=0)
    mad = np.median(np.abs(S - med), axis=0)
    Z = (S - med) / (1.4826 * mad + 1e-6)
    return np.clip(Z, -3.0, 8.0).astype(np.float32)


def bilinear(Z, spec, t, f):
    """Sample 2D array Z[nT,nF] at audio times t and frequencies f (same shape). Outside -> 0."""
    t, f = np.broadcast_arrays(np.asarray(t, float), np.asarray(f, float))
    it = (t - spec["t0"]) / spec["dt"]
    jf = (f - spec["f0"]) / spec["df"]
    nT, nF = Z.shape
    inside = (it >= 0) & (it <= nT - 1) & (jf >= 0) & (jf <= nF - 1)
    it = np.where(inside, it, 0.0)
    jf = np.where(inside, jf, 0.0)
    i0 = np.minimum(np.floor(it).astype(np.int64), nT - 2)
    j0 = np.minimum(np.floor(jf).astype(np.int64), nF - 2)
    a = it - i0
    b = jf - j0
    v = ((1 - a) * (1 - b) * Z[i0, j0] + (1 - a) * b * Z[i0, j0 + 1]
         + a * (1 - b) * Z[i0 + 1, j0] + a * b * Z[i0 + 1, j0 + 1])
    return np.where(inside, v, 0.0)


def curve_score(Z, spec, t_audio, ratio, F0, harmonics=(1, 2, 3, 4), weight=None, norm="mean"):
    """Whitened values along k*F0*ratio(t), k in harmonics, weighted by `weight` (0/1 audibility mask).

    norm="mean":  sum(w*z) / (K*sum(w))            (average z on the curve)
    norm="sqrtN": sum(w*z) / sqrt(K*sum(w))         (matched-filter / LLR statistic, ~N(0,1) under noise)

    t_audio, ratio, F0, weight: mutually broadcastable, last axis = samples along the curve.
    Returns the broadcast shape without the last axis.
    """
    ratio = np.asarray(ratio, float)
    F0 = np.asarray(F0, float)
    tot = 0.0
    for k in harmonics:
        tot = tot + bilinear(Z, spec, t_audio, k * F0 * ratio)
    if weight is None:
        weight = np.ones(tot.shape[-1])
    weight = np.broadcast_to(weight, tot.shape)
    num = np.sum(tot * weight, axis=-1)
    den = np.sum(weight, axis=-1) * len(harmonics)
    if norm == "sqrtN":
        den = np.sqrt(den)
    return num / np.maximum(den, 1e-9)
