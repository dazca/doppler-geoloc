"""Whole-region / whole-day two-event search for real data (many flights, unknown T_start).

Differences from search.py (which stays the reference for the JS port):
  * per-flight *local* CPA passes (a flight may pass a point several times: pattern work, holds),
    found as local minima of R(t) on a 2 s track sampling (+ parabolic refinement), only where R < r_max;
  * records (point, flight, t_dcpa, d, speed) are joined across events by a sorted key
    point*KEY + t, so the time-offset filter is a vectorised searchsorted (no F x F loop);
  * silence check is evaluated afterwards only for the surviving (point, T_start) hypotheses.
"""
import numpy as np

from .doppler import emission_time, audible_radius, C_DEFAULT

KEY = 1.0e6   # > any time span in seconds inside one day window


def pass_records(tracks, flight_idx, obs, r_max, c=C_DEFAULT, dt=2.0, chunk=4096):
    """Local CPA passes with d < r_max. Returns dict of arrays: n, f, t_cpa, d, speed, t_dcpa."""
    out = {k: [] for k in ("n", "f", "t_cpa", "d", "speed")}
    oo = np.sum(obs * obs, 1)
    for f in flight_idx:
        tr = tracks[f]
        ts = np.arange(tr.t0, tr.t1 + 1e-9, dt)
        if ts.size < 3:
            continue
        P, _, _ = tr.eval(ts)
        # cheap spatial prefilter: points within r_max of the track's horizontal bounding box
        lo, hi = P[:, :2].min(0) - r_max, P[:, :2].max(0) + r_max
        cand = np.nonzero((obs[:, 0] > lo[0]) & (obs[:, 0] < hi[0]) & (obs[:, 1] > lo[1]) & (obs[:, 1] < hi[1]))[0]
        if cand.size == 0:
            continue
        pp = np.sum(P * P, 1)
        for a in range(0, cand.size, chunk):
            idx = cand[a:a + chunk]
            D2 = oo[idx][:, None] - 2 * obs[idx] @ P.T + pp[None, :]
            loc = (D2[:, 1:-1] < D2[:, :-2]) & (D2[:, 1:-1] <= D2[:, 2:]) & (D2[:, 1:-1] < r_max * r_max)
            r, k = np.nonzero(loc)
            if r.size == 0:
                continue
            k = k + 1
            y0, y1, y2 = D2[r, k - 1], D2[r, k], D2[r, k + 1]
            den = y0 - 2 * y1 + y2
            off = np.clip(np.where(den > 0, 0.5 * (y0 - y2) / np.where(den > 0, den, 1), 0.0), -1, 1)
            tc = ts[k] + off * dt
            p, v, _ = tr.eval(tc)
            out["n"].append(idx[r]); out["f"].append(np.full(r.size, f)); out["t_cpa"].append(tc)
            out["d"].append(np.linalg.norm(obs[idx[r]] - p, axis=1)); out["speed"].append(np.linalg.norm(v, axis=1))
    rec = {k: (np.concatenate(v) if v else np.zeros(0)) for k, v in out.items()}
    rec["n"] = rec["n"].astype(np.int64); rec["f"] = rec["f"].astype(np.int64)
    rec["t_dcpa"] = rec["t_cpa"] + rec["d"] / c
    return rec


def pair_join(rec, events, tol):
    """Two-event join: event 0 record A and event 1 record B at the same point with
    |(tB - tA) - (ta1 - ta0)| <= tol and both passing their v/d ranges. Returns arrays (iA, iB)."""
    def ok(ev):
        return ((rec["speed"] >= ev["v_mps"][0]) & (rec["speed"] <= ev["v_mps"][1])
                & (rec["d"] >= ev["cpa_m"][0]) & (rec["d"] <= ev["cpa_m"][1]))
    A = np.nonzero(ok(events[0]))[0]
    B = np.nonzero(ok(events[1]))[0]
    t_ref = min(rec["t_dcpa"].min(), 0) if rec["t_dcpa"].size else 0
    kB = rec["n"][B] * KEY + (rec["t_dcpa"][B] - t_ref)
    o = np.argsort(kB)
    B, kB = B[o], kB[o]
    off = events[1]["t_cpa_audio"] - events[0]["t_cpa_audio"]
    kA = rec["n"][A] * KEY + (rec["t_dcpa"][A] - t_ref) + off
    lo = np.searchsorted(kB, kA - tol, "left")
    hi = np.searchsorted(kB, kA + tol, "right")
    cnt = hi - lo
    iA = np.repeat(A, cnt)
    within = np.arange(cnt.sum()) - np.repeat(np.cumsum(cnt) - cnt, cnt)
    iB = B[np.repeat(lo, cnt) + within]
    keep = rec["f"][iA] != rec["f"][iB]
    return iA[keep], iB[keep]


