"""List all low ADS-B passes near the true spot during the audio (audio time = t - t_start_truth). Uses truth: diagnosis only.
usage: python -P passes.py fixtures/real/v2_<case> [r_m=1500] [maxalt_m=1000]"""
import sys, json, math, os
import numpy as np
case = sys.argv[1]; rmax = float(sys.argv[2]) if len(sys.argv) > 2 else 1500; amax = float(sys.argv[3]) if len(sys.argv) > 3 else 1000
meta = json.load(open(os.path.join(case, "meta.json"))); T = json.load(open(os.path.join(case, "tracks.json"))); T = T if isinstance(T, list) else T["tracks"]
la0, lo0, T0 = meta["true_lat"], meta["true_lon"], meta["t_start_truth_unix"]; c = math.cos(math.radians(la0))
import wave
with wave.open(os.path.join(case, "audio.wav")) as w: dur = w.getnframes() / w.getframerate()
rows = []
for t in T:
    P = np.array(t["points"], float); m = (P[:, 0] > T0 - 60) & (P[:, 0] < T0 + dur + 60)
    if m.sum() < 1: continue
    Q = P[m]; d = np.hypot((Q[:, 2] - lo0) * 111320 * c, (Q[:, 1] - la0) * 111320)
    # local minima of distance below rmax
    for j in range(len(Q)):
        if d[j] < rmax and Q[j, 3] < amax and (j == 0 or d[j] <= d[j - 1]) and (j == len(Q) - 1 or d[j] <= d[j + 1]):
            dtg = np.diff(Q[max(0, j - 3):j + 4, 0])
            rows.append((Q[j, 0] - T0, round(d[j]), round(Q[j, 3]), t.get("callsign"), t.get("type"), t["category"], round(float(dtg.max()) if len(dtg) else -1)))
for r in sorted(rows): print(f"audio {r[0]:7.0f} s  {r[1]:5d} m  alt {r[2]:5d} m  {r[3]} {r[4]} {r[5]}  max dt {r[6]} s")
