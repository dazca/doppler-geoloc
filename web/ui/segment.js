// Scene-cut detector for edited videos (montages), a small port of ref/validation/segment.py (Lane F).
// Short-time log band energies (64 ms frames, 24 log-spaced bands from 60 Hz up to ~0.9 Nyquist); novelty =
// median over bands of |mean(next 1 s) - mean(previous 1 s)| (dB), multiplied by the abrupt single-frame jump
// (median over bands of |L[i+1] - L[i-1]|, scaled /3 and capped at 3). Local maxima above `threshold`, >= minGapS apart.
import { createFFT } from '../engine/fft.js';

export function detectCuts(samples, fs, { threshold = 8, minGapS = 4, halfS = 1, nb = 24, tOffset = 0 } = {}) {
  const win = Math.max(256, 1 << Math.round(Math.log2(0.064 * fs))), hop = win >> 1;
  const n = Math.floor((samples.length - win) / hop) + 1;
  if (n < 10) return [];
  const fft = createFFT(win), frame = new Float64Array(win), pow = new Float64Array(win / 2 + 1);
  const hann = Float64Array.from({ length: win }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win));
  const fHi = Math.min(6000, 0.9 * fs / 2), edges = Array.from({ length: nb + 1 }, (_, k) => 60 * (fHi / 60) ** (k / nb));
  const bandOf = new Int16Array(win / 2 + 1).fill(-1);
  for (let j = 0; j <= win / 2; j++) {
    const f = (j * fs) / win;
    for (let b = 0; b < nb; b++) if (f >= edges[b] && f < edges[b + 1]) { bandOf[j] = b; break; }
  }
  const L = new Float32Array(n * nb), e = new Float64Array(nb);
  for (let i = 0; i < n; i++) {
    const o = i * hop;
    for (let k = 0; k < win; k++) frame[k] = samples[o + k] * hann[k];
    fft.power(frame, pow);
    e.fill(0);
    for (let j = 0; j <= win / 2; j++) if (bandOf[j] >= 0) e[bandOf[j]] += pow[j];
    for (let b = 0; b < nb; b++) L[i * nb + b] = 10 * Math.log10(e[b] + 1e-12);
  }
  const dt = hop / fs, h = Math.max(1, Math.round(halfS / dt));
  // cumulative sums per band for O(1) window means
  const C = new Float64Array((n + 1) * nb);
  for (let i = 0; i < n; i++) for (let b = 0; b < nb; b++) C[(i + 1) * nb + b] = C[i * nb + b] + L[i * nb + b];
  const tmp = new Float64Array(nb), med = (a) => { const s = Array.from(a).sort((x, y) => x - y); return s[s.length >> 1]; };
  const score = new Float64Array(n);
  for (let i = Math.max(h, 1); i < n - h - 1; i++) {
    for (let b = 0; b < nb; b++) tmp[b] = Math.abs((C[(i + h) * nb + b] - C[i * nb + b]) / h - (C[i * nb + b] - C[(i - h) * nb + b]) / h);
    const nov = med(tmp);
    for (let b = 0; b < nb; b++) tmp[b] = Math.abs(L[(i + 1) * nb + b] - L[(i - 1) * nb + b]);
    score[i] = nov * Math.min(med(tmp) / 3, 3);
  }
  const order = Array.from(score.keys()).sort((a, b) => score[b] - score[a]), w = Math.round(minGapS / dt), peaks = [];
  for (const i of order) {
    if (score[i] < threshold) break;
    if (peaks.every((j) => Math.abs(i - j) > w)) peaks.push(i);
  }
  return peaks.sort((a, b) => a - b).map((i) => ({ t: +(tOffset + (i * hop + win / 2) / fs).toFixed(2), score: +score[i].toFixed(1) }));
}
