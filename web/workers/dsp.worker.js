// Module worker: runs STFT (and optionally ridge tracking) off the main thread.
// Create with: new Worker(new URL('./dsp.worker.js', import.meta.url), {type: 'module'})
// Messages in : {id, type: 'stft', samples: Float32Array (transfer), opts}       -> spectrogram
//               {id, type: 'ridge', spec, seed, opts}                             -> trackRidge result
//               {id, type: 'autodetect', spec, opts}                              -> detectEvents result (docs/AUTODETECT.md)
//               {id, type: 'refspec', samples (transfer), fs}                     -> {spec, whitened} (scoring, B11)
// Messages out: {id, type: 'progress', p} | {id, type: 'result', result} | {id, type: 'error', message}
// The spectrogram's data buffer is transferred back (zero copy).
import { stft } from '../engine/stft.js';
import { trackRidge } from '../engine/ridge.js';
import { detectEvents } from '../engine/autodetect.js';
import { whiten } from '../engine/geoloc/spectro.js';

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
    } else if (type === 'refspec') {
      // geoloc.js#referenceSpectrogram + per-bin whitening (prepareSpectrogram then only crops the band it needs)
      const { referenceSpectrogram } = await import('../engine/geoloc.js');
      const spec = await referenceSpectrogram(ev.data.samples, ev.data.fs);
      const Z = whiten(spec), { data, ...meta } = spec;
      self.postMessage({ id, type: 'result', result: { spec, whitened: { ...meta, unit: 'z', data: Z } } }, [data.buffer, Z.buffer]);
    } else if (type === 'autodetect') {
      const result = await detectEvents(ev.data.spec, { ...ev.data.opts, onProgress: (p) => self.postMessage({ id, type: 'progress', p }) });
      self.postMessage({ id, type: 'result', result: { events: [...result], stats: result.stats } });
    } else throw new Error(`unknown message type ${type}`);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err?.stack || err) });
  }
};
