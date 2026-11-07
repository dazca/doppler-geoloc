// Ridge tracking + robust least-squares fit of the straight-line Doppler model (F0, v, d, t_c) with covariance.
// Port of ref/doppler_ref/fit.py. scipy.optimize.least_squares(loss='soft_l1', f_scale=1, bounds) is replaced by a
// bounded Levenberg-Marquardt on the same robust cost (IRLS normal equations); same multi-start in d; covariance
// from scipy's "modified Jacobian" J*sqrt(rho'+2 rho'' r^2) = J (1+r^2)^-3/4 for soft_l1.
import { straightLineF, C_DEFAULT } from './doppler.js';
import { bilinear } from './spectro.js';

/** Per-frame harmonic-stacked peak search (fit.track_ridge). Returns {t, f, s} (fundamental). */
export function trackRidgeRef(Z, spec, tCenter, F0guess, { halfWindow = 60.0, band = [0.72, 1.38], harmonics = [1, 2, 3, 4],
  nCand = 400, minZ = 1.5 } = {}) {
  const i0 = Math.max(0, Math.trunc((tCenter - halfWindow - spec.t0) / spec.dt));
  const i1 = Math.min(spec.nT - 1, Math.trunc((tCenter + halfWindow - spec.t0) / spec.dt));
  const la = Math.log(band[0]), lb = Math.log(band[1]);
  const fc = Float64Array.from({ length: nCand }, (_, j) => F0guess * Math.exp(la + (lb - la) * j / (nCand - 1)));
  const st = new Float64Array(nCand), T = [], Fq = [], S = [];
  const dl = Math.log(fc[1] / fc[0]);
  for (let i = i0; i <= i1; i++) {
    const t = spec.t0 + spec.dt * i;
    for (let j = 0; j < nCand; j++) {
      let s = 0;
      for (const k of harmonics) s += bilinear(Z, spec, t, k * fc[j]);
      st[j] = s / harmonics.length;
    }
    let jm = 0;
    for (let j = 1; j < nCand; j++) if (st[j] > st[jm]) jm = j;
    const j = Math.min(nCand - 2, Math.max(1, jm));
    const y0 = st[j - 1], y1 = st[j], y2 = st[j + 1], den = y0 - 2 * y1 + y2;
    let off = den < 0 ? 0.5 * (y0 - y2) / den : 0.0;
    off = Math.max(-1, Math.min(1, off));
    if (y1 >= minZ) { T.push(t); Fq.push(Math.exp(Math.log(fc[j]) + off * dl)); S.push(y1); }
  }
  return { t: T, f: Fq, s: S };
}

function percentile(a, q) { // numpy linear interpolation
  const s = Float64Array.from(a).sort(), h = (s.length - 1) * q / 100, lo = Math.floor(h), hi = Math.min(s.length - 1, lo + 1);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}

function solveN(A, b, n) { // Gaussian elimination with partial pivoting, A row-major n*n (copied)
  const M = A.slice(), x = b.slice();
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
    if (M[p * n + c] === 0) return null;
    if (p !== c) { for (let k = 0; k < n; k++) { const t = M[c * n + k]; M[c * n + k] = M[p * n + k]; M[p * n + k] = t; } const t = x[c]; x[c] = x[p]; x[p] = t; }
    for (let r = c + 1; r < n; r++) { const f = M[r * n + c] / M[c * n + c]; for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k]; x[r] -= f * x[c]; }
  }
  for (let r = n - 1; r >= 0; r--) { let s = x[r]; for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k]; x[r] = s / M[r * n + r]; }
  return x;
}
function invN(A, n) {
  const out = new Array(n * n);
  for (let c = 0; c < n; c++) { const e = new Array(n).fill(0); e[c] = 1; const x = solveN(A, e, n); if (!x) return null; for (let r = 0; r < n; r++) out[r * n + c] = x[r]; }
  return out;
}

/**
 * Robust LSQ fit of f(t) = straightLineF(t - t_c; F0, v, d). Returns {F0, v, d, t_c, t_cpa_audio, sigma, cov, rms_hz, n}.
 */
