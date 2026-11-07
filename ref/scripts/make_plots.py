"""Plots for docs/img: spectrogram with true vs best curves, score heatmaps (filtered search + unfiltered landscape)."""
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from doppler_ref.scenarios import load_scenario
from doppler_ref.search import run_search, Config, make_grid, flight_tables, score_survivors
from doppler_ref.spectrogram import whiten
from doppler_ref.doppler import emission_time, cpa

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
IMG = os.path.join(ROOT, "docs", "img")


def curve(tr, obs, T_start, F0, c=343.0, half=70.0):
    t_d = cpa(tr, obs[None, :], c)["t_dcpa"][0]
    t_rx = t_d + np.arange(-half, half, 0.25)
    te, R, vr, valid = emission_time(tr, obs, t_rx, c)
    m = (R < 3000) & valid
    return (t_rx - T_start)[m], (F0 * c / (c - vr))[m]


def plot_spectrogram(name, sc, best):
    Z = whiten(sc["spec"])
    sp = sc["spec"]
    tru = sc["truth"]
    ids = [t.id for t in sc["tracks"]]
    o_t = np.array(tru["observer"]["enu"])
    o_b = sc["enu"].fwd(best["lat"], best["lon"], best["elev_m"])
    E = len(tru["events"])
    fig, axs = plt.subplots(1, E, figsize=(6 * E, 5), squeeze=False)
    for e, ev in enumerate(tru["events"]):
        ax = axs[0, e]
        t0, t1 = ev["t_cpa_audio"] - 70, ev["t_cpa_audio"] + 70
        i0, i1 = int((t0 - sp["t0"]) / sp["dt"]), int((t1 - sp["t0"]) / sp["dt"])
        i0 = max(i0, 0)
        ax.imshow(Z[i0:i1].T, origin="lower", aspect="auto", cmap="gray_r", vmin=-1, vmax=6,
                  extent=[sp["t0"] + i0 * sp["dt"], sp["t0"] + i1 * sp["dt"], 0, sp["df"] * sp["nF"]])
        tr = sc["tracks"][ids.index(ev["flight"])]
        trb = sc["tracks"][ids.index(best["flights"][e])]
        for k in (1, 2, 3, 4):
            ta, fa = curve(tr, o_t, tru["t_start_unix"], ev["F0"])
            tb, fb = curve(trb, o_b, best["t_start_unix"], best["F0"][e])
            ax.plot(ta, k * fa, color="#1f77b4", lw=1.2, label="truth" if k == 1 else None)
            ax.plot(tb, k * fb, color="#d62728", lw=1.0, ls="--", label="best fit" if k == 1 else None)
        ax.set_ylim(0, min(1000, 5.2 * ev["F0"]))
        ax.set_xlim(t0, t1)
        ax.set_xlabel("audio time (s)")
        ax.set_ylabel("frequency (Hz)")
        ax.set_title(f"{name} event {e + 1}: flight {ev['flight']} (d={ev['cpa_m']:.0f} m, v={ev['v_mps']:.0f} m/s)")
        ax.legend(loc="upper right")
    fig.tight_layout()
    p = os.path.join(IMG, f"{name}_spectrogram_overlay.png")
    fig.savefig(p, dpi=110)
    plt.close(fig)
    print("wrote", p)


def landscape(sc, half=6000.0, spacing=200.0):
    """Unfiltered score map: true flights forced, T_start from event-0 anchor, sweeps on."""
    cfg = Config()
    tru = sc["truth"]
    o = np.array(tru["observer"]["enu"])
    g = make_grid(sc["enu"], sc["dem"], o[:2], half, spacing)
    ids = [t.id for t in sc["tracks"]]
    fl = np.array([ids.index(e["flight"]) for e in tru["events"]])
    tab = flight_tables(sc["tracks"], g["obs"], cfg.c)
    N = len(g["obs"])
    sT = tab["t_dcpa"][fl[0]] - sc["events"][0]["t_cpa_audio"]
    surv = (np.arange(N), np.tile(fl, (N, 1)), sT)
    r = score_survivors(sc["tracks"], tab, g["obs"], sc["events"], surv, whiten(sc["spec"]), sc["spec"], cfg,
                        1.0, 4.0, 1.0, 0.04, 0.01)
    return g, r["score"].reshape(g["shape"])


