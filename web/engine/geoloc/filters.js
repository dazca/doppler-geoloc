// Stage 4 filters: speed / CPA distance per event, time offset (events locked by geometry), silence,
// optional T_start window. Port of search.apply_filters ('faithful' mode) plus the Lane-A-recommended
// soft-prior mode ('robust'): generous hard gates for pruning only, Gaussian penalties added to the score.
import { audibleRadius, trackRadius } from './doppler.js';
import { evalTrack, gapLength } from './track.js';

/** soft-L1 of a chi^2 term: 2(sqrt(1+chi2)-1). Quadratic near 0, linear for large deviations. */
export const softL1 = (chi2) => 2 * (Math.sqrt(1 + chi2) - 1);

/** Interval prior: zero inside [lo, hi], Gaussian outside with sigma. Returns chi^2. */
export const intervalChi2 = (x, lo, hi, sigma) => {
  const o = x < lo ? lo - x : x > hi ? x - hi : 0;
  return (o / sigma) ** 2;
};

/** Growable typed buffer. */
class Buf {
  constructor(T, cap = 1024) { this.T = T; this.a = new T(cap); this.n = 0; }
  push(v) { if (this.n === this.a.length) { const b = new this.T(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; }
  get() { return this.a.subarray(0, this.n); }
}

/** Per-event hard gates. faithful mode or ev.locked: the entered ranges. robust: the union of the widened entered
 * range and the physical envelope of the event class, so that a badly conditioned fit can never prune the truth. */
export function eventGates(events, cfg) {
  const robust = cfg.mode === 'robust', soft = cfg.soft;
  return events.map((ev) => {
    const [v0, v1] = ev.v_mps, [d0, d1] = ev.cpa_m;
    if (!robust || ev.locked) return { v0, v1, d0, d1 };
    const cls = ev.cls || 'unknown', pv = soft.phys_v[cls] || soft.phys_v.unknown;
    // CPA distance: never beyond the class's physical audibility (1.34 x audible radius: 4 km for props), even when
    // a poorly constrained fit suggests a much wider range (the range itself still acts as a soft penalty)
    const dMax = cfg.audible_engine ? (soft.phys_d_class[cls] ?? soft.phys_d_class.unknown) : soft.phys_d_factor * audibleRadius(cls, cfg.audible);
    return { v0: Math.min(v0 * soft.v_gate[0], pv[0]), v1: Math.max(v1 * soft.v_gate[1], pv[1]),
      d0: Math.min(d0 * soft.d_gate[0], soft.phys_d_min), d1: dMax };
  });
}

/**
 * tab: sparse CSR (cpa_sparse.toCSR) {ptr, f, d_cpa, speed, t_dcpa}, entries of a point sorted by t_dcpa.
 * events: [{t_cpa_audio, v_mps, cpa_m, cls?, locked?, t_sigma_s?, v_est?, d_est?}].
 * Per grid point and anchor entry (event 0) the other events are matched by binary search on the sorted delayed-CPA
 * times (O(k log k) per point, k = flights within reach there) instead of a scan over all flights.
 * Returns survivors {S, E, n:Int32Array, assign:Int32Array(S*E), tdcpa:Float64Array(S*E), T:Float64Array(S),
 *   Te:Float64Array(S*E), chi2vd:Float64Array(S), capped}, in the reference order (anchor flight, then point).
 *   T  : T_start hypothesis (faithful: from event 0; robust: mean of the per-event implied T_start)
 *   Te : per-event implied T_start t_dcpa[f_e] - t_cpa_audio[e]  (offset residual = Te - T_start)
 */
export function applyFilters(tracks, tab, N, events, duration, cfg) {
  const E = events.length;
  const robust = cfg.mode === 'robust', soft = cfg.soft;
  const cand = tracks.map((t) => cfg.candidate_categories.includes(t.category));
  const raud = Float64Array.from(tracks, (t) => trackRadius(t, cfg));
  const gates = eventGates(events, cfg);
  // silence: faithful = hard veto (Python); robust = soft penalty per unassigned audible flight in the recording
  // (colsto truth has 2 such flights at 2.3 and 2.8 km, so a hard veto would remove it)
  const silChi = soft.silence_chi ?? 2.47, silMax = soft.silence_max ?? 3;
  // recording span in audio time (a montage clip searches only its own span)
  const wA = cfg.audio_window ? cfg.audio_window[0] : 0, wB = cfg.audio_window ? cfg.audio_window[1] : duration;
  let nv = 0;
  const vio = new Int32Array(16);
  const useVD = cfg.use_vd_filter;
  const { ptr, f: TF, d_cpa: TD, speed: TS, t_dcpa: TT, t_cpa: TCP } = tab;
  // optional restriction of the anchor (event 0) flight, e.g. montage refinement around a seed
  const anchorOk = cfg.anchor_flights ? (() => { const m = new Uint8Array(tracks.length); for (const f of cfg.anchor_flights) m[f] = 1; return m; })() : null;
  // per-event flight restriction (event.allowed_flights, e.g. from a tail-number hint)
  const allowE = events.map((ev) => { if (!ev.allowed_flights) return null; const m = new Uint8Array(tracks.length); for (const f of ev.allowed_flights) m[f] = 1; return m; });
  const okE = (e, q) => {
    if (!cand[TF[q]]) return false;
    if (allowE[e] && !allowE[e][TF[q]]) return false;
    if (e === 0 && anchorOk && !anchorOk[TF[q]]) return false;
    if (!useVD) return true;
    const g = gates[e], v = TS[q], d = TD[q];
    return v >= g.v0 && v <= g.v1 && d >= g.d0 && d <= g.d1;
  };
  // offset gate per event (robust: also >= 3 x the event's own time uncertainty t_sigma_s, if given);
  // the residual of event e is measured against the anchor event 0, so both uncertainties add
  const tSig = events.map((ev) => Math.max(soft.sigma_t, ev.t_sigma_s || 0));
  const tolE = events.map((ev, e) => !cfg.use_offset_filter ? 1e9 : !robust ? cfg.offset_tol
    : Math.max(soft.offset_gate, 3 * Math.hypot(tSig[e], tSig[0])));
  const ta = events.map((e) => e.t_cpa_audio);
  let prior = null;
  if (cfg.t_start_prior) {
    const [Tc, h] = cfg.t_start_prior;
    prior = robust ? [Tc - h - soft.prior_gate_extra, Tc + h + soft.prior_gate_extra] : [Tc - h, Tc + h];
  }
  const silences = cfg.silences || [];
  const lower = (lo, hi, t) => { while (lo < hi) { const m = (lo + hi) >> 1; if (TT[m] < t) lo = m + 1; else hi = m; } return lo; };
  const oN = new Buf(Int32Array), oA = new Buf(Int32Array), oTd = new Buf(Float64Array), oT = new Buf(Float64Array),
    oTe = new Buf(Float64Array), oC = new Buf(Float64Array), oKey = new Buf(Float64Array), oSg = new Buf(Float64Array);
  const asgQ = new Int32Array(E), asgF = new Int32Array(E), Te = new Float64Array(E);
  // D13 outlier events (robust): an event may stay unexplained (aircraft without ADS-B) at a fixed cost. Hypotheses
  // are seeded from every event as anchor and extended greedily; each one is counted once (its anchor is its first
  // explained event). At least min_explained events must be explained (2; 1 when T_start is known to +-120 s).
  const partial = cfg.allow_unexplained ?? (robust && E >= 2);
  const knownT = !!(cfg.t_start_prior && cfg.t_start_prior[1] <= 120);
  const minExpl = Math.min(E, cfg.min_explained ?? (knownT ? 1 : 2));
  const unexplChi = soft.unexplained_chi ?? 40;   // = 2 U / lambda, U = 1 score unit per unexplained event
  const isUsed = (fl) => { for (let e = 0; e < E; e++) if (asgF[e] === fl) return true; return false; };
  const tolAB = (e, a) => (!cfg.use_offset_filter ? 1e9 : !robust ? cfg.offset_tol
    : Math.max(soft.offset_gate, 3 * Math.hypot(tSig[e], tSig[a])));
  for (let n = 0; n < N; n++) {
    const p0 = ptr[n], p1 = ptr[n + 1];
    for (let A = 0; A < (partial ? E : 1); A++) {
      for (let qa = p0; qa < p1; qa++) {
        if (!okE(A, qa)) continue;
        const T0 = TT[qa] - ta[A];
        asgF.fill(-1); asgQ.fill(-1); Te.fill(NaN);
        asgQ[A] = qa; asgF[A] = TF[qa]; Te[A] = T0;
        let alive = true, nExpl = 1, dup = false;
        for (let e = 0; e < E && alive; e++) {
          if (e === A) continue;
          const tgt = T0 + ta[e], tol = tolAB(e, A);
          let best = -1, br = Infinity, bf = 0;
          for (let q = lower(p0, p1, tgt - tol); q < p1 && TT[q] <= tgt + tol; q++) {
            const fl = TF[q];
            if (isUsed(fl) || !okE(e, q)) continue;
            const r = Math.abs(TT[q] - tgt);
            if (r < br || (r === br && fl < bf)) { br = r; best = q; bf = fl; }
          }
          if (best >= 0) { asgQ[e] = best; asgF[e] = TF[best]; Te[e] = TT[best] - ta[e]; nExpl++; if (e < A) dup = true; }
          else if (!partial) alive = false;
        }
        if (!alive || dup || nExpl < minExpl) continue;
        let T = T0;
        if (robust) { T = 0; for (let e = 0; e < E; e++) if (asgF[e] >= 0) T += Te[e]; T /= nExpl; }
        if (prior && (T < prior[0] || T > prior[1])) continue;
        nv = 0;
        if (cfg.use_silence_filter) {
          let loud = false;
          for (let q = lower(p0, p1, T + wA); q < p1 && TT[q] <= T + wB; q++) {
            if (TD[q] < raud[TF[q]] && !isUsed(TF[q])) {
              if (!robust) { loud = true; break; }
              let seen = false; for (let k = 0; k < nv; k++) if (vio[k] === TF[q]) seen = true;
              if (!seen && nv < vio.length) vio[nv++] = TF[q];
            }
          }
          if (loud) continue;
        }
        if (silences.length) { // user-marked silent intervals (audio time): no unassigned audible flight may pass then
          let loud = false;
          for (let q = p0; q < p1 && !loud; q++) {
            if (TD[q] >= raud[TF[q]] || isUsed(TF[q])) continue;
            const t_ = TT[q] - T;
            for (const s of silences) if (t_ >= s.t0 && t_ <= s.t1) { loud = true; break; }
          }
          if (loud) continue;
        }
        let chi = robust ? silChi * Math.min(nv, silMax) + unexplChi * (E - nExpl) : 0; // soft-L1 terms 2(sqrt(1+x^2)-1)
        if (robust && useVD) {
          for (let e = 0; e < E; e++) {
            const ev = events[e], q = asgQ[e];
            if (ev.locked || q < 0) continue;
            const [v0, v1] = ev.v_mps, [d0, d1] = ev.cpa_m;
            const sv = Math.max(soft.sigma_v_rel * 0.5 * (v0 + v1), 0.5 * (v1 - v0));
            const sd = Math.max(soft.sigma_d_rel * 0.5 * (d0 + d1), 0.5 * (d1 - d0));
            // point estimates with sigma (honest ridge fit: Doppler-implied speed / CPA distance) beat ranges:
            // ADS-B ground speed at the CPA vs Doppler-implied speed, Gaussian (soft-L1)
            chi += ev.v_est ? softL1(((TS[q] - ev.v_est[0]) / ev.v_est[1]) ** 2) : softL1(intervalChi2(TS[q], v0, v1, sv));
            chi += ev.d_est ? softL1(((TD[q] - ev.d_est[0]) / ev.d_est[1]) ** 2) : softL1(intervalChi2(TD[q], d0, d1, sd));
          }
        }
        oN.push(n); oT.push(T); oC.push(chi); oKey.push(asgF[A] * N + n + A * 1e-3);
        for (let e = 0; e < E; e++) {
          oA.push(asgF[e]); oTe.push(Te[e]); oTd.push(asgQ[e] >= 0 ? TT[asgQ[e]] : NaN);
          // D14: CPA inside a long ADS-B gap -> the timing is uncertain: sigma_t >= gap length / 4
          const gl = robust && asgQ[e] >= 0 && TCP ? gapLength(tracks[asgF[e]], TCP[asgQ[e]]) : 0;
          oSg.push(Math.max(tSig[e], gl / 4));
        }
      }
    }
  }
  let S = oN.n;
  // reference order: anchor flight, then point (stable for equal keys)
  const key = oKey.get();
  const order = Array.from({ length: S }, (_, i) => i).sort((i, j) => key[i] - key[j] || i - j);
  const capped = 0;
  const take1 = (B, T) => { const a = B.get(), o = new T(S); for (let k = 0; k < S; k++) o[k] = a[order[k]]; return o; };
  const takeE = (B, T) => { const a = B.get(), o = new T(S * E); for (let k = 0; k < S; k++) for (let e = 0; e < E; e++) o[k * E + e] = a[order[k] * E + e]; return o; };
  return { S, E, n: take1(oN, Int32Array), assign: takeE(oA, Int32Array), tdcpa: takeE(oTd, Float64Array), T: take1(oT, Float64Array),
    Te: takeE(oTe, Float64Array), chi2vd: take1(oC, Float64Array), tsig: takeE(oSg, Float64Array), capped };
}

/** Subset of survivors (indices in order). */
export function selectSurvivors(surv, idx) {
  const E = surv.E, S = idx.length;
  const o = { S, E, n: new Int32Array(S), assign: new Int32Array(S * E), tdcpa: new Float64Array(S * E), T: new Float64Array(S),
    Te: new Float64Array(S * E), chi2vd: new Float64Array(S), tsig: surv.tsig ? new Float64Array(S * E) : null, capped: surv.capped || 0 };
  idx.forEach((i, k) => {
    o.n[k] = surv.n[i]; o.T[k] = surv.T[i]; o.chi2vd[k] = surv.chi2vd[i];
    for (let e = 0; e < E; e++) { o.assign[k * E + e] = surv.assign[i * E + e]; o.tdcpa[k * E + e] = surv.tdcpa[i * E + e]; o.Te[k * E + e] = surv.Te[i * E + e]; if (o.tsig) o.tsig[k * E + e] = surv.tsig[i * E + e]; }
  });
  return o;
}

/**
 * Silence veto from flights that cannot be candidates (e.g. jets): tab2 holds their sparse CPA entries, computed only
 * at the points that still have survivors. A survivor dies if one of them passes audibly (d < audible radius) during
 * its recording window [T, T + duration], or inside a user-marked silence.
 */
export function vetoSilence(surv, tab2, tracks, duration, cfg) {
  const raud = Float64Array.from(tracks, (t) => audibleRadius(t.category, cfg.audible)), silences = cfg.silences || [];
  const { ptr, f: TF, d_cpa: TD, t_dcpa: TT } = tab2, keep = [];
  for (let s = 0; s < surv.S; s++) {
    const n = surv.n[s], T = surv.T[s];
    let loud = false;
    for (let q = ptr[n]; q < ptr[n + 1] && !loud; q++) {
      if (TD[q] >= raud[TF[q]]) continue;
      const t = TT[q] - T;
      if (cfg.use_silence_filter && t >= 0 && t <= duration) loud = true;
      for (const si of silences) if (t >= si.t0 && t <= si.t1) loud = true;
    }
    if (!loud) keep.push(s);
  }
  return keep.length === surv.S ? surv : selectSurvivors(surv, keep);
}

/**
 * Survivor cap (robust; cfg.max_survivors, default 20000): rank by the cheap bound = prior penalty
 * (v/d terms + offset residuals); the curve score can only be computed for the kept ones.
 */
export function capSurvivors(surv, events, cfg, factor = 1) {
  const cap = factor * (cfg.max_survivors ?? (cfg.mode === 'robust' ? 20000 : Infinity));
  if (surv.S <= cap) return surv;
  const E = surv.E, soft = cfg.soft, tSig = events.map((ev) => Math.max(soft.sigma_t, ev.t_sigma_s || 0));
  const pen = new Float64Array(surv.S);
  for (let s = 0; s < surv.S; s++) {
    let chi = surv.chi2vd[s];
    for (let e = 0; e < E; e++) { const te = surv.Te[s * E + e]; if (te === te) chi += softL1(((te - surv.T[s]) / (surv.tsig ? surv.tsig[s * E + e] : tSig[e])) ** 2); }
    pen[s] = chi;
  }
  const keep = Array.from({ length: surv.S }, (_, i) => i).sort((i, j) => pen[i] - pen[j] || i - j).slice(0, cap).sort((i, j) => i - j);
  const o = selectSurvivors(surv, keep);
  o.capped = surv.S - keep.length;
  return o;
}

/**
 * Space-time index of the samples (every dtS seconds) of flights that can only veto (non-candidate classes, e.g. jets),
 * for the silence filter at scale. Buckets: (time slot of slotS seconds, square cell of cellM metres).
 */
export function buildVetoIndex(tracks, flights, window, { dtS = 2, slotS = 120, cellM = 6000 } = {}) {
  const X = [], Y = [], Zs = [], Te = [], Fi = [], b6 = new Float64Array(6);
  for (const f of flights) {
    const tr = tracks[f];
    const a = Math.max(tr.t0, window ? window[0] : -Infinity), z = Math.min(tr.t1, window ? window[1] : Infinity);
    for (let t = a; t <= z; t += dtS) { evalTrack(tr, t, b6); X.push(b6[0]); Y.push(b6[1]); Zs.push(b6[2]); Te.push(t); Fi.push(f); }
  }
  const map = new Map(), key = (s, cx, cy) => s * 1e8 + (cx + 5000) * 1e4 + (cy + 5000);
  for (let i = 0; i < X.length; i++) {
    const k = key(Math.floor(Te[i] / slotS), Math.floor(X[i] / cellM), Math.floor(Y[i] / cellM));
    let l = map.get(k); if (!l) map.set(k, (l = [])); l.push(i);
  }
  return { X: Float64Array.from(X), Y: Float64Array.from(Y), Z: Float64Array.from(Zs), T: Float64Array.from(Te), F: Int32Array.from(Fi),
    map, key, slotS, cellM, n: X.length };
}

/**
 * Silence veto with the index: survivor s (point obs[n], start T) dies if a veto flight is within its audible radius
 * while its sound arrives inside [T, T + duration] (or inside a user-marked silence): emission time t_e of a sample,
 * reception t_e + R/c. Sample-based (dt 2 s), i.e. "audible during the clip", not only "CPA during the clip".
 */
export function vetoSilenceIndexed(surv, idx, obs, tracks, duration, cfg) {
  if (!idx.n) return surv;
  const raud = Float64Array.from(tracks, (t) => trackRadius(t, cfg)), silences = cfg.silences || [];
  const c = cfg.c, { X, Y, Z, T: TE, F, map, key, slotS, cellM } = idx, keep = [];
  const wA = cfg.audio_window ? cfg.audio_window[0] : 0, wB = cfg.audio_window ? cfg.audio_window[1] : duration;
  const robust = cfg.mode === 'robust', silChi = cfg.soft.silence_chi ?? 2.47, silMax = cfg.soft.silence_max ?? 3;
  if (robust) {
    // soft: count distinct audible veto flights during the clip and add the silence penalty (no removal)
    const chi = Float64Array.from(surv.chi2vd);
    for (let s = 0; s < surv.S; s++) {
      const n = surv.n[s], T = surv.T[s], ox = obs[3 * n], oy = obs[3 * n + 1], oz = obs[3 * n + 2];
      const cx = Math.floor(ox / cellM), cy = Math.floor(oy / cellM);
      const s0 = Math.floor((T + wA - cellM * 1.5 / c) / slotS), s1 = Math.floor((T + wB) / slotS);
      const seen = new Set();
      for (let sl = s0; sl <= s1; sl++) for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const l = map.get(key(sl, cx + a, cy + b));
        if (!l) continue;
        for (const i of l) {
          if (seen.has(F[i])) continue;
          const dx = X[i] - ox, dy = Y[i] - oy, dz = Z[i] - oz, R = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (R >= raud[F[i]]) continue;
          const t = TE[i] + R / c - T;
          if ((cfg.use_silence_filter && t >= wA && t <= wB) || silences.some((si) => t >= si.t0 && t <= si.t1)) seen.add(F[i]);
        }
      }
      chi[s] += silChi * Math.min(seen.size, silMax);
    }
    return { ...surv, chi2vd: chi };
  }
  for (let s = 0; s < surv.S; s++) {
    const n = surv.n[s], T = surv.T[s], ox = obs[3 * n], oy = obs[3 * n + 1], oz = obs[3 * n + 2];
    const cx = Math.floor(ox / cellM), cy = Math.floor(oy / cellM);
    const s0 = Math.floor((T + wA - cellM * 1.5 / c) / slotS), s1 = Math.floor((T + wB) / slotS);
    let loud = false;
    for (let sl = s0; sl <= s1 && !loud; sl++) for (let a = -1; a <= 1 && !loud; a++) for (let b = -1; b <= 1 && !loud; b++) {
      const l = map.get(key(sl, cx + a, cy + b));
      if (!l) continue;
      for (const i of l) {
        const dx = X[i] - ox, dy = Y[i] - oy, dz = Z[i] - oz, R = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (R >= raud[F[i]]) continue;
        const t = TE[i] + R / c - T;
        if (cfg.use_silence_filter && t >= wA && t <= wB) { loud = true; break; }
        let hit = false;
        for (const si of silences) if (t >= si.t0 && t <= si.t1) hit = true;
        if (hit) { loud = true; break; }
      }
    }
    if (!loud) keep.push(s);
  }
  return keep.length === surv.S ? surv : selectSurvivors(surv, keep);
}
