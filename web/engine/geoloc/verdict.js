// D11: absolute fit-quality test of a candidate ("is this a plausible match at all?"), complementing the margin
// (which only compares candidates with each other).
//
// Per event e of the candidate (observer o, flight f_e, T_start, F0_e):
//  * spectrogram permutation null: the same predicted curve is scored at N_t random time shifts (25-240 s away, both
//    signs) and at N_f F0 offsets (4-12 %), each re-maximised over the same local delta x rho sweep as the candidate.
//    z_e = (s_e - median_null) / (1.4826 MAD_null). A real match lies far above its own shifted copies; a curve that
//    merely fits broadband clutter or a stationary hum does not.
//  * ridge (if the event carries its tracked ridge): RMS misfit at the candidate vs the median misfit of the shifted
//    copies (ratio_e; ~1 = the flight explains the ridge no better than a random time does), and vs the ridge's own
//    noise (q_e = RMS / self-noise, the self-noise being the residual of a local quadratic over +-1 s).
// Combined: z = sum_e z_e / sqrt(E). Verdict: 'match' | 'weak' | 'no plausible match', with reasons.
import { cpa } from './doppler.js';
import { makeScoreContext, simulate, arange } from './score.js';

export const VERDICT_DEFAULTS = Object.freeze({
  n_shift: 40, shift_min: 25, shift_max: 240, f0_offsets: [-0.12, -0.09, -0.06, -0.04, 0.04, 0.06, 0.09, 0.12],
  delta_half: 1.0, delta_step: 0.25, f0_rel: 0.01, f0_step: 0.0025, tau_step: 0.25,
  z_match: 5.0, z_weak: 2.0, ratio_match: 0.15, ratio_none: 0.6, sigma_floor: 0.02, seed: 12345,
  montage_match_frac: 0.6, montage_weak_frac: 0.3,
});

const median = (a) => { const s = Float64Array.from(a).sort(); const n = s.length; return n ? (n & 1 ? s[n >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2])) : NaN; };
const mad = (a, m) => median(a.map((x) => Math.abs(x - m)));

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Ridge self-noise: RMS of log f around a local quadratic over +-1 s (relative units). */
export function ridgeSelfNoise(ridge, half = 1.0) {
  const t = ridge.map((p) => p[0]), y = ridge.map((p) => Math.log(p[1])), n = t.length;
  let s2 = 0, m = 0, lo = 0;
  for (let i = 0; i < n; i++) {
    while (t[lo] < t[i] - half) lo++;
    let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0, Y0 = 0, Y1 = 0, Y2 = 0, k = 0;
    for (let j = lo; j < n && t[j] <= t[i] + half; j++) {
      const x = t[j] - t[i], x2 = x * x; S0++; S1 += x; S2 += x2; S3 += x2 * x; S4 += x2 * x2; Y0 += y[j]; Y1 += x * y[j]; Y2 += x2 * y[j]; k++;
    }
    if (k < 6) continue;
    // solve the 3x3 normal equations for the value at x = 0 (Cramer)
    const D = S0 * (S2 * S4 - S3 * S3) - S1 * (S1 * S4 - S3 * S2) + S2 * (S1 * S3 - S2 * S2);
    if (Math.abs(D) < 1e-30) continue;
    const a = (Y0 * (S2 * S4 - S3 * S3) - S1 * (Y1 * S4 - S3 * Y2) + S2 * (Y1 * S3 - S2 * Y2)) / D;
    const r = y[i] - a; s2 += r * r * k / Math.max(1, k - 3); m++;
  }
  return m ? Math.sqrt(s2 / m) : NaN;
}

/**
 * tracks: built tracks; o: observer ENU; cand: {fidx[], F0[], t_start_unix | t_start_by_event[]}; events: [{ridge?}];
 * Z, spec: whitened spectrogram (contract meta); cfg: search config (robust: snr weighting). Returns verdict object.
 */