export function fitStraight(times, freqs, { guess = null, c = C_DEFAULT, weights = null, maxIter = 300, fix = null, prior = null, starts = null } = {}) {
  // fix: {d: value} holds d fixed (profile likelihood). prior: {v: [lo, hi, sigma], d: [lo, hi, sigma], scale}
  // adds pseudo-residuals scale * (distance outside [lo, hi]) / sigma (soft-L1 like the data).
  const n = times.length;
  const sw = Float64Array.from({ length: n }, (_, i) => Math.sqrt(weights ? weights[i] : 1));
  let x0;
  let tmin = Infinity, tmax = -Infinity;
  for (const t of times) { if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
  if (guess) x0 = guess.slice();
  else {
    const fhi = percentile(freqs, 97), flo = percentile(freqs, 3);
    const F0g = 2 * fhi * flo / (fhi + flo), vg = Math.max(20.0, c * (fhi - flo) / (fhi + flo));
    let jb = 0, bm = Infinity;
    for (let i = 0; i < n; i++) { const e = Math.abs(freqs[i] - 0.5 * (fhi + flo)); if (e < bm) { bm = e; jb = i; } }
    x0 = [F0g, vg, 1000.0, times[jb]];
  }
  const lb = [x0[0] * 0.5, 5.0, 30.0, tmin - 300], ub = [x0[0] * 2.0, 0.6 * c, 20000.0, tmax + 300];
  for (let k = 0; k < 4; k++) x0[k] = Math.min(ub[k] - 1e-6, Math.max(lb[k] + 1e-6, x0[k]));
  const clip = (p) => p.map((v, k) => Math.min(ub[k], Math.max(lb[k], v)));
  const fixK = fix && fix.d != null ? 2 : -1;
  if (fixK >= 0) x0[2] = fix.d;
  const pr = prior ? [[1, prior.v], [2, prior.d]].filter(([, q]) => q) : [];
  const nR = n + pr.length;
  const resid = (p, r) => {
    for (let i = 0; i < n; i++) r[i] = sw[i] * (straightLineF(times[i] - p[3], p[0], p[1], p[2], c) - freqs[i]);
    pr.forEach(([k, [lo, hi, sg]], j) => { const x = p[k]; r[n + j] = prior.scale * (x < lo ? lo - x : x > hi ? x - hi : 0) / sg; });
    return r;
  };
  const costOf = (r) => { let s = 0; for (let i = 0; i < nR; i++) s += 2 * (Math.sqrt(1 + r[i] * r[i]) - 1); return 0.5 * s; };
  const jac = (p, r, J) => { // forward differences
    const q = p.slice(), r2 = new Float64Array(nR);
    for (let k = 0; k < 4; k++) {
      if (k === fixK) { for (let i = 0; i < nR; i++) J[i * 4 + k] = 0; continue; }
      const h = 1e-7 * Math.max(1, Math.abs(p[k]));
      q[k] = p[k] + h; resid(q, r2); q[k] = p[k];
      for (let i = 0; i < nR; i++) J[i * 4 + k] = (r2[i] - r[i]) / h;
    }
  };
  const r = new Float64Array(nR), rt = new Float64Array(nR), J = new Float64Array(nR * 4);
  function lm(start) {
    let p = clip(start), mu = 1e-3;
    resid(p, r); let cost = costOf(r);
    for (let it = 0; it < maxIter; it++) {
      jac(p, r, J);
      const H = new Array(16).fill(0), g = [0, 0, 0, 0];
      for (let i = 0; i < nR; i++) {
        const w = 1 / Math.sqrt(1 + r[i] * r[i]); // rho'(r^2)
        for (let a = 0; a < 4; a++) {
          const ja = J[i * 4 + a];
          g[a] += w * r[i] * ja;
          for (let b = a; b < 4; b++) H[a * 4 + b] += w * ja * J[i * 4 + b];
        }
      }
      for (let a = 0; a < 4; a++) for (let b = 0; b < a; b++) H[a * 4 + b] = H[b * 4 + a];
      if (fixK >= 0) { for (let a = 0; a < 4; a++) { H[fixK * 4 + a] = 0; H[a * 4 + fixK] = 0; } H[fixK * 5] = 1; g[fixK] = 0; }
      let improved = false;
      for (let tries = 0; tries < 30; tries++) {
        const A = H.slice();
        for (let a = 0; a < 4; a++) A[a * 5] += mu * Math.max(H[a * 5], 1e-12);
        const dx = solveN(A, g.map((v) => -v), 4);
        if (!dx) { mu *= 10; continue; }
        const pn = clip(p.map((v, k) => v + dx[k]));
        resid(pn, rt);
        const cn = costOf(rt);
        if (cn < cost) {
          const rel = (cost - cn) / Math.max(cost, 1e-300);
          const step = pn.reduce((s, v, k) => Math.max(s, Math.abs(v - p[k]) / Math.max(1e-8, Math.abs(p[k]))), 0);
          p = pn; r.set(rt); cost = cn; mu = Math.max(mu / 3, 1e-12); improved = true;
          if (rel < 1e-12 || step < 1e-10) return { p, cost };
          break;
        }
        mu *= 4;
      }
      if (!improved) break;
    }
    return { p, cost };
  }
  let best = null;
  for (const dg of (fixK >= 0 ? [fix.d] : starts || [x0[2], 500.0, 1500.0, 3000.0])) {
    const xs = x0.slice(); xs[2] = dg;
    const res = lm(xs);
    if (!best || res.cost < best.cost) best = res;
  }
  const p = best.p;
  resid(p, r); jac(p, r, J);
  const JTJ = new Array(16).fill(0);
  for (let i = 0; i < nR; i++) {
    const sc = Math.pow(1 + r[i] * r[i], -1.5); // (J * (1+z)^-3/4)^T (...)
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) JTJ[a * 4 + b] += sc * J[i * 4 + a] * J[i * 4 + b];
  }
  const dof = Math.max(1, n - 4), s2 = 2 * best.cost / dof;
  if (fixK >= 0) { for (let a = 0; a < 4; a++) { JTJ[fixK * 4 + a] = 0; JTJ[a * 4 + fixK] = 0; } JTJ[fixK * 5] = 1; }
  const inv = invN(JTJ, 4);
  const cov = inv ? inv.map((v) => v * s2) : null;
  const sig = cov ? [0, 1, 2, 3].map((k) => Math.sqrt(cov[k * 5])) : [NaN, NaN, NaN, NaN];
  return { F0: p[0], v: p[1], d: p[2], t_c: p[3], t_cpa_audio: p[3] + p[2] / c,
    sigma: { F0: sig[0], v: sig[1], d: sig[2], t_c: sig[3] }, cov, rms_hz: Math.sqrt(s2), n, cost: best.cost,
    resid: Float64Array.from(r.subarray(0, n)) };
}

