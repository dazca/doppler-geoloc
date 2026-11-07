"""Coarse overview spectrogram of a long recording (to pick a continuous hour with flyovers).
usage: python -P overview.py audio.wav out.png [strip_s=1200 fmin=40 fmax=600 t0 t1]"""
import sys, numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy.io import wavfile
from scipy.signal import spectrogram
wav, out = sys.argv[1], sys.argv[2]
strip = float(sys.argv[3]) if len(sys.argv) > 3 else 1200
fmin = float(sys.argv[4]) if len(sys.argv) > 4 else 40
fmax = float(sys.argv[5]) if len(sys.argv) > 5 else 600
fs, x = wavfile.read(wav)
t0 = float(sys.argv[6]) if len(sys.argv) > 6 else 0
t1 = float(sys.argv[7]) if len(sys.argv) > 7 else len(x) / fs
Ds, ts = [], []
for c0 in np.arange(t0, t1, 1800.0):
    xc = x[int(c0 * fs):int(min(t1, c0 + 1800) * fs)].astype(np.float32)
    if len(xc) < 8192: continue
    f, t, S = spectrogram(xc, fs, nperseg=4096, nfft=4096, noverlap=2048)
    k = (f >= fmin) & (f <= fmax)
    Ds.append(10 * np.log10(S[k] + 1e-12)); ts.append(t + c0)
D = np.concatenate(Ds, 1); t = np.concatenate(ts)
D -= np.median(D, axis=1, keepdims=True)
n = int(np.ceil((t1 - t0) / strip))
fig, axs = plt.subplots(n, 1, figsize=(18, 1.9 * n), squeeze=False)
for i in range(n):
    a, b = t0 + i * strip, t0 + (i + 1) * strip
    m = (t >= a) & (t < b)
    ax = axs[i, 0]
    if m.any():
        ax.pcolormesh(t[m], f[k], D[:, m], vmin=-2, vmax=14, cmap="magma", shading="auto")
    ax.set_xlim(a, b); ax.set_ylabel("Hz")
    ax.set_xticks(np.arange(np.ceil(a / 60) * 60, b, 60), minor=True)
fig.tight_layout(); fig.savefig(out, dpi=55)
