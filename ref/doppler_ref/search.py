"""End-to-end grid search (method stages 3-6).

Stage 3: grid of ground points (spacing, within `radius` of candidate tracks), DEM elevation,
         per (point, flight): CPA time, slant CPA distance, speed at CPA, delayed CPA time.
Stage 4: filters: speed/CPA-range per event, time-offset (anchor event 0 fixes T_start),
         silence (no unmatched audible flight inside the recording).
Stage 5: physical Doppler curve from the real track (retarded time, exact Doppler).
Stage 6: multi-harmonic score on the whitened spectrogram, sweeping T_start (shared) and F0 (per event),
         then coarse-to-fine refinement around the best distinct candidates.
"""
import time
from dataclasses import dataclass, field

import numpy as np
from scipy.spatial import cKDTree

from .doppler import cpa, emission_time, audible_radius, AUDIBLE_R
from .spectrogram import whiten, curve_score


@dataclass
class Config:
    c: float = 343.0
    spacing: float = 200.0
    radius: float = 10000.0           # keep grid points within this horizontal distance of a candidate track
    box_half: float = 12000.0         # search square half-size around the centre
    offset_tol: float = 8.0           # s, time-offset filter tolerance
    audible: dict = field(default_factory=lambda: dict(AUDIBLE_R))
    candidate_categories: tuple = ("prop", "unknown", "heli")
    harmonics: tuple = (1, 2, 3, 4)
    tau_half: float = 60.0            # curve window around delayed CPA (s)
    tau_step: float = 0.5
    delta_half: float = 4.0           # T_start sweep (s)
    delta_step: float = 0.5
    f0_rel: float = 0.04              # F0 sweep +-
    f0_step: float = 0.005
    top_k: int = 6
    refine: tuple = ((100.0, 400.0, 0.25, 1.5, 0.25, 0.015, 0.0025), (50.0, 150.0, 0.25, 1.0, 0.125, 0.01, 0.0025))
    # each refine level: (spacing, half_size, tau_step, delta_half, delta_step, f0_rel, f0_step);
    # sweeps are re-centred on the previous level's best T_start and F0s
    use_vd_filter: bool = True
    use_offset_filter: bool = True    # if False: every candidate flight combination is scored (slow)
    use_silence_filter: bool = True
    t_start_prior: tuple = None       # optional (T_center_unix, half_width_s), e.g. from video metadata
    chunk: int = 16
    min_audible_s: float = 20.0       # curves with a shorter audible window score 0 (kills short-curve artefacts)
    score_norm: str = "mean"          # "mean" | "sqrtN" (see spectrogram.curve_score)


def make_grid(enu, dem, center_enu, half, spacing, keep_tree=None, radius=None):
    ax = np.arange(-half, half + 1e-6, spacing)
    X, Y = np.meshgrid(center_enu[0] + ax, center_enu[1] + ax, indexing="xy")
    xy = np.stack([X.ravel(), Y.ravel()], 1)
    if keep_tree is not None:
        dist, _ = keep_tree.query(xy)
        xy = xy[dist <= radius]
    lat, lon, _ = enu.inv(np.column_stack([xy, np.zeros(len(xy))]))
    elev = dem(lat, lon)
    obs = enu.fwd(lat, lon, elev)
    return {"obs": obs, "lat": lat, "lon": lon, "elev": elev, "xy": xy, "shape": X.shape, "ax": ax}


def flight_tables(tracks, obs, c):
    F = len(tracks)
    tab = {k: np.empty((F, len(obs))) for k in ("t_cpa", "d_cpa", "speed", "t_dcpa")}
    for i, tr in enumerate(tracks):
        r = cpa(tr, obs, c)
        for k in tab:
            tab[k][i] = r[k]
    return tab


