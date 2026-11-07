// Stage 5-6 kernel: exact Doppler simulation from the track + multi-harmonic bilinear score swept over
// T_start offsets (delta) and per-event F0 (rho). Port of search.score_survivors / score_point.
// Tight loops over typed arrays; scratch buffers are allocated once per context.
//
// Two sweep strategies:
//   'full' (faithful, = Python): every (delta, rho) of the grid.
//   'c2f'  (robust default): every other delta and rho first; the penalised total (sum over events minus the
//          soft-prior penalty, computed here exactly as in search.js) picks the best 2 coarse deltas, then the fine
//          neighbours (delta +-1, rho +-1 around each event's coarse best) are evaluated. ~3-4x fewer samples.
//          Unevaluated deltas are returned as -1e9 so the caller's argmax never picks them.
import { emissionTime, trackRadius } from './doppler.js';
import { gapWeight } from './track.js';

export const arange = (a, b, step) => { // numpy arange(a, b + 1e-9, step)
  const n = Math.max(0, Math.ceil((b + 1e-9 - a) / step));
  const r = new Float64Array(n);
  for (let i = 0; i < n; i++) r[i] = a + i * step;
  return r;
};

export const UNEVALUATED = -1e9;
const softL1 = (chi2) => 2 * (Math.sqrt(1 + chi2) - 1);

/**
 * Soft-prior penalty of survivor s at absolute T_start Ts. pen: {lam, chiVD (S), Te (S*E), tSig (E), useOffset, prior}
 * (robust mode); null -> 0. Shared by the kernel (c2f choice) and search.js (final argmax).
 */
export function penaltyAt(pen, s, E, Ts) {
  if (!pen) return 0;
  let chi = pen.chiVD[s];
  if (pen.useOffset) for (let e = 0; e < E; e++) { const te = pen.Te[s * E + e]; if (te !== te) continue; const x = (te - Ts) / (pen.tSigSE ? pen.tSigSE[s * E + e] : pen.tSig[e]); chi += softL1(x * x); }
  if (pen.prior) { const [lo, hi, sg] = pen.prior; const o = Ts < lo ? lo - Ts : Ts > hi ? Ts - hi : 0; chi += softL1((o / sg) ** 2); }
  return 0.5 * pen.lam * chi;
}

/** Context shared by many kernel calls (one per worker). cfg: {c, audible, harmonics, tau_half, min_audible_s, score_norm}. */
export function makeScoreContext(tracks, Z, spec, cfg) {
  const maxTau = Math.ceil((2 * cfg.tau_half) / 0.05) + 2;
  return {
    tracks, Z, spec, cfg, maxTau,
    raud: tracks.map((t) => trackRadius(t, cfg)),
    sims: [],   // per-event simulation buffers {trx, ratio, nAct}
    rowOff: new Int32Array(maxTau), aT: new Float64Array(maxTau), rAct: new Float64Array(maxTau), wAct: new Float64Array(maxTau),
    out3: new Float64Array(3), buf6: new Float64Array(6), samples: 0,
  };
}

const simBuf = (ctx, e) => (ctx.sims[e] ||= { trx: new Float64Array(ctx.maxTau), ratio: new Float64Array(ctx.maxTau),
  w: new Float64Array(ctx.maxTau), R: new Float64Array(ctx.maxTau), nAct: 0, sumW: 0,
  lrAll: new Float64Array(ctx.maxTau), tAll0: 0, stepAll: 1, nAll: 0, gapAll: new Uint8Array(ctx.maxTau), gw: new Float64Array(ctx.maxTau) });

/**
 * Retarded-time simulation on the tau grid.
 * weighting 'none' (faithful): keep samples with R < audible radius, weight 1, >= min_audible_s or score 0.
 * weighting 'snr' (robust): matched filter with the predicted amplitude envelope. Weight
 *   w = max(0, 1 - [PL(R) - PL(R_min)] / D),  PL(R) = 20 log10 R + alpha R  (dB),
 * i.e. the ridge is expected to fade into the noise D dB below its CPA level; samples out to snr_rmax_factor x the
 * audible radius count. A far pass must then match over the long, slowly fading window it implies (a 3 km pass
 * cannot score only its loud centre), while a close pass is judged mostly near its CPA.
 */
