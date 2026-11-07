"""Lane F: harmonic-stacked log-frequency ridge (Viterbi) for every KSMO shot.

H(tau, f) = mean_{k=1..4} z(tau, k f) on a log-f grid 40-420 Hz (step 0.25 %); a DP path maximises
sum H - lam*|dj| with |dj| <= 6 bins/frame (<= 1.5 %/64 ms, enough for a 30 m pass).  Frames whose stacked
z on the path is < Z_MIN (after 1 s smoothing) are marked invalid.  Any line family works for the
log-ratio comparisons downstream (the harmonic number only rescales F0).

Writes out/ksmo_ridges.json: per shot {id, reg, t0, t1, tau[], f[], h[], valid[], q (median h on valid)}
"""
import json
import os

import numpy as np

import ksmo_common as K

FL = np.exp(np.arange(np.log(40.0), np.log(420.0), 0.0025))
HARM = (1, 2, 3, 4)
Z_MIN = 1.2


def stacked(Z, ss):
    tau = ss["t0"] + ss["dt"] * np.arange(ss["nT"])
    T, F = np.meshgrid(tau, FL, indexing="ij")
    H = sum(K.sp.bilinear(Z, ss, T, k * F) for k in HARM) / len(HARM)
    return tau, H


def viterbi(H, lam=0.15, jmax=6):
    nT, nJ = H.shape
    D = H[0].copy()
    bp = np.zeros((nT, nJ), np.int16)
    js = np.arange(nJ)
    for i in range(1, nT):
        best = np.full(nJ, -np.inf)
        arg = np.zeros(nJ, np.int16)
        for d in range(-jmax, jmax + 1):
            src = js - d
            ok = (src >= 0) & (src < nJ)
            cand = np.full(nJ, -np.inf)
            cand[ok] = D[src[ok]] - lam * abs(d)
            m = cand > best
            best[m] = cand[m]
            arg[m] = d
        D = best + H[i]
        bp[i] = arg
    path = np.empty(nT, int)
    path[-1] = int(np.argmax(D))
    for i in range(nT - 1, 0, -1):
        path[i - 1] = path[i] - bp[i, path[i]]
    return path


def ridge_for(spec, t0, t1):
    ss, Z = K.shot_spec(spec, t0, t1)
    tau, H = stacked(Z, ss)
    path = viterbi(H)
    h = H[np.arange(len(tau)), path]
    w = max(1, int(round(1.0 / ss["dt"])))
    hs = np.convolve(h, np.ones(w) / w, mode="same")
    # sub-bin parabolic refinement in log f
    j = np.clip(path, 1, len(FL) - 2)
    r = np.arange(len(tau))
    y0, y1, y2 = H[r, j - 1], H[r, j], H[r, j + 1]
    den = y0 - 2 * y1 + y2
    off = np.where(den < 0, 0.5 * (y0 - y2) / np.where(den < 0, den, -1), 0.0)
    f = np.exp(np.log(FL[j]) + np.clip(off, -1, 1) * 0.0025)
    return {"tau": tau, "f": f, "h": h, "valid": hs >= Z_MIN}


def main():
    spec = K.load_spec()
    out = []
    for s in K.shots():
        if s["t1"] - s["t0"] < 8:
            continue
        r = ridge_for(spec, s["t0"], s["t1"])
        q = float(np.median(r["h"][r["valid"]])) if r["valid"].any() else 0.0
        out.append(dict(s, tau=r["tau"].tolist(), f=r["f"].tolist(), h=r["h"].tolist(),
                        valid=r["valid"].astype(int).tolist(), q=q, frac_valid=float(r["valid"].mean())))
        print(f"{s['id']:16s} dur {s['t1']-s['t0']:5.1f}  valid {r['valid'].mean():4.2f}  q {q:4.2f}  "
              f"f {np.percentile(r['f'][r['valid']], 5) if r['valid'].any() else 0:6.1f}-"
              f"{np.percentile(r['f'][r['valid']], 95) if r['valid'].any() else 0:6.1f}")
    json.dump(out, open(os.path.join(K.OUTD, "ksmo_ridges.json"), "w"))


if __name__ == "__main__":
    main()
