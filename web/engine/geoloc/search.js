// End-to-end grid search (method stages 3-6). Port of ref/doppler_ref/search.run_search with:
//  - an executor abstraction (inline, or the Web Worker pool) for the two heavy kernels
//    (CPA tables; exact Doppler simulation + scoring),
//  - mode 'faithful' (= Python reference: hard filters) or 'robust' (soft priors, wide T_start sweep),
//  - distinct candidates with score margins.
import { AUDIBLE_R, ENGINE_R, audibleRadius, trackRadius } from './doppler.js';
import { evalTrack } from './track.js';
import { applyFilters, eventGates, capSurvivors, buildVetoIndex, vetoSilenceIndexed } from './filters.js';
import { arange, penaltyAt, UNEVALUATED, ridgeTerm } from './score.js';
import { createInlineExecutor } from './exec.js';
import { candidateEvidence } from './evidence.js';

export const DEFAULT_CONFIG = Object.freeze({
  c: 343.0, spacing: 200.0, radius: 10000.0, box_half: 12000.0, offset_tol: 8.0,
  audible: { ...AUDIBLE_R }, candidate_categories: ['prop', 'unknown', 'heli'], harmonics: [1, 2, 3, 4],
  tau_half: 60.0, tau_step: 0.5, delta_half: 4.0, delta_step: 0.5, f0_rel: 0.04, f0_step: 0.005, top_k: 6,
  // each refine level: [spacing, half_size, tau_step, delta_half, delta_step, f0_rel, f0_step]
  refine: [[100.0, 400.0, 0.25, 1.5, 0.25, 0.015, 0.0025], [50.0, 150.0, 0.25, 1.0, 0.125, 0.01, 0.0025]],
  use_vd_filter: true, use_offset_filter: true, use_silence_filter: true,
  t_start_prior: null,             // [T_center_unix, half_width_s]
  min_audible_s: 20.0, score_norm: 'mean',
  mode: 'faithful',                // 'faithful' (hard filters, = Python) | 'robust' (soft priors)
  soft: {
    v_gate: [0.7, 1.4], d_gate: [0.5, 2.0],   // hard pruning gates (multiplying the entered range ends)
    offset_gate: 30.0,                         // s, hard pruning gate on the per-event time-offset residual
    sigma_v_rel: 0.1, sigma_d_rel: 0.2,        // Gaussian penalty outside the entered ranges (x range centre)
    sigma_t: 8.0,                              // s, Gaussian penalty on each event's time-offset residual
    lambda: 0.05,                              // penalty = lambda/2 * sum_terms 2(sqrt(1+chi2)-1)
    delta_half_coarse: 12.0,                   // s, T_start sweep on the coarse grid
    prior_gate_extra: 10.0, prior_sigma_min: 1.0,
    seed_min_frac: 0.5,
    refine_tau: [0.5, 0.25],                   // tau step per refine level in robust mode (faithful: cfg.refine)                        // refine only seeds scoring >= 50 % of the level's best
    // physical envelopes used as the only hard v/d gates in robust mode (unless an event is `locked`)
    phys_v: { prop: [25, 110], heli: [0, 90], jet: [50, 320], unknown: [0, 320] },
    phys_d_factor: 1.34, phys_d_min: 30,      // d gate up to 1.34 x audible radius (no engine table)
    phys_d_class: { prop: 9500, heli: 6500, jet: 9500, unknown: 9500 },   // d gate by event class (engine table on)
    silence_chi: 2.47, silence_max: 3,
    unexplained_chi: 40,                       // D13: chi2 per unexplained event (= 2 U / lambda, U = 1 score unit)         // soft silence: chi2 per unassigned audible flight in the clip (robust)
  },
  prescreen: undefined,            // undefined -> robust: {min:64, keep_frac:0.2, keep_min:64}; null -> off
  recentre: null,                  // null -> 'global' (faithful) / 'per_seed' (robust)
  weighting: null,                 // null -> 'none' (faithful) / 'snr' (robust): predicted-envelope matched filter
  gap_err_scale: 500, gap_min_s: 60,   // D14: inside ADS-B gaps >= gap_min_s, curve-sample weight 1/(1+(err/scale)^2), err = kinematic end mismatch
  audible_engine: undefined,       // undefined -> robust: ENGINE_R (reach by engine type); faithful: null (3/6 km)
  ridge_weight: 1.0,               // combined objective: score - ridge_weight * sum_e log(ridge RMS_e / 0.5 %)
  snr_range_db: 15, snr_alpha_db_km: 3, snr_rmax_factor: 2, snr_min_eff_s: 10,
  evidence: undefined,             // robust + opts.rawSpec: loudness/silence evidence (evidence.js); null -> off
  sweep: null,                     // null -> 'full' (faithful) / 'c2f' (robust)
  distinct_m: 1000.0,              // separation of "distinct" candidates (and for the margin)
});

