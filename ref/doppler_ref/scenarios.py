"""Synthetic scenario generator: analytic DEM, kinematic tracks, ADS-B-like sampling, audio, events.

Analytic DEM (JS-reproducible), local equirectangular coordinates about dem.ref = [lat0, lon0]:
  x = 6371000*cos(lat0)*rad(lon-lon0),  y = 6371000*rad(lat-lat0)
  elev = base + sum_i h_i*exp(-((x-x_i)^2+(y-y_i)^2)/(2*s_i^2)) + wave[0]*sin(x/wave[1])*cos(y/wave[2])
"""
import json
import os

import numpy as np

from .geo import ENU
from .track import Track
from .doppler import cpa, C_DEFAULT
from .synth import synth_scene, write_wav

R_SPH = 6371000.0


def make_dem(p):
    lat0, lon0 = p["ref"]

    def dem(lat, lon):
        lat = np.asarray(lat, float)
        lon = np.asarray(lon, float)
        x = R_SPH * np.cos(np.radians(lat0)) * np.radians(lon - lon0)
        y = R_SPH * np.radians(lat - lat0)
        z = np.full(np.broadcast(x, y).shape, float(p["base"]))
        for (xi, yi, h, s) in p["hills"]:
            z = z + h * np.exp(-((x - xi) ** 2 + (y - yi) ** 2) / (2 * s * s))
        a, lx, ly = p["wave"]
        return z + a * np.sin(x / lx) * np.cos(y / ly)
    return dem


def kinematic_path(v0, hdg0_deg, alt0, segments, dt=0.1):
    """segments: [(duration_s, turn_rate_deg_s, accel_mps2, climb_mps), ...]. Returns t, xyz (rel. start)."""
    t, x, y, z, v, h = 0.0, 0.0, 0.0, alt0, v0, np.radians(hdg0_deg)
    T, P = [0.0], [(0.0, 0.0, alt0)]
    for (dur, tr, acc, climb) in segments:
        for _ in range(int(round(dur / dt))):
            h += np.radians(tr) * dt
            v += acc * dt
            x += v * np.sin(h) * dt   # heading clockwise from north
            y += v * np.cos(h) * dt
            z += climb * dt
            t += dt
            T.append(t)
            P.append((x, y, z))
    return np.array(T), np.array(P)


def place_path(T, P, t_anchor_rel, anchor_xy, lateral_m, t_anchor_unix):
    """Shift path so that at t_anchor_rel it is `lateral_m` to the right of anchor_xy, at t_anchor_unix."""
    i = int(np.argmin(np.abs(T - t_anchor_rel)))
    d = P[min(i + 1, len(P) - 1), :2] - P[max(i - 1, 0), :2]
    d /= np.linalg.norm(d)
    right = np.array([d[1], -d[0]])
    target = np.asarray(anchor_xy) + lateral_m * right
    Q = P.copy()
    Q[:, :2] += target - P[i, :2]
    return T - T[i] + t_anchor_unix, Q


def adsb_sample(Tu, Q, rng, dt_range=(1.0, 5.0), pos_noise=3.0, alt_quant_ft=25.0, gaps=()):
    ts = [Tu[0]]
    while ts[-1] < Tu[-1]:
        ts.append(ts[-1] + rng.uniform(*dt_range))
    ts = np.array(ts[:-1])
    for (g0, g1) in gaps:
        ts = ts[(ts < g0) | (ts > g1)]
    xyz = np.column_stack([np.interp(ts, Tu, Q[:, k]) for k in range(3)])
    xyz[:, :2] += rng.normal(0, pos_noise, (len(ts), 2))
    q = alt_quant_ft * 0.3048
    xyz[:, 2] = np.round(xyz[:, 2] / q) * q
    return ts, xyz


def to_contract(fid, icao, callsign, typ, cat, ts, xyz, enu):
    lat, lon, h = enu.inv(xyz)
    return {"id": fid, "icao24": icao, "callsign": callsign, "type": typ, "category": cat,
            "points": [[round(float(t), 3), round(float(a), 7), round(float(b), 7), round(float(c), 1)]
                       for t, a, b, c in zip(ts, lat, lon, h)]}


