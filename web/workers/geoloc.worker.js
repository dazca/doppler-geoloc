// Module worker for the geolocation engine's two heavy kernels (Lane D).
// Browser: new Worker(new URL('./geoloc.worker.js', import.meta.url), {type: 'module'})
// Node   : worker_threads (see geoloc-pool.js#nodeWorkerFactory); the same file runs in both.
// Messages in : {id, type:'init', tracks, Z (Float32Array, may be backed by a SharedArrayBuffer), spec (meta), cfg}
//               {id, type:'cpa', obs: Float64Array(3*(b-a)) for the slice}       -> {t_cpa, d_cpa, speed, t_dcpa} F*(b-a)
//               {id, type:'score', job}  (score.js#scoreBatch job)              -> {nd, score, rho}
// Messages out: {id, type:'result', result} | {id, type:'error', message}. Result buffers are transferred.
import { makeScoreContext, scoreBatch } from '../engine/geoloc/score.js';
import { sparseCpaEntries } from '../engine/geoloc/cpa_sparse.js';

let port = (typeof self !== 'undefined' && typeof self.postMessage === 'function') ? self : null;
if (!port) {
  const { parentPort } = await import('node:worker_threads');
  port = { postMessage: (m, t) => parentPort.postMessage(m, t), set onmessage(fn) { parentPort.on('message', (data) => fn({ data })); } };
}

let ctx = null, samples = null, tracks = null, cfg = null, Zkeep = null;

port.onmessage = (ev) => {
  const { id, type } = ev.data;
  try {
    if (type === 'init') {
      ({ tracks, cfg } = ev.data);
      if (ev.data.Z) Zkeep = ev.data.Z; // null = keep the previous spectrogram
      ctx = makeScoreContext(tracks, Zkeep, ev.data.spec, cfg);
      port.postMessage({ id, type: 'result', result: true });
    } else if (type === 'cpa') {
      const { flights, lattices, obs, rmax, window } = ev.data;
      const r = sparseCpaEntries(tracks, flights, lattices, obs, cfg.c, rmax, window);
      const out = { n: r.n, p: r.p.slice(), f: r.f.slice(), t_cpa: r.t_cpa.slice(), d_cpa: r.d_cpa.slice(), speed: r.speed.slice(), t_dcpa: r.t_dcpa.slice() };
      port.postMessage({ id, type: 'result', result: out }, [out.p.buffer, out.f.buffer, out.t_cpa.buffer, out.d_cpa.buffer, out.speed.buffer, out.t_dcpa.buffer]);
    } else if (type === 'score') {
      const r = scoreBatch(ctx, ev.data.job);
      port.postMessage({ id, type: 'result', result: r }, r.mis ? [r.score.buffer, r.rho.buffer, r.mis.buffer] : [r.score.buffer, r.rho.buffer]);
    } else throw new Error(`unknown message type ${type}`);
  } catch (err) {
    port.postMessage({ id, type: 'error', message: String(err?.stack || err) });
  }
};
