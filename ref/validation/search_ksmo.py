"""Lane F / F2-F3: per-shot observer score maps for the KSMO montage.

For every selected prop/heli shot and every candidate pass of its tail number (2024-07-09 14:00Z..07-10 03:00Z,
within 4 km / 900 m AGL of KSMO), and every observer of a 50 m grid within 2 km of the runway:
  1. simulate the received-frequency ratio rho(t) = c/(c - v_r(t_e)) with ref/doppler_ref (Newton retarded time,
     exact Doppler, Hermite track with W = 15 s local-quadratic smoothing) on a 0.256 s grid, interpolated to the
     64 ms spectrogram frames;
  2. sweep the shot's absolute start time over the whole pass (every 64 ms frame) and profile F0 in closed form
     against the shot's ridge (log-domain least squares, computed for all shifts at once by FFT correlation);
     keep the 3 best distinct shifts;
  3. score each kept hypothesis on the spectrogram (mean whitened z on k*F0*rho(t), k = 1..4, over the shot's
     Doppler window) with a local sweep of the start time (+-0.26 s) and F0 (+-1.5 %), and keep the max.
Per shot, the observer map = max over passes.  Output: out/maps/<shot>.npz, out/ksmo_grid.npz.

Usage: python search_ksmo.py [--workers 8] [--spacing 50] [--alt-bias 0] [--smooth 15] [--tag base]
"""
import argparse
import json
import os
import time
from multiprocessing import Pool

import numpy as np

import ksmo_common as K
from doppler_ref.doppler import received_freq
from doppler_ref.track import Track

T_WIN = (1720533600.0, 1720580400.0)    # 2024-07-09 14:00Z .. 07-10 03:00Z (meta.json)
RWY_C = np.array([47.1, 53.05])          # runway centre, ENU (m) from ground-roll ADS-B points
RWY_U = np.array([0.7019, 0.7123]) / np.hypot(0.7019, 0.7123)
RWY_HALF = 540.0                         # 3500 ft runway
PROP_REGS = None
DT_G = 0.256
C = 343.0                                # model c; KSMO 2024-07-09 afternoon ~22 C -> 344.4 (checked in F4)


def select_shots(min_valid=0.2, min_q=1.5):
    R = json.load(open(os.path.join(K.OUTD, "ksmo_ridges.json")))
    tr = json.load(open(os.path.join(K.CASE, "tracks.json")))
    typ = {}
    for t in tr:
        if t.get("reg"):
            typ[t["reg"]] = t["type"]
    out = []
    for r in R:
        if typ.get(r["reg"]) not in K.TYPES_PROP:
            continue
        if r["frac_valid"] < min_valid or r["q"] < min_q or r["t1"] - r["t0"] < 10:
            continue
        r["type"] = typ[r["reg"]]
        out.append(r)
    return out


def doppler_window(r):
    """Frames used for fitting/scoring: from the (smoothed) ridge maximum to the last valid frame.
    A constant-F0 source can only produce a falling curve, so rising parts (power/rpm increase on the take-off
    roll) are outside the model and excluded."""
    f = np.log(np.array(r["f"]))
    v = np.array(r["valid"]) > 0
    idx = np.flatnonzero(v)
    i_last = idx[-1]
    fs = np.full(len(f), -np.inf)
    w = 16
    for i in idx:
        sl = v[max(0, i - w):i + w + 1]
        fs[i] = np.median(f[max(0, i - w):i + w + 1][sl])
    i0 = int(np.argmax(fs[:i_last + 1]))
    win = np.zeros(len(f), bool)
    win[i0:i_last + 1] = True
    return win


def make_grid(spacing, dem, radius=2000.0):
    ext = RWY_HALF + radius
    xs = np.arange(-ext, ext + 1e-6, spacing)
    X, Y = np.meshgrid(xs + RWY_C[0], xs + RWY_C[1], indexing="ij")
    P = np.column_stack([X.ravel(), Y.ravel()])
    rel = P - RWY_C
    a = np.clip(rel @ RWY_U, -RWY_HALF, RWY_HALF)
    dist = np.linalg.norm(rel - a[:, None] * RWY_U[None, :], axis=1)
    P = P[dist <= radius]
    lat, lon, _ = K.ENU0.inv(np.column_stack([P, np.zeros(len(P))]))
    h = dem(lat, lon) + 1.5
    obs = K.ENU0.fwd(lat, lon, h)
    return {"obs": obs, "lat": lat, "lon": lon, "h": h, "xy": P}


