// Reference spectrogram, per-bin robust whitening, bilinear sampling, multi-harmonic curve score.
// Port of ref/doppler_ref/spectrogram.py:
//   frame iT = samples [iT*hop, iT*hop+nperseg), periodic Hann, no detrend,
//   dB = 10 log10(|X|^2 / sum(w^2) + 1e-12), bins f <= fmax kept; t0 = nperseg/2/fs, dt = hop/fs, df = fs/nperseg.
//   whitening per frequency bin over time: z = (S - median)/(1.4826 MAD + 1e-6) clipped to [-3, 8].
// Lane C's stft.js uses PSD scaling + detrend and subtracts only the median (no MAD), so it does not reproduce
// the reference z-scores; the FFT itself (fft.js) is reused.
import { createFFT } from '../fft.js';

export function refSpectrogram(x, fs, { nperseg = 4096, hop = 1024, fmax = 1000.0, onProgress } = {}) {
  const n = 1 + Math.max(0, Math.floor((x.length - nperseg) / hop));
  const w = new Float64Array(nperseg);
  let norm = 0;
  for (let i = 0; i < nperseg; i++) { w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / nperseg); norm += w[i] * w[i]; }
  const nF = Math.floor(fmax * nperseg / fs) + 1;
  const fft = createFFT(nperseg), frame = new Float64Array(nperseg), pw = new Float64Array(nperseg / 2 + 1);
  const data = new Float32Array(n * nF), L = 10 / Math.LN10;
  for (let it = 0; it < n; it++) {
    const s = it * hop;
    for (let i = 0; i < nperseg; i++) frame[i] = (x[s + i] ?? 0) * w[i];
    fft.power(frame, pw);
    const o = it * nF;
    for (let j = 0; j < nF; j++) data[o + j] = L * Math.log(pw[j] / norm + 1e-12);
    if (onProgress && it % 500 === 0) onProgress(it / n);
  }
  return { t0: nperseg / 2 / fs, dt: hop / fs, f0: 0.0, df: fs / nperseg, nT: n, nF, data, unit: 'dB' };
}

function selectK(a, n, k) { // quickselect, mutates a
  let lo = 0, hi = n - 1;
  while (hi > lo) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k];
  }
  return a[k];
}
/** numpy-style median (mean of the two middle values for even n), float32 like numpy on float32 input. */
export function median32(a, n) {
  const hi = selectK(a, n, n >> 1);
  if (n & 1) return hi;
  let lo = -Infinity; // max of the lower half
  for (let i = 0; i < (n >> 1); i++) if (a[i] > lo) lo = a[i];
  return Math.fround(Math.fround(lo + hi) / 2);
}

/** Robust per-bin whitening -> Float32Array z [iT*nF+iF], clipped to [lo, hi]. */
export function whiten(spec, { lo = -3.0, hi = 8.0 } = {}) {
  const { nT, nF, data } = spec;
  const Z = new Float32Array(nT * nF), col = new Float32Array(nT), dev = new Float32Array(nT);
  for (let j = 0; j < nF; j++) {
    for (let i = 0; i < nT; i++) col[i] = data[i * nF + j];
    const med = median32(col, nT);
    for (let i = 0; i < nT; i++) dev[i] = Math.abs(Math.fround(data[i * nF + j] - med));
    const mad = median32(dev, nT);
    const den = Math.fround(Math.fround(1.4826 * mad) + 1e-6);
    for (let i = 0; i < nT; i++) {
      const z = Math.fround(data[i * nF + j] - med) / den;
      Z[i * nF + j] = z < lo ? lo : z > hi ? hi : z;
    }
  }
  return Z;
}

/** Bilinear sample of Z at audio time t, frequency f; outside the grid -> 0. */
export function bilinear(Z, spec, t, f) {
  const it = (t - spec.t0) / spec.dt, jf = (f - spec.f0) / spec.df, nT = spec.nT, nF = spec.nF;
  if (!(it >= 0 && it <= nT - 1 && jf >= 0 && jf <= nF - 1)) return 0;
  let i0 = Math.floor(it), j0 = Math.floor(jf);
  if (i0 > nT - 2) i0 = nT - 2;
  if (j0 > nF - 2) j0 = nF - 2;
  const a = it - i0, b = jf - j0, o = i0 * nF + j0;
  return (1 - a) * (1 - b) * Z[o] + (1 - a) * b * Z[o + 1] + a * (1 - b) * Z[o + nF] + a * b * Z[o + nF + 1];
}

/** curve_score: sum_k sum_i w_i z(t_i, k F0 ratio_i) / (K sum w) ('mean') or / sqrt(K sum w) ('sqrtN'). */
export function curveScore(Z, spec, tAudio, ratio, F0, harmonics = [1, 2, 3, 4], weight = null, norm = 'mean') {
  let num = 0, sw = 0;
  for (let i = 0; i < tAudio.length; i++) {
    const w = weight ? weight[i] : 1;
    sw += w;
    if (!w) continue;
    let s = 0;
    for (const k of harmonics) s += bilinear(Z, spec, tAudio[i], k * F0 * ratio[i]);
    num += w * s;
  }
  let den = sw * harmonics.length;
  if (norm === 'sqrtN') den = Math.sqrt(den);
  return num / Math.max(den, 1e-9);
}

/**
 * Integer-factor decimation (fs -> fs/M) with a Hann-windowed-sinc low-pass (cutoff 0.45 fs_out, 16*M+1 taps),
 * computing only the kept outputs. ~1 s for 24 M samples (Lane C's general sinc resampler takes ~75 s there).
 */
export function decimate(x, M) {
  if (M === 1) return Float32Array.from(x);
  const half = 8 * M, L = 2 * half + 1, h = new Float64Array(L), fc = 0.45 / M;
  let sum = 0;
  for (let i = 0; i < L; i++) {
    const k = i - half, w = 0.5 + 0.5 * Math.cos(Math.PI * k / (half + 1));
    h[i] = w * (k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k));
    sum += h[i];
  }
  for (let i = 0; i < L; i++) h[i] /= sum;
  const n = Math.floor(x.length / M), y = new Float32Array(n);
  for (let o = 0; o < n; o++) {
    const c = o * M;
    let acc = 0;
    if (c - half >= 0 && c + half < x.length) for (let i = 0; i < L; i++) acc += h[i] * x[c - half + i];
    else for (let i = 0; i < L; i++) { const j = c - half + i; if (j >= 0 && j < x.length) acc += h[i] * x[j]; }
    y[o] = acc;
  }
  return y;
}
