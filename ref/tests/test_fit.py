import os
import numpy as np
import pytest
from conftest import ROOT
from doppler_ref.doppler import straight_line_f
from doppler_ref.fit import fit_straight, track_ridge
from doppler_ref.scenarios import load_scenario
from doppler_ref.spectrogram import whiten


@pytest.mark.parametrize("F0,v,d,tc", [(128, 57, 750, 5.0), (95, 110, 2500, -12.0), (140, 40, 400, 30.0)])
def test_fit_noiseless_recovers_truth(F0, v, d, tc):
    T = np.arange(-60, 60, 0.128)
    r = fit_straight(T, straight_line_f(T - tc, F0, v, d))
    assert abs(r["F0"] / F0 - 1) < 1e-5 and abs(r["v"] / v - 1) < 1e-4 and abs(r["d"] / d - 1) < 1e-3
    assert abs(r["t_c"] - tc) < 1e-3


def test_fit_noisy_recovers_truth():
    rng = np.random.default_rng(3)
    T = np.arange(-50, 50, 0.128)
    f = straight_line_f(T - 2.0, 120, 60, 900) + rng.normal(0, 1.0, T.size)   # 1 Hz rms noise (~half bin)
    r = fit_straight(T, f)
    assert abs(r["v"] / 60 - 1) < 0.03 and abs(r["d"] / 900 - 1) < 0.08 and abs(r["F0"] / 120 - 1) < 0.005


@pytest.mark.parametrize("name,k,v_tol,d_tol", [("scenario1", 0, 0.05, 0.10), ("scenario1", 1, 0.05, 0.10),
                                                ("scenario2", 0, 0.05, 0.10), ("scenario2", 1, 0.08, 0.10)])
def test_ridge_fit_on_synthetic_audio(name, k, v_tol, d_tol):
    sc = load_scenario(os.path.join(ROOT, "fixtures", name))
    Z = whiten(sc["spec"])
    ev, tr = sc["events"][k], sc["truth"]["events"][k]
    t, f, s = track_ridge(Z, sc["spec"], ev["t_cpa_audio"], ev["F0"])
    r = fit_straight(t, f, weights=s)
    assert abs(r["v"] / tr["v_mps"] - 1) < v_tol
    assert abs(r["d"] / tr["cpa_m"] - 1) < d_tol
    assert abs(r["t_cpa_audio"] - tr["t_cpa_audio"]) < 1.0
    assert abs(r["F0"] / tr["F0"] - 1) < 0.02