export function simulate(ctx, sim, f, ox, oy, oz, tdcpa, tau, tauStep) {
  const { cfg, out3, buf6 } = ctx;
  if (f < 0) { sim.nAct = 0; sim.sumW = 0; sim.nAll = 0; return 0; }   // unexplained event (D13): scores 0
  const tr = ctx.tracks[f], c = cfg.c, { trx, ratio, w, R } = sim;
  const snr = cfg.weighting === 'snr';
  const rmax = snr ? ctx.raud[f] * (cfg.snr_rmax_factor ?? 2) : ctx.raud[f];
  let nAct = 0, rmin = Infinity;
  const lrAll = sim.lrAll, gapAll = sim.gapAll || (sim.gapAll = new Uint8Array(ctx.maxTau)), gw = sim.gw || (sim.gw = new Float64Array(ctx.maxTau));
  const hasGaps = !!(tr.gaps && tr.gaps.length);
  sim.tAll0 = tdcpa + tau[0]; sim.stepAll = tauStep; sim.nAll = tau.length;
  for (let i = 0; i < tau.length; i++) {
    const t = tdcpa + tau[i];
    const valid = emissionTime(tr, ox, oy, oz, t, c, out3, buf6);
    lrAll[i] = valid ? Math.log(c / (c - out3[2])) : NaN;   // log Doppler ratio on the full grid (ridge misfit)
    const gwt = hasGaps && valid ? gapWeight(tr, out3[0], cfg.gap_err_scale ?? 500, cfg.gap_min_s ?? 60) : 1;   // D14: trust of the track
    const ig = gwt < 0.5;                                    // emitted inside an uncertain ADS-B gap
    gapAll[i] = ig ? 1 : 0;
    if (valid && out3[1] < rmax) { trx[nAct] = t; ratio[nAct] = c / (c - out3[2]); R[nAct] = out3[1]; w[nAct] = 1; gw[nAct] = gwt; if (out3[1] < rmin) rmin = out3[1]; nAct++; }
  }
  let sumW = nAct;
  const renorm = cfg.gap_renorm === true;   // default: gap samples shrink toward zero evidence, the denominator is not re-weighted
  if (!snr && hasGaps) { sumW = 0; for (let i = 0; i < nAct; i++) { w[i] = gw[i]; sumW += renorm ? gw[i] : 1; } }
  if (snr && nAct) {
    const D = cfg.snr_range_db ?? 15, al = (cfg.snr_alpha_db_km ?? 3) / 1000, pl0 = 20 * Math.log10(Math.max(rmin, 30)) + al * rmin;
    let m = 0; sumW = 0;
    for (let i = 0; i < nAct; i++) {
      const w0 = 1 - (20 * Math.log10(Math.max(R[i], 30)) + al * R[i] - pl0) / D, wi = w0 * gw[i];
      if (w0 <= 0) continue;
      trx[m] = trx[i]; ratio[m] = ratio[i]; R[m] = R[i]; w[m] = wi; sumW += renorm ? wi : w0; m++;
    }
    nAct = m;
  }
  if (sumW * tauStep < (snr ? (cfg.snr_min_eff_s ?? 10) : cfg.min_audible_s)) { nAct = 0; sumW = 0; }  // short curves score 0
  sim.gapped = hasGaps;
  sim.nAct = nAct; sim.sumW = sumW;
  return nAct;
}

/** Prepare the time rows of one delta (shared by all rho/harmonics). Returns the number of samples inside. */
function prepDelta(ctx, sim, sT, delta) {
  const { spec, rowOff, aT, rAct, wAct } = ctx, { trx, ratio, nAct, w } = sim;
  const base = sT + delta + spec.t0, dt = spec.dt, nT = spec.nT, nF = spec.nF, nTm1 = nT - 1;
  let m = 0;
  for (let i = 0; i < nAct; i++) {
    const it = (trx[i] - base) / dt;
    if (it >= 0 && it <= nTm1) {
      let i0 = Math.floor(it); if (i0 > nT - 2) i0 = nT - 2;
      rAct[m] = ratio[i]; rowOff[m] = i0 * nF; aT[m] = it - i0; wAct[m] = w[i]; m++;
    }
  }
  return m;
}

/** Mean whitened value along k*F0*ratio for the prepared delta (m samples). */
function curveAt(ctx, m, F0, den) {
  const { Z, spec, rowOff, aT, rAct, wAct } = ctx, harm = ctx.cfg.harmonics, K = harm.length, weighted = ctx.cfg.weighting === 'snr' || ctx.weightedNow;
  const nF = spec.nF, invdf = 1 / spec.df, f0n = spec.f0 * invdf, nFm1 = nF - 1, nFm2 = nF - 2;
  let num = 0;
  for (let kk = 0; kk < K; kk++) {
    const sc = harm[kk] * F0 * invdf;
    for (let q = 0; q < m; q++) {
      const jf = sc * rAct[q] - f0n;
      if (jf >= 0 && jf <= nFm1) {
        let j0 = jf | 0; if (j0 > nFm2) j0 = nFm2;
        const a = aT[q], b = jf - j0, o = rowOff[q] + j0;
        const z0 = Z[o], z1 = Z[o + 1], z2 = Z[o + nF], z3 = Z[o + nF + 1];
        const lo = z0 + b * (z1 - z0), hi = z2 + b * (z3 - z2);
        num += weighted ? wAct[q] * (lo + a * (hi - lo)) : lo + a * (hi - lo);
      }
    }
  }
  return num / den;
}

