// Spectrogram panel: wraps SpectrogramView with presets, STFT in the DSP worker, one-click ridge auto-extension in
// the track worker, synced audio playback, and two overlay layers (line overlays + filled bands, e.g. silences).
import { SpectrogramView } from './spectrogram-view.js';
import { createDspClient } from '../workers/dsp-client.js';
import { fmtAudio } from './time-utils.js';

export const DECODE_RATE = 8000;   // 4 kHz Nyquist is plenty for the 30–2000 Hz aircraft band

// STFT presets at 8 kHz. "standard" ~ Lane C's real-audio settings (0.256 s window, 1.95 Hz bins, 64 ms hop).
export const PRESETS = {
  standard: { label: 'Aircraft · standard', nperseg: 2048, nfft: 4096, hop: 512 },
  fine: { label: 'Aircraft · fine frequency', nperseg: 4096, nfft: 8192, hop: 512 },
  fast: { label: 'Fast overview', nperseg: 1024, nfft: 2048, hop: 1024 },
};

/** B5: the displayed spectrogram (nT x nF Float32) is kept within this many bytes by widening the hop. */
export const SPEC_BUDGET_BYTES = 100e6;

/** Smallest hop (multiple of 256, >= the preset's) that keeps nT*nF*4 <= SPEC_BUDGET_BYTES for `duration` s. */
export function budgetHop(p, duration, { fs = DECODE_RATE, fMin = 30, fMax = 2000, budget = SPEC_BUDGET_BYTES } = {}) {
  const nF = Math.floor(fMax * p.nfft / fs) - Math.ceil(fMin * p.nfft / fs) + 1;
  const need = (duration * fs * nF * 4) / budget;
  return Math.max(p.hop, Math.ceil(need / 256) * 256);
}

export function stftOptions(specSettings, duration) {
  const p = PRESETS[specSettings.preset] || PRESETS.standard;
  const hop = budgetHop(p, duration);
  return {
    fs: DECODE_RATE, nperseg: p.nperseg, nfft: p.nfft, hop, fMin: 30, fMax: 2000, whiten: 'freq',
    ...(specSettings.hum ? { whitenWindowS: 120 } : {}),
    ...(specSettings.impulse ? { clipDb: [-10, 25] } : {}),
  };
}

export function ridgeOptions(specSettings, cls, harmonic, seedF) {
  // harmonics are multipliers of the CLICKED line; if the user clicked harmonic n, stack fundamental multiples 1..n+2
  const n = harmonic || 1, top = cls === 'jet' ? 1 : cls === 'heli' ? 2 : 3;
  const opts = { harmonics: Array.from({ length: Math.max(top, n + (top > 1 ? 2 : 0)) }, (_, k) => (k + 1) / n),
    nullStat: 'robust', nullZ: 1.5, maxGapS: 4, snap: 6 };           // LANE_C_REPORT C6 real-audio options
  if (cls === 'prop' || cls === 'jet') opts.monotonic = 'down';     // a straight pass only ever falls
  if (cls === 'jet' && seedF) { opts.maxSlope = 0.25 * seedF; opts.penalty = 2; }
  if (specSettings.impulse) { opts.impulseDb = 6; opts.emClip = 15; } // coast through bursts
  return opts;
}