def pass_L(trk, obs, t0, t1, chunk=400):
    """log rho on frame grid (dt = spectrogram hop).  Returns tf [Mf], L [N, Mf] float32 (nan = invalid)."""
    tg = np.arange(t0, t1, DT_G)
    L = np.empty((len(obs), len(tg)), np.float32)
    for a in range(0, len(obs), chunk):
        o = obs[a:a + chunk][:, None, :]
        f, R, te, valid = received_freq(trk, o, tg[None, :], 1.0, C)
        L[a:a + chunk] = np.where(valid, np.log(f), np.nan)
    q = int(round(DT_G / 0.064))
    Mf = (len(tg) - 1) * q + 1
    tf = tg[0] + 0.064 * np.arange(Mf)
    Lf = np.empty((len(obs), Mf), np.float32)
    for j in range(q):
        wgt = j / q
        Lf[:, j:Mf - 1:q] = (1 - wgt) * L[:, :-1] + wgt * L[:, 1:]
    Lf[:, -1] = L[:, -1]
    return tf, Lf


def corr_fft(x, Y, nfft):
    """c[n, s] = sum_i x[i] * Y[n, s+i] for all s (valid part returned by caller)."""
    X = np.fft.rfft(x, nfft)
    F = np.fft.rfft(Y, nfft, axis=1)
    return np.fft.irfft(np.conj(X)[None, :] * F, nfft, axis=1)


def score_shot_on_pass(r, H, tf, Lf, n_keep=3, chunk=300):
    tau = np.array(r["tau"])
    nT = len(tau)
    win = doppler_window(r)
    w = (np.array(r["valid"]) > 0) & win
    lf = np.log(np.array(r["f"]))
    mu = lf[w].mean()
    rr = np.where(w, lf - mu, 0.0)
    wa = win.astype(float)
    W = w.sum()
    A = np.sum(w * rr * rr)
    E = np.sum(w * rr)
    N, Mf = Lf.shape
    nS = Mf - nT + 1
    out = {k: np.full(N, np.nan) for k in ("score", "T", "logF0", "rms_log", "s")}
    if nS < 1 or W < 20:
        return out
    nfft = int(2 ** np.ceil(np.log2(Mf + nT)))
    iw = np.flatnonzero(win)[::2]                # scoring frames (every 2nd frame = 128 ms)
    dsh = np.array([-4, -2, 0, 2, 4])
    gg = np.linspace(-0.015, 0.015, 7)
    lfl0 = np.log(40.0)
    for a in range(0, N, chunk):
        Lc = Lf[a:a + chunk].astype(np.float64)
        V = np.isfinite(Lc)
        L0 = np.where(V, Lc, 0.0)
        B = corr_fft(w * rr, L0, nfft)[:, :nS]
        Cc = corr_fft(w.astype(float), L0 * L0, nfft)[:, :nS]
        D = corr_fft(w.astype(float), L0, nfft)[:, :nS]
        Vc = corr_fft(wa, V.astype(float), nfft)[:, :nS]
        sse = A - 2 * B + Cc - (E - D) ** 2 / W
        sse[Vc < wa.sum() - 0.5] = np.inf
        n = Lc.shape[0]
        best = np.full(n, -np.inf)
        bT = np.full(n, np.nan)
        bF = np.full(n, np.nan)
        brms = np.full(n, np.nan)
        bs = np.full(n, np.nan)
        s2 = sse.copy()
        rows = np.arange(n)
        for _ in range(n_keep):
            s = np.argmin(s2, axis=1)
            ok = np.isfinite(s2[rows, s])
            if not ok.any():
                break
            phi = (E - D[rows, s]) / W
            logF0 = mu + phi
            # spectrogram score with local sweep
            sd = np.clip(s[:, None] + dsh[None, :], 0, nS - 1)                   # (n,5) shifts kept in range
            idx = sd[:, :, None] + iw[None, None, :]                              # (n,5,ni)
            Lv = Lc[rows[:, None, None], idx]                                     # (n,5,ni)
            lfq = logF0[:, None, None, None] + gg[None, None, :, None] + Lv[:, :, None, :]  # (n,5,7,ni)
            jq = (lfq - lfl0) / 0.0025
            j0 = np.floor(jq).astype(np.int64)
            fr = jq - j0
            inside = (j0 >= 0) & (j0 < H.shape[1] - 1) & np.isfinite(jq)
            j0c = np.clip(j0, 0, H.shape[1] - 2)
            ii = iw[None, None, None, :]
            hv = (1 - fr) * H[ii, j0c] + fr * H[ii, j0c + 1]
            hv = np.where(inside, hv, 0.0)
            sc = hv.mean(-1)                                                     # (n,5,7)
            flat = sc.reshape(n, -1)
            k = np.argmax(flat, axis=1)
            scm = flat[rows, k]
            kd, kg = k // len(gg), k % len(gg)
            upd = ok & (scm > best)
            best[upd] = scm[upd]
            ss_ = sd[rows, kd]
            bT[upd] = (tf[ss_] - tau[0])[upd]            # unix time of the shot's local t = 0 (audio t = shot t0)
            bF[upd] = (logF0 + gg[kg])[upd]
            brms[upd] = np.sqrt(np.maximum(s2[rows, s], 0) / W)[upd]
            bs[upd] = ss_[upd]
            # suppress +-2 s around the chosen shift
            lo = np.clip(s - 31, 0, nS)
            for q in range(-31, 32):
                s2[rows, np.clip(s + q, 0, nS - 1)] = np.inf
        sl = slice(a, a + n)
        out["score"][sl], out["T"][sl], out["logF0"][sl], out["rms_log"][sl], out["s"][sl] = best, bT, bF, brms, bs
    return out