def silence_counts(tracks, obs_s, T_s, duration, matched, c=C_DEFAULT, table=None, margin=0.0):
    """For each hypothesis s (observer obs_s[s], recording [T_s, T_s+duration]) count flights other than
    matched[s] whose (global-in-window) CPA is audible (d < audible radius by category) inside the clip."""
    S = len(T_s)
    count = np.zeros(S, int)
    who = [[] for _ in range(S)]
    t0s = np.array([t.t0 for t in tracks]); t1s = np.array([t.t1 for t in tracks])
    for f, tr in enumerate(tracks):
        sel = np.nonzero((t1s[f] >= T_s - 120) & (t0s[f] <= T_s + duration + 120))[0]
        if sel.size == 0:
            continue
        R = audible_radius(tr.category, table)
        ts = np.arange(tr.t0, tr.t1 + 1e-9, 1.0)
        P, _, _ = tr.eval(ts)
        for s in sel:
            if f in matched[s]:
                continue
            te = ts[(ts >= T_s[s] - R / c - 5) & (ts <= T_s[s] + duration)]
            if te.size == 0:
                continue
            Q = P[(ts >= T_s[s] - R / c - 5) & (ts <= T_s[s] + duration)]
            dd = np.linalg.norm(Q - obs_s[s], axis=1)
            trx = te + dd / c
            m = (dd < R) & (trx >= T_s[s] + margin) & (trx <= T_s[s] + duration - margin)
            if m.any():
                count[s] += 1
                who[s].append((tr.id, float(dd[m].min()), float(trx[m][np.argmin(dd[m])] - T_s[s])))
    return count, who


def ridge_samples(ridges, event, step=1.0):
    """Lane C ridges.json -> (t_k on an integer `step` grid, f_k fundamental-equivalent, weight_k)."""
    T, F, W = [], [], []
    for r in ridges:
        if r["event"] != event:
            continue
        p = np.asarray(r["points"], float)
        T.append(p[:, 0]); F.append(p[:, 1] / r["harmonic"]); W.append(np.clip(np.asarray(r["snr_db"], float), 0.5, None))
    T, F, W = np.concatenate(T), np.concatenate(F), np.concatenate(W)
    k = np.round(T / step).astype(int)
    out_t, out_f, out_w = [], [], []
    for kk in np.unique(k):
        m = k == kk
        out_t.append(kk * step); out_f.append(np.median(F[m])); out_w.append(W[m].sum())
    return np.array(out_t), np.array(out_f), np.array(out_w)


def ridge_residuals(tracks, rec, idx, obs, t_k, f_k, w_k, ta, s_grid, c=C_DEFAULT, chunk=2000, cap=0.03):
    """For records idx (one event with nominal audio time ta) compute the weighted RMS of
    log(f_obs) - log(F0 * ratio) after the best F0, for every time shift s in s_grid (integer seconds):
    predicted receive time t_rx = t_dcpa + (t_audio - ta) + s.  Returns (rms[len(idx), len(s)], logF0[...])."""
    s_grid = np.asarray(s_grid, int)
    lo, hi = int(t_k.min()) + s_grid.min(), int(t_k.max()) + s_grid.max()
    tg = np.arange(lo, hi + 1, dtype=float)                 # audio-time grid (1 s)
    kpos = (t_k - lo).astype(int)                            # index of ridge sample in tg (for s = 0 offset)
    lf = np.log(f_k)
    w = w_k / w_k.sum()
    rms = np.full((len(idx), len(s_grid)), np.inf, np.float32)
    lF0 = np.zeros((len(idx), len(s_grid)), np.float32)
    fl = rec["f"][idx]
    for f in np.unique(fl):
        sel = np.nonzero(fl == f)[0]
        tr = tracks[f]
        for a in range(0, sel.size, chunk):
            s = sel[a:a + chunk]
            i = idx[s]
            t_rx = rec["t_dcpa"][i][:, None] + (tg[None, :] - ta)
            _, R, vr, valid = emission_time(tr, obs[rec["n"][i]][:, None, :], t_rx, c)
            lr = np.where(valid, np.log(c / (c - vr)), np.nan)
            for j, sh in enumerate(s_grid):
                L = lr[:, kpos + sh]          # (n, K)
                d = lf[None, :] - L
                ok = np.isfinite(d)
                ww = np.where(ok, w[None, :], 0.0)
                cover = ww.sum(1)
                m = np.where(ok, d, 0.0)
                mu = (m * ww).sum(1) / np.maximum(cover, 1e-12)
                e = np.minimum(np.abs(np.where(ok, d - mu[:, None], 0.0)), cap)
                r = np.sqrt((e * e * ww).sum(1) / np.maximum(cover, 1e-12))
                r = np.where(cover > 0.8, r, np.inf)          # need the track to cover 80 % of the ridge
                rms[s, j] = r
                lF0[s, j] = mu
    return rms, lF0
