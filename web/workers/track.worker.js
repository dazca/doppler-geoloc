// Module worker (Lane E2): keeps ONE copy of the spectrogram and runs one-click ridge auto-extension and pass
// auto-detection on it, so neither re-clones a ~100 MB spectrogram per call (dsp.worker's messages do).
// In : {id, type: 'spec', spec}                -> 'ok'   (spec is structured-cloned once per STFT; null releases it)
//      {id, type: 'extend', seed, opts}         -> extendRidge result {points, steps}
//      {id, type: 'autodetect', opts}           -> {events, stats} (docs/AUTODETECT.md), with {id, type: 'progress', p}
// Out: {id, type: 'result', result} | {id, type: 'progress', p} | {id, type: 'error', message}
import { extendRidge } from '../engine/ridge-extend.js';

let spec = null;
self.onmessage = async (ev) => {
  const { id, type } = ev.data;
  try {
    if (type === 'spec') { spec = ev.data.spec; self.postMessage({ id, type: 'result', result: 'ok' }); }
    else if (type === 'extend') {
      if (!spec) throw new Error('no spectrogram loaded');
      const r = extendRidge(spec, ev.data.seed, ev.data.opts);
      self.postMessage({ id, type: 'result', result: { points: r.points, steps: r.steps } });
    } else if (type === 'autodetect') {
      if (!spec) throw new Error('no spectrogram loaded');
      const { detectEvents } = await import('../engine/autodetect.js');
      const result = await detectEvents(spec, { ...ev.data.opts, onProgress: (p) => self.postMessage({ id, type: 'progress', p }) });
      self.postMessage({ id, type: 'result', result: { events: [...result], stats: result.stats } });
    } else throw new Error(`unknown message type ${type}`);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err?.message || err) });
  }
};
