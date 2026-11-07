"""Robustness experiments: how error and score landscape degrade with modelling / measurement errors.

Usage: python scripts/robustness.py [quick]
Writes fixtures/robustness_results.json and prints a markdown table.
Metrics per run:
  err_m        horizontal error of the final best point (m); 'FAIL' if no survivor
  ok_flights   best hypothesis uses the true flights
  n_surv       coarse (200 m) (point, assignment) survivors after filters
  best         final score;  truth  score_point at the true observer/flights/T_start/F0 (no sweep)
  runner_up    best coarse score among survivors > 1 km from the final best (lower = better separated)
  amb_km2      area of coarse grid cells with score >= 0.9 * max coarse score (ambiguity area)
"""
import copy, json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import numpy as np

from doppler_ref.scenarios import SCENARIOS, build_scenario, load_scenario, measure_events
from doppler_ref.search import run_search, Config, score_point
from doppler_ref.spectrogram import whiten
from doppler_ref.track import Track
from doppler_ref.fit import track_ridge, fit_straight, event_from_fit

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRATCH = os.environ.get("ROBUST_TMP", os.path.join(ROOT, "fixtures", "_robust_tmp"))


def modify_tracks(sc, alt_bias=0.0, decimate_s=None, gap_at_cpa_s=None):
    out = []
    ev_flights = {e["flight"]: e for e in sc["truth"]["events"]}
    T0 = sc["truth"]["t_start_unix"]
    for tr in sc["tracks"]:
        d = copy.deepcopy(tr.raw)
        pts = np.array(d["points"], float)
        pts[:, 3] += alt_bias
        if decimate_s:
            keep, last = [], -1e18
            for i, t in enumerate(pts[:, 0]):
                if t - last >= decimate_s:
                    keep.append(i); last = t
            pts = pts[keep]
        if gap_at_cpa_s and tr.id in ev_flights:
            tc = T0 + ev_flights[tr.id]["t_cpa_audio"] - ev_flights[tr.id]["cpa_m"] / 343.0
            pts = pts[np.abs(pts[:, 0] - tc) > gap_at_cpa_s / 2]
        d["points"] = pts.tolist()
        out.append(Track(d, sc["enu"], sc.get("smooth_s", 15.0)))
    return out


def evaluate(sc, tracks=None, events=None, cfg=None, duration=None):
    tracks = tracks or sc["tracks"]
    events = events if events is not None else sc["events"]
    cfg = cfg or Config()
    t0 = time.perf_counter()
    r = run_search(tracks, sc["dem"], events, sc["spec"], sc["enu"], sc["center"], duration or sc["duration"], cfg,
                   log=lambda *a: None)
    el = time.perf_counter() - t0
    tru = sc["truth"]
    o = np.array(tru["observer"]["enu"])
    ids = [t.id for t in tracks]
    Z = whiten(sc["spec"])
    nev = len(events)
    tf = [ids.index(e["flight"]) for e in tru["events"][:nev]]
    truth_score = score_point(tracks, tf, o, tru["t_start_unix"], [e["F0"] for e in tru["events"][:nev]],
                              Z, sc["spec"], cfg)[0]
    row = {"n_surv": r["n_surv"], "truth": round(truth_score, 3), "time_s": round(el, 1)}
    if r["best"] is None:
        row.update(err_m="FAIL", ok_flights=False, best=None, runner_up=None, amb_km2=None)
        return row
    b = r["best"]
    bxy = np.array(b["xy"])
    row["err_m"] = round(float(np.hypot(*(bxy - o[:2]))))
    row["ok_flights"] = b["flights"] == [e["flight"] for e in tru["events"][:nev]]
    row["best"] = round(b["score"], 3)
    row["dT_start_s"] = round(b["t_start_unix"] - tru["t_start_unix"], 2)
    cg, (sn, _, _), cs = r["coarse"]["grid"], r["coarse"]["surv"], r["coarse"]["res"]["score"]
    far = np.hypot(*(cg["xy"][sn] - bxy).T) > 1000
    row["runner_up"] = round(float(cs[far].max()), 3) if far.any() else None
    m = r["coarse"]["map"]
    mx = np.nanmax(m)
    row["amb_km2"] = round(float(np.sum(m >= 0.9 * mx) * (Config().spacing / 1000) ** 2), 2)
    return row