/** Contract Doppler event with generous ranges (fit.event_from_fit). */
export function eventFromFit(fit, vRel = 0.2, dRel = 0.4) {
  return { t_cpa_audio: fit.t_cpa_audio, F0: fit.F0, v_mps: [fit.v * (1 - vRel), fit.v * (1 + vRel)],
    cpa_m: [fit.d * (1 - dRel), fit.d * (1 + dRel)] };
}

// ---------------------------------------------------------------------------------------------------------------
// Honest pass fit for user-facing events (orchestrator requirement from real data, e.g. colsto event 1: a partial
// ridge that never reaches the asymptotes makes (v, d) nearly degenerate and a plain fit returns v 110-173 m/s):
//  * residual correlation (overlapping STFT frames) inflates the noise: k = (1+rho1)/(1-rho1) (lag-1 autocorr.);
//  * soft physical priors per class (speed envelope, audible CPA distance) as pseudo-residuals;
//  * profile likelihood over d (F0, v, t_c refitted) gives the 2-sigma (v, d) region (banana-shaped for partial curves);
//  * coverage = fraction of the full Doppler swing observed; 'poorly constrained' when < 0.8 or the profile is wide.
export const PHYS_PRIORS = { // [lo, hi, sigma outside]
  prop: { v: [30, 100, 10], d: [50, 4000, 1000] }, heli: { v: [20, 80, 10], d: [30, 3500, 1000] },
  jet: { v: [60, 300, 20], d: [200, 8000, 2000] }, unknown: { v: [20, 300, 15], d: [30, 6000, 1500] },
};

