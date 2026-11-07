"""Lane F shared helpers for the KSMO 2024-07-09 real case (uses ref/doppler_ref unmodified)."""
import glob
import json
import os
import sys

import numpy as np
from scipy.io import wavfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "ref"))
import importlib  # noqa: E402
sp = importlib.import_module("doppler_ref.spectrogram")
from doppler_ref.geo import ENU  # noqa: E402

CASE = os.path.join(ROOT, "fixtures", "real", "ksmo_2024-07-09")
OUTD = os.path.join(HERE, "out")
IMG = os.path.join(ROOT, "docs", "img")
CACHE = os.path.join(HERE, "cache")
FT = 0.3048
KT = 0.514444
ARP = (34.0158, -118.4513)      # KSMO airport reference point (meta.json)
GEOID_N = None                  # EGM96 undulation at KSMO, computed once (pyproj) and cached
BARO_OFFSET_M = 4.4             # tracks.info.json: median(geom_msl - baro) around KSMO that day
TYPES_PROP = {"C172", "M20P", "C310", "S22T", "BE33", "P28A", "S76", "GB1", "BE95", "BL8", "CRUZ", "C182", "PC12",
              "BE58", "BE20", "P46T"}

ENU0 = ENU(ARP[0], ARP[1], 0.0)


def geoid_n():
    p = os.path.join(CACHE, "geoid_ksmo.json")
    if os.path.exists(p):
        return json.load(open(p))["N"]
    os.environ.setdefault("PROJ_NETWORK", "ON")
    sys.path.insert(0, os.path.join(ROOT, "ref", "data"))
    import fetch_adsb as fa
    n = float(fa.Geoid().N(np.array([ARP[0]]), np.array([ARP[1]]))[0])
    os.makedirs(CACHE, exist_ok=True)
    json.dump({"N": n}, open(p, "w"))
    return n


# ------------------------------------------------------------------ audio / spectrogram
def load_audio():
    fs, x = wavfile.read(os.path.join(CASE, "audio.wav"))
    return fs, x.astype(np.float64) / 32768.0


def load_spec(nperseg=8192, hop=1024, fmax=1500.0):
    """16 kHz audio: 8192-pt window = 0.512 s, 1.95 Hz bins (same as ref's 4096 @ 8 kHz); hop 64 ms."""
    p = os.path.join(CACHE, f"ksmo_spec_{nperseg}_{hop}_{int(fmax)}.npz")
    if os.path.exists(p):
        z = np.load(p)
        spec = {k: (z[k].item() if z[k].ndim == 0 else z[k]) for k in z.files}
        spec["unit"] = "dB"
        return spec
    fs, x = load_audio()
    spec = sp.spectrogram(x, fs, nperseg, hop, fmax)
    os.makedirs(CACHE, exist_ok=True)
    np.savez(p, **{k: v for k, v in spec.items() if k != "unit"})
    return spec


def shot_spec(spec, t0, t1):
    """Sub-spectrogram of one shot [t0,t1) in audio time, whitened on the shot alone (each shot has its own
    background).  Returns (spec_dict with t0 = local time of first frame, Z)."""
    S = sp.as2d(spec)
    i0 = int(np.ceil((t0 - spec["t0"]) / spec["dt"]))
    i1 = int(np.floor((t1 - spec["t0"]) / spec["dt"]))
    sub = S[i0:i1 + 1]
    s = dict(spec)
    s.update(t0=spec["t0"] + i0 * spec["dt"] - t0, nT=sub.shape[0], data=sub.ravel())
    return s, sp.whiten(s)


def load_clips():
    return json.load(open(os.path.join(OUTD, "ksmo_clips.json")))


def shots():
    """All shots = description entries split at internal cuts; trims 0.6 s at each edge (cut transients)."""
    c = load_clips()
    out = []
    for k, e in enumerate(c["clips"]):
        b = [e["t_start"]] + e["internal_cuts"] + [e["t_end"]]
        for j in range(len(b) - 1):
            out.append({"entry": k, "sub": j, "reg": e["reg"], "label": e["label"], "t0": b[j] + 0.6,
                        "t1": b[j + 1] - 0.6, "id": f"{k:02d}{chr(97 + j)}_{e['reg']}"})
    return out


