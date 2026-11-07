"""Real test: colsto Long Island recording vs adsb.lol tracks (whole bbox, whole day, unknown T_start).

python scripts/run_real_colsto.py [--year 2026] [--spacing 300] [--cats prop,unknown] [--tag name]
Writes fixtures/real/colsto_longisland/result_laneA_<tag>.json and docs/img/colsto_*.png
"""
import argparse, json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import numpy as np
from scipy.io import wavfile
from scipy.ndimage import maximum_filter

from doppler_ref.geo import ENU
from doppler_ref.track import Track
from doppler_ref.dem_terrarium import TerrariumDEM
from doppler_ref.spectrogram import spectrogram, whiten
from doppler_ref.fit import fit_straight
from doppler_ref.bigsearch import pass_records, pair_join, silence_counts, ridge_samples, ridge_residuals
from doppler_ref.search import Config, score_survivors, make_grid, flight_tables, apply_filters, _pick_distinct

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
D = os.path.join(ROOT, "fixtures", "real", "colsto_longisland")
C = 343.0
EXPECTED = (40.87, -73.5)


def fit_events(path, v_rel=0.3, d_rng=(0.4, 2.0)):
    rid = json.load(open(path))
    evs, fits = [], []
    for e in sorted(set(r["event"] for r in rid)):
        T, F, W = [], [], []
        for r in rid:
            if r["event"] != e:
                continue
            p = np.array(r["points"])
            T += list(p[:, 0]); F += list(p[:, 1] / r["harmonic"])
            W += list(np.clip(np.array(r["snr_db"]), 0, None) / 10)
        fit = fit_straight(np.array(T), np.array(F), weights=np.array(W))
        fits.append(fit)
        evs.append({"t_cpa_audio": float(fit["t_cpa_audio"]), "F0": float(fit["F0"]),
                    "v_mps": [fit["v"] * (1 - v_rel), fit["v"] * (1 + v_rel)],
                    "cpa_m": [fit["d"] * d_rng[0], fit["d"] * d_rng[1]]})
    return evs, fits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", default="2026")
    ap.add_argument("--spacing", type=float, default=300.0)
    ap.add_argument("--cats", default="prop,unknown")
    ap.add_argument("--tol", type=float, default=15.0)
    ap.add_argument("--v_rel", type=float, default=0.3)
    ap.add_argument("--d_lo", type=float, default=0.4)
    ap.add_argument("--d_hi", type=float, default=2.0)
    ap.add_argument("--events", default=None, help="JSON file with contract events (overrides ridge fit)")
    ap.add_argument("--tag", default="default")
    ap.add_argument("--count_only", type=int, default=0)
    ap.add_argument("--ridge_rank", type=int, default=0, help="pre-rank pairs by ridge residual, keep top N")
    ap.add_argument("--rank_by", default="spec", help="spec | ridge (final ranking/refinement criterion)")
    ap.add_argument("--max_surv", type=int, default=60000)
    ap.add_argument("--r_score", type=float, default=8000.0, help="audible radius used for curve scoring windows")
    ap.add_argument("--blur", type=int, default=1, help="coarse scoring on a max-filtered (3 frames x 5 bins) Z")
    a = ap.parse_args()
    T0 = time.perf_counter()
    log = {"args": vars(a), "stages": {}}

    def stage(name, **kw):
        kw["t_s"] = round(time.perf_counter() - T0, 1)
        log["stages"][name] = kw
        print(name, kw, flush=True)

    meta = json.load(open(os.path.join(D, "meta.json")))
    bbox = meta["bbox"]                                    # [lat0, lon0, lat1, lon1]
    enu = ENU(0.5 * (bbox[0] + bbox[2]), 0.5 * (bbox[1] + bbox[3]), 0.0)
    raw = json.load(open(os.path.join(D, f"tracks_{a.year}.json")))
    cats = tuple(a.cats.split(","))
    tracks = [Track(d, enu, 15.0 if d.get("category") in cats else 0.0) for d in raw if len(d["points"]) >= 2]
    cand = [i for i, t in enumerate(tracks) if t.category in cats]
    stage("load_tracks", n_tracks=len(tracks), n_candidates=len(cand))

    dem = TerrariumDEM(bbox, z=12)
    fs, x = wavfile.read(os.path.join(D, "audio.wav"))
    x = x.astype(np.float64) / 32768.0
    if x.ndim > 1:
        x = x.mean(1)
    duration = x.size / fs
    spec = spectrogram(x, fs, nperseg=int(0.512 * fs), hop=int(0.128 * fs), fmax=1000.0)
    Z = whiten(spec)
    if a.events:
        events, fits = json.load(open(a.events)), None
    else:
        events, fits = fit_events(os.path.join(D, "ridges.json"), a.v_rel, (a.d_lo, a.d_hi))
    stage("events", events=events, duration_s=duration)

    # grid over the bbox (DEM heights from Terrarium)
    c_lat, c_lon = 0.5 * (bbox[0] + bbox[2]), 0.5 * (bbox[1] + bbox[3])
    half = 0.5 * max((bbox[2] - bbox[0]) * 111.2e3, (bbox[3] - bbox[1]) * 111.2e3 * np.cos(np.radians(c_lat)))
    g = make_grid(enu, dem, np.zeros(2), half, a.spacing)
    inb = (g["lat"] >= bbox[0]) & (g["lat"] <= bbox[2]) & (g["lon"] >= bbox[1]) & (g["lon"] <= bbox[3])
    for k in ("obs", "lat", "lon", "elev", "xy"):
        g[k] = g[k][inb]
    N = len(g["obs"])
    stage("grid", n_points=N, spacing_m=a.spacing)

    r_max = max(ev["cpa_m"][1] for ev in events)
    cache = os.path.join(ROOT, "ref", ".cache", f"colsto_rec_{a.year}_{a.spacing:.0f}_{r_max:.0f}_{a.cats}.npz")
    if os.path.exists(cache):
        rec = dict(np.load(cache))
    else:
        rec = pass_records(tracks, cand, g["obs"], r_max, C)
        np.savez(cache, **rec)
    stage("stage3_pass_records", n_records=int(rec["n"].size), r_max_m=r_max)

    iA, iB = pair_join(rec, events, a.tol)
    nA = int(np.sum((rec["speed"] >= events[0]["v_mps"][0]) & (rec["speed"] <= events[0]["v_mps"][1])
                    & (rec["d"] >= events[0]["cpa_m"][0]) & (rec["d"] <= events[0]["cpa_m"][1])))
    nB = int(np.sum((rec["speed"] >= events[1]["v_mps"][0]) & (rec["speed"] <= events[1]["v_mps"][1])
                    & (rec["d"] >= events[1]["cpa_m"][0]) & (rec["d"] <= events[1]["cpa_m"][1])))
    stage("stage4_filters", records_pass_vd_event1=nA, records_pass_vd_event2=nB, pairs_after_offset=int(iA.size),
          distinct_points=int(np.unique(rec["n"][iA]).size),
          distinct_flight_pairs=int(np.unique(rec["f"][iA] * 100000 + rec["f"][iB]).size))
    if iA.size == 0 or a.count_only:
        json.dump(log, open(os.path.join(D, f"result_laneA_{a.tag}.json"), "w"), indent=1, default=float)
        return
    off = events[1]["t_cpa_audio"] - events[0]["t_cpa_audio"]
    resid = np.abs(rec["t_dcpa"][iB] - rec["t_dcpa"][iA] - off)
    if a.ridge_rank:
        rid = json.load(open(os.path.join(D, "ridges.json")))
        dl = np.arange(-10, 11)
        sg = np.arange(-10 - int(a.tol) - 1, 10 + int(a.tol) + 2)
        uA, invA = np.unique(iA, return_inverse=True)
        uB, invB = np.unique(iB, return_inverse=True)
        rs = []
        for e, (u, ta) in enumerate(((uA, events[0]["t_cpa_audio"]), (uB, events[1]["t_cpa_audio"]))):
            tk, fk, wk = ridge_samples(rid, e + 1)
            rr, _ = ridge_residuals(tracks, rec, u, g["obs"], tk, fk, wk, ta, sg, C)
            rs.append(rr)
            stage(f"ridge_residuals_event{e + 1}", n_records=int(u.size))
        Dlt = (rec["t_dcpa"][iB] - events[1]["t_cpa_audio"]) - (rec["t_dcpa"][iA] - events[0]["t_cpa_audio"])
        best = np.full(iA.size, np.inf)
        bdel = np.zeros(iA.size)
        for d in dl:
            ja = d - sg[0]
            jb = np.clip(np.round(d - Dlt).astype(int) - sg[0], 0, len(sg) - 1)
            tot = np.sqrt(0.5 * (rs[0][invA, ja] ** 2 + rs[1][invB, jb] ** 2))
            upd = tot < best
            best[upd] = tot[upd]; bdel[upd] = d
        log["ridge_rank"] = {"rms_best": float(best.min()), "rms_p1": float(np.percentile(best[np.isfinite(best)], 1))
                             if np.isfinite(best).any() else None}
        o = np.argsort(best)[:a.ridge_rank]
        o = o[np.isfinite(best[o])]
        iA, iB = iA[o], iB[o]
        rms_kept, del_kept = best[o], bdel[o]
        stage("ridge_rank", kept=int(iA.size), best_rms_rel=float(best[o[0]]) if o.size else None,
              worst_kept_rms_rel=float(best[o[-1]]) if o.size else None,
              flight_pairs_kept=int(np.unique(rec["f"][iA] * 100000 + rec["f"][iB]).size))
    if iA.size > a.max_surv:
        o = np.argsort(resid)[:a.max_surv]
        iA, iB = iA[o], iB[o]

    # stage 5-6: score survivors (local tab built from the matched pass records)
    fl = np.unique(np.concatenate([rec["f"][iA], rec["f"][iB]]))
    fpos = {f: i for i, f in enumerate(fl)}
    S = iA.size
    tab = {"t_dcpa": np.full((len(fl), S), np.nan)}
    tab["t_dcpa"][[fpos[f] for f in rec["f"][iA]], np.arange(S)] = rec["t_dcpa"][iA]
    tab["t_dcpa"][[fpos[f] for f in rec["f"][iB]], np.arange(S)] = rec["t_dcpa"][iB]
    sub_tracks = [tracks[f] for f in fl]
    surv = (np.arange(S), np.column_stack([[fpos[f] for f in rec["f"][iA]], [fpos[f] for f in rec["f"][iB]]]),
            rec["t_dcpa"][iA] - events[0]["t_cpa_audio"])
    aud = {k: a.r_score for k in ("prop", "heli", "unknown", "jet")}
    cfg = Config(harmonics=(1, 2, 3), tau_half=60.0, delta_half=10.0, f0_rel=0.05, offset_tol=a.tol,
                 use_silence_filter=False, candidate_categories=cats, audible=aud, min_audible_s=30.0)
    obs_s = g["obs"][rec["n"][iA]]
    Zc = maximum_filter(Z, size=(3, 5)) if a.blur else Z
    res = score_survivors(sub_tracks, tab, obs_s, events, surv, Zc, spec, cfg, 1.0, 10.0, 1.0, 0.05, 0.01)
    stage("stage56_coarse_score", n_scored=S)

    xy_s = g["xy"][rec["n"][iA]]
    if a.rank_by == "ridge":
        return ridge_finish(a, log, stage, tracks, rec, iA, iB, rms_kept, g, events, enu, dem, Z, spec, cfg, duration, res)
    order = np.argsort(-res["score"])
    seeds = _pick_distinct(xy_s, order, 8, 1500.0)
    # refinement around each seed with its own flight pair
    cands = []
    for i in seeds:
        fA, fB = rec["f"][iA[i]], rec["f"][iB[i]]
        trs = [tracks[fA], tracks[fB]]
        evs = [dict(ev, t_cpa_audio=ev["t_cpa_audio"] - res["delta"][i], F0=float(res["F0"][i, e]))
               for e, ev in enumerate(events)]
        center = xy_s[i]
        best = None
        for (sp, hw, ts, dh, ds, fr, fst) in ((150.0, 600.0, 0.5, 3.0, 0.5, 0.02, 0.005),
                                             (75.0, 225.0, 0.25, 1.5, 0.25, 0.01, 0.0025),
                                             (40.0, 120.0, 0.25, 1.0, 0.125, 0.006, 0.0015)):
            gg = make_grid(enu, dem, center, hw, sp)
            tb = flight_tables(trs, gg["obs"], C)
            cf = Config(harmonics=(1, 2, 3), tau_half=60.0, offset_tol=a.tol + 5, use_vd_filter=False,
                        audible=aud, min_audible_s=30.0,
                        use_silence_filter=False, candidate_categories=tuple(set(cats) | {trs[0].category, trs[1].category}))
            sv = apply_filters(trs, tb, evs, duration, cf)
            keep = (sv[1][:, 0] == 0) & (sv[1][:, 1] == 1)
            sv = (sv[0][keep], sv[1][keep], sv[2][keep])
            if not len(sv[0]):
                break
            rr = score_survivors(trs, tb, gg["obs"], evs, sv, Z, spec, cf, ts, dh, ds, fr, fst)
            j = int(np.argmax(rr["score"]))
            n = sv[0][j]
            center = gg["xy"][n]
            evs = [dict(ev, t_cpa_audio=ev["t_cpa_audio"] - rr["delta"][j], F0=float(rr["F0"][j, e]))
                   for e, ev in enumerate(evs)]
            best = {"lat": float(gg["lat"][n]), "lon": float(gg["lon"][n]), "elev_m": float(gg["elev"][n]),
                    "score": float(rr["score"][j]), "event_scores": [float(v) for v in rr["event_scores"][j]],
                    "t_start_unix": float(rr["T_start"][j]), "F0": [float(v) for v in rr["F0"][j]],
                    "xy": gg["xy"][n].tolist(), "obs": gg["obs"][n].tolist(),
                    "d_cpa": [float(tb["d_cpa"][k, n]) for k in range(2)],
                    "speed": [float(tb["speed"][k, n]) for k in range(2)],
                    "coarse_score": float(res["score"][i])}
        if best is None:
            continue
        best["flights"] = [{"id": t.id, "icao24": t.icao24, "callsign": t.callsign, "type": t.type,
                            "category": t.category, "desc": t.raw.get("desc"), "reg": t.raw.get("reg")} for t in trs]
        best["t_start_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(best["t_start_unix"]))
        best["dist_to_expected_m"] = float(np.hypot(*(enu.fwd(best["lat"], best["lon"], 0)[:2]
                                                      - enu.fwd(*EXPECTED, 0)[:2])))
        best["_fidx"] = [int(fA), int(fB)]
        cands.append(best)
    cands.sort(key=lambda c: -c["score"])
    stage("refine", n_candidates=len(cands))
    # silence check (all flights incl. jets/helis) for the candidates
    if cands:
        cnt, who = silence_counts(tracks, np.array([c["obs"] for c in cands]), np.array([c["t_start_unix"] for c in cands]),
                                  duration, [set(c["_fidx"]) for c in cands], C)
        for c, k, w in zip(cands, cnt, who):
            c["silence_violations"] = int(k)
            c["silence_flights"] = sorted(w, key=lambda z: z[1])[:8]
    stage("silence_check")
    for k, c in enumerate(cands[:8]):
        print(f"#{k + 1} score {c['score']:.3f} (coarse {c['coarse_score']:.3f}) {c['lat']:.5f},{c['lon']:.5f} "
              f"elev {c['elev_m']:.0f} m  T_start {c['t_start_utc']}  dist_to_expected {c['dist_to_expected_m']:.0f} m "
              f"flights {[(f['icao24'], f['callsign'], f['type']) for f in c['flights']]} d {c['d_cpa']} v {c['speed']} "
              f"silence_violations {c.get('silence_violations')}")
    log["candidates"] = cands
    log["fits"] = fits
    log["coarse"] = {"lat": g["lat"][rec["n"][iA]].tolist(), "lon": g["lon"][rec["n"][iA]].tolist(),
                     "score": res["score"].tolist()}
    with open(os.path.join(D, f"result_laneA_{a.tag}.json"), "w") as fh:
        json.dump(log, fh, indent=1, default=float)
    print("total", round(time.perf_counter() - T0, 1), "s")


def pair_rms_at(trs, obs, events, rid, tol, s_half=12):
    """Ridge RMS (relative) of a fixed flight pair at observer points obs[N,3]; best over T_start shift."""
    rec = pass_records(trs, [0, 1], obs, 12000.0, C, dt=1.0)
    sg = np.arange(-s_half - int(tol) - 1, s_half + int(tol) + 2)
    out = np.full(len(obs), np.inf); outT = np.zeros(len(obs)); outF = np.zeros((len(obs), 2))
    per = []
    for e in range(2):
        idx = np.nonzero(rec["f"] == e)[0]
        tk, fk, wk = ridge_samples(rid, e + 1)
        r, lf = ridge_residuals(trs, rec, idx, obs, tk, fk, wk, events[e]["t_cpa_audio"], sg, C)
        per.append((idx, r, lf))
    (iA, rA, lA), (iB, rB, lB) = per
    for ka, i in enumerate(iA):
        n = rec["n"][i]
        kb = np.nonzero(rec["n"][iB] == n)[0]
        for k in kb:
            j = iB[k]
            Dl = (rec["t_dcpa"][j] - events[1]["t_cpa_audio"]) - (rec["t_dcpa"][i] - events[0]["t_cpa_audio"])
            if abs(Dl) > tol:
                continue
            for d in range(-s_half, s_half + 1):
                jb = int(round(d - Dl)) - sg[0]
                if not 0 <= jb < len(sg):
                    continue
                v = np.sqrt(0.5 * (rA[ka, d - sg[0]] ** 2 + rB[k, jb] ** 2))
                if v < out[n]:
                    out[n] = v
                    outT[n] = rec["t_dcpa"][i] - events[0]["t_cpa_audio"] + d
                    outF[n] = np.exp([lA[ka, d - sg[0]], lB[k, jb]])
    return out, outT, outF


def ridge_finish(a, log, stage, tracks, rec, iA, iB, rms_kept, g, events, enu, dem, Z, spec, cfg, duration, res):
    from doppler_ref.search import score_point
    rid = json.load(open(os.path.join(D, "ridges.json")))
    xy_s = g["xy"][rec["n"][iA]]
    order = np.argsort(rms_kept)
    seeds = _pick_distinct(xy_s, order, 10, 1500.0)
    cands = []
    for i in seeds:
        fA, fB = int(rec["f"][iA[i]]), int(rec["f"][iB[i]])
        trs = [tracks[fA], tracks[fB]]
        center = xy_s[i]
        for (sp, hw) in ((100.0, 500.0), (40.0, 120.0)):
            gg = make_grid(enu, dem, center, hw, sp)
            rr, TT, FF = pair_rms_at(trs, gg["obs"], events, rid, a.tol)
            n = int(np.argmin(rr))
            if not np.isfinite(rr[n]):
                break
            center = gg["xy"][n]
        tb = flight_tables(trs, gg["obs"][n:n + 1], C)
        sc_tot, sc_ev = score_point(trs, [0, 1], gg["obs"][n], TT[n], list(FF[n]), Z, spec, cfg, 0.25)
        c = {"lat": float(gg["lat"][n]), "lon": float(gg["lon"][n]), "elev_m": float(gg["elev"][n]),
             "ridge_rms_rel": float(rr[n]), "ridge_rms_hz_at_F0": [float(rr[n] * f) for f in FF[n]],
             "seed_ridge_rms_rel": float(rms_kept[i]), "score": float(sc_tot), "event_scores": sc_ev,
             "coarse_score": float(res["score"][i]), "t_start_unix": float(TT[n]), "F0": [float(f) for f in FF[n]],
             "xy": gg["xy"][n].tolist(), "obs": gg["obs"][n].tolist(),
             "d_cpa": [float(tb["d_cpa"][k, 0]) for k in range(2)], "speed": [float(tb["speed"][k, 0]) for k in range(2)],
             "_fidx": [fA, fB]}
        c["flights"] = [{"id": t.id, "icao24": t.icao24, "callsign": t.callsign, "type": t.type,
                         "category": t.category, "desc": t.raw.get("desc"), "reg": t.raw.get("reg")} for t in trs]
        c["t_start_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(c["t_start_unix"]))
        c["dist_to_expected_m"] = float(np.hypot(*(enu.fwd(c["lat"], c["lon"], 0)[:2] - enu.fwd(*EXPECTED, 0)[:2])))
        cands.append(c)
    cands.sort(key=lambda c: c["ridge_rms_rel"])
    stage("ridge_refine", n_candidates=len(cands))
    if cands:
        cnt, who = silence_counts(tracks, np.array([c["obs"] for c in cands]), np.array([c["t_start_unix"] for c in cands]),
                                  duration, [set(c["_fidx"]) for c in cands], C)
        for c, k, w in zip(cands, cnt, who):
            c["silence_violations"] = int(k)
            c["silence_flights"] = sorted(w, key=lambda z: z[1])[:8]
    for k, c in enumerate(cands):
        print(f"#{k + 1} ridge_rms {c['ridge_rms_rel'] * 100:.3f}% spec {c['score']:.2f} {c['lat']:.5f},{c['lon']:.5f} "
              f"T_start {c['t_start_utc']} dist_exp {c['dist_to_expected_m']:.0f} m "
              f"{[(f['icao24'], f['callsign'], f['type'], f['category']) for f in c['flights']]} "
              f"d {[round(x) for x in c['d_cpa']]} v {[round(x) for x in c['speed']]} F0 {[round(x, 1) for x in c['F0']]} "
              f"silence {c['silence_violations']}", flush=True)
    log["candidates"] = cands
    log["coarse"] = {"lat": g["lat"][rec["n"][iA]].tolist(), "lon": g["lon"][rec["n"][iA]].tolist(),
                     "score": res["score"].tolist(), "ridge_rms": rms_kept.tolist()}
    with open(os.path.join(D, f"result_laneA_{a.tag}.json"), "w") as fh:
        json.dump(log, fh, indent=1, default=float)
    print("total", round(time.perf_counter() - T0G, 1), "s")


T0G = time.perf_counter()

if __name__ == "__main__":
    main()