export function createSpecPanel(host, { onPick, onBox, onHover, onView } = {}) {
  const view = new SpectrogramView(host, { colormap: 'magma' });
  view.on('pick', (d) => onPick?.(d));
  view.on('box', (d) => onBox?.(d));
  view.on('hover', (d) => { lastHover = d; onHover?.(d); });
  view.on('view', (v) => onView?.(v));

  let dsp = null, tracker = null, spec = null, lastHover = null;
  let lines = new Map(), bands = new Map();
  const audio = new Audio(); audio.preload = 'auto';
  let raf = 0, follow = true;
  const compose = () => view.setOverlays([...bands, ...lines]);

  // track worker: a tiny promise client. It holds the only worker-side copy of the spectrogram (ridge + autodetect).
  const pending = new Map();
  let nextId = 1;
  const dropTracker = (err) => {
    tracker?.terminate(); tracker = null;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  function trackCall(msg, onProgress) {
    if (!tracker) {
      tracker = new Worker(new URL('../workers/track.worker.js', import.meta.url), { type: 'module' });
      tracker.onmessage = (ev) => {
        const p = pending.get(ev.data.id); if (!p) return;
        if (ev.data.type === 'progress') { p.onProgress?.(ev.data.p); return; }
        pending.delete(ev.data.id);
        ev.data.type === 'result' ? p.resolve(ev.data.result) : p.reject(new Error(ev.data.message));
      };
      tracker.onerror = (e) => dropTracker(new Error(e.message || 'track worker error'));
      if (spec && msg.type !== 'spec') tracker.postMessage({ id: 0, type: 'spec', spec });   // re-created after an abort
    }
    return new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject, onProgress }); tracker.postMessage({ ...msg, id }); });
  }

  function tick() {
    view.setCursor(audio.currentTime);
    if (follow && !audio.paused) {
      const v = view.getView(), w = v.t1 - v.t0;
      if (audio.currentTime > v.t1 - w * 0.05 || audio.currentTime < v.t0) view.setView({ t0: audio.currentTime - w * 0.1, t1: audio.currentTime + w * 0.9 });
    }
    api.onTime?.(audio.currentTime, audio.paused);
    raf = audio.paused ? 0 : requestAnimationFrame(tick);
  }
  audio.addEventListener('play', () => { if (!raf) raf = requestAnimationFrame(tick); api.onTime?.(audio.currentTime, false); });
  audio.addEventListener('pause', () => api.onTime?.(audio.currentTime, true));
  audio.addEventListener('seeked', () => { view.setCursor(audio.currentTime); api.onTime?.(audio.currentTime, audio.paused); });

  const api = {
    view, audio, onTime: null,
    get spec() { return spec; },
    get hover() { return lastHover; },
    async compute(samples, opts, onProgress, { tOffset = 0 } = {}) {
      dsp ||= createDspClient();
      const t = performance.now();
      spec = await dsp.stft(samples, opts, onProgress);
      if (tOffset) spec.t0 += tOffset;           // analysed a crop: keep the original recording's time axis
      spec.meta.totalMs = performance.now() - t;
      spec.meta.tOffset = tOffset;
      view.setSpectrogram(spec, { keepView: false });
      view.autoLevels(0.7, 0.999);
      await trackCall({ type: 'spec', spec });   // one structured clone per STFT
      return spec;
    },
    /** One-click ridge with auto-extension (web/engine/ridge-extend.js), in the track worker. */
    ridge(seed, opts) { if (!spec) throw new Error('No spectrogram'); return trackCall({ type: 'extend', seed, opts }); },
    /** Pass auto-detection (docs/AUTODETECT.md) on the track worker's copy of the spectrogram; abort = terminate it. */
    detect(opts, { onProgress, signal } = {}) {
      if (!spec) return Promise.reject(new Error('No spectrogram'));
      if (signal?.aborted) return Promise.reject(new DOMException('Detection cancelled', 'AbortError'));
      const p = trackCall({ type: 'autodetect', opts }, onProgress);
      if (!signal) return p;
      const onAbort = () => dropTracker(new DOMException('Detection cancelled', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      return p.finally(() => signal.removeEventListener('abort', onAbort));   // a later abort must not kill a new run
    },
    /** Reference spectrogram + its whitened copy for scoring, computed in the DSP worker (B11). */
    reference(samples, fs) { dsp ||= createDspClient(); return dsp.refspec(samples, fs); },
    /** Drop the spectrogram everywhere (view, track worker, DSP worker) and stop playback. */
    clear() {
      spec = null; lines = new Map(); bands = new Map(); view.setOverlays([]); view.setSpectrogram(null, { autoLevels: false }); view.setCursor(null);
      dropTracker(new DOMException('Spectrogram cleared', 'AbortError'));
      dsp?.terminate(); dsp = null;
    },
    setLines(map) { lines = map; compose(); },
    setBands(list) { bands = new Map(list.map((b, i) => [`band-${i}`, { type: 'band', ...b }])); compose(); },
    setMode(m) { view.setMode(m === 'mark' || m === 'cut' ? 'pick' : m === 'silence' ? 'box' : 'pan'); host.dataset.mode = m; },
    setSource(url) { audio.pause(); audio.src = url || ''; if (!url) audio.removeAttribute('src'); },
    togglePlay() {
      if (!audio.src) return;
      if (audio.paused) {
        const v = view.getView();
        if (view.cursorT == null || audio.currentTime < v.t0 || audio.currentTime > v.t1) audio.currentTime = Math.max(0, v.t0);
        audio.play().catch(() => {});
      } else audio.pause();
    },
    seek(t) { if (audio.src && Number.isFinite(t)) { audio.currentTime = Math.max(0, t); view.setCursor(audio.currentTime); } },
    setFollow(f) { follow = f; },
    zoomTo(t0, t1, f0, f1) { view.setView({ t0, t1, ...(f0 != null ? { f0, f1 } : {}) }); },
    fmt: fmtAudio,
  };
  return api;
}
