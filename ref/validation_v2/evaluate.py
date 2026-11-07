"""Lane V2 (copied from Lane K ref/validation_cat/evaluate.py): score BLIND engine runs against the truth (run AFTER web/tests/cat_run.mjs).
usage: python -P ref/validation_v2/evaluate.py fixtures/real/v2_<name> [--plots]
Writes <case>/eval.json and (with --plots) docs/img/lane_k_<case>_<seg>_<mode>_{map,overlay}.png.
Also an ADS-B coverage check: tracks passing within 3 km / below 1500 m AGL-ish of the truth in the window."""
import sys, json, glob, math, os
import numpy as np

case = os.path.abspath(sys.argv[1]); plots = "--plots" in sys.argv
name = os.path.basename(case)
meta = json.load(open(os.path.join(case, "meta.json")))
blind = json.load(open(os.path.join(case, "blind.json")))
tla, tlo = meta["true_lat"], meta["true_lon"]
T = json.load(open(os.path.join(case, blind.get("tracks_file", "tracks.json"))))
T = T if isinstance(T, list) else T["tracks"]
byid = {t["id"]: t for t in T}


def hav(a, b, c, d):
    R = 6371000.0
    p1, p2 = math.radians(a), math.radians(c)
    x = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(d - b) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(x))


def closest(t, la, lo):
    P = np.array(t["points"])
    dx = (P[:, 2] - lo) * 111320 * math.cos(math.radians(la)); dy = (P[:, 1] - la) * 111320
    h = np.hypot(dx, dy); k = int(np.argmin(h))
    return h[k], P[k, 3], P[k, 0]


# coverage near the truth
w0, w1 = blind["time"]["t0"], blind["time"]["t1"] + 3600
near = []
for t in T:
    P = np.array(t["points"])
    m = (P[:, 0] >= w0) & (P[:, 0] <= w1)
    if not m.any():
        continue
    h, alt, tt = closest({"points": P[m].tolist()}, tla, tlo)
    if h < 3000 and alt < 1500 + 300:
        near.append({"id": t["id"], "icao24": t["icao24"], "callsign": t.get("callsign"), "type": t.get("type"),
                     "category": t["category"], "hdist_m": round(h), "alt_m": round(alt), "t": tt})
cov = {"n_tracks_total": len(T), "n_nonjet": sum(t["category"] != "jet" for t in T),
       "near_truth_3km_low": sorted(near, key=lambda r: r["t"])}

