"""Lane F: internal consistency of the KSMO ADS-B traces (no audio).

* reported ground speed (gs) vs speed of the smoothed Hermite track (W = 15 s and W = 0) at the report times;
* best lag between the two speed series (a velocity-vs-position latency would show up as a lag);
* altitude source mix near KSMO and geom-vs-ground consistency on the runway.
Writes out/adsb_check.json.
"""
import json
import os

import numpy as np

import ksmo_common as K
from doppler_ref.track import Track


def main():
    from doppler_ref.dem_terrarium import TerrariumDEM
    dem = TerrariumDEM([33.96, -118.51, 34.07, -118.39])
    tr = json.load(open(os.path.join(K.CASE, "tracks.json")))
    regs = {}
    for t in tr:
        if t.get("reg") and t["type"] in K.TYPES_PROP:
            regs.setdefault(t["reg"], (t["icao24"], t["type"]))
    lags = np.arange(-6, 6.01, 0.25)
    rows = {"res15": [], "res0": [], "lag_cost": np.zeros(len(lags)), "n": 0}
    for reg, (ic, typ) in regs.items():
        for p in K.passes(ic, reg, typ, dem):
            if not (1720533600 <= p["t_closest"] <= 1720580400):
                continue
            tp = np.array([q[0] for q in p["points"]])
            gs = np.array([g if g is not None else np.nan for g in p["gs"]])
            air = np.array([k != "ground" for k in p["kind"]])
            for W, key in ((15.0, "res15"), (0.0, "res0")):
                trk = Track(p, K.ENU0, smooth_s=W)
                _, v, _ = trk.eval(tp)
                sp = np.linalg.norm(v[:, :2], axis=1)
                m = np.isfinite(gs) & air & (tp > tp[0] + 20) & (tp < tp[-1] - 20)
                rows[key] += list((sp - gs)[m])
            trk = Track(p, K.ENU0, smooth_s=15.0)
            m = np.isfinite(gs) & air & (tp > tp[0] + 30) & (tp < tp[-1] - 30)
            if m.sum() < 10:
                continue
            for j, L in enumerate(lags):
                _, v, _ = trk.eval(tp[m] + L)
                rows["lag_cost"][j] += np.sum((np.linalg.norm(v[:, :2], axis=1) - gs[m]) ** 2)
            rows["n"] += int(m.sum())
    out = {}
    for key in ("res15", "res0"):
        r = np.array(rows[key])
        out[key] = {"n": int(r.size), "median": float(np.median(r)), "mad": float(np.median(np.abs(r - np.median(r)))),
                    "p5": float(np.percentile(r, 5)), "p95": float(np.percentile(r, 95))}
    j = int(np.argmin(rows["lag_cost"]))
    out["best_lag_s"] = float(lags[j])
    out["lag_rms"] = {float(L): float(np.sqrt(c / rows["n"])) for L, c in zip(lags, rows["lag_cost"])}
    json.dump(out, open(os.path.join(K.OUTD, "adsb_check.json"), "w"), indent=1)
    print(json.dumps({k: v for k, v in out.items() if k != "lag_rms"}, indent=1))
    print("rms(lag):", {k: round(v, 2) for k, v in list(out["lag_rms"].items())[::4]})


if __name__ == "__main__":
    main()