def plot_maps(name, sc, r):
    tru = sc["truth"]
    o = np.array(tru["observer"]["enu"])
    best = r["best"]
    fig, axs = plt.subplots(1, 2, figsize=(14, 6.2))
    # (a) filtered coarse search
    cg = r["coarse"]["grid"]
    m = r["coarse"]["map"]
    ax = axs[0]
    ax.scatter((cg["xy"][:, 0] - o[0]) / 1e3, (cg["xy"][:, 1] - o[1]) / 1e3, s=1, c="#dddddd")
    ok = np.isfinite(m)
    sc_ = ax.scatter((cg["xy"][ok, 0] - o[0]) / 1e3, (cg["xy"][ok, 1] - o[1]) / 1e3, s=18, c=m[ok], cmap="viridis")
    plt.colorbar(sc_, ax=ax, label="score (coarse survivors)")
    ax.set_title(f"{name}: 200 m grid ({r['n_grid']} pts, grey) and filter survivors ({ok.sum()} pts)")
    # (b) landscape
    g, L = landscape(sc)
    ax = axs[1]
    ext = [(g["ax"][0]) / 1e3, (g["ax"][-1]) / 1e3, (g["ax"][0]) / 1e3, (g["ax"][-1]) / 1e3]
    im = ax.imshow(L, origin="lower", extent=ext, cmap="magma", vmin=0, vmax=np.nanpercentile(L, 99.8))
    plt.colorbar(im, ax=ax, label="score (true flights forced, no filters)")
    ax.set_title("unfiltered score landscape around truth")
    for ax in axs:
        for tr in sc["tracks"]:
            ts = np.arange(tr.t0, tr.t1, 5.0)
            p = tr.eval(ts)[0]
            ax.plot((p[:, 0] - o[0]) / 1e3, (p[:, 1] - o[1]) / 1e3, lw=0.8,
                    color="#ff7f0e" if tr.category == "jet" else "#1f77b4")
            ax.annotate(tr.id, ((p[len(p) // 2, 0] - o[0]) / 1e3, (p[len(p) // 2, 1] - o[1]) / 1e3), fontsize=8)
        ax.plot(0, 0, "o", mfc="none", mec="cyan", ms=12, mew=2, label="truth")
        bx, by = (best["xy"][0] - o[0]) / 1e3, (best["xy"][1] - o[1]) / 1e3
        ax.plot(bx, by, "x", color="red", ms=10, mew=2, label=f"best ({np.hypot(bx, by) * 1e3:.0f} m)")
        ax.set_xlabel("east of truth (km)")
        ax.set_ylabel("north of truth (km)")
        ax.set_aspect("equal")
        ax.legend(loc="lower left", fontsize=8)
    axs[0].set_xlim(-12, 12); axs[0].set_ylim(-12, 12)
    axs[1].set_xlim(ext[0], ext[1]); axs[1].set_ylim(ext[2], ext[3])
    fig.tight_layout()
    p = os.path.join(IMG, f"{name}_score_maps.png")
    fig.savefig(p, dpi=110)
    plt.close(fig)
    print("wrote", p)


if __name__ == "__main__":
    os.makedirs(IMG, exist_ok=True)
    for name in sys.argv[1:] or ["scenario1", "scenario2"]:
        sc = load_scenario(os.path.join(ROOT, "fixtures", name))
        r = run_search(sc["tracks"], sc["dem"], sc["events"], sc["spec"], sc["enu"], sc["center"], sc["duration"],
                       Config(), log=lambda *a: None)
        plot_spectrogram(name, sc, r["best"])
        plot_maps(name, sc, r)
