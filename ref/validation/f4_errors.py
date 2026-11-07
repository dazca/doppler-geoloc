"""Lane F / F4: real-world model errors at a fixed observer (the combined estimate, or --latlon).

For every shot (assigned pass = pass chosen at the observer) it re-runs the start-time/F0 sweep for:
  * ADS-B altitude bias -150..+150 m (25 m steps)          -> best bias, score curve
  * track smoothing W = 0, 5, 10, 15, 25 s
  * speed of sound 337 / 343 / 349 m/s (T ~ 10 / 20 / 30 C)
and reports the ridge-vs-model residual (Hz), the straight-line Doppler fit speed vs ADS-B ground speed
(reported 'gs' and Hermite position-derived), and the inferred absolute shot times (chronology check).
Writes out/f4_<tag>.json.
"""
import argparse
import json
import os

import numpy as np

import ksmo_common as K
import search_ksmo as S
import ridges as RG
from doppler_ref.doppler import received_freq
from doppler_ref.fit import fit_straight
from doppler_ref.track import Track


def eval_point(r, H, p, obs, smooth=15.0, c=343.0):
    S.C = c
    trk = Track(p, K.ENU0, smooth_s=smooth)
    t0 = max(p["points"][0][0] + 2, S.T_WIN[0] - 200)
    tf, Lf = S.pass_L(trk, obs[None, :], t0, p["points"][-1][0] + 20)
    o = S.score_shot_on_pass(r, H, tf, Lf)
    S.C = 343.0
    return {k: float(v[0]) for k, v in o.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="base")
    ap.add_argument("--latlon", default="")
    ap.add_argument("--chrono", action="store_true", help="use chronology-constrained pass assignment")
    a = ap.parse_args()
    from doppler_ref.dem_terrarium import TerrariumDEM
    dem = TerrariumDEM([33.96, -118.51, 34.07, -118.39])
    summ = json.load(open(os.path.join(K.OUTD, f"summary_{a.tag}.json")))
    if a.latlon:
        lat, lon = map(float, a.latlon.split(","))
    else:
        lat, lon = summ["combined"]["best_latlon"]
    h = float(dem(lat, lon)) + 1.5
    obs = K.ENU0.fwd(np.array([lat]), np.array([lon]), np.array([h]))[0]
    ridges = {r["id"]: r for r in json.load(open(os.path.join(K.OUTD, "ksmo_ridges.json")))}
    spec = K.load_spec()
    tr = json.load(open(os.path.join(K.CASE, "tracks.json")))
    out = {"observer": [lat, lon, h], "shots": {}}
    for sid in sorted(summ["shots"]):
        rec = summ["shots"][sid]
        pid = rec["at_combined"]["pass"] if not a.chrono else rec.get("chrono_pass", rec["at_combined"]["pass"])
        r = ridges[sid]
        reg = r["reg"]
        ic = next(t["icao24"] for t in tr if t.get("reg") == reg)
        typ = next(t["type"] for t in tr if t.get("reg") == reg)
        ss, Z = K.shot_spec(spec, r["t0"], r["t1"])
        _, H = RG.stacked(Z, ss)
        H = H[:len(r["tau"])]

        def pass_with(bias):
            return next(p for p in K.passes(ic, reg, typ, dem, alt_bias=bias) if p["id"] == pid)

        p0 = pass_with(0.0)
        base = eval_point(r, H, p0, obs)
        biases = list(range(-150, 151, 25))
        bs = [eval_point(r, H, pass_with(b), obs)["score"] for b in biases]
        sm = {w: eval_point(r, H, p0, obs, smooth=w)["score"] for w in (0.0, 5.0, 10.0, 15.0, 25.0)}
        cs = {c: eval_point(r, H, p0, obs, c=c)["score"] for c in (337.0, 343.0, 349.0)}
        # residuals and speeds at the base hypothesis
        tau = np.array(r["tau"])
        T = base["T"]
        F0 = np.exp(base["logF0"])
        trk = Track(p0, K.ENU0, smooth_s=15.0)
        f, R, te, valid = received_freq(trk, obs[None, :], T + tau, 1.0, 343.0)
        win = S.doppler_window(r)
        rv = (np.array(r["valid"]) > 0) & win
        rf = np.array(r["f"])
        res = rf[rv] - F0 * f[rv]
        # straight-line fit to the ridge in the window
        try:
            fit = fit_straight(tau[rv], rf[rv])
            v_fit, d_fit, sv = fit["v"], fit["d"], fit["sigma"]["v"]
        except Exception:
            v_fit = d_fit = sv = float("nan")
        # ADS-B speeds around the CPA (within the window)
        i_c = np.argmin(np.where(rv, R, np.inf))
        te_c = te[i_c]
        _, vel, _ = trk.eval(np.array([te_c]))
        v_herm = float(np.linalg.norm(vel[0][:2]))
        tp = np.array([q[0] for q in p0["points"]])
        gs = np.array([g if g is not None else np.nan for g in p0["gs"]])
        near = np.abs(tp - te_c) < 6
        gs_rep = float(np.nanmedian(gs[near])) if near.any() else float(np.nan)
        kinds = [p0["kind"][j] for j in np.flatnonzero(near)]
        out["shots"][sid] = {
            "pass": pid, "score": base["score"], "T_shot_unix": T, "F0": float(F0),
            "rms_hz": float(np.sqrt(np.mean(res ** 2))), "mad_hz": float(np.median(np.abs(res))),
            "rms_rel": float(np.sqrt(np.mean((res / (F0 * f[rv])) ** 2))),
            "Rmin_window_m": float(R[rv].min()), "alt_bias_scores": dict(zip(biases, bs)),
            "best_bias": biases[int(np.argmax(bs))], "smooth_scores": sm, "c_scores": cs,
            "v_fit": v_fit, "v_fit_sigma": sv, "d_fit": d_fit, "v_hermite": v_herm, "gs_reported": gs_rep,
            "kinds_at_cpa": kinds, "n_window": int(rv.sum())}
        q = out["shots"][sid]
        print(f"{sid:14s} {pid:11s} sc {q['score']:.2f} rms {q['rms_hz']:5.2f} Hz ({100*q['rms_rel']:.2f}%) "
              f"Rmin {q['Rmin_window_m']:5.0f} bias* {q['best_bias']:+4d} "
              f"v_fit {v_fit:5.1f}±{sv:4.1f} gs {gs_rep:5.1f} herm {v_herm:5.1f} smooth {sm} c {cs}", flush=True)
    json.dump(out, open(os.path.join(K.OUTD, f"f4_{a.tag}{'_chrono' if a.chrono else ''}.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
