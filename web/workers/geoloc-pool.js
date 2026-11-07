// Worker pool for the geolocation engine (Lane D). Implements the executor interface of
// web/engine/geoloc/exec.js: init(tracks, Z, spec, cfg), cpa(obs, N, {signal, onProgress}), score(job, {signal, onProgress}), close().
//   const pool = createGeolocPool({ size: navigator.hardwareConcurrency });
//   await runSearchCore(..., { exec: pool }); pool.close();
// The whitened spectrogram Z is shared through a SharedArrayBuffer when available (cross-origin isolated pages,
// Node); otherwise each worker receives one structured-clone copy at init. Work is split into ~4 chunks per worker
// for load balancing. On abort the pending promise rejects immediately; in-flight chunk results are discarded.
import { subJob } from '../engine/geoloc/exec.js';
import { toCSR } from '../engine/geoloc/cpa_sparse.js';

const WORKER_URL = new URL('./geoloc.worker.js', import.meta.url);
const abortErr = () => new DOMException('Aborted', 'AbortError');

/** Browser factory (module worker). */
export const browserWorkerFactory = () => new Worker(WORKER_URL, { type: 'module' });

/** Node factory (worker_threads) with a browser-like surface. */
export async function nodeWorkerFactory() {
  const { Worker } = await import('node:worker_threads');
  return () => {
    const w = new Worker(WORKER_URL);
    const shim = { onmessage: null, onerror: null, postMessage: (m, t) => w.postMessage(m, t), terminate: () => w.terminate() };
    w.on('message', (data) => shim.onmessage?.({ data }));
    w.on('error', (e) => shim.onerror?.(e));
    return shim;
  };
}

const defaultSize = () => Math.max(1, Math.min(16, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4));