export function absoluteTest(tracks, o, cand, events, Z, spec, cfg, opts = {}) {
  const P = { ...VERDICT_DEFAULTS, ...opts };
  const ctx = makeScoreContext(tracks, Z, spec, cfg);
  const tau = arange(-cfg.tau_half, cfg.tau_half, P.tau_step);
  const dLoc = arange(-P.delta_half, P.delta_half, P.delta_step), rLoc = arange(-P.f0_rel, P.f0_rel, P.f0_step);
  const rnd = mulberry32(P.seed);
  const mk = () => ({ trx: new Float64Array(ctx.maxTau), ratio: new Float64Array(ctx.maxTau), w: new Float64Array(ctx.maxTau), R: new Float64Array(ctx.maxTau),
    nAct: 0, sumW: 0, lrAll: new Float64Array(ctx.maxTau), tAll0: 0, stepAll: 1, nAll: 0 });
  const simW = mk();
  const sim = { trx: new Float64Array(ctx.maxTau), ratio: new Float64Array(ctx.maxTau), w: new Float64Array(ctx.maxTau), R: new Float64Array(ctx.maxTau),
    nAct: 0, sumW: 0, lrAll: new Float64Array(ctx.maxTau), tAll0: 0, stepAll: 1, nAll: 0 };
  const perEvent = [];
  const reasons = [];
  for (let e = 0; e < cand.fidx.length; e++) {
    if (cand.fidx[e] < 0) { perEvent.push({ event: e, flight: null, score: 0, z: null, audible: false, status: cand.t_start_by_event ? 'bad' : 'unexplained', unexplained: true }); continue; }
    const f = cand.fidx[e], T = cand.t_start_by_event ? cand.t_start_by_event[e] : cand.t_start_unix, F0 = cand.F0[e];
    // the pass the search used (a leg may pass the observer several times: circuits); global CPA as fallback
    const tdc = cand.tdcpa?.[e] ?? cpa(tracks[f], [o], cfg.c).t_dcpa[0];
    simulate(ctx, sim, f, o[0], o[1], o[2], tdc, tau, P.tau_step);
    const scoreAt = (sT, F) => { // local sweep max, same as the candidate's own refinement
      if (!sim.nAct) return 0;
      let best = -Infinity;
      for (const d of dLoc) for (const r of rLoc) { const v = curveScoreSim(ctx, sim, sT + d, F * (1 + r)); if (v > best) best = v; }
      return best;
    };
    const s0 = scoreAt(T, F0);
    // null shifts must keep the predicted curve inside the recording (montage clips are only 20-30 s long):
    // feasible range from the audible span of the curve vs the spectrogram span; exclusion zone around 0
    const specA = spec.t0, specB = spec.t0 + (spec.nT - 1) * spec.dt;
    const spanA = sim.nAct ? sim.trx[0] - T : 0, spanB = sim.nAct ? sim.trx[sim.nAct - 1] - T : 0, span = Math.max(1, spanB - spanA);
    const lo = Math.max(-P.shift_max, specA - spanA - 0.5 * span), hi = Math.min(P.shift_max, specB - spanB + 0.5 * span);
    const excl = Math.min(P.shift_min, Math.max(3, 0.25 * span));
    const nullS = [], shifts = [];
    for (let j = 0; j < 4 * P.n_shift && shifts.length < P.n_shift; j++) {
      const sh = lo + rnd() * (hi - lo);
      if (Math.abs(sh) < excl) continue;
      shifts.push(sh); nullS.push(scoreAt(T + sh, F0));
    }
    for (const fo of P.f0_offsets) nullS.push(scoreAt(T, F0 * (1 + fo)));
    for (let j = 0; j < 16; j++) {            // mixed (small shift, F0 offset) copies
      const fo = (rnd() < 0.5 ? -1 : 1) * (0.04 + 0.08 * rnd()), sh = (rnd() - 0.5) * 2 * excl;
      nullS.push(scoreAt(T + sh, F0 * (1 + fo)));
    }
    const med = median(nullS), sc = Math.max(1.4826 * mad(nullS, med), P.sigma_floor);
    const z = (s0 - med) / sc;
    let ngw = 0; for (let i = 0; i < sim.nAct; i++) if (sim.gw && sim.gw[i] < 1) ngw++;
    const row = { flight: tracks[f].id, curve_gap_fraction: sim.nAct ? +(ngw / sim.nAct).toFixed(2) : 0, score: +s0.toFixed(3), null_median: +med.toFixed(3), null_sigma: +sc.toFixed(3), z: +z.toFixed(2), audible: sim.nAct > 0 };
    const rg = events[e]?.ridge;
    if (rg && rg.length >= 8) {
      const st = Math.max(1, Math.ceil(rg.length / 150)), pts = rg.filter((_, i) => i % st === 0);
      const R = { t: Float64Array.from(pts, (p) => p[0]), lf: Float64Array.from(pts, (p) => Math.log(p[1])) };
      // wide rho grid covering the ridge at every shift (the scoring window is only +-tau_half): fair null
      const tr0 = Math.min(...R.t) + T, tr1 = Math.max(...R.t) + T;
      const half = Math.max(Math.abs(tr0 - P.shift_max - 5 - tdc), Math.abs(tr1 + P.shift_max + 5 - tdc));
      const stepW = Math.max(0.5, (2 * half) / (ctx.maxTau - 2));
      simulate(ctx, simW, f, o[0], o[1], o[2], tdc, arange(-half, half, stepW), stepW);
      const full = (sh) => { let m = Infinity; for (const d of dLoc) m = Math.min(m, robustMisfit(simW, R, T + sh + d)); return m; };
      const st0 = {};
      let rms = Infinity;
      for (const d of dLoc) rms = Math.min(rms, robustMisfit(simW, R, T + d, 0.7, st0));
      row.gap_fraction = st0.n ? +(st0.gap / st0.n).toFixed(2) : 0;
      const nullR = shifts.map((sh) => full(sh)).filter(Number.isFinite);
      const medR = nullR.length >= 5 ? median(nullR) : NaN, self = ridgeSelfNoise(rg);
      row.ridge_rms = Number.isFinite(rms) ? +rms.toFixed(5) : null; row.ridge_null_median = Number.isFinite(medR) ? +medR.toFixed(5) : null;
      if (rms !== rms) { row.ridge_ratio = null; row.ridge_in_gap = true; }   // NaN: ridge mostly inside an ADS-B gap
      else if (!Number.isFinite(rms)) { row.ridge_ratio = null; row.ridge_uncovered = true; }
      else row.ridge_ratio = Number.isFinite(medR) ? +(rms / medR).toFixed(3) : null;
      row.ridge_self_noise = +self.toFixed(5); row.ridge_q = +(rms / Math.max(self, 0.002)).toFixed(2);
    }
    perEvent.push(row);
  }
  const E = perEvent.length, zs = perEvent.filter((r) => r.z != null), zc = zs.reduce((a, r) => a + r.z, 0) / Math.sqrt(Math.max(1, zs.length));
  const zmin = zs.length ? Math.min(...zs.map((r) => r.z)) : -Infinity;   // every explained event must be explained well
  const ratios = perEvent.filter((r) => r.ridge_ratio != null).map((r) => r.ridge_ratio);
  const uncovered = perEvent.filter((r) => r.ridge_uncovered);
  const worstRatio = ratios.length ? Math.max(...ratios) : null;
  const scoreSum = zs.reduce((a, r) => a + r.score, 0);
  // per-event status. With a tracked ridge the ridge misfit decides (on cluttered real audio it is the sharper test,
  // Lane A colsto); without one the spectrogram permutation z decides.
  for (const r of perEvent) {
    if (r.unexplained) { if (r.status !== 'unexplained') r.status = 'bad'; }
    // D16: an unverifiable ridge (mostly inside an ADS-B gap) is no supporting evidence: the event falls back on its
    // spectrogram evidence, capped at 'moderate'; an uncovered ridge (track absent at the ridge times) stays 'bad'
    else if (r.ridge_in_gap) r.status = r.z < P.z_weak || !(r.score > 0) ? 'bad' : 'moderate';
    else if (r.ridge_uncovered) r.status = 'bad';
    else if (r.ridge_ratio != null) r.status = r.ridge_ratio <= P.ratio_match ? 'good' : r.ridge_ratio > P.ratio_none ? 'bad' : 'moderate';
    else r.status = r.z >= P.z_match && r.score > 0 ? 'good' : r.z < P.z_weak || !(r.score > 0) ? 'bad' : 'moderate';
  }
  let verdict;
  const bad = perEvent.filter((r) => r.status === 'bad'), mod = perEvent.filter((r) => r.status === 'moderate');
  const good = perEvent.filter((r) => r.status === 'good');
  const unex = perEvent.filter((r) => r.status === 'unexplained'), nEx = perEvent.length - unex.length;
  if (!E) verdict = 'no plausible match';
  else if (cand.t_start_by_event && E >= 3) {
    // montage: clips are independent pieces of evidence; one unexplained clip must not veto the others
    const fg = good.length / E, fgm = (good.length + 0.5 * mod.length) / E;   // moderate clips count half (D16)
    verdict = fg >= P.montage_match_frac ? 'match' : fgm >= P.montage_weak_frac ? 'weak' : 'no plausible match';
    reasons.push(`montage: ${good.length} of ${E} clips explained well, ${mod.length} moderately, ${bad.length} not (match needs >= ${Math.round(100 * P.montage_match_frac)} % good, weak >= ${Math.round(100 * P.montage_weak_frac)} %, moderate counting half)`);
  }
  else if (!nEx) verdict = 'no plausible match';
  else if (bad.length) verdict = 'no plausible match';
  else if (mod.length) verdict = 'weak';
  else verdict = 'match';
  // D13: a single explained event with unknown T_start is km-ambiguous (the solution set is a pair of curves
  // parallel to the track, MATH.md section 10): never more than 'weak'
  if (verdict === 'match' && nEx === 1 && !P.known_t) {
    verdict = 'weak';
    reasons.push('only one explained event and T_start unknown: the position is ambiguous along the track (km scale); a known start time or a second event is needed');
  }
  // leaving events unexplained adds model freedom (any subset may be dropped): one verdict level more conservative
  if (unex.length && !cand.t_start_by_event) {
    const lowered = verdict === 'match' ? 'weak' : 'no plausible match';
    if (lowered !== verdict) reasons.push(`verdict lowered from '${verdict}' to '${lowered}' because events were left unexplained`);
    verdict = lowered;
  }
  if (unex.length) reasons.push(`${unex.length} of ${E} events left unexplained (no ADS-B flight fits them at this T_start: aircraft without ADS-B?): events ${unex.map((r) => r.event + 1).join(', ')}; the verdict uses the ${nEx} explained ones`);
  for (const r of perEvent) {
    const who = `event flight ${r.flight}`;
    if (r.unexplained) continue;
    if (r.gap_fraction > 0.2) reasons.push(`${who}: ${Math.round(100 * r.gap_fraction)} % of its ridge falls inside ADS-B gaps (track interpolated kinematically, weight reduced)`);
    if (r.ridge_in_gap) reasons.push(`${who}: the ridge lies mostly inside an ADS-B gap: unverifiable, so the event rests on its spectrogram evidence (z = ${r.z.toFixed(1)}, ${r.status})`);
    else if (r.ridge_uncovered) reasons.push(`${who}: its track does not cover the time span of the tracked ridge`);
    else if (r.ridge_ratio != null) {
      reasons.push(`${who}: ridge misfit ${r.ridge_ratio.toFixed(2)} x its time-shifted null (${r.status}; match <= ${P.ratio_match}, none > ${P.ratio_none})`);
      if (r.z < P.z_weak) reasons.push(`${who}: spectrogram evidence weak (z = ${r.z.toFixed(1)} vs its shifted copies), the ridge carries the match`);
    } else reasons.push(`${who}: spectrogram z = ${r.z.toFixed(1)} vs its time/F0-shifted copies (${r.status}; match >= ${P.z_match}, none < ${P.z_weak})` + (r.score > 0 ? '' : ', score <= 0'));
  }
  for (const r of perEvent) if (!r.audible && !r.unexplained) reasons.push(`event flight ${r.flight}: predicted curve outside the audible range`);
  return { verdict, n_explained: nEx, unexplained_events: unex.map((r) => r.event), z: +zc.toFixed(2), z_min: +zmin.toFixed(2), worst_ridge_ratio: worstRatio, reasons, events: perEvent };
}

