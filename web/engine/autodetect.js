// Automatic flyover detection (Lane AD). Pure ES module (browser worker + Node). Contract: docs/AUTODETECT.md.
//
// detectEvents(spec, opts) -> [{seed, harmonic, points, fit, flyover, score, label, snr_db, span, related, reasons}]
//
// 1. scan: pool the whitened spectrogram into ~0.5 s blocks, keep a "tonal contrast" map (each bin minus its
//    frequency side-bands, so broadband bursts and slopes cancel), pick local peaks above a noise-calibrated threshold
//    and link them into tracklets (slowly varying, mostly falling lines).
// 2. track: strongest tracklets first, seed web/engine/ridge-extend.js#extendRidge (the same tracker as a UI click)
//    at the tracklet's strongest block, on a zero-copy ±trackHalfS crop (bounds the tracker's cost). Flat or rising
//    tracklets are never seeds. Tracklets that lie on an already tracked line, on a small-integer ratio of it, or run
//    parallel to it (constant frequency ratio: engine-order combs) are the same pass: not re-tracked, listed in `related`.
// 3. judge: geoloc.js#flyoverCheck rejects static / rising / step lines, a cheap straight-pass fit screens them,
//    events with the same CPA time and overlapping spans are merged (one pass), and geoloc.js#fitEvent fits the
//    survivors. A 0..1 confidence combines ridge SNR, duration, fit residual, swing coverage, harmonic support and
//    physical plausibility (too slow / too close = ground source).
import { extendRidge, REAL_AUDIO_OPTS } from './ridge-extend.js';
import { flyoverCheck, fitEvent } from './geoloc.js';
import { fitStraight } from './geoloc/fit.js';

export const AUTODETECT_DEFAULTS = {
  fMin: 40, fMax: 600, maxEvents: 12, minScore: 0.25, confidentScore: 0.6, cls: 'prop', c: 343,
  impulse: true, blockS: 0.5, peakZ: 3, minTrackletS: 4, minRidgeS: 6, minFallBins: 1.5, trackHalfS: 60, maxCandidates: 30, maxTimeMs: 15000,
};

const abortErr = () => (typeof DOMException === 'function' ? new DOMException('Aborted', 'AbortError') : Object.assign(new Error('Aborted'), { name: 'AbortError' }));

/** ridge options as app.js uses for a click on the fundamental of a prop (web/ui/spec-panel.js ridgeOptions). */
export function autoRidgeOptions({ cls = 'prop', impulse = true } = {}) {
  const top = cls === 'jet' ? 1 : cls === 'heli' ? 2 : 3;
  const o = { harmonics: Array.from({ length: top }, (_, k) => k + 1), nullStat: 'robust', nullZ: 1.5, maxGapS: 4, snap: 6 };
  if (cls !== 'heli') o.monotonic = 'down';
  if (impulse) { o.impulseDb = REAL_AUDIO_OPTS.impulseDb; o.emClip = REAL_AUDIO_OPTS.emClip; }
  return o;
}

// ------------------------------------------------------------------ 1. scan
/**
 * Tonal-contrast map on ~blockS blocks. Returns {nb, B, jLo, nJ, T: Float32Array(nb*nJ), sigma}.
 * T[b*nJ + j] = mean_dB(bin jLo+j over block b) - mean of its side bands (±3..8 bins).
 */
