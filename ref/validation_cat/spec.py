"""Quick-look spectrogram (per-bin median-normalised dB), in strips.
usage: python -I spec.py audio.wav out.png [fmin fmax strip_s t0 t1]"""
import sys, numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy.io import wavfile
from scipy.signal import spectrogram

wav, out = sys.argv[1], sys.argv[2]
fmin = float(sys.argv[3]) if len(sys.argv) > 3 else 30
fmax = float(sys.argv[4]) if len(sys.argv) > 4 else 800
strip = float(sys.argv[5]) if len(sys.argv) > 5 else 300
fs, x = wavfile.read(wav)
x = x.astype(np.float32)
t0 = float(sys.argv[6]) if len(sys.argv) > 6 else 0
t1 = float(sys.argv[7]) if len(sys.argv) > 7 else len(x) / fs
x = x[int(t0 * fs):int(t1 * fs)]
f, t, S = spectrogram(x, fs, nperseg=4096, nfft=8192, noverlap=4096 - 1024)
t = t + t0
k = (f >= fmin) & (f <= fmax)
D = 10 * np.log10(S[k] + 1e-12)
D -= np.median(D, axis=1, keepdims=True)
n = int(np.ceil((t1 - t0) / strip))
fig, axs = plt.subplots(n, 1, figsize=(16, 2.6 * n), squeeze=False)
for i in range(n):
    a, b = t0 + i * strip, t0 + (i + 1) * strip
    m = (t >= a) & (t < b)
    ax = axs[i, 0]
    if m.any():
        ax.pcolormesh(t[m], f[k], D[:, m], vmin=-3, vmax=15, cmap="magma", shading="auto")
    ax.set_xlim(a, b); ax.set_ylabel("Hz")
    ax.set_xticks(np.arange(np.ceil(a / 10) * 10, b, 10), minor=True)
axs[-1, 0].set_xlabel("audio time (s)")
fig.tight_layout(); fig.savefig(out, dpi=70)