export function makeConfig(over = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...over, audible: { ...DEFAULT_CONFIG.audible, ...(over.audible || {}) },
    soft: { ...DEFAULT_CONFIG.soft, ...(over.soft || {}) } };
  if (cfg.weighting == null) cfg.weighting = cfg.mode === 'robust' ? 'snr' : 'none';
  if (cfg.audible_engine === undefined) cfg.audible_engine = cfg.mode === 'robust' ? { ...ENGINE_R } : null;
  return cfg;
}

const abortErr = () => (typeof DOMException !== 'undefined' ? new DOMException('Aborted', 'AbortError')
  : Object.assign(new Error('Aborted'), { name: 'AbortError' }));
const checkAbort = (signal) => { if (signal?.aborted) throw abortErr(); };

/** Points within `radius` (horizontal) of any sample (sx, sy) — bucket grid, exact distance test. */
export function proximityMask(xy, N, sx, sy, radius) {
  const cell = radius, buckets = new Map();
  for (let i = 0; i < sx.length; i++) {
    const k = Math.floor(sx[i] / cell) + ',' + Math.floor(sy[i] / cell);
    let b = buckets.get(k); if (!b) buckets.set(k, (b = [])); b.push(i);
  }
  const keep = new Uint8Array(N), r2 = radius * radius;
  for (let p = 0; p < N; p++) {
    const x = xy[2 * p], y = xy[2 * p + 1], cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    let hit = false;
    for (let a = -1; a <= 1 && !hit; a++) for (let b = -1; b <= 1 && !hit; b++) {
      const bk = buckets.get((cx + a) + ',' + (cy + b));
      if (!bk) continue;
      for (const i of bk) { const dx = sx[i] - x, dy = sy[i] - y; if (dx * dx + dy * dy <= r2) { hit = true; break; } }
    }
    keep[p] = hit ? 1 : 0;
  }
  return keep;
}

/** Square grid around (cx, cy) ENU -> {N, xy, lat, lon, elev, obs, ix, iy, nx}. dem: async (lat[], lon[]) -> elev[]. */
export async function makeGrid(enu, dem, cx, cy, half, spacing, { keep = null, mask = null } = {}) {
  const nx = Math.max(0, Math.ceil((2 * half + 1e-6) / spacing)); // numpy arange(-half, half+1e-6, spacing)
  const ax = Float64Array.from({ length: nx }, (_, i) => -half + i * spacing);
  let N = nx * nx, xy = new Float64Array(2 * N), ix = new Int32Array(N), iy = new Int32Array(N);
  for (let r = 0, p = 0; r < nx; r++) for (let q = 0; q < nx; q++, p++) { xy[2 * p] = cx + ax[q]; xy[2 * p + 1] = cy + ax[r]; ix[p] = q; iy[p] = r; }
  let sel = keep ? keep(xy, N) : null;
  if (mask) { const m = mask(xy, N); sel = sel ? sel.map((v, i) => v & m[i]) : m; }
  if (sel) {
    let M = 0; for (let p = 0; p < N; p++) M += sel[p] ? 1 : 0;
    const xy2 = new Float64Array(2 * M), ix2 = new Int32Array(M), iy2 = new Int32Array(M);
    for (let p = 0, k = 0; p < N; p++) if (sel[p]) { xy2[2 * k] = xy[2 * p]; xy2[2 * k + 1] = xy[2 * p + 1]; ix2[k] = ix[p]; iy2[k] = iy[p]; k++; }
    xy = xy2; ix = ix2; iy = iy2; N = M;
  }
  const lat = new Float64Array(N), lon = new Float64Array(N), tmp = new Float64Array(3);
  for (let p = 0; p < N; p++) { enu.inv(xy[2 * p], xy[2 * p + 1], 0, tmp); lat[p] = tmp[0]; lon[p] = tmp[1]; }
  const elev = N ? Float64Array.from(await dem(lat, lon)) : new Float64Array(0);
  const obs = new Float64Array(3 * N);
  for (let p = 0; p < N; p++) { enu.fwd(lat[p], lon[p], elev[p], tmp); obs[3 * p] = tmp[0]; obs[3 * p + 1] = tmp[1]; obs[3 * p + 2] = tmp[2]; }
  // lattice descriptor for the sparse CPA rasteriser (cpa_sparse.js)
  const idx = new Int32Array(nx * nx).fill(-1);
  for (let p = 0; p < N; p++) idx[iy[p] * nx + ix[p]] = p;
  const lattices = [{ x0: cx - half, y0: cy - half, s: spacing, nx, ny: nx, idx }];
  return { N, xy, lat, lon, elev, obs, nx, ix, iy, ax, lattices };
}

