"""Retarded-time solver, Doppler curves, CPA / delayed-CPA times.

Conventions (docs/CONTRACTS.md): u = unit vector source->observer at emission time,
v_r = v_s . u (> 0 approaching), exact f = F0 * c / (c - v_r).
"""
import numpy as np

C_DEFAULT = 343.0


def speed_of_sound(T_celsius):
    return 331.3 * np.sqrt(1.0 + T_celsius / 273.15)


def emission_time(track, obs, t_rx, c=C_DEFAULT, n_iter=4, method="newton"):
    """Solve t_rx = t_e + |obs - r(t_e)| / c for t_e.

    obs: [..., 3] broadcastable against t_rx[...].  Returns (t_e, R, v_r, valid).
    Newton: g(t_e) = t_e + R/c - t_rx,  g' = 1 - v_r/c  (always in [1-M, 1+M], M = |v|/c).
    Initial guess t_e = t_rx - R(t_rx)/c has error <= M R/c; 4 Newton steps -> < 1e-9 s.
    """
    t_rx = np.asarray(t_rx, float)
    obs = np.asarray(obs, float)
    p, _, _ = track.eval(t_rx)
    te = t_rx - np.linalg.norm(obs - p, axis=-1) / c
    for _ in range(n_iter):
        p, v, _ = track.eval(te)
        dvec = obs - p
        R = np.linalg.norm(dvec, axis=-1)
        vr = np.sum(v * dvec, axis=-1) / np.maximum(R, 1e-9)
        g = te + R / c - t_rx
        if method == "newton":
            te = te - g / (1.0 - vr / c)
        else:  # fixed point t_e <- t_rx - R(t_e)/c
            te = t_rx - R / c
    p, v, valid = track.eval(te)
    dvec = obs - p
    R = np.linalg.norm(dvec, axis=-1)
    vr = np.sum(v * dvec, axis=-1) / np.maximum(R, 1e-9)
    return te, R, vr, valid


def received_freq(track, obs, t_rx, F0=1.0, c=C_DEFAULT, exact=True):
    """f(t_rx) for a source of constant frequency F0.  Returns (f, R, t_e, valid)."""
    te, R, vr, valid = emission_time(track, obs, t_rx, c)
    if exact:
        f = F0 * c / (c - vr)
    else:
        f = F0 * (1.0 + vr / c)
    return f, R, te, valid


# ---------- straight line, constant speed: closed form ----------
def straight_line_te(T, v, d, c=C_DEFAULT):
    """tau = t_e - t_c as function of T = t_rx - t_c (t_c = time source is at CPA)."""
    b2 = (v / c) ** 2
    S = np.sqrt(b2 * T ** 2 + (1 - b2) * (d / c) ** 2)
    return (T - S) / (1 - b2)


def straight_line_f(T, F0, v, d, c=C_DEFAULT):
    """Exact received frequency for a straight constant-speed pass.

    f(T) = F0/(1-b^2) * (1 - b*T/sqrt(T^2 + tau0^2)),  b = v/c, tau0 = d*sqrt(1-b^2)/v,
    T = t_rx - t_c.  f = F0 at T = d/c (the 'delayed CPA'); centre of symmetry at T = 0.
    """
    b = v / c
    tau0 = d * np.sqrt(1 - b * b) / v
    return F0 / (1 - b * b) * (1 - b * T / np.sqrt(T * T + tau0 * tau0))


# ---------- CPA ----------
def cpa(track, obs, c=C_DEFAULT, dt=0.5, chunk=2048):
    """Closest point of approach of `track` to each observer obs[N,3].

    Returns dict of arrays [N]: t_cpa (emission time at CPA), d_cpa (3D slant), speed (|v| at CPA),
    t_dcpa = t_cpa + d_cpa/c (receive time of the CPA emission = 'delayed CPA time').
    Dense sampling at dt then parabolic refinement of R^2.
    """
    obs = np.atleast_2d(np.asarray(obs, float))
    ts = np.arange(track.t0, track.t1 + 1e-9, dt)
    if ts.size < 3:
        ts = np.linspace(track.t0, track.t1, 3)
    P, _, _ = track.eval(ts)
    N = obs.shape[0]
    t_cpa = np.empty(N)
    for a in range(0, N, chunk):
        o = obs[a:a + chunk]
        D2 = (np.sum(o * o, 1)[:, None] - 2 * o @ P.T + np.sum(P * P, 1)[None, :])
        j = np.clip(np.argmin(D2, axis=1), 1, ts.size - 2)
        r = np.arange(o.shape[0])
        y0, y1, y2 = D2[r, j - 1], D2[r, j], D2[r, j + 1]
        den = y0 - 2 * y1 + y2
        off = np.where(den > 0, 0.5 * (y0 - y2) / np.where(den > 0, den, 1), 0.0)
        off = np.clip(off, -1, 1)
        t_cpa[a:a + chunk] = ts[j] + off * (ts[1] - ts[0])
    p, v, _ = track.eval(t_cpa)
    d = np.linalg.norm(obs - p, axis=-1)
    return {"t_cpa": t_cpa, "d_cpa": d, "speed": np.linalg.norm(v, axis=-1),
            "t_dcpa": t_cpa + d / c}


AUDIBLE_R = {"prop": 3000.0, "heli": 3000.0, "unknown": 3000.0, "jet": 6000.0}


def audible_radius(category, table=None):
    table = table or AUDIBLE_R
    return table.get(category, table["unknown"])
