// Semi-automatic spectral ridge tracker (Viterbi / dynamic programming). Pure ES module.
//
// trackRidge(spec, seed, opts) -> {points: [{t, f, snr, score}], seed: {t, f}, iSeed, threshold,
//                                   nullStats: {mean, std} | null, params}
//   points[].snr   dB of the tracked line over the frame's band median; .score = smoothed path score
//   spec  : spectrogram per docs/CONTRACTS.md (dB, ideally whitened)
//   seed  : {t, f} user click (audio seconds, Hz)
//   opts.bandFrac      search band = f_seed*(1 ± bandFrac)            (default 0.25)
//   opts.fLo/opts.fHi  explicit band (Hz), overrides bandFrac
//   opts.maxSlope      max |df/dt| in Hz/s                            (default 0.1*f_seed per s)
//   opts.penalty       dB cost per (bin jump)^2                        (default 4)
//   opts.snap          snap seed to strongest bin within ±snap bins    (default 3)
//   opts.tMin/opts.tMax  tracking time limits (default seed ± 120 s, clipped to spectrogram)
//   opts.harmonics     multipliers of the tracked line whose energy is summed into the score,
//                      e.g. [1,2,3] if the clicked line is the fundamental, [0.5,1,1.5] if it is
//                      the 2nd harmonic. Default [1].
//   opts.minSnr        fixed trim threshold on the smoothed path score (dB over frame median).
//                      Default: automatic = mean + nullZ*std of the same tracker run on a "null"
//                      spectrogram (each frame's band circularly rolled by a random offset, which
//                      destroys ridges but keeps noise statistics).
//   opts.nullZ         z for the automatic threshold (default 3)
//   opts.nullStat      'mean' (mean/std, default) | 'robust' (median / 1.4826*MAD; recommended for real
//                      recordings whose null still contains bursts and other strong structures)
//   opts.smoothS       smoothing window for the trim score (s, default 2.0)
//   opts.maxGapS       tolerated low-score gap inside the ridge (s, default 2)
//   opts.seedGapS      max distance from the seed to the nearest confident segment (s, default 5)
//   opts.trim          false to return the full Viterbi path (default true)
//   opts.guide         optional [{t, f}] (e.g. a fundamental track) + opts.guideMult (m, default 1) and
//                      opts.guideTolHz (default 4): restricts the search at each frame to
//                      |f - m*guide(t)| <= tol (frames outside the guide's time span are unrestricted
//                      unless opts.guideOnly, in which case tracking stops at the guide's ends)
//   opts.monotonic     'down' | 'up' | null (default): constrain f(t) to be non-increasing (a straight
//                      constant-speed pass always is) or non-decreasing
//   opts.stack         'mean' (default) | 'median': how harmonic energies are combined; 'median' ignores
//                      one harmonic hit by a narrow-band burst or crossing line (needs >= 3 harmonics)
//   opts.emClip        clip per-bin emission (dB over frame median) to ±emClip, so isolated very strong
//                      cells (residual hum, clicks) cannot dominate the path (default: no clip)
//   opts.impulseDb     frames whose band median exceeds the median of all frame medians (tracking
//                      range) by more than impulseDb are treated as missing (emission 0: the path
//                      coasts on the transition model). Use for impulsive broadband bursts. (default off)
//
// Each direction (forward and backward in time from the seed frame) is a separate Viterbi pass
// starting from the snapped seed bin. Transition score: -penalty*(Δbin)^2, |Δbin| <= maxJump.
// Emission: mean over harmonics of (S - per-frame band median). Output frequency is refined
// by parabolic interpolation of the dB peak (sub-bin accuracy) and divided back by the multiplier.

