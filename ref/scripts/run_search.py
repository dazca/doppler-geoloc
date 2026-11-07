"""Run the end-to-end grid search on a scenario, print timings/accuracy, save result JSON."""
import json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import numpy as np
from doppler_ref.scenarios import load_scenario
from doppler_ref.search import run_search, Config

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def horiz_err(sc, best):
    t = sc["truth"]["observer"]
    a = sc["enu"].fwd(t["lat"], t["lon"], 0.0)
    b = sc["enu"].fwd(best["lat"], best["lon"], 0.0)
    return float(np.hypot(*(a - b)[:2]))


def run(name, cfg=None, events=None, quiet=False):
    t0 = time.perf_counter()
    sc = load_scenario(os.path.join(ROOT, "fixtures", name))
    t_load = time.perf_counter() - t0
    ev = events if events is not None else sc["events"]
    r = run_search(sc["tracks"], sc["dem"], ev, sc["spec"], sc["enu"], sc["center"], sc["duration"],
                   cfg or Config(), log=(lambda *a: None) if quiet else print)
    r["timings"]["load_wav_spectrogram"] = t_load
    err = horiz_err(sc, r["best"]) if r["best"] else None
    return sc, r, err


if __name__ == "__main__":
    for name in sys.argv[1:] or ["scenario1", "scenario2"]:
        sc, r, err = run(name)
        b = r["best"]
        print(f"== {name}: grid {r['n_grid']} pts, coarse survivors {r['n_surv']}")
        for L in r["levels"]:
            print(f"   refine {L['spacing']:.0f} m: {L['n_points']} pts, {L['n_surv']} surv, best score {L['best']['score']:.3f}"
                  f" err {horiz_err(sc, L['best']):.0f} m")
        print("   best:", json.dumps({k: b[k] for k in ('lat', 'lon', 'elev_m', 'score', 'flights', 't_start_unix', 'F0')}))
        print(f"   truth: {sc['truth']['observer']['lat']:.6f},{sc['truth']['observer']['lon']:.6f}"
              f" T_start {sc['truth']['t_start_unix']}; dT_start = {b['t_start_unix'] - sc['truth']['t_start_unix']:+.2f} s")
        print(f"   HORIZONTAL ERROR: {err:.0f} m")
        print("   timings (s):", {k: round(v, 2) for k, v in r["timings"].items()})
        with open(os.path.join(ROOT, "fixtures", name, "result_ref.json"), "w") as fh:
            json.dump({"best": b, "levels": r["levels"], "timings": r["timings"], "n_grid": r["n_grid"],
                       "n_surv": r["n_surv"], "horizontal_error_m": err}, fh, indent=1)
