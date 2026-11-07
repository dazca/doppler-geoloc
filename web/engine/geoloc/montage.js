// D11: montages. Edited videos are sequences of clips; each clip has its own unknown T_start (independent offsets).
// Given the observer, the evidence is separable per clip:  S(r_o) = sum_c max_{assignment_c, T_c} S_c(r_o, ...).
// So: one search per clip on the SAME grid (time-offset pairing only within a clip, silence only inside the clip's
// own audio span), per-point best scores summed across clips (a clip with no survivor at a point gets a penalty),
// then common 100 m / 50 m refinement around the best distinct seeds of the summed map.
import { runSearchCore, makeConfig } from './search.js';

const TOPM = 6;
/** Per grid point: the best survivor and the top-M survivors (score desc) of one clip's search. */
function bestPerPoint(r) {
  const g = r.coarse.grid, surv = r.coarse.surv, res = r.coarse.res, best = new Int32Array(g.N).fill(-1);
  const top = new Int32Array(g.N * TOPM).fill(-1);
  if (!res) return { grid: g, best, top, surv, res };
  for (let s = 0; s < surv.S; s++) {
    const n = surv.n[s], o = n * TOPM, v = res.score[s];
    let k = TOPM - 1;
    if (top[o + k] >= 0 && res.score[top[o + k]] >= v) continue;
    while (k > 0 && (top[o + k - 1] < 0 || res.score[top[o + k - 1]] < v)) { top[o + k] = top[o + k - 1]; k--; }
    top[o + k] = s;
  }
  for (let n = 0; n < g.N; n++) best[n] = top[n * TOPM];
  return { grid: g, best, top, surv, res };
}

/** Clip-level runs on one grid (center, half, spacing) -> per clip per-point best, and the summed score field. */
async function clipPass(tracks, dem, groups, Z, spec, enu, center, duration, cfg, opts, lv) {
  const per = [];
  for (const [k, gr] of groups.entries()) {
    const c = { ...cfg, ...lv.cfg, ...(lv.perGroup?.[k] || {}), refine: [], audio_window: gr.window, box_half: lv.half, spacing: lv.spacing,
      soft: { ...cfg.soft, ...(lv.cfg?.soft || {}) } };
    const r = await runSearchCore(tracks, dem, gr.events, Z, spec, enu, center, duration, c, { ...opts, rawSpec: null });
    per.push(bestPerPoint(r));
  }
  const N = per[0].grid.N, sum = new Float64Array(N).fill(-Infinity), covered = new Uint8Array(N);
  const miss = per.map((p) => { let m = Infinity; if (p.res) for (const v of p.res.score) m = Math.min(m, v); return (Number.isFinite(m) ? m : 0) - 1; });
  const K = per.length, chosen = per.map(() => new Int32Array(N).fill(-1));
  if (!cfg.montage_chrono) {
    for (let n = 0; n < N; n++) {
      let tot = 0, any = false;
      per.forEach((p, k) => { const s = p.best[n]; chosen[k][n] = s; if (s >= 0) { tot += p.res.score[s]; any = true; } else tot += miss[k]; });
      if (any) { sum[n] = tot; covered[n] = 1; }
    }
    return { per, sum, covered, grid: per[0].grid, chosen };
  }
  // chronological montage prior (soft): clips appear in recording order, so clip k's absolute start
  // (T_k + t0_k) should precede clip k+1's. DP over clips (ordered by t0) on each point's top-M survivors per clip,
  // penalty cfg.montage_chrono_penalty per inversion; a clip may stay unexplained (miss score).
  const ord = groups.map((g, k) => k).sort((a, b) => groups[a].window[0] - groups[b].window[0]);
  const pen = cfg.montage_chrono_penalty ?? 1.0, M1 = TOPM + 1;
  const val = new Float64Array(K * M1), from = new Int32Array(K * M1), abs = new Float64Array(K * M1);
  for (let n = 0; n < N; n++) {
    let any = false;
    for (let q = 0; q < K; q++) {
      const k = ord[q], p = per[k];
      for (let j = 0; j < M1; j++) {
        const s = j < TOPM ? p.top[n * TOPM + j] : -1;
        if (j < TOPM && s < 0) { val[q * M1 + j] = -Infinity; continue; }
        const sc = s >= 0 ? p.res.score[s] : miss[k];
        if (s >= 0) any = true;
        abs[q * M1 + j] = s >= 0 ? p.res.T_start[s] + groups[k].window[0] : NaN;
        if (q === 0) { val[j] = sc; from[j] = -1; continue; }
        let bv = -Infinity, bi = -1;
        for (let i = 0; i < M1; i++) {
          const pv = val[(q - 1) * M1 + i]; if (pv === -Infinity) continue;
          const a0 = abs[(q - 1) * M1 + i], a1 = abs[q * M1 + j];
          const v = pv + sc - (a0 === a0 && a1 === a1 && a0 > a1 ? pen : 0);
          if (v > bv) { bv = v; bi = i; }
        }
        val[q * M1 + j] = bv; from[q * M1 + j] = bi;
      }
    }
    if (!any) continue;
    let bj = 0;
    for (let j = 1; j < M1; j++) if (val[(K - 1) * M1 + j] > val[(K - 1) * M1 + bj]) bj = j;
    sum[n] = val[(K - 1) * M1 + bj]; covered[n] = 1;
    for (let q = K - 1, j = bj; q >= 0 && j >= 0; q--) { const k = ord[q]; chosen[k][n] = j < TOPM ? per[k].top[n * TOPM + j] : -1; j = from[q * M1 + j]; }
  }
  return { per, sum, covered, grid: per[0].grid, chosen };
}