const denOf = (ctx, sim) => { const K = ctx.cfg.harmonics.length, n = ctx.cfg.weighting === 'snr' || ctx.weightedNow ? sim.sumW : sim.nAct;
  return ctx.cfg.score_norm === 'sqrtN' ? Math.sqrt(n * K) : n * K; };

/** Best over rho indices [r0, r1] step rs at one delta. Writes [best, bestR] to out2. */
function bestOverRho(ctx, sim, sT, delta, F0s, r0, r1, rs, out2) {
  if (!sim.nAct) { out2[0] = 0; out2[1] = r0; return; }
  ctx.weightedNow = !!sim.gapped;   // gap-weighted samples also in 'none' weighting (D14)
  const m = prepDelta(ctx, sim, sT, delta), den = denOf(ctx, sim);
  let best = -Infinity, bestR = r0;
  for (let r = r0; r <= r1; r += rs) { const s = curveAt(ctx, m, F0s[r], den); ctx.samples += m; if (s > best) { best = s; bestR = r; } }
  out2[0] = best; out2[1] = bestR;
}

/** Full sweep for one (observer, flight, event): writes best-over-rho per delta into outS/outR at oS. */
export function scoreEvent(ctx, f, ox, oy, oz, tdcpa, sT, tau, tauStep, deltas, F0s, outS, outR, oS) {
  const sim = simBuf(ctx, 0);
  const nAct = simulate(ctx, sim, f, ox, oy, oz, tdcpa, tau, tauStep);
  const o2 = [0, 0];
  for (let d = 0; d < deltas.length; d++) {
    bestOverRho(ctx, sim, sT, deltas[d], F0s, 0, F0s.length - 1, 1, o2);
    outS[oS + d] = o2[0]; outR[oS + d] = o2[1];
  }
  return nAct;
}

/**
 * Ridge misfit (Lane A, colsto): RMS over the tracked ridge points of log f_ridge - log rho(t_rx), t_rx = sT + delta + t,
 * with F0 profiled out (the mean of the residual). Relative units (0.005 = 0.5 % of F0). Points outside the simulated
 * window are skipped; if fewer than half remain, returns `bad`.
 */
export function ridgeMisfit(sim, ridge, sT, delta, bad = 0.05, minFrac = 0.5) {
  const { lrAll, tAll0, stepAll, nAll, gapAll } = sim, n = ridge.t.length;
  let s1 = 0, s2 = 0, m = 0, ng = 0;
  for (let i = 0; i < n; i++) {
    const x = (sT + delta + ridge.t[i] - tAll0) / stepAll;
    if (!(x >= 0 && x <= nAll - 1)) continue;
    const i0 = Math.min(Math.floor(x), nAll - 2), a = x - i0, l0 = lrAll[i0], l1 = lrAll[i0 + 1];
    if (l0 !== l0 || l1 !== l1) continue;
    if (gapAll && (gapAll[i0] || gapAll[i0 + 1])) { ng++; continue; }   // inside an ADS-B gap: unknown, not a misfit
    const r = ridge.lf[i] - (l0 + a * (l1 - l0));
    s1 += r; s2 += r * r; m++;
  }
  if (m < Math.max(8, minFrac * (n - ng))) return ng > 0.5 * n ? 0.01 : bad;   // mostly in an uncertain gap: unverified (mild 1 % misfit)
  const mu = s1 / m;
  return Math.sqrt(Math.max(0, s2 / m - mu * mu));
}

/** Combined-objective ridge term (score units): mu * sum_e log(max(rms_e, floor) / ref). Lower misfit -> bonus. */
export function ridgeTerm(rr, mu, ref = 0.005, floor = 0.001) {
  let t = 0;
  for (const r of rr) t += Math.log(Math.max(r, floor) / ref);
  return mu * t;
}

const coarseIdx = (n) => { const r = []; for (let i = 0; i < n; i += 2) r.push(i); if (r[r.length - 1] !== n - 1) r.push(n - 1); return r; };

/**
 * Batch job (what a worker executes). job: {S, E, f:Int32Array(S*E), obs:Float64Array(3S), tdcpa:Float64Array(S*E),
 *  sT:Float64Array(S), F0:number[E], tau_step, delta:[lo, hi, step], f0_rel, f0_step, sweep:'full'|'c2f', pen}
 * Returns {nd, score: Float64Array(S*E*nd), rho: Int16Array(S*E*nd), evals} (index ((s*E)+e)*nd + d).
 */
