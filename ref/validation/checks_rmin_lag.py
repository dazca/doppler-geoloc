"""Lane F checks: (1) CPA geometry / altitude source at the combined estimate; (2) ADS-B time shift vs per-shot rms."""
import json, os, copy
import numpy as np
import ksmo_common as K, search_ksmo as S, ridges as RG, overlay as O, f4_errors as F
from doppler_ref.dem_terrarium import TerrariumDEM

dem = TerrariumDEM([33.96, -118.51, 34.07, -118.39])
s = json.load(open(os.path.join(K.OUTD, "summary_base_chrono.json")))
g = dict(np.load(os.path.join(K.OUTD, "maps_base", "grid.npz")))
i = int(np.argmin(np.linalg.norm(g["xy"] - np.array(s["combined"]["best_xy"]), axis=1)))
obs = g["obs"][i]
print("observer ENU", obs.round(1), "DEM ground", float(g["h"][i] - 1.5), "geoidN", K.geoid_n())
R = {x["id"]: x for x in json.load(open(os.path.join(K.OUTD, "ksmo_ridges.json")))}
spec = K.load_spec()
good = ["01a_N796SP", "03a_N201XQ", "04a_N6409U", "12a_N67CM", "14a_N819MM", "16b_N148AC", "18a_N2902S",
        "23a_N201XQ", "33a_N785AM"]
shifts = [-3, -2, -1, 0, 1, 2, 3]
out = {"cpa": {}, "shift": {}}
for sid in good:
    a = s["shots"][sid]["at_combined"]; r = R[sid]
    ss, Z = K.shot_spec(spec, r["t0"], r["t1"]); _, H = RG.stacked(Z, ss); H = H[:len(r["tau"])]
    p = O.get_pass(sid.split("_")[1], a["pass"], dem)
    tau = np.array(r["tau"])
    f, Rr, te, valid, trk = O.sim_curve(p, obs, a["T_shot_unix"], tau)
    tt = np.linspace(a["T_shot_unix"] - 60, a["T_shot_unix"] + tau[-1] + 60, 2000)
    P, _, _ = trk.eval(tt)
    d = np.linalg.norm(P - obs, axis=1); k = int(np.argmin(d))
    tp = np.array([q[0] for q in p["points"]]); j = int(np.argmin(abs(tp - tt[k])))
    out["cpa"][sid] = dict(Rmin=float(d[k]), horiz=float(np.hypot(*(P[k, :2] - obs[:2]))),
                           h_above_obs=float(P[k, 2] - obs[2]), alt_msl=float(P[k, 2]),
                           src=p["kind"][j], dt_cpa_in_shot=float(tt[k] - a["T_shot_unix"]),
                           raw_alt_near=float(p["points"][j][3]))
    print(sid, {k2: (round(v, 1) if isinstance(v, float) else v) for k2, v in out["cpa"][sid].items()})
    row = {}
    for dt in shifts:
        q = copy.deepcopy(p); q["points"] = [[pt[0] + dt] + list(pt[1:]) for pt in p["points"]]
        e = F.eval_point(r, H, q, obs)
        row[dt] = dict(score=e["score"], rms=e["rms_log"], dT=e["T"] - a["T_shot_unix"])
    out["shift"][sid] = row
    print("   shift rms%:", {dt: round(100 * v["rms"], 3) for dt, v in row.items()},
          "dT:", {dt: round(v["dT"], 2) for dt, v in row.items()})
tot = {dt: float(np.sqrt(np.mean([out["shift"][x][dt]["rms"] ** 2 for x in good]))) for dt in shifts}
out["shift_total_rms"] = tot
print("pooled rms% by shift:", {dt: round(100 * v, 3) for dt, v in tot.items()})
json.dump(out, open(os.path.join(K.OUTD, "checks_rmin_lag.json"), "w"), indent=1)
