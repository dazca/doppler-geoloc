// Thin adapter around Lane AD's detector (contract: docs/AUTODETECT.md).
// Runs the detector off the main thread through `run(opts, {onProgress, signal})`: the spectrogram panel's track
// worker, which already holds the one worker-side copy of the spectrogram (B5: no extra ~100 MB clone per detection).
// If that worker does not know the message (or none is given), falls back once to running
// web/engine/autodetect.js#detectEvents on the main thread. Resolves the contract's event array, or [] when no
// detector is available at all.
let workerOk = null;

/** @returns {Promise<Array>} detected passes, best first (docs/AUTODETECT.md "Return shape"). */
export async function detectPasses(spec, opts = {}, { onProgress, signal, run } = {}) {
  if (run && workerOk !== false) {
    try { const r = await run(opts, { onProgress, signal }); workerOk = true; return asList(r); }
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