def apply_filters(tracks, tab, events, duration, cfg):
    """Return survivors: list of (n, assigned_flights[E], T_start)."""
    E = len(events)
    F, N = tab["d_cpa"].shape
    cats = [t.category for t in tracks]
    cand = np.array([c in cfg.candidate_categories for c in cats])
    ok = np.zeros((E, F, N), bool)
    for e, ev in enumerate(events):
        m = np.broadcast_to(cand[:, None], (F, N)).copy()
        if cfg.use_vd_filter:
            m &= (tab["speed"] >= ev["v_mps"][0]) & (tab["speed"] <= ev["v_mps"][1])
            m &= (tab["d_cpa"] >= ev["cpa_m"][0]) & (tab["d_cpa"] <= ev["cpa_m"][1])
        ok[e] = m
    raud = np.array([audible_radius(c, cfg.audible) for c in cats])
    audible = tab["d_cpa"] < raud[:, None]
    ta = np.array([ev["t_cpa_audio"] for ev in events])
    out_n, out_a, out_T = [], [], []
    for A in range(F):
        alive = ok[0, A].copy()
        if not alive.any():
            continue
        T = tab["t_dcpa"][A] - ta[0]
        assign = np.full((E, N), -1)
        assign[0] = A
        used = np.zeros((F, N), bool)
        used[A] = True
        for e in range(1, E):
            resid = np.abs(tab["t_dcpa"] - T[None, :] - ta[e])
            tol = cfg.offset_tol if cfg.use_offset_filter else 1e9  # off: closest-in-time flight
            valid = ok[e] & ~used & (resid <= tol)
            r = np.where(valid, resid, np.inf)
            best = np.argmin(r, axis=0)
            has = np.isfinite(r[best, np.arange(N)])
            alive &= has
            assign[e] = np.where(has, best, -1)
            used[best[has], np.nonzero(has)[0]] = True
        if cfg.t_start_prior is not None:
            alive &= np.abs(T - cfg.t_start_prior[0]) <= cfg.t_start_prior[1]
        if cfg.use_silence_filter:
            inrec = (tab["t_dcpa"] >= T[None, :]) & (tab["t_dcpa"] <= T[None, :] + duration)
            loud = audible & inrec & ~used
            alive &= ~loud.any(axis=0)
        idx = np.nonzero(alive)[0]
        out_n.append(idx)
        out_a.append(assign[:, idx].T)
        out_T.append(T[idx])
    if not out_n:
        return np.zeros(0, int), np.zeros((0, E), int), np.zeros(0)
    return np.concatenate(out_n), np.concatenate(out_a), np.concatenate(out_T)


def score_survivors(tracks, tab, obs, events, surv, Z, spec, cfg, tau_step, delta_half, delta_step, f0_rel, f0_step):
    sn, sa, sT = surv
    S = len(sn)
    E = len(events)
    tau = np.arange(-cfg.tau_half, cfg.tau_half + 1e-9, tau_step)
    delta = np.arange(-delta_half, delta_half + 1e-9, delta_step)
    rho = np.arange(-f0_rel, f0_rel + 1e-9, f0_step)
    per_event = np.zeros((E, S, len(delta)))
    per_event_rho = np.zeros((E, S, len(delta)), int)
    for e, ev in enumerate(events):
        F0s = ev["F0"] * (1 + rho)
        for f in np.unique(sa[:, e]):
            sel = np.nonzero(sa[:, e] == f)[0]
            tr = tracks[f]
            raud = audible_radius(tr.category, cfg.audible)
            for a in range(0, len(sel), cfg.chunk):
                s = sel[a:a + cfg.chunk]
                n = sn[s]
                t_rx = tab["t_dcpa"][f, n][:, None] + tau[None, :]
                te, R, vr, valid = emission_time(tr, obs[n][:, None, :], t_rx, cfg.c)
                ratio = cfg.c / (cfg.c - vr)
                w = ((R < raud) & valid).astype(float)
                w[w.sum(axis=1) * tau_step < cfg.min_audible_s] = 0.0
                t_aud = (t_rx - sT[s][:, None])[:, None, None, :] - delta[None, :, None, None]
                sc = curve_score(Z, spec, t_aud, ratio[:, None, None, :], F0s[None, None, :, None],
                                 cfg.harmonics, w[:, None, None, :], cfg.score_norm)  # (s, nd, nr)
                per_event[e, s] = sc.max(axis=2)
                per_event_rho[e, s] = sc.argmax(axis=2)
    tot = per_event.sum(axis=0)
    bd = tot.argmax(axis=1)
    r = np.arange(S)
    return {"score": tot[r, bd], "delta": delta[bd], "T_start": sT + delta[bd],
            "F0": np.array([events[e]["F0"] * (1 + rho[per_event_rho[e, r, bd]]) for e in range(E)]).T,
            "event_scores": per_event[:, r, bd].T}


