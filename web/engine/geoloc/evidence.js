// D8: physically motivated extra evidence for the top distinct candidates, independent of the Doppler-curve score.
// Evaluated after the search (cheap: ~10 candidates); the result re-ranks candidates and refines the margin.
//
// For a candidate (observer r_o, assigned flights, T_start, F0 per event) and the RAW dB spectrogram (contract):
//  1. Received level of each event along its predicted curve near the CPA, in dB above the per-bin median noise:
//       L_e = max_k mean_{|tau| < 8 s} [S(t, k F0 rho(t)) - median_bin],   (best harmonic, bilinear in dB)
//  2. Implied source level  Ls_e = L_e + PL(d_e),  PL(d) = 20 log10(d / 1 m) + alpha d   (spherical + excess loss).
//     Different aircraft differ by ~ +-6 dB, so  chi2_level = sum_e (Ls_e - mean Ls)^2 / sigma_Ls^2  (E >= 2).
//     A hypothesis that puts a loud-looking event at 3 km and a faint one at 800 m is penalised.
//  3. Silence consistency over the whole clip: every unassigned flight whose delayed CPA falls inside the
//     recording within r_check of the candidate should be heard at  L_pred = mean Ls - PL(d_f).  Its curve is
//     searched (free F0 in [60, 250] Hz); if L_pred exceeds the detection level but nothing is there, add
//     chi2 = ((L_pred - L_det) / sigma_Ls)^2 (soft, one-sided).
// The evidence is combined as  score_ev = score - lambda_ev/2 * sum soft-L1(chi2)  (same convention as the priors).
import { emissionTime, cpa, audibleRadius } from './doppler.js';
import { median32 } from './spectro.js';

export const EVIDENCE_DEFAULTS = Object.freeze({
  alpha_db_per_km: 3.0, sigma_ls_db: 6.0, lambda: 0.1, r_check: 8000, l_det_db: 6.0,
  cpa_window_s: 8, f_search: [60, 250], z_seen: 1.0,
});

/** Per-bin noise median of the raw dB spectrogram (cached on the spec object). */
function binMedian(spec) {
  if (spec._binMedian) return spec._binMedian;
  const { nT, nF, data } = spec, col = new Float32Array(nT), med = new Float32Array(nF);
  for (let j = 0; j < nF; j++) { for (let i = 0; i < nT; i++) col[i] = data[i * nF + j]; med[j] = median32(col, nT); }
  Object.defineProperty(spec, '_binMedian', { value: med, enumerable: false });
  return med;
}

function bilin(spec, arr, t, f) {
  const it = (t - spec.t0) / spec.dt, jf = (f - spec.f0) / spec.df, nT = spec.nT, nF = spec.nF;
  if (!(it >= 0 && it <= nT - 1 && jf >= 0 && jf <= nF - 1)) return NaN;
  const i0 = Math.min(Math.floor(it), nT - 2), j0 = Math.min(Math.floor(jf), nF - 2), a = it - i0, b = jf - j0, o = i0 * nF + j0;
  return (1 - a) * ((1 - b) * arr[o] + b * arr[o + 1]) + a * ((1 - b) * arr[o + nF] + b * arr[o + nF + 1]);
}

/** Predicted curve (audio time, ratio, R) of flight tr at observer o, |tau| <= half around its delayed CPA. */
function curve(tr, o, T_start, c, half, step) {
  const k = cpa(tr, [o], c), t_dcpa = k.t_dcpa[0], out = [], o3 = new Float64Array(3), b6 = new Float64Array(6);
  for (let tau = -half; tau <= half + 1e-9; tau += step) {
    const trx = t_dcpa + tau;
    if (!emissionTime(tr, o[0], o[1], o[2], trx, c, o3, b6)) continue;
    out.push([trx - T_start, c / (c - o3[2]), o3[1], tau]);
  }
  return { pts: out, d: k.d_cpa[0], t_dcpa: t_dcpa };
}

