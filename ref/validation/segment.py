"""Lane F / F1: segment the KSMO montage into clips (scene cuts) and map them to the description list.

Cut detector: short-time (64 ms) log band energies in 24 log-spaced bands 60-6000 Hz; novelty = median over
bands of |mean(after 1 s) - mean(before 1 s)| (dB), plus the broadband level jump.  Cuts are abrupt changes,
so we take local maxima of the novelty above a threshold, at least 4 s apart.  Each description timestamp
(m:ss, 1 s resolution) is then snapped to the strongest detected cut within +-3 s.

Writes ref/validation/out/ksmo_clips.json and docs/img/lane_f_segmentation.png.
"""
import json
import os
import re

import numpy as np
from scipy.io import wavfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
CASE = os.path.join(ROOT, "fixtures", "real", "ksmo_2024-07-09")
OUTD = os.path.join(HERE, "out")


def description_list():
    meta = json.load(open(os.path.join(CASE, "meta.json")))
    txt = meta["audible_aircraft_notes"].split("audio.wav, 1330 s long):")[1].split("spec.png")[0]
    out = []
    for m in re.finditer(r"(\d+):(\d\d) (N\d+[A-Z]*)([^;]*)", txt):
        out.append({"t_desc": int(m.group(1)) * 60 + int(m.group(2)), "reg": m.group(3), "label": m.group(4).strip()})
    return out


def band_energies(x, fs, win=1024, hop=512, nb=24):
    n = 1 + (x.size - win) // hop
    w = np.hanning(win)
    idx = np.arange(n)[:, None] * hop + np.arange(win)[None, :]
    E = np.empty((n, nb), np.float32)
    edges = np.geomspace(60, 6000, nb + 1)
    f = np.fft.rfftfreq(win, 1 / fs)
    bi = np.digitize(f, edges) - 1
    for a in range(0, n, 4096):
        X = np.abs(np.fft.rfft(x[idx[a:a + 4096]] * w, axis=1)) ** 2
        for b in range(nb):
            E[a:a + 4096, b] = X[:, bi == b].sum(1)
    t = (np.arange(n) * hop + win / 2) / fs
    return t, 10 * np.log10(E + 1e-3)


def novelty(t, L, half_s=1.0):
    dt = t[1] - t[0]
    h = int(round(half_s / dt))
    c = np.cumsum(np.vstack([np.zeros((1, L.shape[1])), L]), axis=0)
    nov = np.zeros(len(t))
    for i in range(h, len(t) - h):
        before = (c[i] - c[i - h]) / h
        after = (c[i + h] - c[i]) / h
        nov[i] = np.median(np.abs(after - before))
    return nov


def main():
    os.makedirs(OUTD, exist_ok=True)
    fs, x = wavfile.read(os.path.join(CASE, "audio.wav"))
    x = x.astype(np.float64) / 32768
    t, L = band_energies(x, fs)
    nov = novelty(t, L, 1.0)
    # sharper single-frame jump (abrupt edit) : median over bands of |L[i+1]-L[i-1]| smoothed little
    jump = np.r_[0, np.median(np.abs(L[2:] - L[:-2]), axis=1), 0]
    score = nov * np.minimum(jump / 3.0, 3.0)
    # local maxima
    dt = t[1] - t[0]
    w = int(4.0 / dt)
    peaks = []
    for i in np.argsort(-score):
        if score[i] < 8.0:
            break
        if all(abs(i - j) > w for j in peaks):
            peaks.append(i)
    peaks = sorted(peaks)
    cuts = [{"t": float(t[i]), "nov_db": float(nov[i]), "score": float(score[i])} for i in peaks]
    desc = description_list()
    clips = []
    for k, d in enumerate(desc):
        near = [c for c in cuts if abs(c["t"] - d["t_desc"] - 0.5) <= 3.0]
        snap = max(near, key=lambda c: c["score"])["t"] if near else float(d["t_desc"])
        clips.append(dict(d, t_start=snap, snapped=bool(near)))
    dur = x.size / fs
    for k, c in enumerate(clips):
        c["t_end"] = clips[k + 1]["t_start"] if k + 1 < len(clips) else dur
        # internal cuts (same description entry may hold several shots)
        c["internal_cuts"] = [round(q["t"], 2) for q in cuts if c["t_start"] + 3 < q["t"] < c["t_end"] - 3]
    json.dump({"cuts": cuts, "clips": clips, "duration": dur}, open(os.path.join(OUTD, "ksmo_clips.json"), "w"),
              indent=1)
    print(f"{len(cuts)} cuts detected; {len(clips)} description entries, "
          f"{sum(c['snapped'] for c in clips)} snapped to a detected cut")
    for c in clips:
        print(f"{c['reg']:7s} {c['label'][:18]:18s} desc {c['t_desc']:5d}  start {c['t_start']:7.2f} "
              f"end {c['t_end']:7.2f} snapped={c['snapped']} internal={c['internal_cuts']}")
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(2, 1, figsize=(18, 6), sharex=True)
    ax[0].imshow((L - np.median(L, 0)).T, aspect="auto", origin="lower", extent=[t[0], t[-1], 0, L.shape[1]],
                 cmap="magma", vmin=-10, vmax=20)
    ax[0].set_ylabel("band (60 Hz-6 kHz, log)")
    ax[1].plot(t, score, lw=0.6)
    for c in cuts:
        ax[1].axvline(c["t"], color="0.6", lw=0.5)
    for c in clips:
        ax[1].axvline(c["t_start"], color="r" if c["snapped"] else "orange", lw=1)
        ax[1].text(c["t_start"], ax[1].get_ylim()[1] * 0.9, c["reg"], rotation=90, fontsize=7, va="top")
    ax[1].set_ylabel("cut score")
    ax[1].set_xlabel("audio time (s)")
    fig.tight_layout()
    fig.savefig(os.path.join(ROOT, "docs", "img", "lane_f_segmentation.png"), dpi=80)


if __name__ == "__main__":
    main()