export function tonalMap(spec, { fMin = 40, fMax = 600, blockS = 0.5, iT0 = 0, iT1 = spec.nT } = {}) {
  const { f0, df, nF, data, dt } = spec;
  const B = Math.max(1, Math.round(blockS / dt));
  const G = 3, W = 8;                                      // guard and outer side-band offsets (bins)
  const jLo = Math.max(W, Math.round((fMin - f0) / df)), jHi = Math.min(nF - 1 - W, Math.round((fMax - f0) / df));
  if (jHi <= jLo) throw new Error('autodetect: band outside the spectrogram');
  const pLo = jLo - W, pN = jHi + W - pLo + 1, nJ = jHi - jLo + 1;
  const nb = Math.max(0, Math.floor((iT1 - iT0) / B));
  const T = new Float32Array(nb * nJ), P = new Float64Array(pN), cum = new Float64Array(pN + 1);
  for (let b = 0; b < nb; b++) {
    P.fill(0);
    for (let i = iT0 + b * B, e = i + B; i < e; i++) { const o = i * nF + pLo; for (let k = 0; k < pN; k++) P[k] += data[o + k]; }
    for (let k = 0; k < pN; k++) cum[k + 1] = cum[k] + P[k];
    const o = b * nJ, inv = 1 / B, side = 1 / (2 * (W - G + 1));
    for (let j = 0; j < nJ; j++) {
      const k = j + W;                                     // index in P
      const s = (cum[k - G + 1] - cum[k - W]) + (cum[k + W + 1] - cum[k + G]);
      T[o + j] = (P[k] - s * side) * inv;
    }
  }
  // robust noise scale of the contrast map (subsampled MAD)
  const step = Math.max(1, Math.floor(T.length / 200000)), smp = [];
  for (let k = 0; k < T.length; k += step) smp.push(T[k]);
  smp.sort((a, b) => a - b);
  const med = smp[smp.length >> 1] || 0;
  const dev = smp.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const sigma = 1.4826 * (dev[dev.length >> 1] || 1);
  return { nb, B, jLo, nJ, T, sigma, med, iT0 };
}

/** Peaks per block linked into tracklets. Returns [{pts:[{b, j, v}], sum, b0, b1}] sorted by sum desc. */
export function findTracklets(map, { thr, maxPeaks = 12, maxGap = 2, minBlocks = 8, maxJump = 3, maxRise = 1 } = {}) {
  const { nb, nJ, T } = map;
  const active = [], done = [];
  for (let b = 0; b < nb; b++) {
    const o = b * nJ, peaks = [];
    for (let j = 1; j < nJ - 1; j++) {
      const v = T[o + j];
      if (v >= thr && v >= T[o + j - 1] && v > T[o + j + 1]) peaks.push({ j, v });
    }
    peaks.sort((a, c) => c.v - a.v);
    if (peaks.length > maxPeaks) peaks.length = maxPeaks;
    const used = new Set();
    // extend strongest tracklets first
    active.sort((a, c) => c.sum - a.sum);
    for (const tr of active) {
      const last = tr.pts[tr.pts.length - 1], gap = b - last.b;
      const tol = maxJump * gap + Math.ceil(0.01 * (last.j + map.jLo) * gap);   // ~1 %/block slope allowance
      let best = null, bd = Infinity;
      for (let k = 0; k < peaks.length; k++) {
        if (used.has(k)) continue;
        const dj = peaks[k].j - last.j;
        if (dj > maxRise * gap || -dj > tol) continue;
        const d = Math.abs(dj);
        if (d < bd) { bd = d; best = k; }
      }
      if (best != null) { used.add(best); const p = peaks[best]; tr.pts.push({ b, j: p.j, v: p.v }); tr.sum += p.v; }
    }
    for (let k = 0; k < peaks.length; k++) if (!used.has(k)) active.push({ pts: [{ b, ...peaks[k] }], sum: peaks[k].v });
    for (let a = active.length - 1; a >= 0; a--) {
      if (b - active[a].pts[active[a].pts.length - 1].b > maxGap) { const [tr] = active.splice(a, 1); if (tr.pts.length >= minBlocks) done.push(tr); }
    }
  }
  for (const tr of active) if (tr.pts.length >= minBlocks) done.push(tr);
  for (const tr of done) { tr.b0 = tr.pts[0].b; tr.b1 = tr.pts[tr.pts.length - 1].b; }
  return done.sort((a, c) => c.sum - a.sum);
}

/** frequency fall (bins) of a tracklet: median of its first quarter minus median of its last quarter. */
export function trackletFall(tl) {
  const j = tl.pts.map((p) => p.j), k = Math.max(2, Math.floor(j.length / 4));
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  return med(j.slice(0, k)) - med(j.slice(-k));
}

/** zero-copy time crop of a contract spectrogram (frames are contiguous rows). */
export function cropSpec(spec, tA, tB) {
  const i0 = Math.max(0, Math.floor((tA - spec.t0) / spec.dt)), i1 = Math.min(spec.nT, Math.ceil((tB - spec.t0) / spec.dt) + 1);
  return { ...spec, t0: spec.t0 + i0 * spec.dt, nT: i1 - i0, data: spec.data.subarray(i0 * spec.nF, i1 * spec.nF) };
}