# ------------------------------------------------------------------ ADS-B (raw readsb traces)
def raw_points(icao):
    """Merge all cached raw traces of an aircraft (2 days x 2 feeds) into sorted point dicts."""
    pts = {}
    for p in sorted(glob.glob(os.path.join(CACHE, "ksmo_raw", f"*_{icao}.json"))):
        d = json.load(open(p))
        base = float(d["timestamp"])
        feed = "mlat" if "mlatonly" in p else "prod"
        for q in d["trace"]:
            if q[1] is None:
                continue
            t = base + q[0]
            flags = q[6] if len(q) > 6 and isinstance(q[6], int) else 0
            geom = q[10] if len(q) > 10 and isinstance(q[10], (int, float)) else None
            baro = q[3] if isinstance(q[3], (int, float)) else None
            if baro is not None and (flags & 8):
                geom, baro = (geom if geom is not None else baro), None
            src = q[9] if len(q) > 9 else None
            if isinstance(src, str) and src.startswith("tisb"):
                geom = None
            key = round(t, 2)
            if key in pts and feed == "mlat":
                continue
            pts[key] = {"t": t, "lat": q[1], "lon": q[2], "baro": baro, "geom": geom, "ground": q[3] == "ground",
                        "gs": q[4] * KT if isinstance(q[4], (int, float)) else None,
                        "trk": q[5] if isinstance(q[5], (int, float)) else None,
                        "vr": q[7] * FT / 60 if len(q) > 7 and isinstance(q[7], (int, float)) else None,
                        "src": src, "stale": bool(flags & 1)}
    return [pts[k] for k in sorted(pts)]


def to_msl(q, dem=None):
    """Altitude MSL (m): geom - N, else baro + local offset, ground -> DEM + 2 m (antenna)."""
    if q["geom"] is not None:
        return q["geom"] * FT - geoid_n(), "geom"
    if q["baro"] is not None:
        return q["baro"] * FT + BARO_OFFSET_M, "baro"
    if q["ground"] and dem is not None:
        return float(dem(q["lat"], q["lon"])) + 2.0, "ground"
    return None, None


def passes(icao, reg, typ, dem, r_max=4000.0, h_max_agl=900.0, pad=150.0, alt_bias=0.0):
    """Split an aircraft's day into 'passes' near KSMO: maximal time spans where the aircraft is within r_max
    (horizontal) of the ARP and below h_max_agl, padded by `pad` s, merged when overlapping.
    Returns list of contract-like track dicts (+ 'gs','trk','kind' arrays) with ground points kept."""
    P = raw_points(icao)
    if not P:
        return []
    t = np.array([q["t"] for q in P])
    lat = np.array([q["lat"] for q in P])
    lon = np.array([q["lon"] for q in P])
    e = ENU0.fwd(lat, lon, np.zeros_like(lat))
    rh = np.hypot(e[:, 0], e[:, 1])
    alts = [to_msl(q, dem) for q in P]
    alt = np.array([a if a is not None else np.nan for a, _ in alts])
    near = (rh < r_max) & ((alt - 55.0) < h_max_agl)
    spans = []
    for i in np.flatnonzero(near):
        a, b = t[i] - pad, t[i] + pad
        if spans and a <= spans[-1][1]:
            spans[-1][1] = max(spans[-1][1], b)
        else:
            spans.append([a, b])
    out = []
    for k, (a, b) in enumerate(spans):
        m = (t >= a) & (t <= b) & np.isfinite(alt)
        if m.sum() < 5:
            continue
        idx = np.flatnonzero(m)
        pts = [[t[i], lat[i], lon[i], alt[i] + (0.0 if alts[i][1] == "ground" else alt_bias)] for i in idx]
        j = idx[np.argmin(rh[idx])]
        out.append({"id": f"{reg}_p{k}", "icao24": icao, "reg": reg, "type": typ,
                    "category": "heli" if typ == "S76" else "prop", "points": pts,
                    "gs": [P[i]["gs"] for i in idx], "trk": [P[i]["trk"] for i in idx],
                    "kind": [alts[i][1] for i in idx], "src": [P[i]["src"] for i in idx],
                    "t_closest": float(t[j]), "r_closest": float(rh[j]), "alt_closest": float(alt[j])})
    return out