def measure_events(truth_events, seed, t_err=3.0, f_err=0.02, v_err=0.15, d_err=0.30,
                   v_range=(0.8, 1.25), d_range=(0.7, 1.5)):
    """Simulate a human reading the spectrogram: uniform errors, then generous [min,max] ranges."""
    erng = np.random.default_rng(seed)
    out = []
    for te in truth_events:
        v_est = te["v_mps"] * (1 + erng.uniform(-v_err, v_err))
        d_est = te["cpa_m"] * (1 + erng.uniform(-d_err, d_err))
        out.append({"t_cpa_audio": round(te["t_cpa_audio"] + erng.uniform(-t_err, t_err), 2),
                    "F0": round(te["F0"] * (1 + erng.uniform(-f_err, f_err)), 2),
                    "v_mps": [round(v_est * v_range[0], 1), round(v_est * v_range[1], 1)],
                    "cpa_m": [round(d_est * d_range[0]), round(d_est * d_range[1])],
                    "_point_estimates": {"v": round(v_est, 1), "d": round(d_est)}})
    return out


def build_scenario(cfg, out_dir, fs=8000, write_audio=True):
    """cfg: dict (see SCENARIOS). Writes tracks.json, truth.json, events_measured.json, scenario.json, audio.wav."""
    rng = np.random.default_rng(cfg["seed"])
    lat0, lon0 = cfg["ref"]
    enu = ENU(lat0, lon0, 0.0)
    dem = make_dem(cfg["dem"])
    ox, oy = cfg["observer_xy"]
    olat, olon, _ = enu.inv(np.array([ox, oy, 0.0]))
    oel = float(dem(olat, olon))
    obs = enu.fwd(olat, olon, oel)
    T_start = cfg["T_start"]
    tracks_json, sources, dense = [], [], {}
    for f in cfg["flights"]:
        T, P = kinematic_path(f["v0"], f["hdg"], f["alt"], f["segments"])
        Tu, Q = place_path(T, P, f["t_anchor_rel"], (ox, oy), f["lateral"], T_start + f["t_anchor_audio"])
        ts, xyz = adsb_sample(Tu, Q, rng, gaps=[(T_start + a, T_start + b) for a, b in f.get("gaps", [])])
        tj = to_contract(f["id"], f["icao24"], f.get("callsign"), f["type"], f["category"], ts, xyz, enu)
        tracks_json.append(tj)
        # dense "true" path -> Track for audio synthesis
        k = slice(None, None, 5)  # 0.5 s
        la, lo, hh = enu.inv(Q[k])
        dtr = Track({"id": f["id"], "category": f["category"],
                     "points": np.column_stack([Tu[k], la, lo, hh]).tolist()}, enu)
        dense[f["id"]] = dtr
        sources.append({"track": dtr, "F0": f["F0"], "category": f["category"], "level": f.get("level", 1.0)})
    duration = cfg["duration"]
    truth_events = []
    for fid in cfg["event_flights"]:
        r = cpa(dense[fid], obs[None, :], C_DEFAULT, dt=0.1)
        F0 = [f["F0"] for f in cfg["flights"] if f["id"] == fid][0]
        truth_events.append({"flight": fid, "t_cpa_audio": float(r["t_dcpa"][0] - T_start), "F0": F0,
                             "v_mps": float(r["speed"][0]), "cpa_m": float(r["d_cpa"][0])})
    # all flights' CPA at truth (for documentation / silence check)
    all_cpa = {}
    for fid, tr in dense.items():
        r = cpa(tr, obs[None, :], C_DEFAULT, dt=0.25)
        all_cpa[fid] = {"t_dcpa_audio": float(r["t_dcpa"][0] - T_start), "d_cpa": float(r["d_cpa"][0])}
    measured = measure_events(truth_events, cfg["seed"] + 1000)
    os.makedirs(out_dir, exist_ok=True)
    truth = {"observer": {"lat": float(olat), "lon": float(olon), "elev_m": oel, "enu": obs.tolist()},
             "t_start_unix": T_start, "duration_s": duration, "events": truth_events, "all_flights_cpa": all_cpa,
             "c": C_DEFAULT}
    scen = {"name": cfg["name"], "ref": cfg["ref"], "search_center": cfg["search_center"],
            "dem": cfg["dem"], "fs": fs, "duration_s": duration, "c": C_DEFAULT,
            "notes": cfg.get("notes", "")}
    for name, obj in (("tracks.json", tracks_json), ("truth.json", truth),
                      ("events_measured.json", measured), ("scenario.json", scen)):
        with open(os.path.join(out_dir, name), "w") as fh:
            json.dump(obj, fh, indent=1 if name != "tracks.json" else None)
    x = None
    if write_audio:
        x = synth_scene(sources, obs, T_start, duration, fs, cfg.get("c_audio", C_DEFAULT),
                        noise_level=cfg.get("noise_level", 1.0), seed=cfg["seed"], wind=cfg.get("wind"))
        write_wav(os.path.join(out_dir, "audio.wav"), x, fs)
    return {"enu": enu, "dem": dem, "obs": obs, "truth": truth, "measured": measured, "tracks": tracks_json,
            "audio": x, "dense": dense}


