// The UI's only door to the geolocation engine (contract: web/engine/geoloc-api.md).
// ONE-LINE SWITCH between Lane D's real engine (web/engine/geoloc.js) and the UI stub.
// The URL can override it (?engine=stub or ?engine=real) for side-by-side testing.
const DEFAULT_ENGINE = 'real';

const wanted = new URLSearchParams(globalThis.location?.search || '').get('engine') || DEFAULT_ENGINE;
let mod;
if (wanted === 'real') {
  try { mod = await import('../engine/geoloc.js'); }
  catch (e) { console.warn('[engine] real engine failed to load, falling back to stub:', e?.message || e); }
}
mod ||= await import('../engine/geoloc-stub.js');

export const ENGINE_INFO = mod.ENGINE_INFO || { name: wanted, version: '?', fake: false };
export const { fitEvent, fetchFlights, runSearch, simulateCurves } = mod;
/** Optional (real engine only): reference spectrogram for scoring, (samples, fs) → contract spectrogram. */
export const referenceSpectrogram = mod.referenceSpectrogram || null;
// [id, plain-language label, technical name (tooltip)]
export const STAGES = [
  ['grid', 'Laying out places to test', 'search grid + terrain'], ['cpa', 'When each plane was closest', 'delayed closest approach (CPA)'],
  ['filters', 'Ruling out mismatches', 'speed, distance, timing and silence filters'], ['sim', 'Simulating each plane\'s sound', 'Doppler simulation'],
  ['score', 'Comparing with your recording', 'spectrogram scoring'], ['refine', 'Zooming in on the best places', 'refinement (100 m, 50 m)'],
];