export function scoreBatch(ctx, job, onTick) {
  const { S, E } = job;
  const tau = arange(-ctx.cfg.tau_half, ctx.cfg.tau_half, job.tau_step);
  const deltas = arange(job.delta[0], job.delta[1], job.delta[2]);
  const rho = arange(-job.f0_rel, job.f0_rel, job.f0_step);
  const F0s = job.F0.map((F) => Float64Array.from(rho, (r) => F * (1 + r)));
  const nd = deltas.length, nr = rho.length;
  const score = new Float64Array(S * E * nd), rhoI = new Int16Array(S * E * nd);
  const ridges = job.ridges && job.ridges.some(Boolean) ? job.ridges : null, mu = job.ridge_weight ?? 1;
  const mis = ridges ? new Float32Array(S * E * nd) : null, rrTmp = new Float64Array(E);
  const c2f = job.sweep === 'c2f' && nd >= 5 && nr >= 5;
  const dC = coarseIdx(nd), rCs = 2, o2 = [0, 0];
  const keepD = job.keep_deltas || 2;
  const samples0 = ctx.samples;
  const totC = new Float64Array(nd);
  for (let s = 0; s < S; s++) {
    const ox = job.obs[3 * s], oy = job.obs[3 * s + 1], oz = job.obs[3 * s + 2], sT = job.sT[s];
    for (let e = 0; e < E; e++) {
      const q = s * E + e;
      simulate(ctx, simBuf(ctx, e), job.f[q], ox, oy, oz, job.tdcpa[q], tau, job.tau_step);
      if (ridges) for (let d = 0; d < nd; d++) mis[q * nd + d] = ridges[e] && job.f[q] >= 0 ? ridgeMisfit(simBuf(ctx, e), ridges[e], sT, deltas[d]) : 0.005;
    }
    const ridgeAt = (d) => { if (!ridges) return 0; for (let e = 0; e < E; e++) rrTmp[e] = mis[(s * E + e) * nd + d]; return ridgeTerm(rrTmp, mu); };
    if (!c2f) {
      for (let e = 0; e < E; e++) {
        const q = s * E + e, sim = simBuf(ctx, e);
        for (let d = 0; d < nd; d++) {
          bestOverRho(ctx, sim, sT, deltas[d], F0s[e], 0, nr - 1, 1, o2);
          score[q * nd + d] = o2[0]; rhoI[q * nd + d] = o2[1];
        }
      }
    } else {
      score.fill(UNEVALUATED, s * E * nd, (s + 1) * E * nd);
      // stage A: coarse delta x coarse rho
      for (const d of dC) {
        let tot = 0;
        for (let e = 0; e < E; e++) {
          const q = s * E + e;
          bestOverRho(ctx, simBuf(ctx, e), sT, deltas[d], F0s[e], 0, nr - 1, rCs, o2);
          // last rho index may be skipped by the stride: include it
          if ((nr - 1) % rCs) { const b = o2.slice(); bestOverRho(ctx, simBuf(ctx, e), sT, deltas[d], F0s[e], nr - 1, nr - 1, 1, o2); if (b[0] >= o2[0]) { o2[0] = b[0]; o2[1] = b[1]; } }
          score[q * nd + d] = o2[0]; rhoI[q * nd + d] = o2[1];
          tot += o2[0];
        }
        totC[d] = tot - penaltyAt(job.pen, s, E, sT + deltas[d]) - ridgeAt(d);
      }
      // stage B: fine neighbours of the best coarse deltas
      const best = dC.slice().sort((a, b) => totC[b] - totC[a] || a - b).slice(0, keepD);
      for (const dc of best) {
        for (let d = Math.max(0, dc - 1); d <= Math.min(nd - 1, dc + 1); d++) {
          for (let e = 0; e < E; e++) {
            const q = s * E + e, rc = rhoI[q * nd + dc];
            bestOverRho(ctx, simBuf(ctx, e), sT, deltas[d], F0s[e], Math.max(0, rc - 1), Math.min(nr - 1, rc + 1), 1, o2);
            if (o2[0] > score[q * nd + d]) { score[q * nd + d] = o2[0]; rhoI[q * nd + d] = o2[1]; }
          }
        }
      }
    }
    if (onTick && (s & 15) === 15) onTick(s + 1, S);
  }
  return { nd, score, rho: rhoI, mis, evals: (ctx.samples - samples0) * ctx.cfg.harmonics.length };
}