/** Robust ridge misfit: 1.4826 MAD of log f_ridge - log rho(t_rx) (F0 profiled by the median). Ridge points where
 * the track is not valid (e.g. ADS-B starts at lift-off while the ridge includes the ground roll) are skipped;
 * >= minCover of the points must be covered, else Infinity ('uncovered'). */
function robustMisfit(sim, R, sT, minCover = 0.7, stat = null) {
  const { lrAll, tAll0, stepAll, nAll, gapAll } = sim, n = R.t.length, res = [];
  let ng = 0;
  for (let i = 0; i < n; i++) {
    const x = (sT + R.t[i] - tAll0) / stepAll;
    if (!(x >= 0 && x <= nAll - 1)) continue;
    const i0 = Math.min(Math.floor(x), nAll - 2), a = x - i0, l0 = lrAll[i0], l1 = lrAll[i0 + 1];
    if (l0 !== l0 || l1 !== l1) continue;
    if (gapAll && (gapAll[i0] || gapAll[i0 + 1])) { ng++; continue; }   // D14: inside an ADS-B gap -> unknown
    res.push(R.lf[i] - (l0 + a * (l1 - l0)));
  }
  if (stat) { stat.gap = ng; stat.n = n; stat.used = res.length; }
  if (ng > 0.7 * n) return NaN;   // mostly inside an uncertain gap: unverifiable
  if (res.length < Math.max(8, minCover * (n - ng))) return Infinity;
  const m = median(res);
  return 1.4826 * mad(res, m);
}