def _pick_distinct(xy, order, k, min_sep):
    chosen = []
    for i in order:
        if all(np.hypot(*(xy[i] - xy[j])) >= min_sep for j in chosen):
            chosen.append(i)
        if len(chosen) >= k:
            break
    return chosen


def run_search(tracks, dem, events, spec, enu, center_latlon, duration, cfg=None, log=print):
    cfg = cfg or Config()
    timings = {}
    t0 = time.perf_counter()
    Z = whiten(spec)
    timings["whiten"] = time.perf_counter() - t0

    # Stage 2: candidate filter (category) -> grid support
    cand_tracks = [t for t in tracks if t.category in cfg.candidate_categories]
    pts = np.concatenate([t.eval(np.arange(t.t0, t.t1, 5.0))[0][:, :2] for t in cand_tracks])
    tree = cKDTree(pts)
    c_enu = enu.fwd(center_latlon[0], center_latlon[1], 0.0)

    # Stage 3
    t0 = time.perf_counter()
    grid = make_grid(enu, dem, c_enu, cfg.box_half, cfg.spacing, tree, cfg.radius)
    tab = flight_tables(tracks, grid["obs"], cfg.c)
    timings["stage3_grid_cpa"] = time.perf_counter() - t0
    N = len(grid["obs"])

    # Stage 4
    t0 = time.perf_counter()
    surv = apply_filters(tracks, tab, events, duration, cfg)
    timings["stage4_filters"] = time.perf_counter() - t0
    log(f"coarse grid: {N} points x {len(tracks)} flights; survivors (point,assignment): {len(surv[0])}")

    # Stage 5-6 on coarse grid
    t0 = time.perf_counter()
    res = score_survivors(tracks, tab, grid["obs"], events, surv, Z, spec, cfg,
                          cfg.tau_step, cfg.delta_half, cfg.delta_step, cfg.f0_rel, cfg.f0_step)
    timings["stage56_coarse_score"] = time.perf_counter() - t0
    coarse_map = np.full(N, np.nan)
    if len(surv[0]):
        np.fmax.at(coarse_map, surv[0], res["score"])
    coarse = {"grid": grid, "surv": surv, "res": res, "map": coarse_map}

    # Refinement levels
    t0 = time.perf_counter()
    best = None
    seeds_xy = None
    if len(surv[0]):
        order = np.argsort(-res["score"])
        idx = _pick_distinct(grid["xy"][surv[0]], order, cfg.top_k, 2 * cfg.refine[0][1])
        seeds_xy = grid["xy"][surv[0][idx]]
        i0 = order[0]
        # re-centre: common time shift and per-event F0 from the coarse best
        events = [dict(ev, t_cpa_audio=ev["t_cpa_audio"] - res["delta"][i0], F0=float(res["F0"][i0, e]))
                  for e, ev in enumerate(events)]
    levels = []
    for (sp, half, ts, dh, ds, fr, fs_) in cfg.refine:
        if seeds_xy is None:
            break
        obs_l, lat_l, lon_l, el_l, xy_l = [], [], [], [], []
        for sxy in seeds_xy:
            g = make_grid(enu, dem, np.array([sxy[0], sxy[1]]), half, sp)
            obs_l.append(g["obs"]); lat_l.append(g["lat"]); lon_l.append(g["lon"])
            el_l.append(g["elev"]); xy_l.append(g["xy"])
        g = {"obs": np.concatenate(obs_l), "lat": np.concatenate(lat_l), "lon": np.concatenate(lon_l),
             "elev": np.concatenate(el_l), "xy": np.concatenate(xy_l)}
        tab_r = flight_tables(tracks, g["obs"], cfg.c)
        surv_r = apply_filters(tracks, tab_r, events, duration, cfg)
        if not len(surv_r[0]):
            break
        rr = score_survivors(tracks, tab_r, g["obs"], events, surv_r, Z, spec, cfg, ts, dh, ds, fr, fs_)
        order = np.argsort(-rr["score"])
        idx = _pick_distinct(g["xy"][surv_r[0]], order, max(1, cfg.top_k // 2), 2 * half)
        seeds_xy = g["xy"][surv_r[0][idx]]
        i = order[0]
        events = [dict(ev, t_cpa_audio=ev["t_cpa_audio"] - rr["delta"][i], F0=float(rr["F0"][i, e]))
                  for e, ev in enumerate(events)]
        n = surv_r[0][i]
        best = {"lat": float(g["lat"][n]), "lon": float(g["lon"][n]), "elev_m": float(g["elev"][n]),
                "score": float(rr["score"][i]), "flights": [tracks[f].id for f in surv_r[1][i]],
                "t_start_unix": float(rr["T_start"][i]), "F0": [float(x) for x in rr["F0"][i]],
                "event_scores": [float(x) for x in rr["event_scores"][i]], "xy": g["xy"][n].tolist()}
        cands = []
        for j in idx:
            nn = surv_r[0][j]
            cands.append({"lat": float(g["lat"][nn]), "lon": float(g["lon"][nn]),
                          "elev_m": float(g["elev"][nn]), "score": float(rr["score"][j]),
                          "flights": [tracks[f].id for f in surv_r[1][j]],
                          "t_start_unix": float(rr["T_start"][j]), "xy": g["xy"][nn].tolist()})
        levels.append({"spacing": sp, "n_points": len(g["obs"]), "n_surv": len(surv_r[0]),
                       "best": best, "candidates": cands})
    timings["refine"] = time.perf_counter() - t0
    return {"best": best, "levels": levels, "coarse": coarse, "timings": timings,
            "n_grid": N, "n_surv": int(len(surv[0]))}


def score_point(tracks, flight_idx, obs, T_start, F0s, Z, spec, cfg=None, tau_step=None):
    """Score a single hypothesis (no sweep): observer obs[3], flights (one per event), T_start, F0 per event.

    For each event: tau grid [-tau_half, tau_half] step tau_step around the flight's delayed CPA time at obs,
    exact Doppler ratio from the retarded-time solver, weight = (R < audible radius) & track-valid,
    score_e = curve_score(...) over cfg.harmonics; total = sum_e score_e.  Returns (total, [score_e]).
    """
    cfg = cfg or Config()
    tau_step = tau_step or cfg.tau_step
    tau = np.arange(-cfg.tau_half, cfg.tau_half + 1e-9, tau_step)
    obs = np.asarray(obs, float)
    out = []
    for f, F0 in zip(flight_idx, F0s):
        tr = tracks[f]
        t_dcpa = cpa(tr, obs[None, :], cfg.c)["t_dcpa"][0]
        t_rx = t_dcpa + tau
        te, R, vr, valid = emission_time(tr, obs, t_rx, cfg.c)
        w = ((R < audible_radius(tr.category, cfg.audible)) & valid).astype(float)
        if w.sum() * tau_step < cfg.min_audible_s:
            w[:] = 0.0
        out.append(float(curve_score(Z, spec, t_rx - T_start, cfg.c / (cfg.c - vr), F0, cfg.harmonics, w,
                                     cfg.score_norm)))
    return sum(out), out
