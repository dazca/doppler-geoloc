"""Write golden fixtures (inputs + expected outputs) for cross-checking the JS port: fixtures/golden/*.json"""
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import numpy as np
from doppler_ref.geo import ENU
from doppler_ref.track import Track
from doppler_ref.doppler import emission_time, straight_line_f, straight_line_te, cpa
from doppler_ref.spectrogram import spectrogram, whiten, curve_score, as2d
from doppler_ref.scenarios import load_scenario
from doppler_ref.search import score_point, Config

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "fixtures", "golden")


def L(a):
    return np.asarray(a, float).round(9).tolist()


def dump(name, obj):
    with open(os.path.join(OUT, name), "w") as fh:
        json.dump(obj, fh, indent=None, separators=(",", ":"))
    print("wrote", name)


def golden_track():
    """A curved, accelerating, climbing track sampled irregularly (deterministic)."""
    ref = [41.90, 2.30]
    enu = ENU(ref[0], ref[1], 0.0)
    ts = np.cumsum(np.r_[0, 1 + 4 * (0.5 + 0.5 * np.sin(np.arange(1, 80) * 1.7))]) + 1.7e9
    s = ts - ts[0]
    hdg = np.radians(30 + 0.5 * s)            # turning 0.5 deg/s
    v = 55 + 0.05 * s
    x = np.cumsum(np.r_[0, (v[1:] * np.sin(hdg[1:])) * np.diff(s)]) - 3000
    y = np.cumsum(np.r_[0, (v[1:] * np.cos(hdg[1:])) * np.diff(s)]) - 4000
    z = 700 + 1.5 * s
    lat, lon, h = enu.inv(np.column_stack([x, y, z]))
    pts = [[float(round(a, 3)), float(round(b, 8)), float(round(c, 8)), float(round(d, 2))]
           for a, b, c, d in zip(ts, lat, lon, h)]
    tj = {"id": "G1", "icao24": "abcdef", "callsign": "GOLD1", "type": "C172", "category": "prop", "points": pts}
    return ref, enu, tj


