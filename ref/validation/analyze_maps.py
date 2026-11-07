"""Lane F: summarise per-shot score maps, combine them, and estimate the filming spot.

python analyze_maps.py --tag base
Writes out/summary_<tag>.json and docs/img/lane_f_score_maps.png (only for --tag base) .
"""
import argparse
import datetime as dt
import glob
import json
import os

import numpy as np

import ksmo_common as K


def utc(t):
    if not np.isfinite(t):
        return "--"
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%H:%M:%S")


def load(tag):
    od = os.path.join(K.OUTD, "maps_" + tag)
    grid = dict(np.load(os.path.join(od, "grid.npz")))
    passes = json.load(open(os.path.join(od, "passes.json")))
    maps = {}
    for p in sorted(glob.glob(os.path.join(od, "*_N*.npz"))):
        z = np.load(p)
        if not np.isfinite(z["score"]).any():
            continue
        maps[os.path.basename(p)[:-4]] = {k: z[k] for k in z.files}
    return grid, passes, maps


def shot_map(m):
    s = np.where(np.isfinite(m["score"]), m["score"], -np.inf)
    k = np.argmax(s, axis=0)
    n = np.arange(s.shape[1])
    return s[k, n], k


def concentration(xy, S, frac=0.9):
    i = int(np.argmax(S))
    top = S >= S.max() - (1 - frac) * (S.max() - np.median(S))
    d = np.linalg.norm(xy[top] - xy[i], axis=1)
    return {"n_top": int(top.sum()), "max_dist_m": float(d.max()), "p90_dist_m": float(np.percentile(d, 90))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="base")
    ap.add_argument("--exclude", default="")
    a = ap.parse_args()
    grid, passes, maps = load(a.tag)
    xy = grid["xy"]
    clips = K.load_clips()
    out = {"shots": {}, "tag": a.tag}
    tot = np.zeros(len(xy))
    excl = set(a.exclude.split(",")) if a.exclude else set()
    for sid, m in maps.items():
        S, k = shot_map(m)
        i = int(np.argmax(S))
        pid = str(m["pids"][k[i]])
        T = float(m["T"][k[i], i])
        med = float(np.median(S))
        rec = {"best_score": float(S[i]), "median_map": med, "best_xy": xy[i].tolist(),
               "best_latlon": [float(grid["lat"][i]), float(grid["lon"][i])], "pass": pid,
               "T_shot_unix": T, "T_shot_utc": utc(T), "F0_base": float(np.exp(m["logF0"][k[i], i])),
               "rms_log": float(m["rms_log"][k[i], i]),
               "pass_scores": {str(p): float(np.nanmax(m["score"][j])) for j, p in enumerate(m["pids"])},
               "conc": concentration(xy, S)}
        out["shots"][sid] = rec
        if sid not in excl:
            tot += S
    i = int(np.argmax(tot))
    out["combined"] = {"best_xy": xy[i].tolist(), "best_latlon": [float(grid["lat"][i]), float(grid["lon"][i])],
                       "score": float(tot[i]), "conc": concentration(xy, tot),
                       "dist_from_arp_m": float(np.hypot(*xy[i]))}
    # per-shot values at the combined best point
    for sid, m in maps.items():
        S, k = shot_map(m)
        out["shots"][sid]["at_combined"] = {"score": float(S[i]), "pass": str(m["pids"][k[i]]),
                                            "T_shot_unix": float(m["T"][k[i], i]),
                                            "T_shot_utc": utc(float(m["T"][k[i], i])),
                                            "F0_base": float(np.exp(m["logF0"][k[i], i])),
                                            "rms_log": float(m["rms_log"][k[i], i])}
    # ---- chronology-constrained combination: the montage is (apparently) in filming order, so the shot
    # absolute times must be non-decreasing in audio order.  DP over shots per observer.
    order = sorted([s for s in maps if s not in excl], key=lambda s: s[:3])
    N = len(xy)
    prevS = prevT = None
    back = []
    for sid in order:
        m = maps[sid]
        Sc = np.where(np.isfinite(m["score"]), m["score"], -1e9)
        Tm = np.where(np.isfinite(m["T"]), m["T"], 0.0)
        if prevS is None:
            cur = Sc.copy()
            bk = np.full(Sc.shape, -1)
        else:
            cur = np.full(Sc.shape, -np.inf)
            bk = np.full(Sc.shape, -1)
            for j in range(Sc.shape[0]):
                for k in range(prevS.shape[0]):
                    cand = np.where(prevT[k] <= Tm[j] + 5.0, prevS[k], -np.inf) + Sc[j]
                    upd = cand > cur[j]
                    cur[j][upd] = cand[upd]
                    bk[j][upd] = k
        back.append(bk)
        prevS, prevT = cur, Tm
    totc = prevS.max(0)
    ic = int(np.argmax(totc))
    # backtrack at the chrono optimum
    j = int(np.argmax(prevS[:, ic]))
    assign = {}
    for n_, sid in reversed(list(enumerate(order))):
        m = maps[sid]
        assign[sid] = {"pass": str(m["pids"][j]), "score": float(m["score"][j, ic]),
                       "T_shot_unix": float(m["T"][j, ic]), "T_shot_utc": utc(float(m["T"][j, ic])),
                       "F0_base": float(np.exp(m["logF0"][j, ic])), "rms_log": float(m["rms_log"][j, ic])}
        j = int(back[n_][j, ic])
    out["combined_chrono"] = {"best_xy": xy[ic].tolist(), "best_latlon": [float(grid["lat"][ic]),
                              float(grid["lon"][ic])], "score": float(totc[ic]),
                              "conc": concentration(xy, np.where(np.isfinite(totc), totc, np.nanmin(totc[np.isfinite(totc)]))),
                              "assign": assign}
    np.savez(os.path.join(K.OUTD, f"combined_{a.tag}.npz"), xy=xy, lat=grid["lat"], lon=grid["lon"], tot=tot,
             totc=totc)
    for sid in order:
        out["shots"][sid]["chrono_pass"] = assign[sid]["pass"]
    print("chrono best", {k: v for k, v in out["combined_chrono"].items() if k != "assign"})
    for sid in order:
        q = assign[sid]
        print(f"   {sid:14s} {q['pass']:12s} {q['T_shot_utc']} score {q['score']:.2f} rms {100*q['rms_log']:.2f}%")
    json.dump(out, open(os.path.join(K.OUTD, f"summary_{a.tag}.json"), "w"), indent=1)
    print(f"combined best {out['combined']}")
    print(f"{'shot':14s} {'best':>6s} {'med':>5s} {'pass':12s} {'T_utc':9s} {'dist_best_to_comb':>8s} | at comb: "
          f"score pass T_utc rms%")
    for sid in sorted(out["shots"]):
        r = out["shots"][sid]
        c = r["at_combined"]
        d = np.hypot(*(np.array(r["best_xy"]) - np.array(out["combined"]["best_xy"])))
        print(f"{sid:14s} {r['best_score']:6.2f} {r['median_map']:5.2f} {r['pass']:12s} {r['T_shot_utc']:9s} "
              f"{d:8.0f} | {c['score']:5.2f} {c['pass']:12s} {c['T_shot_utc']} {100*c['rms_log']:5.2f} "
              f"top90={r['conc']['p90_dist_m']:.0f}")


if __name__ == "__main__":
    main()