function candidateAt(pass, n, groups, tracks, E, level) {
  const g = pass.grid, fidx = new Array(E), F0 = new Array(E), es = new Array(E), Tby = new Array(E), resid = new Array(E), rr = new Array(E).fill(null), td = new Array(E).fill(null);
  const Tclip = {};
  let raw = 0, pen = 0;
  pass.per.forEach((p, k) => {
    const s = pass.chosen ? pass.chosen[k][n] : p.best[n], gr = groups[k];
    if (s < 0) { gr.idx.forEach((e) => { fidx[e] = -1; F0[e] = gr.events[gr.idx.indexOf(e)].F0; es[e] = 0; Tby[e] = NaN; resid[e] = NaN; }); return; }
    const Ec = p.surv.E;
    Tclip[gr.id] = p.res.T_start[s]; raw += p.res.raw[s]; pen += p.res.penalty[s];
    gr.idx.forEach((e, j) => {
      fidx[e] = p.surv.assign[s * Ec + j]; F0[e] = p.res.F0[s * Ec + j]; es[e] = p.res.event_scores[s * Ec + j];
      Tby[e] = p.res.T_start[s]; resid[e] = p.res.offset_resid[s * Ec + j]; if (p.res.ridge_rms) rr[e] = p.res.ridge_rms[s * Ec + j];
      td[e] = p.surv.tdcpa ? p.surv.tdcpa[s * Ec + j] : null;
    });
  });
  return { lat: g.lat[n], lon: g.lon[n], elev_m: g.elev[n], score: pass.sum[n], fidx, flights: fidx.map((f) => (f >= 0 ? tracks[f].id : null)),
    F0, event_scores: es, t_start_unix: Tby[0], t_start_by_event: Tby, t_start_by_clip: Tclip, raw_score: raw, penalty: pen,
    offset_resid_s: resid, ridge_rms: rr.some((x) => x != null) ? rr : null, tdcpa: td, xy: [g.xy[2 * n], g.xy[2 * n + 1]], level_m: level };
}

function topDistinct(pass, k, sep) {
  const g = pass.grid, order = Array.from({ length: g.N }, (_, i) => i).filter((n) => pass.covered[n]).sort((a, b) => pass.sum[b] - pass.sum[a]);
  const out = [];
  for (const n of order) {
    if (out.every((m) => Math.hypot(g.xy[2 * n] - g.xy[2 * m], g.xy[2 * n + 1] - g.xy[2 * m + 1]) >= sep)) out.push(n);
    if (out.length >= k) break;
  }
  return out;
}

/**
 * Montage search. events carry `clip` ids; clips: optional [{id, t0, t1}] audio spans (default: span of the clip's
 * events +- 90 s). Returns a runSearchCore-like result (best, candidates, margin, runnerUp, coarse, ...).
 */