// ------------------------------------------------------------------ helpers
const RATIOS = (() => {   // small-integer frequency ratios p/q between lines of one harmonic family
  const out = [];
  for (let q = 1; q <= 3; q++) for (let p = 1; p <= 8; p++) {
    const r = p / q;
    if (r >= 0.24 && r <= 6.01 && !out.some((x) => Math.abs(x.r - r) < 1e-9)) out.push({ r, p, q });
  }
  return out;
})();

/** linear interpolation of a ridge [{t,f}] at time t (null outside its span). */
function ridgeAt(pts, t) {
  if (!pts.length || t < pts[0].t || t > pts[pts.length - 1].t) return null;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].t <= t) lo = m; else hi = m; }
  const a = pts[lo], b = pts[hi];
  return b.t > a.t ? a.f + (b.f - a.f) * (t - a.t) / (b.t - a.t) : a.f;
}

/** fraction of tracklet blocks lying on line `pts` × ratio (within tol), for the best small-integer ratio. */
function coverage(tl, pts, { tOf, fOf, ratios = RATIOS, tolHz }) {
  let best = { frac: 0, r: null };
  for (const R of ratios) {
    let hit = 0, n = 0;
    for (const p of tl.pts) {
      const f = ridgeAt(pts, tOf(p.b));
      if (f == null) continue;
      n++;
      if (Math.abs(fOf(p.j) - f * R.r) <= tolHz + 0.015 * f * R.r) hit++;
    }
    const frac = hit / tl.pts.length;
    if (frac > best.frac) best = { frac, r: R, n };
  }
  return best;
}

/**
 * Is the tracklet "parallel" to line `pts`, i.e. f_tl(t) = r·f_line(t) with a constant r over their overlap? Doppler
 * scales every line of one aircraft by the same factor, so any engine-order / blade line of the same pass is parallel
 * (dense combs have ratios like 7/6 that are not small-integer). Needs the tracklet to fall clearly more than the
 * residual, so a static tone is never "parallel" to a falling line. Returns {r, frac} or null.
 */
function parallelRatio(tl, pts, { tOf, fOf, df }) {
  const a = [], b = [];
  for (const p of tl.pts) { const f = ridgeAt(pts, tOf(p.b)); if (f != null) { a.push(fOf(p.j)); b.push(f); } }
  if (a.length < 0.5 * tl.pts.length || a.length < 4) return null;
  const rs = a.map((x, i) => x / b[i]).sort((x, y) => x - y), r = rs[rs.length >> 1];
  let ss = 0;
  for (let i = 0; i < a.length; i++) ss += (a[i] - r * b[i]) ** 2;
  const rms = Math.sqrt(ss / a.length), fall = a[0] - a[a.length - 1];
  if (rms > 1.5 * df || fall < Math.max(2 * df, 3 * rms)) return null;
  return { r, frac: a.length / tl.pts.length };
}

const nearSmallRatio = (r) => RATIOS.some((x) => Math.abs(r - x.r) < 0.03 * x.r);

/** harmonic number of the tracked line: smallest n <= 4 with n·r ≈ integer for every related line below it. */
function harmonicNumber(ratios) {
  // only small-integer lines BELOW the tracked one can make it a harmonic (comb lines like 6/7 say nothing)
  const below = ratios.filter((r) => r < 0.99 && nearSmallRatio(r));
  for (let n = 1; n <= 4; n++) if (below.every((r) => Math.abs(n * r - Math.round(n * r)) < 0.05 * n * r && Math.round(n * r) >= 1)) return n;
  return 1;
}

/** The pass fit is invariant to a frequency scale except for the Hz fields: rescale instead of refitting. */
export function scaleFit(fit, k) {
  const F = (o) => (o ? { ...o, F0: o.F0 * k, ...(o.rms_hz != null ? { rms_hz: o.rms_hz * k } : {}) } : o);
  return { ...fit, F0: fit.F0 * k, rms_hz: fit.rms_hz * k, curve: fit.curve?.map(([t, f]) => [t, f * k]),
    sigma: F(fit.sigma), sigma_total: F(fit.sigma_total), unconstrained: F(fit.unconstrained) };
}