/** Mean level (dB above bin median) of harmonic k along the curve within |tau| < w; and mean z if Z given. */
function levelAlong(spec, med, pts, F0, k, w) {
  let s = 0, n = 0;
  for (const [t, ratio, , tau] of pts) {
    if (Math.abs(tau) > w) continue;
    const f = k * F0 * ratio, v = bilin(spec, spec.data, t, f);
    if (!Number.isFinite(v)) continue;
    const jf = (f - spec.f0) / spec.df, j0 = Math.min(Math.floor(jf), spec.nF - 2), b = jf - j0;
    s += v - ((1 - b) * med[j0] + b * med[j0 + 1]); n++;
  }
  return n ? s / n : NaN;
}

const softL1 = (x) => 2 * (Math.sqrt(1 + x) - 1);

/**
 * Evidence for one candidate. tracks: built tracks (same ENU frame as o = observer ENU), cand: {fidx[], t_start_unix, F0[]},
 * spec: RAW dB spectrogram (contract), duration: s, opts: EVIDENCE_DEFAULTS overrides. Returns {chi2_level, chi2_silence, penalty, detail}.
 */
export function candidateEvidence(tracks, o, cand, spec, duration, { c = 343, harmonics = [1, 2, 3, 4], ...opt } = {}) {
  const P = { ...EVIDENCE_DEFAULTS, ...opt };
  const med = binMedian(spec);
  const PL = (d) => 20 * Math.log10(Math.max(d, 1)) + P.alpha_db_per_km * d / 1000;
  const ev = cand.fidx.map((f, e) => ({ f, e })).filter(({ f }) => f >= 0).map(({ f, e }) => {
    const cv = curve(tracks[f], o, cand.t_start_unix, c, P.cpa_window_s, 0.25);
    const L = Math.max(...harmonics.map((k) => levelAlong(spec, med, cv.pts, cand.F0[e], k, P.cpa_window_s)).filter(Number.isFinite), -99);
    return { flight: tracks[f].id, d: cv.d, L, Ls: L + PL(cv.d) };
  });
  const E = ev.length, mLs = ev.reduce((a, q) => a + q.Ls, 0) / E;
  let chiL = 0;
  if (E >= 2) for (const q of ev) chiL += softL1(((q.Ls - mLs) / P.sigma_ls_db) ** 2);
  // silence consistency
  const used = new Set(cand.fidx), sil = [];
  let chiS = 0;
  tracks.forEach((tr, f) => {
    if (used.has(f) || tr.category === 'jet') return;
    const k = cpa(tr, [o], c), d = k.d_cpa[0], ta = k.t_dcpa[0] - cand.t_start_unix;
    if (d > P.r_check || ta < 0 || ta > duration) return;
    const Lpred = mLs - PL(d);
    if (Lpred < P.l_det_db) return;
    // is there a curve? best mean level over a coarse F0 search (fundamental and 2nd harmonic)
    const cv = curve(tr, o, cand.t_start_unix, c, 15, 0.5);
    let seen = -99;
    for (let F0 = P.f_search[0]; F0 <= P.f_search[1]; F0 *= 1.01) {
      for (const h of [1, 2]) { const L = levelAlong(spec, med, cv.pts, F0, h, 15); if (L > seen) seen = L; }
    }
    // a pure-noise curve maximised over ~140 F0 values reaches a few dB; require the prediction to exceed it
    const deficit = Lpred - Math.max(seen, P.l_det_db);
    const x = deficit > 0 ? softL1((deficit / P.sigma_ls_db) ** 2) : 0;
    chiS += x;
    sil.push({ flight: tr.id, d: Math.round(d), t_audio: Math.round(ta), L_pred: +Lpred.toFixed(1), L_seen: +seen.toFixed(1), chi: +x.toFixed(2) });
  });
  const penalty = 0.5 * P.lambda * (chiL + chiS);
  return { chi2_level: chiL, chi2_silence: chiS, penalty,
    detail: { events: ev.map((q) => ({ flight: q.flight, d: Math.round(q.d), L_db: +q.L.toFixed(1), Ls_db: +q.Ls.toFixed(1) })), silence: sil } };
}