def auto_events(sc):
    Z = whiten(sc["spec"])
    out = []
    for ev in sc["events"]:
        t, f, s = track_ridge(Z, sc["spec"], ev["t_cpa_audio"], ev["F0"])
        out.append(event_from_fit(fit_straight(t, f, weights=s)))
    return out


def resynth(name, **kw):
    cfg = copy.deepcopy(SCENARIOS[name])
    cfg.update(kw)
    d = os.path.join(SCRATCH, name + "_" + "_".join(f"{k}{v}" for k, v in kw.items()).replace(" ", "")
                     .replace("[", "").replace("]", "").replace(",", "_"))
    build_scenario(cfg, d)
    return load_scenario(d)


def main(quick=False):
    rows = []

    def add(name, label, row):
        row = {"scenario": name, "variant": label, **row}
        rows.append(row)
        print(json.dumps(row), flush=True)

    for name in (["scenario1"] if quick else ["scenario1", "scenario2"]):
        sc = load_scenario(os.path.join(ROOT, "fixtures", name))
        tru = sc["truth"]
        add(name, "baseline (human-measured events)", evaluate(sc))
        add(name, "auto events (ridge + LSQ fit)", evaluate(sc, events=auto_events(sc)))
        dur1 = tru["events"][0]["t_cpa_audio"] + 150.0   # clip cut before the 2nd pass
        add(name, "one event only (clip cut)", evaluate(sc, events=sc["events"][:1], duration=dur1))
        add(name, "one event + T_start known +-2 s", evaluate(
            sc, events=sc["events"][:1], duration=dur1, cfg=Config(t_start_prior=(tru["t_start_unix"] + 1.3, 2.0))))
        add(name, "no v/d filter (offset+silence only)", evaluate(sc, cfg=Config(use_vd_filter=False)))
        add(name, "no silence filter", evaluate(sc, cfg=Config(use_silence_filter=False)))
        for b in (-100.0, 50.0, 100.0, 200.0, 400.0):
            add(name, f"ADS-B altitude bias {b:+.0f} m", evaluate(sc, tracks=modify_tracks(sc, alt_bias=b)))
        for dec in (10.0, 20.0, 30.0):
            add(name, f"track decimated to {dec:.0f} s", evaluate(sc, tracks=modify_tracks(sc, decimate_s=dec)))
        for g in (30.0, 60.0):
            add(name, f"{g:.0f} s gap at CPA (event flights)", evaluate(sc, tracks=modify_tracks(sc, gap_at_cpa_s=g)))
        for (te, ve, de, lab) in [(6.0, 0.15, 0.3, "t err +-6 s"), (10.0, 0.15, 0.3, "t err +-10 s"),
                                  (3.0, 0.30, 0.6, "v err +-30%, d err +-60%")]:
            ev = measure_events(tru["events"], 7, t_err=te, v_err=ve, d_err=de)
            add(name, "measured " + lab, evaluate(sc, events=ev))
        ev = measure_events(tru["events"], 7)
        ev[0]["cpa_m"] = [round(tru["events"][0]["cpa_m"] * 1.6), round(tru["events"][0]["cpa_m"] * 3.0)]
        add(name, "event-0 CPA range wrong (excludes truth)", evaluate(sc, events=ev))
        if quick:
            continue
        for w in (5.0, 10.0, 15.0):
            add(name, f"wind {w:.0f} m/s (audio only)", evaluate(resynth(name, wind=[w * 0.6, w * 0.8, 0.0])))
        for c_a, lab in ((331.3, "0 C"), (349.0, "30 C")):
            add(name, f"air temp {lab} (audio c={c_a}), model c=343", evaluate(resynth(name, c_audio=c_a)))
        for nl in (2.5, 5.0):
            add(name, f"noise x{nl}", evaluate(resynth(name, noise_level=nl)))
    with open(os.path.join(ROOT, "fixtures", "robustness_results.json"), "w") as fh:
        json.dump(rows, fh, indent=1)
    cols = ["scenario", "variant", "err_m", "ok_flights", "n_surv", "best", "truth", "runner_up", "amb_km2", "dT_start_s"]
    print("\n| " + " | ".join(cols) + " |\n|" + "---|" * len(cols))
    for r in rows:
        print("| " + " | ".join(str(r.get(c, "")) for c in cols) + " |")


if __name__ == "__main__":
    main(quick="quick" in sys.argv)
