"""Lane F: overlay the best simulated Doppler curve(s) on each shot's spectrogram.

python overlay.py --tag base --which combined|best [--out lane_f_overlays_combined.png] [--shots id1,id2]
Re-simulates with ref/doppler_ref (received_freq) at the chosen observer / pass / T / F0 and also re-scores the
hypothesis with the reference doppler_ref.spectrogram.curve_score (k = 1..4) for cross-checking.
"""
import argparse
import json
import os

import numpy as np

import ksmo_common as K
import search_ksmo as S
from doppler_ref.doppler import received_freq
from doppler_ref.track import Track


def sim_curve(p, obs, T, tau, smooth=15.0, c=S.C):
    trk = Track(p, K.ENU0, smooth_s=smooth)
    f, R, te, valid = received_freq(trk, obs[None, :], T + tau, 1.0, c)
    return f, R, te, valid, trk


def get_pass(reg, pid, dem, alt_bias=0.0):
    tr = json.load(open(os.path.join(K.CASE, "tracks.json")))
    ic = next(t["icao24"] for t in tr if t.get("reg") == reg)
    typ = next(t["type"] for t in tr if t.get("reg") == reg)
    for p in K.passes(ic, reg, typ, dem, alt_bias=alt_bias):
        if p["id"] == pid:
            return p
    raise KeyError(pid)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="base")
    ap.add_argument("--which", default="combined")
    ap.add_argument("--out", default=None)
    ap.add_argument("--shots", default="")
    ap.add_argument("--summary", default=None)
    a = ap.parse_args()
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from doppler_ref.dem_terrarium import TerrariumDEM
    dem = TerrariumDEM([33.96, -118.51, 34.07, -118.39])
    summ = json.load(open(a.summary or os.path.join(K.OUTD, f"summary_{a.tag}.json")))
    grid = dict(np.load(os.path.join(K.OUTD, "maps_" + a.tag, "grid.npz")))
    ridges = {r["id"]: r for r in json.load(open(os.path.join(K.OUTD, "ksmo_ridges.json")))}
    spec = K.load_spec()
    ids = a.shots.split(",") if a.shots else sorted(summ["shots"])
    n = len(ids)
    nc = 4
    nr = int(np.ceil(n / nc))
    fig, axs = plt.subplots(nr, nc, figsize=(5.2 * nc, 3.6 * nr), squeeze=False)
    rows = []
    for ax, sid in zip(axs.ravel(), ids):
        rec = summ["shots"][sid]
        h = rec if a.which == "best" else rec["at_combined"]
        xy = np.array(rec["best_xy"] if a.which == "best" else summ["combined"]["best_xy"])
        i = int(np.argmin(np.linalg.norm(grid["xy"] - xy, axis=1)))
        obs = grid["obs"][i]
        r = ridges[sid]
        ss, Z = K.shot_spec(spec, r["t0"], r["t1"])
        tau = ss["t0"] + ss["dt"] * np.arange(ss["nT"])
        p = get_pass(r["reg"], h["pass"], dem)
        f, R, te, valid, trk = sim_curve(p, obs, h["T_shot_unix"], tau)
        F0 = h["F0_base"]
        win = S.doppler_window(r)
        sc_ref = float(K.sp.curve_score(Z, ss, tau[win], f[win], F0, harmonics=(1, 2, 3, 4)))
        ax.imshow(Z.T, aspect="auto", origin="lower", extent=[tau[0], tau[-1], 0, ss["nF"] * ss["df"]],
                  vmin=0, vmax=6, cmap="gray_r")
        for k in (1, 2, 3, 4):
            ax.plot(tau[win], k * F0 * f[win], "r-", lw=0.8, alpha=0.8)
            ax.plot(tau[~win], k * F0 * f[~win], "r:", lw=0.6, alpha=0.5)
        rf = np.array(r["f"])
        rv = (np.array(r["valid"]) > 0) & win
        resid = rf[rv] - F0 * f[rv]
        fmax = min(1000, 5.5 * F0 * np.nanmax(f))
        ax.set_ylim(30, fmax)
        ax.set_title(f"{sid} {h['pass']} {h['T_shot_utc']}Z\nscore {sc_ref:.2f}  Rmin {R.min():.0f} m  "
                     f"rms {np.sqrt(np.mean(resid**2)):.2f} Hz @F0={F0:.0f}", fontsize=8)
        ax.set_xlabel("shot time (s)", fontsize=7)
        ax.tick_params(labelsize=7)
        rows.append({"id": sid, "score_ref": sc_ref, "score_map": h.get("score", rec["best_score"]),
                     "rms_hz": float(np.sqrt(np.mean(resid ** 2))), "Rmin": float(R.min()), "F0": F0})
    for ax in axs.ravel()[n:]:
        ax.axis("off")
    fig.tight_layout()
    out = a.out or f"lane_f_overlays_{a.which}.png"
    fig.savefig(os.path.join(K.IMG, out) if not os.path.isabs(out) else out, dpi=70)
    for q in rows:
        print(q)


if __name__ == "__main__":
    main()