def main():
    os.makedirs(OUT, exist_ok=True)
    ref, enu, tj = golden_track()
    tr = Track(tj, enu)
    # 1. geodesy
    q = np.array([[41.9, 2.3, 0.0], [41.95, 2.25, 812.5], [41.85, 2.41, 1500.0], [42.1, 2.0, 30.0]])
    e = enu.fwd(q[:, 0], q[:, 1], q[:, 2])
    back = np.column_stack(enu.inv(e))
    dump("geo.json", {"ref": ref + [0.0], "lla": L(q), "enu": L(e), "lla_back": L(back),
                      "tolerance": {"enu_m": 1e-6, "lla_deg": 1e-9, "h_m": 1e-6},
                      "notes": "WGS84 exact ECEF-based ENU. ref = [lat0, lon0, h0]."})
    # 2. track interpolation
    tq = np.linspace(tr.t0 - 5, tr.t1 + 5, 57)
    p, v, valid = tr.eval(tq)
    trs = Track(tj, enu, 15.0)
    ps, vs, _ = trs.eval(tq)
    dump("track_interp.json", {"ref": ref, "track": tj, "t": L(tq), "pos_enu": L(p), "vel_enu": L(v),
                               "smoothed_W15": {"pos_enu": L(ps), "vel_enu": L(vs)},
                               "valid": valid.tolist(), "tolerance": {"pos_m": 1e-4, "vel_mps": 1e-6},
                               "notes": "C1 cubic Hermite, non-uniform 3-point tangents (ref/doppler_ref/track.py). "
                                        "Clamped outside [t0,tn] with valid=false."})
    # 3. emission time + Doppler
    obs = enu.fwd(np.array([41.88, 41.87, 41.9]), np.array([2.29, 2.31, 2.27]), np.array([150.0, 320.0, 60.0]))
    cases = []
    for o in obs:
        c = cpa(tr, o[None, :], 343.0)
        trx = c["t_dcpa"][0] + np.arange(-90, 91, 7.5)
        te, R, vr, val = emission_time(tr, o, trx, 343.0)
        cases.append({"obs_enu": L(o), "t_rx": L(trx), "t_e": L(te), "R": L(R), "v_r": L(vr), "valid": val.tolist(),
                      "f_exact_F0_100": L(100 * 343 / (343 - vr)), "f_first_order_F0_100": L(100 * (1 + vr / 343)),
                      "cpa": {k: float(c[k][0]) for k in c}})
    dump("emission_doppler.json", {
        "ref": ref, "track": tj, "c": 343.0, "cases": cases,
        "tolerance": {"t_e_s": 1e-6, "R_m": 1e-3, "v_r_mps": 1e-4, "f_hz": 1e-4,
                      "t_cpa_s": 2e-3, "d_cpa_m": 1e-2, "speed_mps": 1e-3, "t_dcpa_s": 2e-3},
        "notes": "Newton on g(t_e)=t_e+R/c-t_rx, 4 iterations from t_e=t_rx-R(t_rx)/c. CPA: track sampled every "
                 "0.5 s from t0, argmin R^2, parabolic refinement (offset clipped to +-1 sample)."})
    # 4. straight line closed form
    T = np.linspace(-120, 120, 49)
    sl = []
    for (F0, v_, d) in [(100.0, 50.0, 500.0), (130.0, 80.0, 1500.0), (90.0, 120.0, 800.0)]:
        sl.append({"F0": F0, "v": v_, "d": d, "T": L(T), "f": L(straight_line_f(T, F0, v_, d, 343.0)),
                   "tau": L(straight_line_te(T, v_, d, 343.0)),
                   "slope_at_delayed_cpa": -F0 * v_ ** 2 / (343.0 * d),
                   "f_hi": F0 * 343 / (343 - v_), "f_lo": F0 * 343 / (343 + v_)})
    dump("straight_line.json", {"c": 343.0, "cases": sl, "tolerance": {"f_hz": 1e-9, "tau_s": 1e-9},
                                "notes": "T = t_rx - t_c; f = F0/(1-b^2)*(1 - b*T/sqrt(T^2+tau0^2)), b=v/c, "
                                         "tau0=d*sqrt(1-b^2)/v"})
    # 5. spectrogram on a deterministic signal
    fs = 8000
    t = np.arange(2 * fs) / fs
    x = (0.5 * np.sin(2 * np.pi * (200 * t + 50 * t ** 2)) + 0.2 * np.sin(2 * np.pi * 440 * t)
         + 0.01 * np.cos(2 * np.pi * 1234.5 * t))
    sp = spectrogram(x, fs, nperseg=512, hop=128, fmax=1000.0)
    Zs = whiten(sp)
    dump("spectrogram.json", {
        "signal_formula": "x(t)=0.5 sin(2pi(200t+50t^2)) + 0.2 sin(2pi 440 t) + 0.01 cos(2pi 1234.5 t), t=n/8000, n=0..15999",
        "fs": fs, "nperseg": 512, "hop": 128, "fmax": 1000.0,
        "spec": {k: (L(v) if k == "data" else v) for k, v in sp.items()},
        "whitened": L(Zs.ravel()),
        "tolerance": {"dB": 1e-3, "whitened": 1e-3},
        "notes": "see ref/doppler_ref/spectrogram.py docstring for exact definitions"})
    # 6. curve scores on that small spectrogram
    tt = np.linspace(0.2, 1.8, 41)
    cs = []
    for (F0, harms) in [(1.0, (1,)), (1.0, (1, 2)), (1.02, (1, 2, 3))]:
        ratio = 200 + 100 * tt   # true chirp instantaneous frequency
        cs.append({"t_audio": L(tt), "ratio": L(ratio), "F0": F0, "harmonics": list(harms),
                   "score": float(curve_score(Zs, sp, tt, ratio, F0, harms))})
    dump("curve_score_small.json", {"uses": "spectrogram.json whitened", "cases": cs, "tolerance": {"score": 1e-4}})
    # 7. scenario-level point scores (JS: spectrogram of fixtures/scenario1/audio.wav with x = int16/32768)
    sc = load_scenario(os.path.join(ROOT, "fixtures", "scenario1"))
    Z = whiten(sc["spec"])
    cfg = Config()
    ids = [t.id for t in sc["tracks"]]
    tru = sc["truth"]
    pts = []
    o_true = sc["enu"].fwd(tru["observer"]["lat"], tru["observer"]["lon"], tru["observer"]["elev_m"])
    for dx, dy in [(0, 0), (100, 0), (0, -200), (500, 500), (-1500, 800)]:
        o = o_true + np.array([dx, dy, 0.0])
        lat, lon, _ = sc["enu"].inv(o)
        el = float(sc["dem"](lat, lon))
        o = sc["enu"].fwd(lat, lon, el)
        F0s = [e["F0"] for e in tru["events"]]
        fl = [ids.index(e["flight"]) for e in tru["events"]]
        tot, per = score_point(sc["tracks"], fl, o, tru["t_start_unix"], F0s, Z, sc["spec"], cfg)
        pts.append({"lat": float(lat), "lon": float(lon), "elev_m": el, "obs_enu": L(o),
                    "flights": [ids[i] for i in fl], "t_start_unix": tru["t_start_unix"], "F0": F0s,
                    "score": tot, "event_scores": per})
    S2 = as2d(sc["spec"])
    dump("scenario1_point_scores.json", {
        "scenario": "fixtures/scenario1",
        "spectrogram_params": {"nperseg": 4096, "hop": 1024, "fmax": 1000.0, "input_scale": "int16/32768"},
        "spec_checksums": {"nT": sc["spec"]["nT"], "nF": sc["spec"]["nF"], "mean_dB": float(S2.mean()),
                           "row100_first8": L(S2[100, :8]), "whitened_mean": float(Z.mean())},
        "config": {"c": cfg.c, "tau_half": cfg.tau_half, "tau_step": cfg.tau_step, "harmonics": list(cfg.harmonics),
                   "audible_m": cfg.audible},
        "dem": sc["scen"]["dem"], "ref": sc["scen"]["ref"], "points": pts,
        "tolerance": {"score_abs": 2e-3, "mean_dB": 1e-3},
        "track_smoothing_s": 15.0, "score_norm": cfg.score_norm,
        "notes": "score_point(): no sweep. Tracks loaded with local-quadratic smoothing W=15 s (track.py docstring). "
                 "obs_enu uses DEM elevation; DEM formula in ref/doppler_ref/scenarios.py."})


if __name__ == "__main__":
    main()
