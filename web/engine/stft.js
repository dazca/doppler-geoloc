// STFT -> spectrogram (docs/CONTRACTS.md format). Pure ES module (browser + Node).
//
// stft(x, opts) -> {t0, dt, f0, df, nT, nF, data: Float32Array [iT*nF+iF], unit: "dB", meta}
//   x       : Float32Array/Float64Array mono samples
//   opts.fs        sample rate (Hz, required)
//   opts.nperseg   window length in samples (default 2048)
//   opts.nfft      FFT length >= nperseg, power of 2 (zero padding). default nextPow2(nperseg)
//   opts.hop       hop in samples (default nperseg/4)
//   opts.window    'hann' (periodic, = scipy 'hann') | 'hann-sym' | 'rect' | Float array
//   opts.detrend   'constant' (subtract frame mean, scipy default) | false   (default 'constant')
//   opts.scaling   'density' (PSD, V^2/Hz, scipy default) | 'spectrum' (V^2)  (default 'density')
//   opts.fMin, opts.fMax  keep only bins with fMin <= f <= fMax (saves memory)
//   opts.dbFloor   floor in dB applied before log (default -200)
//   opts.whiten    'none' | 'freq' | 'frame' | 'both'
//                  'freq' : subtract per-frequency median over time (removes stationary
//                           hum/tilt; faint moving Doppler lines pop out) -> unit "dB re median"
//                  'frame': subtract per-frame median over frequency (removes broadband gusts)
//                  'both' : freq then frame
//   opts.whitenWindowS  if set, 'freq'/'both' whitening uses a running per-frequency median over
//                  ~this many seconds (block medians, linearly interpolated) instead of the global
//                  median -> also removes hum lines that come and go. (default: global)
//   opts.clipDb    if set (number or [lo, hi]), clip the final dB values (limits impulsive bursts /
//                  residual tones dominating ridge scores and display). Applied last.
//   opts.onProgress(fraction)   optional
//
// Frame i is centred at t = (i*hop + nperseg/2)/fs  (same as scipy.signal.spectrogram).
// Number of frames = floor((N - nperseg)/hop) + 1.

import { createFFT, nextPow2, isPow2 } from './fft.js';

export function makeWindow(kind, n) {
  if (kind && typeof kind !== 'string') return Float64Array.from(kind);
  const w = new Float64Array(n);
  if (kind === 'rect') { w.fill(1); return w; }
  const denom = kind === 'hann-sym' ? n - 1 : n;
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / denom);
  return w;
}

export function stftParams(opts) {
  const fs = opts.fs;
  if (!(fs > 0)) throw new Error('stft: opts.fs required');
  const nperseg = opts.nperseg ?? 2048;
  const nfft = opts.nfft ?? nextPow2(nperseg);
  if (!isPow2(nfft) || nfft < nperseg) throw new Error('stft: nfft must be power of 2 >= nperseg');
  const hop = opts.hop ?? Math.max(1, nperseg >> 2);
  const df = fs / nfft;
  const nBins = nfft / 2 + 1;
  const iF0 = Math.max(0, Math.ceil((opts.fMin ?? 0) / df - 1e-9));
  const iF1 = Math.min(nBins - 1, Math.floor((opts.fMax ?? fs / 2) / df + 1e-9));
  return { fs, nperseg, nfft, hop, df, nBins, iF0, iF1, nF: iF1 - iF0 + 1 };
}

export function stft(x, opts = {}) {
  const P = stftParams(opts);
  const { fs, nperseg, nfft, hop, df, iF0, iF1, nF } = P;
  const N = x.length;
  const nT = N >= nperseg ? Math.floor((N - nperseg) / hop) + 1 : 0;
  const win = makeWindow(opts.window ?? 'hann', nperseg);
  let sw = 0, sw2 = 0;
  for (let i = 0; i < nperseg; i++) { sw += win[i]; sw2 += win[i] * win[i]; }
  const scaling = opts.scaling ?? 'density';
  const scale = scaling === 'density' ? 1 / (fs * sw2) : 1 / (sw * sw);
  const detrend = (opts.detrend ?? 'constant') === 'constant';
  const floorLin = Math.pow(10, (opts.dbFloor ?? -200) / 10);
  const nyq = nfft / 2;

  // per-bin scale incl. one-sided doubling (not DC, not Nyquist), folded into the log offset
  const binOff = new Float64Array(nF);
  for (let j = 0; j < nF; j++) {
    const k = iF0 + j;
    binOff[j] = scale * (k === 0 || k === nyq ? 1 : 2);
  }

  const fft = createFFT(nfft);
  const frame = new Float64Array(nfft);
  const pw = new Float64Array(nfft / 2 + 1);
  const data = new Float32Array(nT * nF);
  const progEvery = Math.max(1, Math.floor(nT / 50));

  for (let it = 0; it < nT; it++) {
    loadFrame(x, it * hop, nperseg, win, detrend, frame);  // frame[nperseg..nfft) stays zero
    fft.power(frame, pw);
    toDb(pw, iF0, nF, binOff, floorLin, data, it * nF);
    if (opts.onProgress && it % progEvery === 0) opts.onProgress(it / nT);
  }

  const spec = {
    t0: nperseg / 2 / fs, dt: hop / fs, f0: iF0 * df, df, nT, nF, data, unit: 'dB',
    meta: { fs, nperseg, nfft, hop, scaling, whiten: opts.whiten ?? 'none' },
  };
  const wh = opts.whiten ?? 'none';
  if (wh === 'freq' || wh === 'both') {
    if (opts.whitenWindowS) whitenFreqLocal(spec, opts.whitenWindowS); else whitenFreq(spec);
  }
  if (wh === 'frame' || wh === 'both') whitenFrame(spec);
  if (opts.clipDb != null) clipSpec(spec, opts.clipDb);
  spec.meta.whitenWindowS = opts.whitenWindowS ?? null;
  spec.meta.clipDb = opts.clipDb ?? null;
  if (wh !== 'none') spec.unit = 'dB re median';
  if (opts.onProgress) opts.onProgress(1);
  return spec;
}

