"""Zoomed spectrograms of several windows (to place seeds). usage: python -P zoom.py audio.wav out.png fmin fmax t0:t1 [t0:t1 ...]"""
import sys, numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy.io import wavfile
from scipy.signal import spectrogram
fs, x = wavfile.read(sys.argv[1]); fmin, fmax = float(sys.argv[3]), float(sys.argv[4])
wins = [tuple(map(float, w.split(":"))) for w in sys.argv[5:]]
fig, axs = plt.subplots(len(wins), 1, figsize=(16, 3.4 * len(wins)), squeeze=False)
for ax, (a, b) in zip(axs[:, 0], wins):
    xc = x[int(a * fs):int(b * fs)].astype(np.float32)
    f, t, S = spectrogram(xc, fs, nperseg=4096, nfft=16384, noverlap=4096 - 512)
    k = (f >= fmin) & (f <= fmax); D = 10 * np.log10(S[k] + 1e-12); D -= np.median(D, axis=1, keepdims=True)
    ax.pcolormesh(t + a, f[k], D, vmin=-2, vmax=18, cmap="magma", shading="auto")
    ax.set_xticks(np.arange(np.ceil(a / 5) * 5, b, 5)); ax.set_xticks(np.arange(np.ceil(a), b, 1), minor=True)
    ax.set_yticks(np.arange(np.ceil(fmin / 20) * 20, fmax, 20)); ax.grid(alpha=0.25)
fig.tight_layout(); fig.savefig(sys.argv[2], dpi=60)
