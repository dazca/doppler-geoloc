"""Golden fixtures are reproducible from the current code (guards against silent drift)."""
import json, os
import numpy as np
from conftest import ROOT
from doppler_ref.geo import ENU
from doppler_ref.track import Track
from doppler_ref.doppler import emission_time, straight_line_f, cpa
from doppler_ref.spectrogram import spectrogram, whiten, curve_score

G = os.path.join(ROOT, "fixtures", "golden")


def load(n):
    with open(os.path.join(G, n)) as fh:
        return json.load(fh)


def test_golden_emission_and_cpa():
    d = load("emission_doppler.json")
    enu = ENU(d["ref"][0], d["ref"][1], 0.0)
    tr = Track(d["track"], enu)
    for c in d["cases"]:
        o = np.array(c["obs_enu"])
        te, R, vr, _ = emission_time(tr, o, np.array(c["t_rx"]), d["c"])
        assert np.abs(te - c["t_e"]).max() < d["tolerance"]["t_e_s"]
        assert np.abs(100 * 343 / (343 - vr) - c["f_exact_F0_100"]).max() < d["tolerance"]["f_hz"]
        r = cpa(tr, o[None, :], d["c"])
        assert abs(r["t_dcpa"][0] - c["cpa"]["t_dcpa"]) < d["tolerance"]["t_dcpa_s"]


def test_golden_straight_and_spectrogram():
    d = load("straight_line.json")
    for c in d["cases"]:
        assert np.abs(straight_line_f(np.array(c["T"]), c["F0"], c["v"], c["d"], d["c"]) - c["f"]).max() < 1e-9
    s = load("spectrogram.json")
    t = np.arange(2 * 8000) / 8000
    x = 0.5 * np.sin(2 * np.pi * (200 * t + 50 * t ** 2)) + 0.2 * np.sin(2 * np.pi * 440 * t) + 0.01 * np.cos(2 * np.pi * 1234.5 * t)
    sp = spectrogram(x, 8000, 512, 128, 1000.0)
    assert np.abs(sp["data"] - np.array(s["spec"]["data"])).max() < 1e-3
    Z = whiten(sp)
    for c in load("curve_score_small.json")["cases"]:
        sc = curve_score(Z, sp, np.array(c["t_audio"]), np.array(c["ratio"]), c["F0"], tuple(c["harmonics"]))
        assert abs(sc - c["score"]) < 1e-4