export async function runMontageCore(tracks, dem, events, Z, spec, enu, center, duration, cfgIn = {}, opts = {}, clips = []) {
  const cfg = makeConfig(cfgIn), E = events.length, t0 = performance.now();
  const ids = [...new Set(events.map((e) => e.clip))];
  const groups = ids.map((id) => {
    const idx = events.map((e, i) => (e.clip === id ? i : -1)).filter((i) => i >= 0);
    const evs = idx.map((i) => events[i]);
    const cl = clips.find((c) => c.id === id);
    const ts = evs.flatMap((e) => (e.ridge ? e.ridge.map((p) => p[0]) : [e.t_cpa_audio]));
    const window = cl ? [cl.t0, cl.t1] : [Math.max(0, Math.min(...ts) - 90), Math.min(duration, Math.max(...ts) + 90)];
    return { id, idx, events: evs, window };
  });
  opts.onProgress?.({ stage: 'grid', frac: 0, message: `montage: ${groups.length} clips with independent start times` });
  // coarse: whole region, per clip; sum
  const coarse = await clipPass(tracks, dem, groups, Z, spec, enu, center, duration, cfg, opts, { half: cfg.box_half, spacing: cfg.spacing, cfg: {} });
  const seeds = topDistinct(coarse, Math.max(3, Math.floor(cfg.top_k / 2)), 2000);
  const finals = [];
  // candidate flights per clip near a seed: the anchor flights of the coarse top-M survivors within 1 km
  const g0 = coarse.grid;
  const flightsNear = (n0, k) => {
    const p = coarse.per[k], set = new Map();
    if (!p.res) return [];
    for (let n = 0; n < g0.N; n++) {
      if (Math.hypot(g0.xy[2 * n] - g0.xy[2 * n0], g0.xy[2 * n + 1] - g0.xy[2 * n0 + 1]) > 1000) continue;
      for (let j = 0; j < 6; j++) { const s = p.top[n * 6 + j]; if (s < 0) break; const f = p.surv.assign[s * p.surv.E]; set.set(f, Math.max(set.get(f) ?? -Infinity, p.res.score[s])); }
    }
    return [...set.entries()].sort((a, b) => b[1] - a[1]).slice(0, cfg.montage_refine_flights ?? 12).map(([f]) => f);
  };
  for (const n0 of seeds) {
    let cx = coarse.grid.xy[2 * n0], cy = coarse.grid.xy[2 * n0 + 1], best = null;
    const perGroup = groups.map((_, k) => ({ anchor_flights: flightsNear(n0, k) }));
    for (const [sp, half] of [[100, 500], [50, 150]]) {
      const ll = enu.inv(cx, cy, 0);
      const pass = await clipPass(tracks, dem, groups, Z, spec, enu, [ll[0], ll[1]], duration, cfg, opts,
        { half, spacing: sp, cfg: { tau_step: 0.25, delta_step: 0.25, f0_step: 0.0025, radius: 1e7 }, perGroup });
      const top = topDistinct(pass, 1, 0);
      if (!top.length) break;
      best = candidateAt(pass, top[0], groups, tracks, E, sp);
      cx = best.xy[0]; cy = best.xy[1];
    }
    if (!best) best = candidateAt(coarse, n0, groups, tracks, E, cfg.spacing);
    finals.push(best);
  }
  finals.sort((a, b) => b.score - a.score);
  const best = finals[0] || null;
  let margin = null, runnerUp = null;
  if (best) {
    const ru = finals.find((c) => Math.hypot(c.xy[0] - best.xy[0], c.xy[1] - best.xy[1]) >= 3 * cfg.distinct_m
      || (Math.hypot(c.xy[0] - best.xy[0], c.xy[1] - best.xy[1]) >= cfg.distinct_m && c.flights.join() !== best.flights.join()));
    if (ru) { runnerUp = ru; margin = (best.score - ru.score) / Math.max(Math.abs(best.score), 1); } else margin = 1;
  }
  const map = Float64Array.from(coarse.sum, (v, n) => (coarse.covered[n] ? v : NaN));
  return { best, candidates: finals, margin, runnerUp, n_grid: coarse.grid.N, n_surv: coarse.per.reduce((a, p) => a + (p.surv?.S || 0), 0),
    timings: { montage_total: performance.now() - t0 }, survivorsByStage: { grid: coarse.grid.N, clips: groups.length },
    coarse: { grid: coarse.grid, map }, n_refine_points: 0, events_recentred: events, levels: [], montage: { clips: groups.map((g) => ({ id: g.id, events: g.idx, window: g.window })) } };
}
