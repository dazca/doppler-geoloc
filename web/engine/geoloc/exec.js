// Inline (same-thread) executor for the two heavy kernels. The worker pool (web/workers/geoloc-pool.js)
// implements the same interface: init(tracks, Z, spec, cfg), cpa(obs, N, {signal, onProgress}),
// score(job, {signal, onProgress}), close().
import { sampleTrack, cpaInto } from './doppler.js';
import { sparseCpaEntries, toCSR } from './cpa_sparse.js';
import { makeScoreContext, scoreBatch } from './score.js';

const abortErr = () => (typeof DOMException !== 'undefined' ? new DOMException('Aborted', 'AbortError')
  : Object.assign(new Error('Aborted'), { name: 'AbortError' }));

/** CPA tables for observers [a, b) of obs (3N). out: {t_cpa, d_cpa, speed, t_dcpa} Float64Array(F*N), row f. */
export function cpaTables(samples, tracks, obs, a, b, c, out, N, colOff = 0) {
  for (let f = 0; f < tracks.length; f++) {
    const o = f * N + colOff;
    const view = { t_cpa: out.t_cpa.subarray(o), d_cpa: out.d_cpa.subarray(o),
      speed: out.speed.subarray(o), t_dcpa: out.t_dcpa.subarray(o) };
    cpaInto(tracks[f], samples[f], obs, a, b, c, view, -a);
  }
}

export const newTables = (F, N) => ({ t_cpa: new Float64Array(F * N), d_cpa: new Float64Array(F * N),
  speed: new Float64Array(F * N), t_dcpa: new Float64Array(F * N) });

/** Slice a score job to survivors [a, b). */
export const subJob = (job, a, b) => ({ ...job, S: b - a, f: job.f.subarray(a * job.E, b * job.E),
  obs: job.obs.subarray(3 * a, 3 * b), tdcpa: job.tdcpa.subarray(a * job.E, b * job.E), sT: job.sT.subarray(a, b),
  pen: job.pen ? { ...job.pen, chiVD: job.pen.chiVD.subarray(a, b), Te: job.pen.Te.subarray(a * job.E, b * job.E), tSigSE: job.pen.tSigSE ? job.pen.tSigSE.subarray(a * job.E, b * job.E) : null } : null });

export function createInlineExecutor() {
  let ctx = null, samples = null, tracks = null, cfg = null;
  const yieldNow = () => new Promise((r) => setTimeout(r, 0));
  return {
    kind: 'inline', workers: 1,
    async init(tr, Z, spec, c) {
      tracks = tr; cfg = c; ctx = makeScoreContext(tr, Z, spec, c);
    },
    /** Sparse CPA (cpa_sparse.js): grid {N, obs, lattices}; opts {rmax: Float64Array(F), window}. Returns CSR. */
    async cpa(grid, { rmax, window = null, signal, onProgress } = {}) {
      const F = tracks.length, parts = [], CH = 16;
      for (let a = 0; a < F; a += CH) {
        const fl = []; for (let f = a; f < Math.min(F, a + CH); f++) fl.push(f);
        parts.push(sparseCpaEntries(tracks, fl, grid.lattices, grid.obs, cfg.c, rmax, window));
        onProgress?.(Math.min(1, (a + CH) / F));
        if (signal) { await yieldNow(); if (signal.aborted) throw abortErr(); }
      }
      return toCSR(grid.N, parts);
    },
    async score(job, { signal, onProgress } = {}) {
      const { S, E } = job, CH = 8;
      if (!signal && !onProgress) return scoreBatch(ctx, job);
      let nd = 0, score = null, rho = null, evals = 0, mis = null;
      for (let a = 0; a < S; a += CH) {
        const b = Math.min(S, a + CH);
        const r = scoreBatch(ctx, subJob(job, a, b));
        if (!score) { nd = r.nd; score = new Float64Array(S * E * nd); rho = new Int16Array(S * E * nd); if (r.mis) mis = new Float32Array(S * E * nd); }
        score.set(r.score, a * E * nd); rho.set(r.rho, a * E * nd); evals += r.evals || 0; if (mis && r.mis) mis.set(r.mis, a * E * nd);
        onProgress?.(b / S);
        if (signal) { await yieldNow(); if (signal.aborted) throw abortErr(); }
      }
      if (!score) { const r = scoreBatch(ctx, job); return r; }
      return { nd, score, rho, evals, mis };
    },
    close() {},
  };
}
