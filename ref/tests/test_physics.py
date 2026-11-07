import numpy as np
import pytest
from scipy.optimize import brentq

from doppler_ref.geo import ENU
from doppler_ref.track import Track
from doppler_ref.doppler import emission_time, received_freq, straight_line_f, straight_line_te, cpa
from doppler_ref.synth import received_by_emission_grid

C = 343.0
ENU0 = ENU(41.9, 2.3, 0.0)


def make_track(ts, xyz, cat="prop"):
    lat, lon, h = ENU0.inv(xyz)
    return Track({"id": "x", "category": cat, "points": np.column_stack([ts, lat, lon, h]).tolist()}, ENU0)


def curved_track():
    from make_golden import golden_track
    ref, enu, tj = golden_track()
    return Track(tj, enu), enu


def test_enu_roundtrip():
    lat = np.array([41.9, 41.95, 42.3]); lon = np.array([2.3, 2.1, 2.9]); h = np.array([0, 900, 3000.0])
    e = ENU0.fwd(lat, lon, h)
    la, lo, hh = ENU0.inv(e)
    assert np.allclose(la, lat, atol=1e-10) and np.allclose(lo, lon, atol=1e-10) and np.allclose(hh, h, atol=1e-5)
    assert np.allclose(ENU0.fwd(41.9, 2.3, 100.0), [0, 0, 100.0], atol=1e-6)


def test_hermite_reproduces_quadratic_motion():
    ts = np.cumsum(np.r_[0, np.random.default_rng(0).uniform(1, 5, 60)])
    xyz = np.column_stack([3 * ts + 0.1 * ts ** 2, -2 * ts, 500 + 0.01 * ts ** 2])
    tr = make_track(ts, xyz)
    tq = np.linspace(ts[1], ts[-2], 500)
    p, v, valid = tr.eval(tq)
    ex = np.column_stack([3 * tq + 0.1 * tq ** 2, -2 * tq, 500 + 0.01 * tq ** 2])
    ev = np.column_stack([3 + 0.2 * tq, -2 + 0 * tq, 0.02 * tq])
    assert valid.all()
    assert np.abs(p - ex).max() < 0.05      # ENU curvature makes it not exactly quadratic in ENU
    assert np.abs(v - ev).max() < 0.02


def test_retarded_time_vs_bruteforce():
    tr, enu = curved_track()
    o = enu.fwd(41.88, 2.29, 150.0)
    trx = np.linspace(tr.t0 + 30, tr.t1, 40)
    te, R, vr, valid = emission_time(tr, o, trx, C)
    for k in range(len(trx)):
        g = lambda t: t + np.linalg.norm(o - tr.eval(t)[0]) / C - trx[k]
        tb = brentq(g, tr.t0 - 100, trx[k], xtol=1e-12)
        assert abs(te[k] - tb) < 1e-6  # unix-time float64 resolution ~2.4e-7 s
    # residual
    p, _, _ = tr.eval(te)
    assert np.abs(te + np.linalg.norm(o - p, axis=-1) / C - trx).max() < 1e-6


def test_fixed_point_converges_linearly():
    tr, enu = curved_track()
    o = enu.fwd(41.88, 2.29, 150.0)
    trx = np.linspace(tr.t0 + 30, tr.t1, 40)
    te_n = emission_time(tr, o, trx, C, n_iter=4)[0]
    errs = [np.abs(emission_time(tr, o, trx, C, n_iter=n, method="fixed")[0] - te_n).max() for n in (1, 3, 6, 12)]
    assert errs[-1] < 1e-6 and errs[0] > errs[1] > errs[2]


def test_newton_matches_independent_emission_grid_model():
    tr, enu = curved_track()
    o = enu.fwd(41.87, 2.31, 320.0)
    trx = np.linspace(tr.t0 + 40, tr.t1 - 5, 200)
    f, R, te, valid = received_freq(tr, o, trx, 1.0, C)
    ratio, R2, te2 = received_by_emission_grid(tr, o, trx, C, None, dt_e=0.005)
    assert np.abs(te - te2).max() < 1e-4
    assert np.abs(f - ratio).max() < 2e-4   # finite-difference derivative in the grid model


def test_straight_line_closed_form_vs_numeric():
    for (F0, v, d, h) in [(100.0, 50.0, 600.0, 400.0), (130.0, 90.0, 1500.0, 900.0), (90.0, 120.0, 800.0, 300.0)]:
        ts = np.arange(-400, 400.1, 2.0) + 1.7e9
        y = np.sqrt(d * d - h * h)
        xyz = np.column_stack([v * (ts - 1.7e9), np.full_like(ts, y), np.full_like(ts, h)])
        # build track in a flat local frame: use ENU directly (Track with P set manually)
        tr = make_track(ts, xyz)
        tr.P = xyz.copy(); from doppler_ref.track import hermite_tangents; tr.M = hermite_tangents(tr.t, tr.P)
        o = np.zeros(3)
        T = np.linspace(-150, 150, 301)
        f, R, te, _ = received_freq(tr, o, 1.7e9 + T, F0, C)
        assert np.abs(f - straight_line_f(T, F0, v, d, C)).max() < 1e-8 * F0 * 1e3
        assert np.abs((te - 1.7e9) - straight_line_te(T, v, d, C)).max() < 1e-6  # float64 unix-time resolution
        # analytic properties
        assert abs(straight_line_f(d / C, F0, v, d, C) - F0) < 1e-9
        eps = 1e-4
        slope = (straight_line_f(d / C + eps, F0, v, d, C) - straight_line_f(d / C - eps, F0, v, d, C)) / (2 * eps)
        assert abs(slope - (-F0 * v * v / (C * d))) < 1e-6 * abs(slope)
        assert abs(straight_line_f(1e7, F0, v, d, C) - F0 * C / (C + v)) < 1e-6
        assert abs(straight_line_f(-1e7, F0, v, d, C) - F0 * C / (C - v)) < 1e-6
        # point symmetry about (T=0, F0/(1-b^2))
        b = v / C
        assert np.allclose(straight_line_f(T, F0, v, d, C) + straight_line_f(-T, F0, v, d, C), 2 * F0 / (1 - b * b))


def test_first_order_error_magnitude():
    for v in (50.0, 120.0):
        b = v / C
        exact, first = 1 / (1 - b), 1 + b
        assert abs((exact - first) - b * b / (1 - b)) < 1e-12
    # numbers quoted in MATH.md
    assert abs((50 / C) ** 2 / (1 - 50 / C) - 0.0249) < 5e-4
    assert abs((120 / C) ** 2 / (1 - 120 / C) - 0.1883) < 5e-4


def test_cpa_vs_bruteforce():
    tr, enu = curved_track()
    obs = enu.fwd(np.array([41.88, 41.87, 41.9, 41.86]), np.array([2.29, 2.31, 2.27, 2.33]), np.array([150, 320, 60, 10.0]))
    r = cpa(tr, obs, C)
    ts = np.arange(tr.t0, tr.t1, 0.001)
    P, _, _ = tr.eval(ts)
    for k, o in enumerate(obs):
        D = np.linalg.norm(P - o, axis=1)
        j = np.argmin(D)
        assert abs(r["d_cpa"][k] - D[j]) < 0.01
        assert abs(r["t_cpa"][k] - ts[j]) < 0.25  # R(t) is very flat at CPA; C1 Hermite accel jumps at knots
        assert abs(r["t_dcpa"][k] - (r["t_cpa"][k] + r["d_cpa"][k] / C)) < 1e-9