const asig = (x) => x / Math.sqrt(1 + x * x);
/** Cheap screening fit (one unconstrained straight-pass LSQ, no profile likelihood): the fields scoreEvent reads. */
export function quickFit(pairs, c = 343) {
  const ts = pairs.map((p) => p[0]), fs = pairs.map((p) => p[1]);
  const f = fitStraight(ts, fs, { c, maxIter: 100 });
  if (!Number.isFinite(f.F0) || !Number.isFinite(f.v) || !Number.isFinite(f.d)) return null;
  const b = f.v / c, tau0 = f.d * Math.sqrt(1 - b * b) / f.v;
  const coverage = 0.5 * (asig((ts[ts.length - 1] - f.t_c) / tau0) - asig((ts[0] - f.t_c) / tau0));
  const w = coverage >= 0.8 ? 0.25 : 0.6;
  return { t_cpa_audio: f.t_cpa_audio, F0: f.F0, rms_hz: f.rms_hz, point: { v: f.v, d: f.d }, t_sigma_s: 2,
    v_mps: [f.v * (1 - w), f.v * (1 + w)], cpa_m: [f.d * (1 - 2 * w), f.d * (1 + 2 * w)],
    quality: { coverage }, poorly_constrained: coverage < 0.8, quick: true };
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** 0..1 confidence from ridge and fit quality. Returns {score, reasons}. */
export function scoreEvent({ snr, durS, fit, fly, nRelated, cls = 'prop', steps = 0 }) {
  const reasons = [];
  const sSnr = clamp01((snr - 3) / 9);                     // 3 dB -> 0, 12 dB -> 1
  const sDur = clamp01((durS - 8) / 40);                   // 8 s -> 0, 48 s -> 1
  const cov = fit.quality?.coverage ?? 0.5;
  const sCov = clamp01((cov - 0.3) / 0.5);                 // fraction of the Doppler swing observed
  const relRms = fit.rms_hz / Math.max(1, fit.F0);
  const sRms = clamp01(1 - (relRms - 0.004) / 0.02);
  const sHarm = clamp01(nRelated / 2);
  let s = 0.3 * sSnr + 0.2 * sDur + 0.25 * sCov + 0.15 * sRms + 0.1 * sHarm;
  if (snr < 5) reasons.push(`weak line (${snr.toFixed(1)} dB)`);
  if (durS < 15) reasons.push(`short ridge (${durS.toFixed(0)} s)`);
  if (cov < 0.5) reasons.push(`only ${(100 * cov).toFixed(0)} % of the Doppler swing seen`);
  if (relRms > 0.015) reasons.push(`ridge far from a straight-pass curve (rms ${fit.rms_hz.toFixed(1)} Hz)`);
  if (fit.poorly_constrained) { s *= 0.75; reasons.push('poorly constrained fit'); }
  // physical plausibility: too slow / too close are ground sources (vehicles, birds, machinery steps); too fast / too
  // far is usually an under-constrained partial curve, penalised less when the fit's 2-sigma range is plausible
  const v = fit.point?.v, d = fit.point?.d;
  const vMax = cls === 'jet' ? 320 : cls === 'heli' ? 90 : 110, vMin = cls === 'jet' ? 50 : 20, dMin = 100, dMax = 6000;
  const overlaps = (r, lo, hi) => Array.isArray(r) && r[0] <= hi && r[1] >= lo;
  if (!(v >= vMin) || !(d >= dMin)) { s *= 0.4; reasons.push(`too slow or too close for an aircraft (v ${Number.isFinite(v) ? v.toFixed(0) : '?'} m/s, d ${Number.isFinite(d) ? d.toFixed(0) : '?'} m): ground source?`); }
  else if (v > vMax || d > dMax) {
    const soft = overlaps(fit.v_mps, vMin, vMax) && overlaps(fit.cpa_m, dMin, dMax);
    s *= soft ? 0.85 : 0.5;
    reasons.push(`fit outside the ${cls} envelope (v ${v.toFixed(0)} m/s, d ${d.toFixed(0)} m)${soft ? ', but its range is plausible' : ''}`);
  }
  if (fly && fly.kind !== 'flyover') { s *= 0.7; reasons.push(fly.reason); }
  if (steps > 0.3) { s *= 0.5; reasons.push(`${(100 * steps).toFixed(0)} % of the fall happens in abrupt steps (rpm changes, not a Doppler curve)`); }
  return { score: clamp01(s), reasons };
}

/**
 * Fraction of a ridge's total fall that happens faster than the fitted straight pass can ever fall (2.5 x its maximum
 * slope F0 v^2 / (c d (1-b^2)^1.5), MATH.md §3), measured on a ±0.25 s median-smoothed ridge over 0.5 s steps.
 * A staircase of rpm changes (taxi, run-up, power changes) scores high; a real Doppler sweep scores ~0.
 */
export function stepFraction(pairs, fit, c = 343) {
  const v = fit.point?.v, d = fit.point?.d, F0 = fit.F0;
  if (!(v > 0 && d > 0 && F0 > 0) || pairs.length < 8) return 0;
  const b = v / c, sMax = F0 * v * v / (c * d * Math.pow(1 - b * b, 1.5));
  const t = pairs.map((p) => p[0]), f = pairs.map((p) => p[1]), n = t.length;
  const sm = new Float64Array(n), w = [];
  for (let i = 0, lo = 0, hi = 0; i < n; i++) {
    while (t[lo] < t[i] - 0.25) lo++;
    while (hi + 1 < n && t[hi + 1] <= t[i] + 0.25) hi++;
    w.length = 0; for (let k = lo; k <= hi; k++) w.push(f[k]);
    w.sort((x, y) => x - y); sm[i] = w[w.length >> 1];
  }
  let fast = 0, total = 0;
  for (let i = 0, j = 0; i < n; i++) {
    while (j < n - 1 && t[j] < t[i] + 0.5) j++;
    if (t[j] - t[i] < 0.25) break;
    const drop = sm[i] - sm[j], dtS = t[j] - t[i];
    if (drop > 0) { total += drop; if (drop / dtS > 2.5 * sMax) fast += drop; }
  }
  return total > 0 ? fast / total : 0;
}

// ------------------------------------------------------------------ main
/**
 * @param spec contract spectrogram (whitened dB). Read only.
 * @param opts see docs/AUTODETECT.md
 */
export async function detectEvents(spec, opts = {}) {
  const o = { ...AUTODETECT_DEFAULTS, ...opts };
  const { signal, onProgress } = o;
  const t0 = performance.now();
  const check = () => { if (signal?.aborted) throw abortErr(); };
  const { dt, df, f0, nT } = spec;
  const iT0 = Math.max(0, Math.round(((o.tMin ?? -Infinity) === -Infinity ? 0 : (o.tMin - spec.t0) / dt)));
  const iT1 = Math.min(nT, o.tMax == null ? nT : Math.round((o.tMax - spec.t0) / dt) + 1);
  onProgress?.({ stage: 'scan', frac: 0 });
  const tm = { scan: 0, track: 0, quick: 0, fit: 0, nFit: 0 };
  const map = tonalMap(spec, { fMin: o.fMin, fMax: o.fMax, blockS: o.blockS, iT0, iT1 });
  const thr = map.med + o.peakZ * map.sigma;
  const tOf = (b) => spec.t0 + (map.iT0 + (b + 0.5) * map.B) * dt - dt / 2;
  const fOf = (j) => f0 + (map.jLo + j) * df;
  const minBlocks = Math.max(3, Math.round(o.minTrackletS / (map.B * dt)));
  const tls = findTracklets(map, { thr, minBlocks });
  onProgress?.({ stage: 'scan', frac: 1 });
  tm.scan = performance.now() - t0;

  // excluded windows (user-marked passes)
  const excl = (o.exclude || []).map((x) => (x.t0 != null ? [x.t0, x.t1] : [x.t_cpa_audio - 30, x.t_cpa_audio + 30]));
  const inExcl = (t) => excl.some(([a, b]) => t >= a && t <= b);

  const ropts = autoRidgeOptions({ cls: o.cls, impulse: o.impulse });
  const lines = [];          // every tracked line: {pts:[{t,f}], ev|null}
  const events = [];
  const tolHz = 2 * df;
  let nTried = 0, nFlat = 0, truncated = 0;
  for (let k = 0; k < tls.length; k++) {
    check();
    if (nTried >= o.maxCandidates || performance.now() - t0 > o.maxTimeMs) { truncated = tls.length - k; break; }
    const tl = tls[k];
    // a pass's line falls: skip flat or rising tracklets (a pass seen only on its flat asymptote is useless anyway,
    // and its falling part forms its own tracklet). Static tones crossing a pass are not its harmonics either.
    if (trackletFall(tl) < o.minFallBins) { nFlat++; continue; }
    // skip tracklets lying on an already tracked line (ratio 1) or on a harmonic of an accepted pass
    let skip = false;
    for (const L of lines) {
      const cv = coverage(tl, L.pts, { tOf, fOf, tolHz, ratios: L.ev ? RATIOS : [{ r: 1, p: 1, q: 1 }] });
      let r = cv.frac >= 0.5 ? cv.r.r : null;
      if (r == null && L.ev) r = parallelRatio(tl, L.pts, { tOf, fOf, df })?.r ?? null;
      if (r != null) {
        skip = true;
        if (L.ev && Math.abs(r - 1) > 0.02) {
          const pk = tl.pts.reduce((a, p) => (p.v > a.v ? p : a));
          L.ev.related.push({ f_ratio: +r.toFixed(4), t: +tOf(pk.b).toFixed(2), f: +fOf(pk.j).toFixed(2), strength: +(tl.sum / tl.pts.length).toFixed(2) });
        }
        break;
      }
    }
    if (skip) continue;
    const pk = tl.pts.reduce((a, p) => (p.v > a.v ? p : a));
    const seed = { t: tOf(pk.b), f: fOf(pk.j) };
    if (inExcl(seed.t)) continue;
    nTried++;
    onProgress?.({ stage: 'track', frac: k / tls.length });
    let r;
    // track on a zero-copy time crop around the seed: every trackRidge call inside extendRidge scans its whole
    // window (default ±120 s), so the crop bounds the cost; a pass is audible for ~±60 s around its strongest point
    const tx = performance.now();
    try {
      const C = cropSpec(spec, seed.t - o.trackHalfS, seed.t + o.trackHalfS);
      r = extendRidge(C, seed, ropts);
      // the ridge ran into the crop edge: redo once on a crop twice as wide (long, slow passes)
      const P = r.points, tA = C.t0 + spec.dt, tB = C.t0 + (C.nT - 2) * spec.dt;
      if (P.length >= 8 && ((P[0].t <= tA && C.t0 > spec.t0) || (P[P.length - 1].t >= tB && C.nT + (C.t0 - spec.t0) / spec.dt < spec.nT - 1)))
        r = extendRidge(cropSpec(spec, seed.t - 2 * o.trackHalfS, seed.t + 2 * o.trackHalfS), seed, ropts);
    } catch { tm.track += performance.now() - tx; continue; }
    tm.track += performance.now() - tx;
    const pts = r.points;
    if (pts.length < 8) { lines.push({ pts: tl.pts.map((p) => ({ t: tOf(p.b), f: fOf(p.j) })), ev: null }); continue; }
    const line = { pts, ev: null };
    lines.push(line);
    const pairs = pts.map((p) => [p.t, p.f]);
    const fly = flyoverCheck(pairs);
    if (!fly.ok) continue;
    if (pts[pts.length - 1].t - pts[0].t < o.minRidgeS) continue;
    // screening fit on a decimated ridge (the full fit is done only for the survivors, below)
    const stride = Math.max(1, Math.ceil(pairs.length / 300));
    let fit;
    const tq = performance.now();
    try { fit = quickFit(stride > 1 ? pairs.filter((_, i) => i % stride === 0) : pairs, o.c); } catch { fit = null; }
    tm.quick += performance.now() - tq;
    if (!fit) continue;
    const snrs = pts.map((p) => p.snr).sort((a, b) => a - b);
    const ev = { seed: { t: +seed.t.toFixed(3), f: +seed.f.toFixed(2) }, line: pts, fit, flyover: fly, related: [],
      snr_db: snrs[snrs.length >> 1], span: [pts[0].t, pts[pts.length - 1].t] };
    line.ev = ev;
    events.push(ev);
  }
  onProgress?.({ stage: 'fit', frac: 0.5 });

  // merge events that are the same pass on different lines (same CPA time, ratio of small integers)
  events.sort((a, b) => b.snr_db * (b.span[1] - b.span[0]) - a.snr_db * (a.span[1] - a.span[0]));
  const kept = [];
  for (const ev of events) {
    let host = null, ratio = null;
    for (const h of kept) {
      // same CPA time and overlapping spans: two lines of one pass (any ratio: engine-order combs are not harmonic)
      if (Math.abs(h.fit.t_cpa_audio - ev.fit.t_cpa_audio) > Math.max(6, 2 * (h.fit.t_sigma_s || 0))) continue;
      const ov = Math.min(h.span[1], ev.span[1]) - Math.max(h.span[0], ev.span[0]);
      if (ov < 0.5 * Math.min(h.span[1] - h.span[0], ev.span[1] - ev.span[0])) continue;
      const fr = ev.fit.F0 / h.fit.F0;
      const R = RATIOS.find((x) => Math.abs(fr - x.r) < 0.04 * x.r);
      host = h; ratio = R ? R.r : fr; break;
    }
    if (host) {
      if (Math.abs(ratio - 1) < 0.02) continue;    // the same line found twice
      host.related.push({ f_ratio: +ratio.toFixed(4), t: ev.seed.t, f: ev.seed.f, strength: +ev.snr_db.toFixed(2), tracked: true });
      continue;
    }
    kept.push(ev);
  }

  const scored = [];
  for (const ev of kept) {
    const rel = [];
    for (const r of ev.related) if (!rel.some((x) => Math.abs(x.f_ratio - r.f_ratio) < 0.02)) rel.push(r);
    const n = harmonicNumber(rel.map((r) => r.f_ratio));
    const durS = ev.span[1] - ev.span[0];
    const pre = scoreEvent({ snr: ev.snr_db, durS, fit: ev.fit, fly: ev.flyover, nRelated: rel.length, cls: o.cls,
      steps: stepFraction(ev.line.map((p) => [p.t, p.f]), ev.fit, o.c) });
    // margin: the full fit may move the score a little
    if (pre.score >= o.minScore - 0.05) scored.push({ ev, rel, n, durS, pre: pre.score });
  }
  scored.sort((a, b) => b.pre - a.pre);
  const out = [];
  for (let k = 0; k < scored.length && out.length < o.maxEvents; k++) {
    check();
    onProgress?.({ stage: 'fit', frac: 0.5 + 0.5 * k / scored.length });
    const { ev, rel, n, durS } = scored[k];
    const points = ev.line.map((p) => [+p.t.toFixed(3), +(p.f / n).toFixed(3)]);
    let fit;
    const tf = performance.now();
    // the overlapping STFT frames are strongly correlated: <= 400 points give the same fit (colsto: within 0.35 s, 1 % in v)
    const st = Math.max(1, Math.ceil(points.length / 400));
    try { fit = await fitEvent(st > 1 ? points.filter((_, i) => i % st === 0) : points, { c: o.c, cls: o.cls }); } catch { fit = null; }
    tm.fit += performance.now() - tf; tm.nFit++;
    if (!fit) continue;
    const { score, reasons } = scoreEvent({ snr: ev.snr_db, durS, fit, fly: ev.flyover, nRelated: rel.length, cls: o.cls, steps: stepFraction(points, fit, o.c) });
    if (score < o.minScore) continue;
    out.push({ seed: ev.seed, harmonic: n, points, fit, flyover: ev.flyover, score: +score.toFixed(3),
      label: score >= o.confidentScore ? 'confident' : 'suggestion', snr_db: +ev.snr_db.toFixed(2),
      span: ev.span.map((x) => +x.toFixed(2)), related: rel, reasons });
  }
  out.sort((a, b) => b.score - a.score);
  if (out.length > o.maxEvents) out.length = o.maxEvents;
  onProgress?.({ stage: 'fit', frac: 1 });
  Object.defineProperty(out, 'stats', { value: { tracklets: tls.length, flat: nFlat, tried: nTried, untried: truncated, tracked: events.length, sigma: map.sigma, thr, timings: Object.fromEntries(Object.entries(tm).map(([k, v]) => [k, Math.round(v)])), elapsedMs: Math.round(performance.now() - t0) }, enumerable: false });
  return out;
}