/** Weighted mean whitened value along the simulated curve at T_start sT and fundamental F (harmonics of cfg). */
function curveScoreSim(ctx, sim, sT, F) {
  const { Z, spec, cfg } = ctx, harm = cfg.harmonics, K = harm.length, weighted = cfg.weighting === 'snr';
  const t0 = spec.t0, dt = spec.dt, nT = spec.nT, nF = spec.nF, invdf = 1 / spec.df, f0n = spec.f0 * invdf;
  let num = 0;
  for (let i = 0; i < sim.nAct; i++) {
    const it = (sim.trx[i] - sT - t0) / dt;
    if (!(it >= 0 && it <= nT - 1)) continue;
    const i0 = Math.min(Math.floor(it), nT - 2), a = it - i0, w = weighted ? sim.w[i] : 1;
    for (let k = 0; k < K; k++) {
      const jf = harm[k] * F * sim.ratio[i] * invdf - f0n;
      if (!(jf >= 0 && jf <= nF - 1)) continue;
      const j0 = Math.min(jf | 0, nF - 2), b = jf - j0, o = i0 * nF + j0;
      const lo = Z[o] + b * (Z[o + 1] - Z[o]), hi = Z[o + nF] + b * (Z[o + nF + 1] - Z[o + nF]);
      num += w * (lo + a * (hi - lo));
    }
  }
  const den = (weighted ? sim.sumW : sim.nAct) * K;
  return den > 0 ? num / den : 0;
}