function concatGrids(gs) {
  const N = gs.reduce((a, g) => a + g.N, 0);
  const out = { N, xy: new Float64Array(2 * N), lat: new Float64Array(N), lon: new Float64Array(N),
    elev: new Float64Array(N), obs: new Float64Array(3 * N), lattices: [] };
  let o = 0;
  for (const g of gs) {
    out.xy.set(g.xy, 2 * o); out.lat.set(g.lat, o); out.lon.set(g.lon, o); out.elev.set(g.elev, o); out.obs.set(g.obs, 3 * o);
    for (const L of g.lattices) out.lattices.push({ ...L, idx: L.idx.map((v) => (v >= 0 ? v + o : -1)) });
    o += g.N;
  }
  return out;
}

/** Score survivors with the executor, combine per-event scores (sum) minus soft-prior penalties, argmax over delta. */
export async function scoreSurvivors(exec, grid, tab, events, surv, cfg, lv, hooks) {
  const { S, E } = surv, N = grid.N;
  const f = new Int32Array(S * E), tdcpa = new Float64Array(S * E), obs = new Float64Array(3 * S);
  for (let s = 0; s < S; s++) {
    const n = surv.n[s];
    obs[3 * s] = grid.obs[3 * n]; obs[3 * s + 1] = grid.obs[3 * n + 1]; obs[3 * s + 2] = grid.obs[3 * n + 2];
    for (let e = 0; e < E; e++) { const fl = surv.assign[s * E + e]; f[s * E + e] = fl; tdcpa[s * E + e] = surv.tdcpa[s * E + e]; }
  }
  const robust = cfg.mode === 'robust', soft = cfg.soft;
  let prior = null;
  if (robust && cfg.t_start_prior) {
    const [Tc, h] = cfg.t_start_prior;
    prior = [Tc - h, Tc + h, Math.max(soft.prior_sigma_min, h)];
  }
  const tSig = events.map((ev) => Math.max(soft.sigma_t, ev.t_sigma_s || 0));
  const pen = robust ? { lam: soft.lambda, chiVD: surv.chi2vd, Te: surv.Te, tSig, tSigSE: surv.tsig || null, useOffset: cfg.use_offset_filter, prior } : null;
  const sweep = cfg.sweep ?? (robust ? 'c2f' : 'full');
  // ridge misfit (Lane A): tracked ridge points (fundamental) per event, <= 150 points, as log f
  const ridges = robust && cfg.ridge_weight ? events.map((ev) => {
    const r = ev.ridge; if (!r || r.length < 8) return null;
    const st = Math.max(1, Math.ceil(r.length / 150)), pts = r.filter((_, i) => i % st === 0);
    return { t: Float64Array.from(pts, (p) => p[0]), lf: Float64Array.from(pts, (p) => Math.log(p[1])) };
  }) : null;
  const job = { S, E, f, obs, tdcpa, sT: surv.T, F0: events.map((e) => e.F0), tau_step: lv.tau_step,
    delta: [-lv.delta_half, lv.delta_half, lv.delta_step], f0_rel: lv.f0_rel, f0_step: lv.f0_step, sweep, pen,
    ridges: ridges && ridges.some(Boolean) ? ridges : null, ridge_weight: cfg.ridge_weight };
  const r = await exec.score(job, hooks);
  scoreSurvivors.evals = (scoreSurvivors.evals || 0) + (r.evals || 0);
  if (globalThis.process?.env?.GEOLOC_DEBUG) console.log(`[score] S=${S} E=${E} tau=${lv.tau_step} delta=+-${lv.delta_half}/${lv.delta_step} rho=+-${lv.f0_rel}/${lv.f0_step} sweep=${sweep} samples=${((r.evals || 0) / 1e6).toFixed(1)}M`);
  const deltas = arange(-lv.delta_half, lv.delta_half, lv.delta_step), nd = r.nd;
  const rho = arange(-lv.f0_rel, lv.f0_rel, lv.f0_step);
  const out = { S, score: new Float64Array(S), raw: new Float64Array(S), penalty: new Float64Array(S),
    delta: new Float64Array(S), T_start: new Float64Array(S), F0: new Float64Array(S * E),
    event_scores: new Float64Array(S * E), offset_resid: new Float64Array(S * E), ridge_rms: r.mis ? new Float64Array(S * E) : null };
  const rr = new Float64Array(E);
  for (let s = 0; s < S; s++) {
    let best = -Infinity, bd = 0, bRaw = 0, bPen = 0;
    for (let d = 0; d < nd; d++) {
      let tot = 0;
      for (let e = 0; e < E; e++) tot += r.score[(s * E + e) * nd + d];
      if (tot <= UNEVALUATED) continue;
      let pn = penaltyAt(pen, s, E, surv.T[s] + deltas[d]);
      if (r.mis) { for (let e = 0; e < E; e++) rr[e] = r.mis[(s * E + e) * nd + d]; pn += ridgeTerm(rr, cfg.ridge_weight); }
      const v = tot - pn;
      if (v > best) { best = v; bd = d; bRaw = tot; bPen = pn; }
    }
    out.score[s] = best; out.raw[s] = bRaw; out.penalty[s] = bPen; out.delta[s] = deltas[bd];
    out.T_start[s] = surv.T[s] + deltas[bd];
    for (let e = 0; e < E; e++) {
      const q = (s * E + e) * nd + bd;
      out.event_scores[s * E + e] = r.score[q];
      out.F0[s * E + e] = events[e].F0 * (1 + rho[r.rho[q]]);
      if (out.ridge_rms) out.ridge_rms[s * E + e] = r.mis[q];
      out.offset_resid[s * E + e] = surv.Te[s * E + e] - out.T_start[s];   // NaN for an unexplained event
    }
  }
  return out;
}

