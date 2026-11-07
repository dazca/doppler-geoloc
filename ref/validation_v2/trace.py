"""Greedy line follower to produce seed lists: from (t_start, f_start) follow the local spectral max forwards and
backwards to [ta, tb] within +-tol (fractional) per 0.5 s step.  Prints [[t,f],...] every `every` s and the peak SNR.
usage: python -P trace.py audio.wav t_start f_start ta tb [tol=0.02 every=2]"""
import sys, json, numpy as np
from scipy.io import wavfile
fs, x = wavfile.read(sys.argv[1]); x = x.astype(np.float32)
ts, f0, ta, tb = map(float, sys.argv[2:6])
tol = float(sys.argv[6]) if len(sys.argv) > 6 else 0.02
every = float(sys.argv[7]) if len(sys.argv) > 7 else 2.0
N = 4096; NF = 32768; fr = np.fft.rfftfreq(NF, 1 / fs); w = np.hanning(N)
def spec(t):
    i = int(t * fs); s = x[i - N // 2:i + N // 2]
    return 20 * np.log10(np.abs(np.fft.rfft(s * w, NF)) + 1e-9)
def step(t, f):
    P = spec(t); k = (fr > f * (1 - tol)) & (fr < f * (1 + tol)); j = np.argmax(np.where(k, P, -1e9))
    bg = np.median(P[(fr > f * 0.8) & (fr < f * 1.2)]); return fr[j], P[j] - bg
out = []
for direction in (1, -1):
    t, f = ts, f0
    while ta <= t <= tb:
        f, snr = step(t, f); out.append((t, f, snr)); t += 0.5 * direction
out = sorted(set(out))
sel = [p for p in out if abs((p[0] - ts) / every - round((p[0] - ts) / every)) < 1e-6]
print(json.dumps([[round(t, 1), round(f, 1)] for t, f, s in sel]))
print(" ".join(f"{t:.0f}:{f:.1f}/{s:.0f}" for t, f, s in sel))
