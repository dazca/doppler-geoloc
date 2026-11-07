// Promise wrapper around dsp.worker.js.
//   const dsp = createDspClient();
//   const spec = await dsp.stft(samples, opts, onProgress, {transfer: false});  // transfer=true detaches samples
//   const ridge = await dsp.ridge(spec, seed, opts);   // copies spec (structured clone); main thread is fine too
//   dsp.terminate();
export function createDspClient(url = new URL('./dsp.worker.js', import.meta.url)) {
  const worker = new Worker(url, { type: 'module' });
  const pending = new Map();
  let nextId = 1;
  worker.onmessage = (ev) => {
    const { id, type } = ev.data, p = pending.get(id);
    if (!p) return;
    if (type === 'progress') p.onProgress?.(ev.data.p);
    else { pending.delete(id); type === 'result' ? p.resolve(ev.data.result) : p.reject(new Error(ev.data.message)); }
  };
  worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'worker error')); pending.clear(); };
  const call = (msg, transfer, onProgress) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ ...msg, id }, transfer);
  });
  return {
    stft(samples, opts, onProgress, { transfer = false } = {}) {
      const s = transfer ? samples : samples.slice();
      return call({ type: 'stft', samples: s, opts }, [s.buffer], onProgress);
    },
    ridge: (spec, seed, opts) => call({ type: 'ridge', spec, seed, opts }, []),
    terminate: () => worker.terminate(),
  };
}