/** Subset of survivors (indices) as a new survivor set. */
function subSurv(surv, idx) {
  const E = surv.E, S = idx.length;
  const o = { S, E, n: new Int32Array(S), assign: new Int32Array(S * E), T: new Float64Array(S), Te: new Float64Array(S * E), chi2vd: new Float64Array(S), tdcpa: new Float64Array(S * E), tsig: surv.tsig ? new Float64Array(S * E) : null };
  idx.forEach((i, k) => {
    o.n[k] = surv.n[i]; o.T[k] = surv.T[i]; o.chi2vd[k] = surv.chi2vd[i];
    for (let e = 0; e < E; e++) { o.assign[k * E + e] = surv.assign[i * E + e]; o.Te[k * E + e] = surv.Te[i * E + e]; o.tdcpa[k * E + e] = surv.tdcpa[i * E + e]; if (o.tsig) o.tsig[k * E + e] = surv.tsig[i * E + e]; }
  });
  return o;
}

/**
 * Coarse-level scoring. With cfg.prescreen (default in robust mode) and many survivors: a cheap pass
 * (tau 1 s, delta 1 s, F0 1 %) ranks everything, then the full sweep runs only on the top fraction plus the best
 * survivor of every distinct 800 m cluster. Non-rescored survivors keep min(cheap score, lowest full score).
 */
async function scoreCoarse(exec, grid, tab, events, surv, cfg, lv, hooks) {
  const ps = cfg.prescreen !== undefined ? cfg.prescreen : (cfg.mode === 'robust' ? { min: 64, keep_frac: 0.2, keep_min: 64 } : null);
  if (!ps || surv.S <= ps.min) return scoreSurvivors(exec, grid, tab, events, surv, cfg, lv, hooks);
  const cheapLv = { ...lv, tau_step: Math.max(1.0, lv.tau_step), delta_step: Math.max(1.0, lv.delta_step), f0_step: Math.max(0.01, lv.f0_step) };
  const cheap = await scoreSurvivors(exec, grid, tab, events, surv, cfg, cheapLv,
    { signal: hooks.signal, onProgress: (q) => hooks.onProgress?.(0.3 * q) });
  const order = argsortDesc(cheap.score);
  const M = Math.min(surv.S, Math.max(ps.keep_min, Math.ceil(ps.keep_frac * surv.S)));
  const keep = new Set(order.slice(0, M));
  for (const i of pickDistinct(grid.xy, (i) => surv.n[i], order, 4 * cfg.top_k, 2 * (cfg.refine[0]?.[1] ?? 400))) keep.add(i);
  const idx = [...keep].sort((a, b) => a - b);
  // full sweep only around each kept survivor's cheap-pass T_start (coarse-to-fine on the delta axis)
  const sub = subSurv(surv, idx);
  idx.forEach((i, k) => { sub.T[k] = cheap.T_start[i]; });
  const lvFull = ps.recentre === false ? lv : { ...lv, delta_half: Math.max(3 * lv.delta_step, cheapLv.delta_step * 1.5) };
  const full = await scoreSurvivors(exec, grid, tab, events, sub, cfg, lvFull,
    { signal: hooks.signal, onProgress: (q) => hooks.onProgress?.(0.3 + 0.7 * q) });
  let minFull = Infinity;
  for (let k = 0; k < idx.length; k++) minFull = Math.min(minFull, full.score[k]);
  const out = cheap; // overwrite rescored entries in place
  const E = surv.E;
  for (let i = 0; i < surv.S; i++) out.score[i] = Math.min(out.score[i], minFull - 1e-9);
  idx.forEach((i, k) => {
    for (const key of ['score', 'raw', 'penalty', 'T_start']) out[key][i] = full[key][k];
    out.delta[i] = full.T_start[k] - surv.T[i];
    for (let e = 0; e < E; e++) for (const key of ['F0', 'event_scores', 'offset_resid', 'ridge_rms']) if (out[key] && full[key]) out[key][i * E + e] = full[key][k * E + e];
  });
  out.n_rescored = idx.length;
  return out;
}

