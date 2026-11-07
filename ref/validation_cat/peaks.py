"""Print spectral peaks (fmin..fmax) at given audio times, to place ridge seeds precisely.
usage: python -P peaks.py audio.wav fmin fmax t1 t2 ..."""
import sys, numpy as np
from scipy.io import wavfile
from scipy.signal import find_peaks
fs, x = wavfile.read(sys.argv[1]); x = x.astype(np.float32)
fmin, fmax = float(sys.argv[2]), float(sys.argv[3])
for t in map(float, sys.argv[4:]):
    i = int(t * fs); seg = x[i - 2048:i + 2048] * np.hanning(4096)
    P = 20 * np.log10(np.abs(np.fft.rfft(seg, 16384)) + 1e-9); f = np.fft.rfftfreq(16384, 1 / fs)
    k = (f >= fmin) & (f <= fmax); Pk = P[k] - np.median(P[k]); fk = f[k]
    pk, _ = find_peaks(Pk, prominence=6, distance=8)
    top = sorted(pk, key=lambda j: -Pk[j])[:8]
    print(f"t={t:7.1f}: " + "  ".join(f"{fk[j]:6.1f}({Pk[j]:4.1f})" for j in sorted(top)))
