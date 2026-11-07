// Module worker: runs STFT (and optionally ridge tracking) off the main thread.
// Create with: new Worker(new URL('./dsp.worker.js', import.meta.url), {type: 'module'})
// Messages in : {id, type: 'stft', samples: Float32Array (transfer), opts}       -> spectrogram
//               {id, type: 'ridge', spec, seed, opts}                             -> trackRidge result
//               {id, type: 'autodetect', spec, opts}                              -> detectEvents result (docs/AUTODETECT.md)
// Messages out: {id, type: 'progress', p} | {id, type: 'result', result} | {id, type: 'error', message}
// The spectrogram's data buffer is transferred back (zero copy).
import { stft } from '../engine/stft.js';
import { trackRidge } from '../engine/ridge.js';
import { detectEvents } from '../engine/autodetect.js';

self.onmessage = async (ev) => {
  const { id, type } = ev.data;
  try {
    if (type === 'stft') {
      const t = performance.now();
      const spec = stft(ev.data.samples, { ...ev.data.opts, onProgress: (p) => self.postMessage({ id, type: 'progress', p }) });
      spec.meta.elapsedMs = performance.now() - t;
      self.postMessage({ id, type: 'result', result: spec }, [spec.data.buffer]);
    } else if (type === 'ridge') {
      self.postMessage({ id, type: 'result', result: trackRidge(ev.data.spec, ev.data.seed, ev.data.opts) });
    } else if (type === 'autodetect') {
      const result = await detectEvents(ev.data.spec, { ...ev.data.opts, onProgress: (p) => self.postMessage({ id, type: 'progress', p }) });
      self.postMessage({ id, type: 'result', result: { events: [...result], stats: result.stats } });
    } else throw new Error(`unknown message type ${type}`);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err?.stack || err) });
  }
};