def job(args):
    p, shots_r, grid_obs, smooth, tag = args
    import ridges
    t = time.time()
    trk = Track(p, K.ENU0, smooth_s=smooth)
    t0 = max(p["points"][0][0] + 2, T_WIN[0] - 200)
    spec = K.load_spec()
    Hs = {}
    for r in shots_r:
        ss, Z = K.shot_spec(spec, r["t0"], r["t1"])
        _, H = ridges.stacked(Z, ss)
        Hs[r["id"]] = H[:len(r["tau"])]
    parts = {r["id"]: [] for r in shots_r}
    blk = 400
    for b in range(0, len(grid_obs), blk):
        tf, Lf = pass_L(trk, grid_obs[b:b + blk], t0, p["points"][-1][0] + 20)
        for r in shots_r:
            parts[r["id"]].append(score_shot_on_pass(r, Hs[r["id"]], tf, Lf))
        del Lf
    res = {sid: {k: np.concatenate([q[k] for q in L]) for k in L[0]} for sid, L in parts.items()}
    return p["id"], res, time.time() - t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--spacing", type=float, default=50.0)
    ap.add_argument("--alt-bias", type=float, default=0.0)
    ap.add_argument("--smooth", type=float, default=15.0)
    ap.add_argument("--tag", default="base")
    a = ap.parse_args()
    from doppler_ref.dem_terrarium import TerrariumDEM
    dem = TerrariumDEM([33.96, -118.51, 34.07, -118.39])
    grid = make_grid(a.spacing, dem)
    print("grid", len(grid["obs"]))
    shots_r = select_shots()
    print("shots", len(shots_r), [r["id"] for r in shots_r])
    jobs = []
    pass_meta = {}
    for reg in sorted({r["reg"] for r in shots_r}):
        mine = [r for r in shots_r if r["reg"] == reg]
        ic = mine[0]["icao"] if "icao" in mine[0] else None
        tr = json.load(open(os.path.join(K.CASE, "tracks.json")))
        ic = next(t["icao24"] for t in tr if t.get("reg") == reg)
        for p in K.passes(ic, reg, mine[0]["type"], dem, alt_bias=a.alt_bias):
            if p["points"][-1][0] < T_WIN[0] or p["points"][0][0] > T_WIN[1]:
                continue
            pass_meta[p["id"]] = {k: p[k] for k in ("t_closest", "r_closest", "alt_closest")}
            pass_meta[p["id"]].update(t0=p["points"][0][0], t1=p["points"][-1][0], n=len(p["points"]))
            jobs.append((p, mine, grid["obs"], a.smooth, a.tag))
    print("passes", len(jobs))
    od = os.path.join(K.OUTD, "maps_" + a.tag)
    os.makedirs(od, exist_ok=True)
    np.savez(os.path.join(od, "grid.npz"), **grid)
    json.dump(pass_meta, open(os.path.join(od, "passes.json"), "w"), indent=1)
    per_shot = {r["id"]: {} for r in shots_r}
    t = time.time()
    with Pool(a.workers) as pool:
        for pid, res, el in pool.imap_unordered(job, jobs):
            print(f"  {pid}: {el:.1f} s", flush=True)
            for sid, o in res.items():
                per_shot[sid][pid] = o
    print(f"total {time.time()-t:.0f} s")
    for sid, d in per_shot.items():
        pids = sorted(d)
        arr = {f: np.array([d[p][f] for p in pids]) for f in ("score", "T", "logF0", "rms_log")}
        np.savez(os.path.join(od, sid + ".npz"), pids=np.array(pids), **arr)


if __name__ == "__main__":
    main()