const asig = (x) => x / Math.sqrt(1 + x * x);
const opts_sys = { v: 0.15, d: 0.25, t: 1.5 }; // straight-line model error floor (relative v, d; seconds for t_cpa)

export function fitPass(times, freqs, { c = C_DEFAULT, cls = 'unknown', weights = null, profileN = 36 } = {}) {
  const n = times.length;
  const f0 = fitStraight(times, freqs, { c, weights });
  const ord = Array.from(times.keys()).sort((a, b) => times[a] - times[b]);
  let num = 0, den = 0;
  for (let k = 0; k < n; k++) { const r = f0.resid[ord[k]]; den += r * r; if (k) num += r * f0.resid[ord[k - 1]]; }
  const rho = Math.max(0, Math.min(0.98, den > 0 ? num / den : 0));
  const kInf = Math.min(100, (1 + rho) / (1 - rho));
  const s2eff = Math.max(1e-6, f0.rms_hz ** 2 * kInf);
  const P = PHYS_PRIORS[cls] || PHYS_PRIORS.unknown;
  const prior = { v: P.v, d: P.d, scale: Math.sqrt(s2eff) };
  const fit = fitStraight(times, freqs, { c, weights, prior, guess: [f0.F0, f0.v, f0.d, f0.t_c], starts: [f0.d, 500, 1500, 3000] });
  const cov = fit.cov ? fit.cov.map((v) => v * kInf) : null;
  const sigma = cov ? { F0: Math.sqrt(cov[0]), v: Math.sqrt(cov[5]), d: Math.sqrt(cov[10]), t_c: Math.sqrt(cov[15]) } : fit.sigma;
  // profile over d (log grid); Delta chi^2 = 2 Delta cost / s2eff <= 4 (2 sigma)
  const dGrid = Array.from({ length: profileN }, (_, i) => 30 * Math.pow(20000 / 30, i / (profileN - 1)));
  // profile on a decimated ridge (<= 600 points, correlated anyway); costs rescaled to the full point count
  const stride = Math.max(1, Math.ceil(n / 600));
  const pt = stride > 1 ? times.filter((_, i) => i % stride === 0) : times, pf = stride > 1 ? freqs.filter((_, i) => i % stride === 0) : freqs;
  const pw = weights && stride > 1 ? weights.filter((_, i) => i % stride === 0) : weights;
  const scaleN = n / pt.length;
  const fitD = stride > 1 ? fitStraight(pt, pf, { c, weights: pw, prior: { ...prior, scale: prior.scale / Math.sqrt(scaleN) }, guess: [fit.F0, fit.v, fit.d, fit.t_c], starts: [fit.d] }) : fit;
  const prof = dGrid.map((d) => {
    const g = [fit.F0, Math.min(0.59 * c, Math.max(5.5, fit.v * Math.sqrt(d / fit.d))), d, fit.t_c];
    const r0 = fitStraight(pt, pf, { c, weights: pw, prior: { ...prior, scale: prior.scale / Math.sqrt(scaleN) }, guess: g, fix: { d }, maxIter: 150 });
    const r = { ...r0, cost: fit.cost + (r0.cost - fitD.cost) * scaleN };
    return { d, v: r.v, F0: r.F0, t_c: r.t_c, t_cpa_audio: r.t_cpa_audio, cost: r.cost };
  });
  const cmin = Math.min(fit.cost, ...prof.map((q) => q.cost));
  const dchi = (q) => 2 * (q.cost - cmin) / s2eff;
  const inside = prof.filter((q) => dchi(q) <= 4);
  const ext = (k, x) => [Math.min(x, ...inside.map((q) => q[k])), Math.max(x, ...inside.map((q) => q[k]))];
  const dR = ext('d', fit.d), vR = ext('v', fit.v), tR = ext('t_cpa_audio', fit.t_cpa_audio);
  const b = fit.v / c, tau0 = fit.d * Math.sqrt(1 - b * b) / fit.v;
  let tmin = Infinity, tmax = -Infinity;
  for (const t of times) { if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
  const coverage = 0.5 * (asig((tmax - fit.t_c) / tau0) - asig((tmin - fit.t_c) / tau0));
  const reasons = [];
  if (coverage < 0.8) reasons.push(`only ${(100 * coverage).toFixed(0)} % of the Doppler swing is observed (asymptotes not reached)`);
  if (sigma.v / fit.v > 0.15) reasons.push(`speed uncertain (1 sigma ${(100 * sigma.v / fit.v).toFixed(0)} %)`);
  if (sigma.d / fit.d > 0.3) reasons.push(`CPA distance uncertain (1 sigma ${(100 * sigma.d / fit.d).toFixed(0)} %)`);
  if (dR[1] >= dGrid[dGrid.length - 2] || dR[0] <= dGrid[1]) reasons.push('CPA distance not bounded by the data at 2 sigma');
  if (f0.v < P.v[0] - P.v[2] || f0.v > P.v[1] + P.v[2] || f0.d > P.d[1] + P.d[2])
    reasons.push(`unconstrained fit (v ${f0.v.toFixed(0)} m/s, d ${f0.d.toFixed(0)} m) is outside the ${cls} envelope; physical prior applied`);
  // total uncertainty = statistical (inflated) (+) straight-line model error. The model error floor (15 % v, 25 % d,
  // 1.5 s t_cpa; Lane A: passes inside a turn are biased by up to -23 % v / -27 % d) grows as 1/coverage^2 when the
  // asymptotes are not observed. Suggested ranges = 2-sigma total (+) 2-sigma profile region (+) the usual +-20/40 %.
  const cv = Math.max(0.2, coverage), grow = 1 / (cv * cv);
  const sv = Math.hypot(sigma.v, opts_sys.v * fit.v * grow), sd = Math.hypot(sigma.d, opts_sys.d * fit.d * grow);
  const st = Math.hypot(sigma.t_c, sd / c, opts_sys.t * grow);
  const sigma_total = { v: sv, d: sd, t_cpa_audio: st, F0: Math.hypot(sigma.F0, 0.01 * fit.F0) };
  const ranges = {
    v_mps: [Math.max(5, Math.min(vR[0], fit.v - 2 * sv, 0.8 * fit.v)), Math.max(vR[1], fit.v + 2 * sv, 1.2 * fit.v)],
    cpa_m: [Math.max(10, Math.min(dR[0], fit.d - 2 * sd, 0.6 * fit.d)), Math.max(dR[1], fit.d + 2 * sd, 1.4 * fit.d)],
    t_cpa_audio: [Math.min(tR[0], fit.t_cpa_audio - 2 * st), Math.max(tR[1], fit.t_cpa_audio + 2 * st)],
  };
  return { ...fit, sigma, sigma_total, ranges, cov,
    unconstrained: { F0: f0.F0, v: f0.v, d: f0.d, t_c: f0.t_c, t_cpa_audio: f0.t_cpa_audio, rms_hz: f0.rms_hz },
    profile: { d: dR, v: vR, t_cpa_audio: tR, points: prof.map((q) => ({ d: q.d, v: q.v, t_cpa_audio: q.t_cpa_audio, dchi2: dchi(q) })) },
    quality: { coverage, poorly_constrained: reasons.length > 0, reasons, corr_inflation: kInf, n_eff: n / kInf, rho1: rho } };
}