def _seg(*s):
    return [tuple(x) for x in s]


SCENARIOS = {
    "scenario1": {
        "name": "scenario1", "seed": 11, "ref": [40.80, -72.90], "T_start": 1717243200.0, "duration": 1150.0,
        "observer_xy": [1500.0, -700.0], "search_center": [40.812, -72.870], "noise_level": 1.0,
        "notes": "Two prop events ~920 s apart (as in the video), hill terrain, distractors incl. a jet.",
        "dem": {"ref": [40.80, -72.90], "base": 40.0,
                "hills": [[1800.0, -500.0, 180.0, 1500.0], [-4000.0, 3000.0, 120.0, 2500.0], [6000.0, 4000.0, 90.0, 2000.0]],
                "wave": [25.0, 900.0, 1300.0]},
        "event_flights": ["P1", "P2"],
        "flights": [
            {"id": "P1", "icao24": "a1b2c3", "callsign": "N172AB", "type": "C172", "category": "prop", "F0": 128.0,
             "v0": 56.0, "hdg": 20.0, "alt": 610.0, "t_anchor_rel": 300.0, "t_anchor_audio": 100.0, "lateral": 650.0,
             "segments": _seg((200, 0, 0, 0), (25, 1.6, 0, 0), (150, 0, 0.02, 0), (100, -0.8, 0, 2.0), (300, 0, 0, 0))},
            {"id": "P2", "icao24": "b2c3d4", "callsign": "N28PA", "type": "PA28", "category": "prop", "F0": 112.0,
             "v0": 50.0, "hdg": 170.0, "alt": 880.0, "t_anchor_rel": 280.0, "t_anchor_audio": 1020.0, "lateral": -1100.0,
             "segments": _seg((150, 0, 0, 0), (200, 0, 0.05, -1.0), (40, 2.0, 0, 0), (300, 0, 0, 0))},
            {"id": "P3", "icao24": "c3d4e5", "callsign": "N3DX", "type": "SR22", "category": "prop", "F0": 95.0,
             "v0": 75.0, "hdg": 290.0, "alt": 1100.0, "t_anchor_rel": 300.0, "t_anchor_audio": 520.0, "lateral": 5500.0,
             "segments": _seg((600, 0, 0, 0))},
            {"id": "P4", "icao24": "d4e5f6", "callsign": "N44D", "type": "C152", "category": "prop", "F0": 140.0,
             "v0": 48.0, "hdg": 95.0, "alt": 450.0, "t_anchor_rel": 300.0, "t_anchor_audio": -1500.0, "lateral": 400.0,
             "segments": _seg((300, 0, 0, 0), (60, 3.0, 0, 0), (300, 0, 0, 0))},
            {"id": "P5", "icao24": "e5f6a7", "callsign": "N5E", "type": "BE36", "category": "prop", "F0": 105.0,
             "v0": 70.0, "hdg": 240.0, "alt": 1500.0, "t_anchor_rel": 300.0, "t_anchor_audio": 760.0, "lateral": -4200.0,
             "segments": _seg((600, 0, 0, 0))},
            {"id": "J1", "icao24": "f6a7b8", "callsign": "JBU123", "type": "A320", "category": "jet", "F0": 2200.0,
             "v0": 160.0, "hdg": 45.0, "alt": 3500.0, "t_anchor_rel": 200.0, "t_anchor_audio": 650.0, "lateral": 9000.0,
             "segments": _seg((400, 0, 0, 8.0))},
        ],
    },
    "scenario2": {
        "name": "scenario2", "seed": 22, "ref": [46.50, 7.90], "T_start": 1720000000.0, "duration": 720.0,
        "observer_xy": [-800.0, 1200.0], "search_center": [46.505, 7.880], "noise_level": 1.0,
        "notes": "Three prop events in a hilly valley (observer on a slope), track gap, a jet and prop distractors.",
        "dem": {"ref": [46.50, 7.90], "base": 600.0,
                "hills": [[-2500.0, 2500.0, 450.0, 2200.0], [3000.0, -1500.0, 600.0, 3000.0], [500.0, 6000.0, 300.0, 2500.0]],
                "wave": [40.0, 1200.0, 800.0]},
        "event_flights": ["Q1", "Q2", "Q3"],
        "flights": [
            {"id": "Q1", "icao24": "aa0001", "callsign": "HBABC", "type": "DR40", "category": "prop", "F0": 122.0,
             "v0": 52.0, "hdg": 80.0, "alt": 1400.0, "t_anchor_rel": 250.0, "t_anchor_audio": 70.0, "lateral": 450.0,
             "segments": _seg((150, 0, 0, 0), (60, -1.5, 0, 1.5), (300, 0, -0.02, 0))},
            {"id": "Q2", "icao24": "aa0002", "callsign": "HBXYZ", "type": "P28A", "category": "prop", "F0": 104.0,
             "v0": 60.0, "hdg": 200.0, "alt": 1800.0, "t_anchor_rel": 300.0, "t_anchor_audio": 360.0, "lateral": 900.0,
             "gaps": [[330.0, 342.0]],
             "segments": _seg((300, 0, 0, -2.0), (80, 1.2, 0.03, 0), (300, 0, 0, 0))},
            {"id": "Q3", "icao24": "aa0003", "callsign": "HBQQ", "type": "C182", "category": "prop", "F0": 136.0,
             "v0": 64.0, "hdg": 320.0, "alt": 1600.0, "t_anchor_rel": 300.0, "t_anchor_audio": 610.0, "lateral": -700.0,
             "segments": _seg((250, 0, 0, 0), (50, 2.2, 0, 0), (300, 0, 0, 1.0))},
            {"id": "Q4", "icao24": "aa0004", "callsign": "HBDIS", "type": "C172", "category": "prop", "F0": 118.0,
             "v0": 55.0, "hdg": 10.0, "alt": 1500.0, "t_anchor_rel": 300.0, "t_anchor_audio": 220.0, "lateral": 5000.0,
             "segments": _seg((600, 0, 0, 0))},
            {"id": "Q5", "icao24": "aa0005", "callsign": None, "type": None, "category": "unknown", "F0": 100.0,
             "v0": 45.0, "hdg": 135.0, "alt": 1300.0, "t_anchor_rel": 300.0, "t_anchor_audio": 2000.0, "lateral": 300.0,
             "segments": _seg((600, 0, 0, 0))},
            {"id": "J2", "icao24": "bb0001", "callsign": "SWR77", "type": "A20N", "category": "jet", "F0": 2400.0,
             "v0": 180.0, "hdg": 260.0, "alt": 6000.0, "t_anchor_rel": 200.0, "t_anchor_audio": 450.0, "lateral": 7000.0,
             "segments": _seg((400, 0, 0, 0))},
        ],
    },
}


def load_scenario(d, nperseg=4096, hop=1024, fmax=1000.0, smooth_s=15.0):
    """Load a fixtures/<scenario>/ directory -> dict ready for search.run_search."""
    from scipy.io import wavfile
    from .track import load_tracks
    from .spectrogram import spectrogram
    with open(os.path.join(d, "scenario.json")) as fh:
        scen = json.load(fh)
    with open(os.path.join(d, "truth.json")) as fh:
        truth = json.load(fh)
    with open(os.path.join(d, "events_measured.json")) as fh:
        events = json.load(fh)
    enu = ENU(scen["ref"][0], scen["ref"][1], 0.0)
    tracks = load_tracks(os.path.join(d, "tracks.json"), enu, smooth_s)
    out = {"scen": scen, "truth": truth, "events": events, "enu": enu, "dem": make_dem(scen["dem"]),
           "tracks": tracks, "duration": scen["duration_s"], "center": scen["search_center"]}
    wav = os.path.join(d, "audio.wav")
    if os.path.exists(wav):
        fs, x = wavfile.read(wav)
        out["fs"] = fs
        out["spec"] = spectrogram(x.astype(np.float64) / 32768.0, fs, nperseg, hop, fmax)
    return out