out = {"case": name, "truth": [tla, tlo], "location_confidence_m": meta["location_confidence_m"], "coverage": cov, "runs": []}
for f in sorted(glob.glob(os.path.join(case, "run_*.json"))):
    R = json.load(open(f))
    c = R["candidates"]
    rec = {"segment": R["segment"], "mode": R["mode"], "n_tracks": R["n_tracks"], "elapsed_s": round(R["elapsed_s"], 1),
           "fits": [{k: v for k, v in (fi.get("fit") or {}).items() if k in ("t_cpa_audio", "F0", "v", "d", "coverage", "poorly_constrained")} for fi in R["fits"]]}
    if c:
        b = c[0]
        rec.update(err_m=round(hav(tla, tlo, b["lat"], b["lon"])), best=[b["lat"], b["lon"]], score=b["score"],
                   margin=R["confidence"].get("margin"), ambiguous=R["confidence"].get("ambiguous"),
                   t_start_utc=b["t_start_unix"], verdict=R["confidence"].get("verdict"),
                   t_start_err_s=(round(b["t_start_unix"] - meta["t_start_truth_unix"], 1) if meta.get("t_start_truth_unix") else None),
                   flights=[{"id": fid, "icao24": byid[fid]["icao24"], "callsign": byid[fid].get("callsign"), "type": byid[fid].get("type"),
                             "category": byid[fid]["category"],
                             "closest_to_truth_m": round(closest(byid[fid], tla, tlo)[0]),
                             "alt_at_closest_m": round(closest(byid[fid], tla, tlo)[1])} for fid in b["flights"] if fid in byid],
                   cand_errs_m=[round(hav(tla, tlo, x["lat"], x["lon"])) for x in c[:10]])
        rec["best_within_1km_rank"] = next((i for i, e in enumerate(rec["cand_errs_m"]) if e < 1000), None)
    out["runs"].append(rec)
    if plots:
        import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
        from scipy.io import wavfile
        from scipy.signal import spectrogram
        tag = f"{name}_{R['segment']}_{R['mode']}"
        fl = R["field"]
        fig, ax = plt.subplots(figsize=(6.5, 6))
        if fl:
            V = np.array(fl["values"], float).reshape(fl["nLat"], fl["nLon"])
            la0, lo0, la1, lo1 = fl["bbox"]
            im = ax.imshow(V, origin="lower", extent=[lo0, lo1, la0, la1], aspect=1 / math.cos(math.radians(tla)), cmap="viridis")
            plt.colorbar(im, ax=ax, shrink=0.7, label="best score (coarse)")
        ax.plot(tlo, tla, "r*", ms=16, label="truth")
        ax.plot(blind["region"]["center"][1], blind["region"]["center"][0], "k+", ms=12, mew=2, label="region centre")
        for i, x in enumerate(c[:5]):
            ax.plot(x["lon"], x["lat"], "o", mfc="none", mec="orange" if i else "red", ms=10 if i == 0 else 6)
        for fid in (c[0]["flights"] if c else []):
            if fid in byid:
                P = np.array(byid[fid]["points"]); ax.plot(P[:, 2], P[:, 1], "-", lw=0.8, color="0.3", alpha=0.7)
        ax.set_xlim(lo0, lo1) if fl else None; ax.set_ylim(la0, la1) if fl else None
        ax.set_title(f"{tag}\nerr {rec.get('err_m')} m, margin {rec.get('margin')}", fontsize=9); ax.legend(fontsize=7, loc="lower left")
        fig.tight_layout(); fig.savefig(os.path.join(os.path.dirname(case), "..", "..", "docs", "img", f"lane_v2_{tag}_map.png"), dpi=80); plt.close(fig)
        # overlay
        fs, x = wavfile.read(os.path.join(case, "audio.wav")); x = x.astype(np.float32)
        s0 = R["seg_t0"]; seg = x[int(s0 * fs):int((s0 + R["duration_s"]) * fs)]
        nE = max(1, len(R["fits"]))
        fig, axs = plt.subplots(1, nE, figsize=(3.2 * nE, 3.6), squeeze=False)
        for j, fi in enumerate(R["fits"]):
            ax = axs[0, j]
            if fi["ridge"]:
                rr = np.array(fi["ridge"]); a0 = max(0, rr[0, 0] - 25 - s0); a1 = rr[-1, 0] + 25 - s0
                f, t, S = spectrogram(seg[int(a0 * fs):int(a1 * fs)], fs, nperseg=4096, nfft=8192, noverlap=4096 - 512)
                k = f <= 700; D = 10 * np.log10(S[k] + 1e-12); D -= np.median(D, axis=1, keepdims=True)
                ax.pcolormesh(t + s0 + a0, f[k], D, vmin=-3, vmax=15, cmap="magma", shading="auto", rasterized=True)
                ax.plot(rr[:, 0], rr[:, 1], "c.", ms=1.5)
                ax.set_xlim(rr[0, 0] - 25, rr[-1, 0] + 25); ax.set_ylim(max(30, rr[:, 1].min() * 0.5), min(700, rr[:, 1].max() * 2.3))
            for cv in R["curves"]:
                if cv.get("points") and cv.get("event", j) == j:
                    pp = np.array(cv["points"]); ax.plot(pp[:, 0] + s0, pp[:, 1], "--", color="lime", lw=0.8)
            ax.set_title(f"ev{j}", fontsize=8); ax.tick_params(labelsize=7)
        fig.suptitle(f"{tag}: cyan = tracked ridge, green dashed = simulated best candidate (h1-3)", fontsize=9)
        fig.tight_layout(); fig.savefig(os.path.join(os.path.dirname(case), "..", "..", "docs", "img", f"lane_v2_{tag}_overlay.png"), dpi=80); plt.close(fig)

json.dump(out, open(os.path.join(case, "eval.json"), "w"), indent=1, default=float)
print(f"== {name}: coverage: {cov['n_tracks_total']} tracks, {cov['n_nonjet']} non-jet, {len(near)} low tracks within 3 km of truth")
for r in near[:30]:
    print(f"   near: {r['icao24']} {r['callsign']} {r['type']} {r['category']} {r['hdist_m']} m alt {r['alt_m']} m")
for r in out["runs"]:
    print(f"  [{r['segment']}/{r['mode']}] err {r.get('err_m')} m verdict {r.get('verdict')} dT {r.get('t_start_err_s')} s margin {r.get('margin')} rank<1km {r.get('best_within_1km_rank')} "
          f"flights {[(fl['icao24'], fl['callsign'], fl['type'], fl['closest_to_truth_m']) for fl in r.get('flights', [])]}")