export function createGeolocPool({ size = defaultSize(), factory = browserWorkerFactory } = {}) {
  const workers = [];
  for (let i = 0; i < size; i++) {
    const w = factory();
    const slot = { w, busy: false, pending: new Map() };
    w.onmessage = (ev) => {
      const { id, type } = ev.data, p = slot.pending.get(id);
      if (!p) return;
      slot.pending.delete(id);
      type === 'result' ? p.resolve(ev.data.result) : p.reject(new Error(ev.data.message));
    };
    w.onerror = (e) => { for (const p of slot.pending.values()) p.reject(new Error(e?.message || 'worker error')); slot.pending.clear(); };
    workers.push(slot);
  }
  let nextId = 1, tracksN = 0, lastZ = null, lastZs = null;
  const call = (slot, msg, transfer = []) => new Promise((resolve, reject) => {
    const id = nextId++;
    slot.pending.set(id, { resolve, reject });
    slot.w.postMessage({ ...msg, id }, transfer);
  });

  // One global FIFO shared by concurrent runTasks() calls, so idle workers always pick up the next chunk.
  const queue = [];
  const dispatch = () => {
    for (const slot of workers) {
      if (slot.busy) continue;
      let item;
      while ((item = queue.shift()) && item.batch.failed);
      if (!item) return;
      const { msg, transfer } = item.task.make();
      slot.busy = true;
      call(slot, msg, transfer).then((r) => { slot.busy = false; item.batch.ok(item.task, r); dispatch(); },
        (e) => { slot.busy = false; item.batch.fail(e); dispatch(); });
    }
  };

  /** Run tasks ({make() -> {msg, transfer}, done(result)}) on the pool; progress after each completion. */
  function runTasks(tasks, { signal, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      let done = 0;
      const batch = { failed: false };
      const onAbort = () => { if (!batch.failed) { batch.failed = true; reject(abortErr()); } };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const finish = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
      if (!tasks.length) return finish();
      batch.ok = (t, r) => {
        if (batch.failed) return;
        t.done(r); done++;
        onProgress?.(done / tasks.length);
        if (done === tasks.length) finish();
      };
      batch.fail = (e) => { if (!batch.failed) { batch.failed = true; signal?.removeEventListener('abort', onAbort); reject(e); } };
      for (const task of tasks) queue.push({ task, batch });
      dispatch();
    });
  }

  return {
    kind: 'pool', workers: size,
    async init(tracks, Z, spec, cfg) {
      tracksN = tracks.length;
      // Z is sent once per distinct array: workers keep it across searches (no 18 MB x N copies per run)
      const sameZ = Z === lastZ;
      let Zs = sameZ ? lastZs : Z;
      if (!sameZ && typeof SharedArrayBuffer !== 'undefined' && !(Z.buffer instanceof SharedArrayBuffer)) {
        try { const sab = new SharedArrayBuffer(Z.byteLength); Zs = new Float32Array(sab); Zs.set(Z); } catch { Zs = Z; }
      }
      lastZ = Z; lastZs = Zs;
      const { data, ...meta } = spec;
      // workers only touch candidate-class flights (CPA phase 1 and scoring); the others (e.g. jets, silence veto on the
      // main thread) travel as empty stubs so that thousands of tracks are not cloned into every worker
      const E0 = new Float64Array(0);
      const wTracks = tracks.map((t) => (cfg.candidate_categories.includes(t.category) ? t
        : { id: t.id, category: t.category, n: 0, t0: t.t0, t1: t.t1, t: E0, P: E0, M: E0 }));
      await Promise.all(workers.map((s) => call(s, { type: 'init', tracks: wTracks, Z: sameZ ? null : Zs, spec: meta, cfg })));
    },
    /** Sparse CPA split by flights (round robin, ~4 chunks per worker); entries merged into CSR here. */
    async cpa(grid, { rmax, window = null, ...hooks } = {}) {
      const F = tracksN, nCh = Math.min(F, size * 4), parts = [], tasks = [];
      for (let k = 0; k < nCh; k++) {
        const flights = []; for (let f = k; f < F; f += nCh) flights.push(f);
        tasks.push({ make: () => ({ msg: { type: 'cpa', flights, lattices: grid.lattices, obs: grid.obs, rmax, window }, transfer: [] }),
          done: (r) => parts.push(r) });
      }
      await runTasks(tasks, hooks);
      return toCSR(grid.N, parts);
    },
    async score(job, hooks = {}) {
      const { S, E } = job;
      const ch = Math.max(2, Math.ceil(S / (size * 4)));
      let nd = 0, score = null, rho = null, evals = 0, mis = null;
      const parts = [];
      const tasks = [];
      for (let a = 0; a < S; a += ch) {
        const b = Math.min(S, a + ch);
        tasks.push({ make: () => { const sj = subJob(job, a, b);
          const j = { ...sj, f: sj.f.slice(), obs: sj.obs.slice(), tdcpa: sj.tdcpa.slice(), sT: sj.sT.slice(),
            pen: sj.pen ? { ...sj.pen, chiVD: sj.pen.chiVD.slice(), Te: sj.pen.Te.slice(), tSigSE: sj.pen.tSigSE ? sj.pen.tSigSE.slice() : null } : null };
          return { msg: { type: 'score', job: j }, transfer: [j.f.buffer, j.obs.buffer, j.tdcpa.buffer, j.sT.buffer] }; },
        done: (r) => parts.push([a, r]) });
      }
      await runTasks(tasks, hooks);
      for (const [a, r] of parts) {
        if (!score) { nd = r.nd; score = new Float64Array(S * E * nd); rho = new Int16Array(S * E * nd); if (r.mis) mis = new Float32Array(S * E * nd); }
        score.set(r.score, a * E * nd); rho.set(r.rho, a * E * nd); evals += r.evals || 0; if (mis && r.mis) mis.set(r.mis, a * E * nd);
      }
      if (!score) { nd = Math.max(0, Math.ceil((2 * job.delta[1] + 1e-9) / job.delta[2])); score = new Float64Array(0); rho = new Int16Array(0); }
      return { nd, score, rho, evals, mis };
    },
    close() { for (const s of workers) s.w.terminate(); },
  };
}
