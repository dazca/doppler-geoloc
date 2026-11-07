"""Ridge tracking + least-squares fit of the straight-line Doppler model (F0, v, d, t_c)."""
import numpy as np
from scipy.optimize import least_squares

from .doppler import straight_line_f, C_DEFAULT
from .spectrogram import bilinear


def track_ridge(Z, spec, t_center, F0_guess, half_window=60.0, band=(0.72, 1.38),
                harmonics=(1, 2, 3, 4), n_cand=400, min_z=1.5):
    """Per-frame harmonic-stacked peak search. Returns times, freqs (fundamental), strength."""
    i0 = max(0, int((t_center - half_window - spec["t0"]) / spec["dt"]))
    i1 = min(spec["nT"] - 1, int((t_center + half_window - spec["t0"]) / spec["dt"]))
    times = spec["t0"] + spec["dt"] * np.arange(i0, i1 + 1)
    fc = F0_guess * np.geomspace(band[0], band[1], n_cand)
    T, Fc = np.meshgrid(times, fc, indexing="ij")
    stack = sum(bilinear(Z, spec, T, k * Fc) for k in harmonics) / len(harmonics)
    j = np.clip(np.argmax(stack, axis=1), 1, n_cand - 2)
    r = np.arange(len(times))
    y0, y1, y2 = stack[r, j - 1], stack[r, j], stack[r, j + 1]
    den = y0 - 2 * y1 + y2
    off = np.where(den < 0, 0.5 * (y0 - y2) / np.where(den < 0, den, -1), 0.0)
    lf = np.log(fc[j]) + np.clip(off, -1, 1) * np.log(fc[1] / fc[0])
    good = y1 >= min_z
    return times[good], np.exp(lf[good]), y1[good]


def fit_straight(times, freqs, guess=None, c=C_DEFAULT, weights=None):
    """Robust LSQ fit of f(t) = straight_line_f(t - t_c; F0, v, d). Returns dict with params & 1-sigma."""
    times = np.asarray(times, float)
    freqs = np.asarray(freqs, float)
    w = np.ones_like(times) if weights is None else np.asarray(weights, float)
    if guess is None:
        fhi, flo = np.percentile(freqs, 97), np.percentile(freqs, 3)
        F0g = 2 * fhi * flo / (fhi + flo)
        vg = max(20.0, c * (fhi - flo) / (fhi + flo))
        t_c = times[np.argmin(np.abs(freqs - 0.5 * (fhi + flo)))]
        guess = (F0g, vg, 1000.0, t_c)
    x0 = np.array(guess, float)
    sw = np.sqrt(w)

    def res(p):
        return sw * (straight_line_f(times - p[3], p[0], p[1], p[2], c) - freqs)

    lb = [x0[0] * 0.5, 5.0, 30.0, times.min() - 300]
    ub = [x0[0] * 2.0, 0.6 * c, 20000.0, times.max() + 300]
    x0 = np.clip(x0, np.array(lb) + 1e-6, np.array(ub) - 1e-6)
    best = None
    for dg in (x0[2], 500.0, 1500.0, 3000.0):  # multi-start in d (weakly identified)
        xs = x0.copy()
        xs[2] = dg
        r = least_squares(res, xs, bounds=(lb, ub), loss="soft_l1", f_scale=1.0)
        if best is None or r.cost < best.cost:
            best = r
    p = best.x
    J = best.jac
    dof = max(1, len(times) - 4)
    s2 = 2 * best.cost / dof
    try:
        cov = np.linalg.inv(J.T @ J) * s2
        sig = np.sqrt(np.diag(cov))
    except np.linalg.LinAlgError:
        sig = np.full(4, np.nan)
    return {"F0": p[0], "v": p[1], "d": p[2], "t_c": p[3], "t_cpa_audio": p[3] + p[2] / c,
            "sigma": {"F0": sig[0], "v": sig[1], "d": sig[2], "t_c": sig[3]},
            "rms_hz": float(np.sqrt(s2))}


def event_from_fit(fit, v_rel=0.2, d_rel=0.4):
    """Turn a fit into a contract Doppler event with generous ranges."""
    v, d = fit["v"], fit["d"]
    return {"t_cpa_audio": float(fit["t_cpa_audio"]), "F0": float(fit["F0"]),
            "v_mps": [float(v * (1 - v_rel)), float(v * (1 + v_rel))],
            "cpa_m": [float(d * (1 - d_rel)), float(d * (1 + d_rel))]}