const argsortDesc = (a) => Array.from(a.keys()).sort((i, j) => a[j] - a[i] || i - j);

function pickDistinct(xy, idxOf, order, k, minSep) {
  const chosen = [];
  for (const i of order) {
    const p = idxOf(i);
    if (chosen.every((j) => { const q = idxOf(j); return Math.hypot(xy[2 * p] - xy[2 * q], xy[2 * p + 1] - xy[2 * q + 1]) >= minSep; })) chosen.push(i);
    if (chosen.length >= k) break;
  }
  return chosen;
}

function candidateFrom(grid, surv, res, i, tracks, level) {
  const n = surv.n[i], E = surv.E;
  const fidx = Array.from(surv.assign.subarray(i * E, i * E + E));
  return {
    lat: grid.lat[n], lon: grid.lon[n], elev_m: grid.elev[n], score: res.score[i], flights: fidx.map((f) => (f >= 0 ? tracks[f].id : null)),
    unexplained: fidx.map((f, e) => (f < 0 ? e : -1)).filter((e) => e >= 0),
    t_start_unix: res.T_start[i], F0: Array.from(res.F0.subarray(i * E, i * E + E)),
    event_scores: Array.from(res.event_scores.subarray(i * E, i * E + E)),
    raw_score: res.raw[i], penalty: res.penalty[i],
    offset_resid_s: Array.from(res.offset_resid.subarray(i * E, i * E + E)),
    ridge_rms: res.ridge_rms ? Array.from(res.ridge_rms.subarray(i * E, i * E + E)) : null,
    xy: [grid.xy[2 * n], grid.xy[2 * n + 1]], level_m: level, fidx,
    tdcpa: surv.tdcpa ? Array.from(surv.tdcpa.subarray(i * E, i * E + E)) : null,   // the pass the search used
  };
}

/**
 * Core search. tracks: built tracks (track.js). dem: async (lat Float64Array, lon Float64Array) -> elevations.
 * events: [{t_cpa_audio, F0, v_mps, cpa_m}] ordered; Z/spec: whitened spectrogram (spectro.js); enu: frame (geo.js);
 * center: [lat, lon] of the search square. opts: {exec, signal, onProgress, mask: (xy, N) -> Uint8Array, topN}.
 */
