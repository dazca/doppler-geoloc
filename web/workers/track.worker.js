// Module worker (Lane E2): keeps ONE copy of the spectrogram and runs one-click ridge auto-extension on it,
// so each click doesn't re-clone a ~100 MB spectrogram (dsp.worker's 'ridge' message does).
// In : {id, type: 'spec', spec}                -> 'ok'   (spec is structured-cloned once per STFT)
//      {id, type: 'extend', seed, opts}         -> extendRidge result {points, steps}
// Out: {id, type: 'result', result} | {id, type: 'error', message}
import { extendRidge } from '../engine/ridge-extend.js';

let spec = null;
self.onmessage = (ev) => {
  const { id, type } = ev.data;
  try {
    if (type === 'spec') { spec = ev.data.spec; self.postMessage({ id, type: 'result', result: 'ok' }); }
    else if (type === 'extend') {
      if (!spec) throw new Error('no spectrogram loaded');
      const r = extendRidge(spec, ev.data.seed, ev.data.opts);
      self.postMessage({ id, type: 'result', result: { points: r.points, steps: r.steps } });
    } else throw new Error(`unknown message type ${type}`);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err?.message || err) });
  }
};
