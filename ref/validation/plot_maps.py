"""Lane F: plot per-shot observer score maps + combined maps (docs/img/lane_f_score_maps.png)."""
import argparse
import json
import os

import numpy as np

import ksmo_common as K
import analyze_maps as A
import search_ksmo as S


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="base")
    a = ap.parse_args()
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    grid, passes, maps = A.load(a.tag)
    summ = json.load(open(os.path.join(K.OUTD, f"summary_{a.tag}.json")))
    comb = np.load(os.path.join(K.OUTD, f"combined_{a.tag}.npz"))
    xy = grid["xy"]
    sp = float(np.min(np.diff(np.unique(xy[:, 0]))))
    xs, ys = np.unique(xy[:, 0]), np.unique(xy[:, 1])
    ix = np.round((xy[:, 0] - xs[0]) / sp).astype(int)
    iy = np.round((xy[:, 1] - ys[0]) / sp).astype(int)

    def img(v):
        M = np.full((len(ys), len(xs)), np.nan)
        M[iy, ix] = v
        return M

    rw = np.array([S.RWY_C - S.RWY_HALF * S.RWY_U, S.RWY_C + S.RWY_HALF * S.RWY_U])
    chrono = summ["combined_chrono"]["assign"]
    ids = sorted(maps)
    panels = ids + ["SUM (unconstrained)", "SUM (chronological passes)"]
    nc = 6
    nr = int(np.ceil(len(panels) / nc))
    fig, axs = plt.subplots(nr, nc, figsize=(3.4 * nc, 3.3 * nr), squeeze=False)
    ext = [xs[0] - sp / 2, xs[-1] + sp / 2, ys[0] - sp / 2, ys[-1] + sp / 2]
    for ax, name in zip(axs.ravel(), panels):
        if name.startswith("SUM (u"):
            v = comb["tot"]
            best = summ["combined"]["best_xy"]
        elif name.startswith("SUM (c"):
            v = np.where(comb["totc"] > -1e8, comb["totc"], np.nan)
            best = summ["combined_chrono"]["best_xy"]
        else:
            m = maps[name]
            pids = list(m["pids"])
            j = pids.index(chrono[name]["pass"]) if name in chrono else None
            v = m["score"][j] if j is not None else A.shot_map(m)[0]
            best = xy[int(np.nanargmax(v))]
        lo, hi = np.nanpercentile(v, 2), np.nanmax(v)
        ax.imshow(img(v), origin="lower", extent=ext, cmap="viridis", vmin=lo, vmax=hi)
        ax.plot(rw[:, 0], rw[:, 1], "w-", lw=2)
        ax.plot(0, 0, "w+", ms=8)
        ax.plot(best[0], best[1], "rx", ms=8, mew=2)
        cb = summ["combined_chrono"]["best_xy"]
        ax.plot(cb[0], cb[1], "o", mfc="none", mec="orange", ms=10)
        ax.set_title(name if name.startswith("SUM") else f"{name}\n{chrono.get(name, {}).get('pass', '')}",
                     fontsize=8)
        ax.tick_params(labelsize=6)
    for ax in axs.ravel()[len(panels):]:
        ax.axis("off")
    fig.suptitle("KSMO: per-shot observer score (max over start time & F0, pass fixed to the chronological "
                 "assignment); white = runway 03/21, + = ARP, x = map max, o = combined estimate (ENU m)", fontsize=10)
    fig.tight_layout()
    fig.savefig(os.path.join(K.IMG, "lane_f_score_maps.png"), dpi=65)


if __name__ == "__main__":
    main()