// small hot-loop helpers (kept separate so V8 optimises them independently)
function loadFrame(x, s, n, win, detrend, frame) {
  let mean = 0;
  if (detrend) { for (let i = 0; i < n; i++) mean += x[s + i]; mean /= n; }
  for (let i = 0; i < n; i++) frame[i] = (x[s + i] - mean) * win[i];
}
function toDb(pw, iF0, nF, binOff, floorLin, data, o) {
  const L = 10 / Math.LN10;
  for (let j = 0; j < nF; j++) {
    let v = pw[iF0 + j] * binOff[j];
    if (v < floorLin) v = floorLin;
    data[o + j] = L * Math.log(v);
  }
}

// ---------- median helpers ----------
// quickselect (Hoare) on a scratch array; returns k-th smallest. Mutates a.
function select(a, n, k) {
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
export function median(arr, n = arr.length, scratch = null) {
  const a = scratch ?? new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = arr[i];
  return select(a, n, n >> 1);
}

/** subtract per-frequency median over time (in place, dB domain). Returns medians. */
export function whitenFreq(spec) {
  const { nT, nF, data } = spec;
  const col = new Float32Array(nT);
  const med = new Float32Array(nF);
  for (let j = 0; j < nF; j++) {
    for (let i = 0; i < nT; i++) col[i] = data[i * nF + j];
    med[j] = nT ? select(col, nT, nT >> 1) : 0;
  }
  for (let i = 0; i < nT; i++) { const o = i * nF; for (let j = 0; j < nF; j++) data[o + j] -= med[j]; }
  return med;
}

/**
 * subtract a running per-frequency median (in place). Medians are computed on blocks of
 * windowS/2 seconds (each block median uses a window of windowS centred on the block) and linearly
 * interpolated between block centres. Handles hum lines that start/stop or drift slowly.
 */
export function whitenFreqLocal(spec, windowS) {
  const { nT, nF, data, dt } = spec;
  const W = Math.max(3, Math.round(windowS / dt));           // window in frames
  const step = Math.max(1, W >> 1);
  const centres = [];
  for (let c = 0; c < nT; c += step) centres.push(c);
  if (centres[centres.length - 1] !== nT - 1) centres.push(nT - 1);
  const nb = centres.length, med = new Float32Array(nb * nF), col = new Float32Array(W + 1);
  for (let b = 0; b < nb; b++) {
    const a = Math.max(0, centres[b] - (W >> 1)), e = Math.min(nT, a + W), a2 = Math.max(0, e - W);
    const n = e - a2;
    for (let j = 0; j < nF; j++) {
      for (let i = 0; i < n; i++) col[i] = data[(a2 + i) * nF + j];
      med[b * nF + j] = select(col, n, n >> 1);
    }
  }
  let b = 0;
  for (let i = 0; i < nT; i++) {
    while (b < nb - 2 && centres[b + 1] < i) b++;
    const c0 = centres[b], c1 = centres[Math.min(nb - 1, b + 1)];
    const u = c1 > c0 ? Math.min(1, Math.max(0, (i - c0) / (c1 - c0))) : 0;
    const o = i * nF, m0 = b * nF, m1 = Math.min(nb - 1, b + 1) * nF;
    for (let j = 0; j < nF; j++) data[o + j] -= med[m0 + j] * (1 - u) + med[m1 + j] * u;
  }
}

/** clip values to [lo, hi] (number -> [-Infinity, hi]) in place */
export function clipSpec(spec, clip) {
  const [lo, hi] = Array.isArray(clip) ? clip : [-Infinity, clip];
  const d = spec.data;
  for (let k = 0; k < d.length; k++) { const v = d[k]; d[k] = v < lo ? lo : v > hi ? hi : v; }
}

/** subtract per-frame median over frequency (in place, dB domain). */
export function whitenFrame(spec) {
  const { nT, nF, data } = spec;
  const row = new Float32Array(nF);
  for (let i = 0; i < nT; i++) {
    const o = i * nF;
    for (let j = 0; j < nF; j++) row[j] = data[o + j];
    const m = select(row, nF, nF >> 1);
    for (let j = 0; j < nF; j++) data[o + j] -= m;
  }
}

/** spectrogram helpers */
export const timeOf = (spec, iT) => spec.t0 + iT * spec.dt;
export const freqOf = (spec, iF) => spec.f0 + iF * spec.df;
export const tIndex = (spec, t) => Math.round((t - spec.t0) / spec.dt);
export const fIndex = (spec, f) => Math.round((f - spec.f0) / spec.df);