export function trackRidge(spec, seed, opts = {}) {
  const { t0, dt, f0, df, nT, nF, data } = spec;
  const fSeed = seed.f;
  const bandFrac = opts.bandFrac ?? 0.25;
  const fLo = Math.max(f0, opts.fLo ?? fSeed * (1 - bandFrac));
  const fHi = Math.min(f0 + (nF - 1) * df, opts.fHi ?? fSeed * (1 + bandFrac));
  const jLo = Math.max(0, Math.round((fLo - f0) / df));
  const jHi = Math.min(nF - 1, Math.round((fHi - f0) / df));
  const nB = jHi - jLo + 1;
  if (nB < 3) throw new Error('ridge: band too narrow');
  const maxSlope = opts.maxSlope ?? 0.1 * fSeed;
  const J = Math.max(1, Math.ceil(maxSlope * dt / df));
  const lam = opts.penalty ?? 4;
  const harmonics = opts.harmonics ?? [1];
  const iSeed = clamp(Math.round((seed.t - t0) / dt), 0, nT - 1);
  const iMin = clamp(Math.round(((opts.tMin ?? seed.t - 120) - t0) / dt), 0, nT - 1);
  const iMax = clamp(Math.round(((opts.tMax ?? seed.t + 120) - t0) / dt), 0, nT - 1);

  // harmonic bin lookup: for state b (freq f_b), bins of f_b*m
  const hb = harmonics.map((m) => {
    const arr = new Int32Array(nB);
    for (let b = 0; b < nB; b++) {
      const k = Math.round(((f0 + (jLo + b) * df) * m - f0) / df);
      arr[b] = k >= 0 && k < nF ? k : -1;
    }
    return arr;
  });

  // emission for frame i into em (Float64Array nB); also returns frame band median
  const scratch = new Float32Array(nF);
  const bandMed = (i, lo, hi) => {
    const n = hi - lo + 1;
    for (let k = 0; k < n; k++) scratch[k] = data[i * nF + lo + k];
    return quickMedian(scratch, n);
  };
  // band covering all harmonics, for the median
  let kAllLo = nF, kAllHi = 0;
  for (const a of hb) for (const k of a) if (k >= 0) { kAllLo = Math.min(kAllLo, k); kAllHi = Math.max(kAllHi, k); }
  const medCache = new Float32Array(nT).fill(NaN);
  const frameMed = (i) => {
    if (Number.isNaN(medCache[i])) medCache[i] = bandMed(i, kAllLo, kAllHi);
    return medCache[i];
  };
  const emClip = opts.emClip ?? Infinity;
  const mono = opts.monotonic === 'down' ? 1 : opts.monotonic === 'up' ? -1 : 0;
  const stackMedian = opts.stack === 'median', hv = new Float64Array(harmonics.length);
  let impulseLevel = Infinity;
  if (opts.impulseDb != null) {
    const m = new Float32Array(iMax - iMin + 1);
    for (let i = iMin; i <= iMax; i++) m[i - iMin] = frameMed(i);
    impulseLevel = quickMedian(m, m.length) + opts.impulseDb;
  }
  // guide: per-frame centre frequency (NaN = unrestricted)
  let guideF = null;
  const guideTol = opts.guideTolHz ?? 4;
  if (opts.guide?.length) {
    const g = opts.guide.map((p) => (Array.isArray(p) ? { t: p[0], f: p[1] } : p)).sort((a, b) => a.t - b.t);
    const m = opts.guideMult ?? 1;
    guideF = new Float64Array(nT).fill(NaN);
    let k = 0;
    for (let i = 0; i < nT; i++) {
      const t = t0 + i * dt;
      if (t < g[0].t || t > g[g.length - 1].t) continue;
      while (k < g.length - 2 && g[k + 1].t < t) k++;
      const a = g[k], b = g[Math.min(g.length - 1, k + 1)];
      const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      guideF[i] = m * (a.f + (b.f - a.f) * u);
    }
  }
  const guideMask = (i, em) => {
    if (!guideF) return;
    const gf = guideF[i];
    if (Number.isNaN(gf)) { if (opts.guideOnly) em.fill(-50); return; }
    for (let b = 0; b < nB; b++) if (Math.abs(f0 + (jLo + b) * df - gf) > guideTol) em[b] = -50;
  };
  const emission = (i, em) => {
    const o = i * nF, med = frameMed(i);
    if (med > impulseLevel) { em.fill(0); return; }
    for (let b = 0; b < nB; b++) {
      let s = 0, c = 0;
      if (stackMedian) {
        for (const a of hb) { const k = a[b]; if (k >= 0) hv[c++] = data[o + k]; }
        if (c) { hv.subarray(0, c).sort(); s = c & 1 ? hv[c >> 1] : 0.5 * (hv[(c >> 1) - 1] + hv[c >> 1]); s *= c; }
      } else for (const a of hb) { const k = a[b]; if (k >= 0) { s += data[o + k]; c++; } }
      const v = c ? s / c - med : -1e9;
      em[b] = v > emClip ? emClip : v < -emClip ? -emClip : v;
    }
  };

  // snap seed
  const em = new Float64Array(nB);
  emission(iSeed, em); guideMask(iSeed, em);
  const bClick = clamp(Math.round((fSeed - f0) / df) - jLo, 0, nB - 1);
  const snap = opts.snap ?? 3;
  let bSeed = bClick;
  for (let b = Math.max(0, bClick - snap); b <= Math.min(nB - 1, bClick + snap); b++) if (em[b] > em[bSeed]) bSeed = b;

  // frames are correlated over ~nperseg/hop frames (window overlap): keep the null roll constant
  // over such blocks so the null retains the short noise streaks the tracker can latch onto.
  const nullBlock = opts.nullBlock ?? (spec.meta?.nperseg && spec.meta?.hop
    ? Math.max(1, Math.ceil(spec.meta.nperseg / spec.meta.hop)) : 4);
  // Viterbi from the seed frame towards iEnd. nullMode: per-frame random circular roll of the
  // emission, constant over nullBlock frames (destroys long ridges, keeps noise statistics) -> null distribution of path score.
  const run = (dir, iEnd, nullMode = false) => {
    const steps = Math.abs(iEnd - iSeed);
    const back = new Int8Array(steps * nB);
    const emAll = new Float32Array((steps + 1) * nB);
    let prev = new Float64Array(nB).fill(-Infinity), cur = new Float64Array(nB);
    prev[bSeed] = 0;
    let rng = 0x9e3779b9, r = 0;
    for (let s = 1; s <= steps; s++) {
      const i = iSeed + dir * s;
      emission(i, em);
      const E = emAll.subarray(s * nB, (s + 1) * nB);
      if (nullMode) {
        if ((s - 1) % nullBlock === 0) { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; r = rng % nB; }
        for (let b = 0; b < nB; b++) E[b] = em[(b + r) % nB];
      } else E.set(em);
      guideMask(i, E);
      for (let b = 0; b < nB; b++) {
        let best = -Infinity, arg = 0;
        let kLo = Math.max(0, b - J), kHi = Math.min(nB - 1, b + J);
        // monotonic Doppler: 'down' = f never increases with time (prev state k >= b going forward)
        if (mono && !nullMode) { if (mono * dir > 0) kLo = Math.max(kLo, b); else kHi = Math.min(kHi, b); }
        for (let k = kLo; k <= kHi; k++) {
          const d = b - k, v = prev[k] - lam * d * d;
          if (v > best) { best = v; arg = k - b; }
        }
        cur[b] = best + E[b];
        back[(s - 1) * nB + b] = arg;
      }
      const t = prev; prev = cur; cur = t;
    }
    const path = new Int32Array(steps + 1), score = new Float64Array(steps + 1);
    let b = 0;
    for (let k = 1; k < nB; k++) if (prev[k] > prev[b]) b = k;
    for (let s = steps; s >= 1; s--) { path[s] = b; score[s] = emAll[s * nB + b]; b += back[(s - 1) * nB + b]; }
    path[0] = bSeed;
    emission(iSeed, em); score[0] = em[bSeed];
    return { path, score };
  };
  const fwd = run(+1, iMax);
  const bwd = run(-1, iMin);

  // assemble in time order; frequency = power-weighted mean over harmonics of the
  // parabolic-refined peak divided by its multiplier
  const pts = [];
  const pushPt = (i, b, score) => {
    const o = i * nF, med = frameMed(i);
    let wsum = 0, fsum = 0, snr = -Infinity;
    for (let h = 0; h < harmonics.length; h++) {
      const m = harmonics[h], kk = hb[h][b];
      if (kk < 0) continue;
      let p = 0;
      if (kk > 0 && kk < nF - 1) {
        const a = data[o + kk - 1], c = data[o + kk], e = data[o + kk + 1];
        const den = a - 2 * c + e;
        p = den < 0 ? clamp(0.5 * (a - e) / den, -0.5, 0.5) : 0;
      }
      const v = data[o + kk] - med;
      if (m === 1 || snr === -Infinity) snr = v;
      const w = Math.pow(10, Math.min(v, 40) / 10);
      fsum += w * (f0 + (kk + p) * df) / m; wsum += w;
    }
    const f = wsum > 0 ? fsum / wsum : f0 + (jLo + b) * df;
    pts.push({ t: t0 + i * dt, f, snr, score });
  };
  for (let s = bwd.path.length - 1; s >= 1; s--) pushPt(iSeed - s, bwd.path[s], bwd.score[s]);
  for (let s = 0; s < fwd.path.length; s++) pushPt(iSeed + s, fwd.path[s], fwd.score[s]);

  const w = Math.max(1, Math.round((opts.smoothS ?? 2.0) / dt));
  const smooth = (arr) => {
    const n = arr.length, cs = new Float64Array(n + 1), out = new Float64Array(n);
    for (let k = 0; k < n; k++) cs[k + 1] = cs[k] + Math.max(-20, Math.min(40, arr[k]));
    for (let k = 0; k < n; k++) {
      const a = Math.max(0, k - (w >> 1)), b = Math.min(n, k + (w >> 1) + 1);
      out[k] = (cs[b] - cs[a]) / (b - a);
    }
    return out;
  };
  // null threshold: smoothed path score on rolled (ridge-free) data
  let threshold = opts.minSnr;
  let nullStats = null;
  if (threshold == null) {
    let iEndNull;
    if (guideF && opts.guideOnly) {
      // null restricted to the guide's span (outside it everything is masked)
      let a = iSeed, b = iSeed;
      while (a > 0 && !Number.isNaN(guideF[a - 1])) a--;
      while (b < nT - 1 && !Number.isNaN(guideF[b + 1])) b++;
      iEndNull = b - iSeed >= iSeed - a ? b : a;
    } else {
      const len = Math.min(nT - 1, Math.max(Math.round(60 / dt), 4 * w));
      iEndNull = iSeed + len <= nT - 1 ? iSeed + len : Math.max(0, iSeed - len);
    }
    const nl = run(iEndNull >= iSeed ? +1 : -1, iEndNull, true).score.slice(1);
    const sm = smooth(nl).slice(w, Math.max(w + 1, nl.length - w));
    let mu, sd;
    if (opts.nullStat === 'robust') {
      // median and 1.4826*MAD: robust to bursts / strong structures present in the null
      const a = Float32Array.from(sm);
      mu = quickMedian(a, a.length);
      for (let k = 0; k < a.length; k++) a[k] = Math.abs(sm[k] - mu);
      sd = 1.4826 * quickMedian(a, a.length);
    } else {
      mu = 0; for (const v of sm) mu += v; mu /= sm.length;
      let va = 0; for (const v of sm) va += (v - mu) ** 2; sd = Math.sqrt(va / sm.length);
    }
    const z = opts.nullZ ?? 3;
    nullStats = { mean: mu, std: sd };
    threshold = mu + z * sd;
  }
  const sm = smooth(pts.map((p) => p.score));
  pts.forEach((p, k) => { p.smoothScore = sm[k]; });
  let points = pts;
  if (opts.trim !== false) {
    // segments where the smoothed score >= threshold, merging gaps <= maxGapS; keep the segment
    // containing the seed, else the nearest one within seedGapS (joined to the seed).
    const maxGap = Math.round((opts.maxGapS ?? 2) / dt);
    const seedGap = Math.round((opts.seedGapS ?? 5) / dt);
    const n = pts.length, kS = bwd.path.length - 1;
    const segs = [];
    for (let k = 0; k < n; k++) {
      if (sm[k] < threshold) continue;
      const last = segs[segs.length - 1];
      if (last && k - last[1] <= maxGap + 1) last[1] = k; else segs.push([k, k]);
    }
    let best = null, bestD = Infinity;
    for (const g of segs) {
      const d = kS < g[0] ? g[0] - kS : kS > g[1] ? kS - g[1] : 0;
      if (d < bestD) { bestD = d; best = g; }
    }
    if (best && bestD <= seedGap) points = pts.slice(Math.min(best[0], kS), Math.max(best[1], kS) + 1);
    else points = pts.slice(kS, kS + 1);
  }
  return {
    points: points.map(({ t, f, snr, smoothScore }) => ({ t, f, snr, score: smoothScore })),
    seed: { t: t0 + iSeed * dt, f: f0 + (jLo + bSeed) * df },
    iSeed,
    threshold, nullStats,
    params: { fLo, fHi, maxJumpBins: J, penalty: lam, harmonics },
  };
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function quickMedian(a, n) {
  let lo = 0, hi = n - 1;
  const k = n >> 1;
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

/**
 * Track from several seeds on the same curve (e.g. the user clicks several dashes of an intermittent
 * line) and merge: per frame keep the point with the highest smoothed score. Frames between merged
 * segments are not filled. Returns {points, parts: [trackRidge results]}.
 */
export function trackRidgeMulti(spec, seeds, opts = {}) {
  const parts = seeds.map((s) => trackRidge(spec, s, opts));
  const byFrame = new Map();
  for (const r of parts) for (const p of r.points) {
    const k = Math.round((p.t - spec.t0) / spec.dt), q = byFrame.get(k);
    if (!q || p.score > q.score) byFrame.set(k, p);
  }
  const points = [...byFrame.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  return { points, parts };
}

/**
 * Remove outliers from a ridge: running median of f over winS seconds; drop points deviating by more
 * than maxDevHz from it. Returns a new array of points (same element type).
 */
export function cleanRidge(points, { winS = 1.5, maxDevHz = 3 } = {}) {
  const P = points.map((p) => (Array.isArray(p) ? { t: p[0], f: p[1], src: p } : { ...p, src: p }));
  const out = [];
  let a = 0, b = 0;
  const buf = [];
  for (let k = 0; k < P.length; k++) {
    while (P[a].t < P[k].t - winS / 2) a++;
    while (b < P.length && P[b].t <= P[k].t + winS / 2) b++;
    buf.length = 0;
    for (let q = a; q < b; q++) buf.push(P[q].f);
    buf.sort((x, y) => x - y);
    if (Math.abs(P[k].f - buf[buf.length >> 1]) <= maxDevHz) out.push(P[k].src);
  }
  return out;
}
