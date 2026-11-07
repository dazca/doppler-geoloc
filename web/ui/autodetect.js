// Thin adapter around Lane AD's detector (contract: docs/AUTODETECT.md).
// Prefers the DSP worker's {type:'autodetect'} message (off the main thread); if this build's worker does not know the
// message yet, falls back once to running web/engine/autodetect.js#detectEvents on the main thread.
// Resolves the contract's event array, or [] when no detector is available at all.
let worker = null, workerOk = null, nextId = 1;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/dsp.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const { id, type } = ev.data, p = pending.get(id);
    if (!p) return;
    if (type === 'progress') p.onProgress?.(ev.data.p);
    else { pending.delete(id); type === 'result' ? p.resolve(ev.data.result) : p.reject(new Error(ev.data.message)); }
  };
  worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'worker error')); pending.clear(); };
  return worker;
}
const abortErr = () => new DOMException('Detection cancelled', 'AbortError');

function viaWorker(spec, opts, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const w = getWorker(), id = nextId++;
    pending.set(id, { resolve, reject, onProgress });
    signal?.addEventListener('abort', () => {
      pending.delete(id); w.terminate(); worker = null;
      for (const p of pending.values()) p.reject(abortErr());
      pending.clear(); reject(abortErr());
    }, { once: true });
    w.postMessage({ id, type: 'autodetect', spec, opts });
  });
}

/** @returns {Promise<Array>} detected passes, best first (docs/AUTODETECT.md "Return shape"). */
export async function detectPasses(spec, opts = {}, { onProgress, signal } = {}) {
  if (workerOk !== false) {
    try { const r = await viaWorker(spec, opts, onProgress, signal); workerOk = true; return asList(r); }
    catch (e) {
      if (e?.name === 'AbortError') throw e;
      if (!/unknown message type/i.test(e?.message || '')) console.warn('[autodetect] worker failed, using main thread:', e?.message || e);
      workerOk = false;
    }
  }
  let mod;
  try { mod = await import('../engine/autodetect.js'); } catch { return []; }
  return asList(await mod.detectEvents(spec, { ...opts, onProgress, signal }));
}
/** The worker answers {events, stats}; the module returns an array (with .stats). */
const asList = (r) => (Array.isArray(r) ? [...r] : Array.isArray(r?.events) ? r.events : []);