export async function runSearchCore(tracks, dem, events, Z, spec, enu, center, duration, cfgIn = {}, opts = {}) {
  const cfg = makeConfig(cfgIn);
  const { signal, onProgress = () => {} } = opts;
  const exec = opts.exec || createInlineExecutor();
  const topN = opts.topN || 10;
  const timings = {}, survivorsByStage = {};
  const now = () => performance.now();
  const prog = (stage, frac, extra = {}) => onProgress({ stage, frac, ...extra });
  let t0 = now();
  scoreSurvivors.evals = 0;
  await exec.init(tracks, Z, spec, cfg);
  timings.init = now() - t0;
  checkAbort(signal);

  // Stage 3a: grid support (points within cfg.radius of candidate tracks sampled every 5 s) + DEM
  t0 = now();
  prog('grid', 0, { message: 'building grid' });
  const sx = [], sy = [], b6 = new Float64Array(6);
  for (const t of tracks) {
    if (!cfg.candidate_categories.includes(t.category)) continue;
    for (let k = 0; ; k++) { const tt = t.t0 + 5.0 * k; if (tt >= t.t1) break; evalTrack(t, tt, b6); sx.push(b6[0]); sy.push(b6[1]); }
  }
  const c3 = enu.fwd(center[0], center[1], 0);
  const grid = await makeGrid(enu, dem, c3[0], c3[1], cfg.box_half, cfg.spacing,
    { keep: (xy, N) => proximityMask(xy, N, sx, sy, cfg.radius), mask: opts.mask });
  const N = grid.N;
  timings.grid_dem = now() - t0;
  survivorsByStage.grid = N;
  prog('grid', 1, { survivors: N, total: grid.nx * grid.nx, message: `${N} grid points at ${cfg.spacing} m` });
  checkAbort(signal);

  // Stage 3b: CPA / delayed-CPA tables
  t0 = now();
  // per-flight reach (audible radius for the silence filter; largest accepted CPA distance for candidates) and
  // the time window in which a delayed CPA can matter (T_start window + clip)
  const gatesD = eventGates(events, cfg).reduce((m, g) => Math.max(m, g.d1), 0);
  // robust: reach = engine-aware audible radius of the flight (piston 4 km, turboprop 9 km, ...), capped by the
  // event gates; faithful: max(category audible radius, gate) as in the reference
  const rmax = Float64Array.from(tracks, (t) => 1.01 * (cfg.audible_engine ? Math.min(trackRadius(t, cfg), Math.max(gatesD, trackRadius(t, cfg) * (cfg.candidate_categories.includes(t.category) ? 1 : 1)))
    : Math.max(audibleRadius(t.category, cfg.audible), cfg.candidate_categories.includes(t.category) ? gatesD : 0)));
  let window = null;
  if (cfg.t_start_prior) {
    const [Tc, h] = cfg.t_start_prior, x = cfg.mode === 'robust' ? cfg.soft.prior_gate_extra : 0, pad = 600;
    window = [Tc - h - x - pad, Tc + h + x + duration + pad];
  }
  // two-phase CPA: candidate classes on the whole grid; the other flights (jets) only veto (silence filter), so they
  // are rasterised only at points that still have survivors and only if their time span can overlap a recording
  const isCand = tracks.map((t) => cfg.candidate_categories.includes(t.category));
  const rmaxC = rmax.map((r, f) => (isCand[f] ? r : 0));
  const vetoFlights = tracks.map((_, f) => f).filter((f) => !isCand[f]);
  let vetoIdx = null;
  const cpaOpts = { rmax: rmaxC, window };
  const nnzV = { n: 0 };
  const tm = { cpa: 0, filters: 0, veto: 0 };
  async function cpaFilter(g, evs, hooks = {}) {
    let t1 = now();
    const tabG = await exec.cpa(g, { ...cpaOpts, signal, ...hooks });
    tm.cpa = now() - t1; t1 = now();
    let sv = applyFilters(tracks, tabG, g.N, evs, duration, cfg);
    tm.filters = now() - t1; t1 = now();
    tm.pre = sv.S;
    if (vetoFlights.length && sv.S) {
      // non-candidate flights (jets) only veto: space-time index of their samples, checked per survivor window;
      // pre-cap at 3x the survivor cap so the veto cost stays bounded
      sv = capSurvivors(sv, evs, cfg, 3);
      vetoIdx ||= buildVetoIndex(tracks, vetoFlights, window ? [window[0] - 60, window[1] + 60] : null,
        { cellM: Math.max(...vetoFlights.map((f) => trackRadius(tracks[f], cfg))) });
      nnzV.n = vetoIdx.n;
      sv = vetoSilenceIndexed(sv, vetoIdx, g.obs, tracks, duration, cfg);
    }
    tm.veto = now() - t1;
    return { tab: tabG, surv: capSurvivors(sv, evs, cfg) };
  }
  const { tab, surv } = await cpaFilter(grid, events, { onProgress: (fr) => prog('cpa', fr) });
  timings.cpa = tm.cpa; timings.filters = tm.filters; timings.veto = tm.veto;
  survivorsByStage.filters_before_veto_cap = tm.pre; survivorsByStage.veto_samples = nnzV.n;
  survivorsByStage.cpa = tab.nnz;
  prog('cpa', 1, { survivors: tab.nnz, message: `${tab.nnz.toLocaleString()} (point, flight) pairs within reach (${N} points x ${tracks.length} flights)` });
  checkAbort(signal);

  // Stage 4
  survivorsByStage.filters = surv.S;
  prog('filters', 1, { survivors: surv.S, message: `${surv.S} (point, flight assignment) survivors` + (surv.capped ? ` (cap: ${surv.capped} with the weakest priors dropped)` : '') });
  survivorsByStage.sim = surv.S;
  prog('sim', 1, { survivors: surv.S, message: 'exact retarded-time Doppler (computed inside the scoring kernel)' });
  checkAbort(signal);

  // Stages 5-6 on the coarse grid
  const robust = cfg.mode === 'robust';
  t0 = now();
  const coarseLv = { tau_step: cfg.tau_step, delta_half: robust ? Math.max(cfg.delta_half, cfg.soft.delta_half_coarse, Math.min(40, 2 * Math.max(0, ...events.map((e) => e.t_sigma_s || 0)))) : cfg.delta_half,
    delta_step: cfg.delta_step, f0_rel: cfg.f0_rel, f0_step: cfg.f0_step };
  const res = surv.S ? await scoreCoarse(exec, grid, tab, events, surv, cfg, coarseLv,
    { signal, onProgress: (fr) => prog('score', fr) }) : null;
  timings.score = now() - t0;
  survivorsByStage.score = surv.S;
  prog('score', 1, { survivors: surv.S });
  const coarseMap = new Float64Array(N).fill(NaN);
  if (res) for (let s = 0; s < surv.S; s++) { const n = surv.n[s]; if (!(coarseMap[n] >= res.score[s])) coarseMap[n] = res.score[s]; }
  let coarseCands = [];
  const perSeed = (cfg.recentre ?? (robust ? 'per_seed' : 'global')) === 'per_seed';
  const recentre = (evs0, rr, i, E) => evs0.map((ev, e) => ({ ...ev, t_cpa_audio: ev.t_cpa_audio - rr.delta[i], F0: rr.F0[i * E + e] }));
  let seeds = null; // [{x, y, evs}]
  let evsGlobal = events.map((e) => ({ ...e }));
  if (res) {
    const order = argsortDesc(res.score);
    const idx = pickDistinct(grid.xy, (i) => surv.n[i], order, cfg.top_k, 2 * (cfg.refine[0]?.[1] ?? 400));
    coarseCands = pickDistinct(grid.xy, (i) => surv.n[i], order, Math.max(cfg.top_k, topN), cfg.distinct_m)
      .map((i) => candidateFrom(grid, surv, res, i, tracks, cfg.spacing));
    evsGlobal = recentre(events, res, order[0], surv.E);
    if (globalThis.process?.env?.GEOLOC_DEBUG) console.log("[seeds]", idx.map((i) => res.score[i].toFixed(3)).join(" "));
    const sMin = robust && cfg.soft.seed_min_frac && res.score[order[0]] > 0 ? cfg.soft.seed_min_frac * res.score[order[0]] : -Infinity;
    seeds = idx.filter((i) => res.score[i] >= sMin).map((i) => ({ x: grid.xy[2 * surv.n[i]], y: grid.xy[2 * surv.n[i] + 1],
      evs: perSeed ? recentre(events, res, i, surv.E) : evsGlobal }));
  }

  // refinement: 100 m then 50 m around the best distinct seeds; T_start/F0 sweeps re-centred each level, either on
  // the global best ('global' = Python reference) or on each seed's own best ('per_seed', robust default: a strong
  // alias elsewhere then cannot drag the sweeps of the true mode away from it).
  t0 = now();
  const levels = [];
  let best = null, finalCands = [], nRefinePts = 0;
  for (let L = 0; L < cfg.refine.length && seeds && seeds.length; L++) {
    checkAbort(signal);
    const [sp, half, ts, dh, ds, fr, fs] = cfg.refine[L];
    const tsL = robust && cfg.soft.refine_tau ? (cfg.soft.refine_tau[L] ?? ts) : ts;
    const lv = { tau_step: tsL, delta_half: dh, delta_step: ds, f0_rel: fr, f0_step: fs };
    const groups = perSeed ? seeds.map((sd) => [sd]) : [seeds];
    const items = []; // {score, x, y, g, sR, rr, i, evs}
    let nSurvL = 0, nPtsL = 0;
    const fracG = new Float64Array(groups.length);
    const runGroup = async (G) => {
      const gseeds = groups[G], evsG = gseeds[0].evs;
      const gs = [];
      for (const sd of gseeds) gs.push(await makeGrid(enu, dem, sd.x, sd.y, half, sp, { mask: opts.mask }));
      const g = concatGrids(gs);
      const { tab: tabR, surv: sR } = await cpaFilter(g, evsG);
      const rr = sR.S ? await scoreSurvivors(exec, g, tabR, evsG, sR, cfg, lv, { signal, onProgress: (q) => {
        fracG[G] = q; prog('refine', (L + fracG.reduce((x, y) => x + y, 0) / groups.length) / cfg.refine.length);
      } }) : null;
      return { g, sR, rr };
    };
    // groups run concurrently: with the worker pool their chunks interleave on one queue
    const outs = await Promise.all(groups.map((_, G) => runGroup(G)));
    outs.forEach(({ g, sR, rr }, G) => {
      nPtsL += g.N; nSurvL += sR.S;
      if (!rr) return;
      for (let i = 0; i < sR.S; i++) items.push({ score: rr.score[i], x: g.xy[2 * sR.n[i]], y: g.xy[2 * sR.n[i] + 1], g, sR, rr, i, evs: groups[G][0].evs, G, ord: items.length });
    });
    nRefinePts += nPtsL;
    if (!items.length) break;
    items.sort((p, q) => q.score - p.score || p.ord - q.ord);
    const distinct = (k, sep) => {
      const ch = [];
      for (const it of items) {
        if (ch.every((c) => Math.hypot(it.x - c.x, it.y - c.y) >= sep)) ch.push(it);
        if (ch.length >= k) break;
      }
      return ch;
    };
    const cand = (it) => candidateFrom(it.g, it.sR, it.rr, it.i, tracks, sp);
    const pMin = robust && cfg.soft.seed_min_frac && items[0].score > 0 ? cfg.soft.seed_min_frac * items[0].score : -Infinity;
    const picks = distinct(Math.max(1, Math.floor(cfg.top_k / 2)), 2 * half).filter((it, k) => k === 0 || it.score >= pMin);
    const top = items[0];
    best = cand(top);
    finalCands = distinct(Math.max(cfg.top_k, topN), cfg.distinct_m).map(cand);
    evsGlobal = recentre(top.evs, top.rr, top.i, top.sR.E);
    seeds = picks.map((it) => ({ x: it.x, y: it.y, evs: perSeed ? recentre(it.evs, it.rr, it.i, it.sR.E) : evsGlobal }));
    levels.push({ spacing: sp, n_points: nPtsL, n_surv: nSurvL, best, candidates: picks.map(cand) });
    prog('refine', (L + 1) / cfg.refine.length, { survivors: nSurvL, message: `${sp} m: ${nSurvL} survivors` });
  }
  const evs = evsGlobal;
  timings.refine = now() - t0;
  survivorsByStage.refine = levels.length ? levels[levels.length - 1].n_surv : 0;
  prog('refine', 1, { survivors: survivorsByStage.refine });
  if (!best && coarseCands.length) best = coarseCands[0];

  // D8 evidence (robust): loudness / source-level consistency + silence consistency on the distinct candidates,
  // needs the raw dB spectrogram (opts.rawSpec). Re-ranks candidates; the margin uses the evidence-adjusted scores.
  const useEv = robust && opts.rawSpec && cfg.evidence !== null;
  if (useEv) {
    const seen = new Set();
    for (const cd of [...finalCands, ...coarseCands]) {
      if (seen.has(cd)) continue; seen.add(cd);
      if (signal) { await new Promise((r) => setTimeout(r, 0)); checkAbort(signal); }
      const o = enu.fwd(cd.lat, cd.lon, cd.elev_m);
      const ev = candidateEvidence(tracks, o, cd, opts.rawSpec, duration, { c: cfg.c, harmonics: cfg.harmonics, ...(cfg.evidence || {}) });
      cd.score_doppler = cd.score; cd.score -= ev.penalty;
      cd.evidence = { chi2_level: +ev.chi2_level.toFixed(2), chi2_silence: +ev.chi2_silence.toFixed(2), penalty: +ev.penalty.toFixed(4), ...ev.detail };
    }
    const byScore = (p, q) => q.score - p.score;
    finalCands.sort(byScore); coarseCands.sort(byScore);
    if (finalCands.length) best = finalCands[0]; else if (coarseCands.length) best = coarseCands[0];
  }
  // distinct candidates + confidence margin. Refined modes first, then coarse modes far from all of them.
  const cands = finalCands.slice();
  for (const c of coarseCands) if (cands.every((d) => Math.hypot(c.xy[0] - d.xy[0], c.xy[1] - d.xy[1]) >= cfg.distinct_m)) cands.push(c);
  let margin = null, runnerUp = null;
  if (best) {
    // a distinct alternative = another flight assignment >= distinct_m away, or anything >= 3 x distinct_m away
    // (the same pair 1 km along a weakly constrained direction is position uncertainty, not an alias)
    const far = (c) => { const d = Math.hypot(c.xy[0] - best.xy[0], c.xy[1] - best.xy[1]);
      return d >= 3 * cfg.distinct_m || (d >= cfg.distinct_m && c.flights.join() !== best.flights.join()); };
    const rf = finalCands.find(far);
    // compare like with like: refined vs refined, else coarse best vs coarse runner-up
    const ru = rf ?? coarseCands.find(far);
    const ref = rf ? best.score : coarseCands[0]?.score;
    // relative margin; the combined objective (score - ridge term) can be <= 0, so normalise by max(|best|, 1)
    if (ru) { runnerUp = ru; margin = (ref - ru.score) / Math.max(Math.abs(ref), 1); } else margin = 1;
  }
  return { best, levels, candidates: cands.slice(0, Math.max(topN, 1)), margin, runnerUp, n_grid: N, n_surv: surv.S,
    timings, survivorsByStage, evals: scoreSurvivors.evals, coarse: { grid, surv, res, map: coarseMap }, n_refine_points: nRefinePts, events_recentred: evs };
}
