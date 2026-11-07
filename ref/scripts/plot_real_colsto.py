"""Plots for the real colsto run: spectrogram overlay of the best candidate + coarse score map.
python scripts/plot_real_colsto.py <tag> [year]"""
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy.io import wavfile

from doppler_ref.geo import ENU
from doppler_ref.track import Track
from doppler_ref.spectrogram import spectrogram, whiten
from doppler_ref.doppler import emission_time, cpa

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
D = os.path.join(ROOT, "fixtures", "real", "colsto_longisland")
IMG = os.path.join(ROOT, "docs", "img")


def main(tag, year):
    res = json.load(open(os.path.join(D, f"result_laneA_{tag}.json")))
    meta = json.load(open(os.path.join(D, "meta.json")))
    bbox = meta["bbox"]
    enu = ENU(0.5 * (bbox[0] + bbox[2]), 0.5 * (bbox[1] + bbox[3]), 0.0)
    raw = {d["id"]: d for d in json.load(open(os.path.join(D, f"tracks_{year}.json")))}
    fs, x = wavfile.read(os.path.join(D, "audio.wav"))
    sp = spectrogram(x.astype(float) / 32768, fs, int(0.512 * fs), int(0.128 * fs), 1000.0)
    Z = whiten(sp)
    rid = json.load(open(os.path.join(D, "ridges.json")))
    cands = res["candidates"]
    best = cands[0]
    obs = np.array(best["obs"])
    fig, axs = plt.subplots(1, 2, figsize=(18, 6.5))
    for e, ax in enumerate(axs):
        tr = Track(raw[best["flights"][e]["id"]], enu, 15.0)
        t_d = cpa(tr, obs[None, :])["t_dcpa"][0]
        t_rx = t_d + np.arange(-90, 90, 0.25)
        te, R, vr, valid = emission_time(tr, obs, t_rx)
        ta = t_rx - best["t_start_unix"]
        a, b = ta[0], ta[-1]
        i0, i1 = max(0, int((a - sp["t0"]) / sp["dt"])), int((b - sp["t0"]) / sp["dt"])
        ax.imshow(Z[i0:i1, :400].T, origin="lower", aspect="auto", cmap="gray_r", vmin=0, vmax=6,
                  extent=[sp["t0"] + i0 * sp["dt"], sp["t0"] + i1 * sp["dt"], 0, 400 * sp["df"]])
        for r in rid:
            if r["event"] == e + 1:
                p = np.array(r["points"])
                ax.plot(p[:, 0], p[:, 1], ".", ms=1, color="#2ca02c", label="Lane C ridge" if r["harmonic"] == 1 else None)
        for k in (1, 2, 3):
            ax.plot(ta[valid], (k * best["F0"][e] * 343 / (343 - vr))[valid], "--", color="#d62728", lw=1,
                    label="predicted (best)" if k == 1 else None)
        f = best["flights"][e]
        ax.set_title(f"event {e + 1}: {f['callsign']} {f['type']} ({f['icao24']}) d={best['d_cpa'][e]:.0f} m "
                     f"v={best['speed'][e]:.0f} m/s")
        ax.set_xlabel("audio time (s)"); ax.set_ylabel("Hz"); ax.set_ylim(0, 700); ax.legend(loc="upper right")
    fig.suptitle(f"colsto best candidate {best['lat']:.4f},{best['lon']:.4f}  T_start {best['t_start_utc']}  "
                 f"ridge RMS {100 * best.get('ridge_rms_rel', float('nan')):.2f}%  spec score {best['score']:.2f}  ({best['dist_to_expected_m'] / 1000:.1f} km from the video's answer)")
    fig.tight_layout()
    fig.savefig(os.path.join(IMG, "colsto_overlay.png"), dpi=100)
    plt.close(fig)
    # score map
    c = res["coarse"]
    fig, ax = plt.subplots(figsize=(9, 8))
    if "ridge_rms" in c:
        s = 100 * np.array(c["ridge_rms"])
        o = np.argsort(-s)
        sc = ax.scatter(np.array(c["lon"])[o], np.array(c["lat"])[o], c=s[o], s=8, cmap="viridis_r", vmax=1.2)
        plt.colorbar(sc, ax=ax, label="ridge RMS misfit, % of F0 (top offset-pair survivors; lower = better)")
    else:
        s = np.array(c["score"])
        o = np.argsort(s)
        sc = ax.scatter(np.array(c["lon"])[o], np.array(c["lat"])[o], c=s[o], s=6, cmap="viridis")
        plt.colorbar(sc, ax=ax, label="coarse score (offset-pair survivors)")
    for k, cc in enumerate(cands[:5]):
        ax.plot(cc["lon"], cc["lat"], "x", color="red", ms=10, mew=2)
        ax.annotate(f"#{k + 1}", (cc["lon"], cc["lat"]), color="red", fontsize=10)
    ax.plot(-73.5, 40.87, "o", mfc="none", mec="cyan", ms=14, mew=2, label="video answer (40.87,-73.5)")
    ax.set_xlim(bbox[1], bbox[3]); ax.set_ylim(bbox[0], bbox[2])
    ax.set_aspect(1 / np.cos(np.radians(40.87)))
    ax.legend(loc="lower right")
    ax.set_title(f"colsto {year}: {len(s)} best offset-pair hypotheses ({tag})")
    fig.tight_layout()
    fig.savefig(os.path.join(IMG, "colsto_score_map.png"), dpi=100)
    print("wrote colsto_overlay.png, colsto_score_map.png")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "2026")
