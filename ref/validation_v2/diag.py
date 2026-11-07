"""After-the-fact diagnosis (uses truth): which ADS-B tracks pass near the true spot around each marked event
(event time = t_start_truth + fitted t_cpa).  usage: python -P diag.py fixtures/real/v2_<case> [run_file] [win_s=90] [r_m=2500]"""
import sys, json, math, os, glob
import numpy as np
case = sys.argv[1]
run = sys.argv[2] if len(sys.argv) > 2 else sorted(glob.glob(os.path.join(case, "run_*robust*.json")))[0]
win = float(sys.argv[3]) if len(sys.argv) > 3 else 90; rmax = float(sys.argv[4]) if len(sys.argv) > 4 else 2500
meta = json.load(open(os.path.join(case, "meta.json"))); R = json.load(open(run))
T = json.load(open(os.path.join(case, "tracks.json"))); T = T if isinstance(T, list) else T["tracks"]
la0, lo0, T0 = meta["true_lat"], meta["true_lon"], meta["t_start_truth_unix"]
c = math.cos(math.radians(la0))
for k, fi in enumerate(R["fits"]):
    f = fi.get("fit") or {}
    tc = (f.get("t_cpa_audio") or 0) + R["seg_t0"]
    te = T0 + tc
    hits = []
    for t in T:
        P = np.array(t["points"], float)
        m = (P[:, 0] > te - win) & (P[:, 0] < te + win)
        if m.sum() < 1: continue
        Q = P[m]; d = np.hypot((Q[:, 2] - lo0) * 111320 * c, (Q[:, 1] - la0) * 111320)
        j = int(np.argmin(d))
        if d[j] < rmax:
            hits.append((round(d[j]), round(Q[j, 3]), round(Q[j, 0] - te), t.get("callsign"), t.get("type"), t["category"], t["id"]))
    hits.sort()
    print(f"ev{k} t_cpa {tc:.1f} s (fit v {f.get('v') and round(f['v'])} d {f.get('d') and round(f['d'])}): {len(hits)} tracks within {rmax:.0f} m +-{win:.0f} s")
    for h in hits[:6]: print("    ", h)
