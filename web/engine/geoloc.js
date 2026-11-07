// Real geolocation engine (Lane D). Implements web/engine/geoloc-api.md (same names/signatures as geoloc-stub.js).
//   fitEvent(points, opts)            straight-pass LSQ fit (MATH.md eq. 3.2), robust soft-L1, with covariance
//   fetchFlights(query, {signal, onProgress})   adsb.lol via Lane B's adsb.js (needs an ADS-B proxy URL), else stub data
//   runSearch(input, {signal, onProgress})      stages 3-6 (grid+DEM, delayed CPA, filters, exact Doppler, score, refine)
//   simulateCurves(candidate, {events, tracks, c, harmonics})
// Heavy kernels run in a Web Worker pool (web/workers/geoloc-pool.js) when Workers exist; inline otherwise (Node).
// Engine modules: web/engine/geoloc/{geo,track,doppler,spectro,filters,score,fit,search,exec}.js
import { makeENU } from './geoloc/geo.js';
import { buildTrack } from './geoloc/track.js';
import { emissionTime, cpa, straightLineF, audibleRadius, AUDIBLE_R } from './geoloc/doppler.js';
import { refSpectrogram, whiten, decimate } from './geoloc/spectro.js';
import { fitPass } from './geoloc/fit.js';
import { runSearchCore, makeConfig } from './geoloc/search.js';
import { absoluteTest } from './geoloc/verdict.js';
import { runMontageCore } from './geoloc/montage.js';
import { createInlineExecutor } from './geoloc/exec.js';

export const ENGINE_INFO = { name: 'geoloc', version: '1.0.0', fake: false };
export const STAGE_ORDER = ['grid', 'cpa', 'filters', 'sim', 'score', 'refine'];
const C = 343;
const TRACK_SMOOTH_S = 15; // local-quadratic smoothing window (Lane A recommendation)

const abortErr = () => new DOMException('Aborted', 'AbortError');

// ------------------------------------------------------------------ ground-ops filter (D11)
/**
 * Is this ridge a flyover? A pass is a FALLING Doppler curve with a real swing. Static tones (ground run-up, hover,
 * constant rpm) and rising pitch (rpm increase, start-up, take-off roll) are not flyovers.
 * points: [[t, f]] (any harmonic). Returns {ok, kind: 'flyover'|'static'|'rising', swing_rel, trend_rel, reason}.
 */
export function flyoverCheck(points, { minSwing = 0.02, minTrend = 0.01, minTransitionS = 1.5 } = {}) {
  const p = (points || []).filter((q) => Number.isFinite(q?.[0]) && Number.isFinite(q?.[1]) && q[1] > 0).sort((a, b) => a[0] - b[0]);
  if (p.length < 8) return { ok: true, kind: 'unknown', reason: 'too few ridge points to judge' };
  const f = p.map((q) => q[1]), s = f.slice().sort((a, b) => a - b), q = (x) => s[Math.min(s.length - 1, Math.floor(x * (s.length - 1)))];
  const med = q(0.5), swing = (q(0.95) - q(0.05)) / med;
  const k = Math.max(3, Math.floor(0.2 * f.length)), mOf = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const trend = (mOf(f.slice(-k)) - mOf(f.slice(0, k))) / med;
  if (trend > minTrend) return { ok: false, kind: 'rising', swing_rel: swing, trend_rel: trend, reason: `pitch rises by ${(100 * trend).toFixed(1)} % (rpm increase / start-up / take-off roll): not a flyover` };
  if (swing < minSwing || -trend < minTrend) return { ok: false, kind: 'static', swing_rel: swing, trend_rel: trend, reason: `no Doppler swing (${(100 * swing).toFixed(1)} %): static tone / ground run, not a flyover` };
  // abrupt drop: a Doppler swing needs >= 2.67 d/v for its 10 -> 90 % transition (>= ~3 s for any airborne pass),
  // a throttle/rpm step completes in about a second. Median-smoothed (+-0.5 s) crossing times of the 90 % / 10 % levels.
  const t = p.map((q) => q[0]), sm = f.map((_, i) => { const w = []; for (let j = i; j >= 0 && t[i] - t[j] <= 0.5; j--) w.push(f[j]); for (let j = i + 1; j < f.length && t[j] - t[i] <= 0.5; j++) w.push(f[j]); return mOf(w); });
  const hiL = q(0.95) - 0.1 * (q(0.95) - q(0.05)), loL = q(0.05) + 0.1 * (q(0.95) - q(0.05));
  let i90 = sm.findIndex((v) => v <= hiL), i10 = sm.findIndex((v, i) => i >= Math.max(0, i90) && v <= loL);
  const transition = i90 >= 0 && i10 >= 0 ? t[i10] - t[i90] : Infinity;
  if (transition < minTransitionS) return { ok: false, kind: 'step', swing_rel: swing, trend_rel: trend, transition_s: transition, reason: `the pitch drops within ${transition.toFixed(1)} s (a Doppler swing takes >= ~3 s): rpm/throttle step, not a flyover` };
  return { ok: true, kind: 'flyover', swing_rel: swing, trend_rel: trend, transition_s: transition, reason: 'falling Doppler curve' };
}

// ------------------------------------------------------------------ fitEvent
export async function fitEvent(points, { c = C, cls = 'unknown' } = {}) {
  const pts = (points || []).filter((p) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]) && p[1] > 0).sort((a, b) => a[0] - b[0]);
  if (pts.length < 8) throw new Error('Too few ridge points to fit a pass (need at least 8).');
  const ts = pts.map((p) => p[0]), fs = pts.map((p) => p[1]);
  const sorted = fs.slice().sort((a, b) => a - b);
  const swing = sorted[Math.floor(0.97 * (sorted.length - 1))] - sorted[Math.floor(0.03 * (sorted.length - 1))];
  if (!(swing > 0.5)) throw new Error('The curve is flat: no Doppler swing to fit.');
  const fit = fitPass(ts, fs, { c, cls });
  if (!Number.isFinite(fit.F0) || !Number.isFinite(fit.v) || !Number.isFinite(fit.d)) throw new Error('The pass fit did not converge.');
  const t0 = ts[0] - 20, t1 = ts[ts.length - 1] + 20, curve = [];
  for (let k = 0; k <= 200; k++) { const t = t0 + (t1 - t0) * k / 200; curve.push([t, straightLineF(t - fit.t_c, fit.F0, fit.v, fit.d, c)]); }
  return {
    t_cpa_audio: fit.t_cpa_audio, t_c: fit.t_c, F0: fit.F0,
    // suggested ranges: 2-sigma total uncertainty (inflated statistics + straight-line model error, growing when the
    // asymptotes are not observed) united with the 2-sigma profile-likelihood region and the classic +-20/40 %
    v_mps: fit.ranges.v_mps, cpa_m: fit.ranges.cpa_m,
    point: { v: fit.v, d: fit.d }, rms_hz: fit.rms_hz, n: pts.length, curve,
    // extras (see geoloc-api.md §1 addendum)
    t_sigma_s: fit.sigma_total.t_cpa_audio, t_cpa_range: fit.ranges.t_cpa_audio, flyover: flyoverCheck(pts),
    sigma: fit.sigma, sigma_total: fit.sigma_total,
    poorly_constrained: fit.quality.poorly_constrained, quality: fit.quality,
    unconstrained: fit.unconstrained, profile: { d: fit.profile.d, v: fit.profile.v, t_cpa_audio: fit.profile.t_cpa_audio },
  };
}

// ------------------------------------------------------------------ fetchFlights
let typesPromise = null;
async function loadTypes() {
  typesPromise ||= (async () => {
    const u = new URL('../data/types.json', import.meta.url);
    try { const r = await fetch(u); if (r.ok) return await r.json(); } catch { /* Node: file URL */ }
    try { const { readFile } = await import('node:fs/promises'); return JSON.parse(await readFile(u)); } catch { return null; }
  })();
  return typesPromise;
}

/**
 * query.worker (or globalThis.GEOLOC_ADSB_WORKER) = URL of the ADS-B proxy (worker/src/index.js). Without one the
 * stub's fixture/synthetic data are returned and a note says so.
 */
export async function fetchFlights(query, { signal, onProgress } = {}) {
  const { bbox, t0, t1, padS = 1800, duration_s = 0, maxAltM } = query;
  const worker = query.worker ?? globalThis.GEOLOC_ADSB_WORKER;
  if (!worker) {
    const stub = await import('./geoloc-stub.js');
    const r = await stub.fetchFlights(query, { signal, onProgress });
    return { ...r, notes: [...(r.notes || []), 'No ADS-B proxy configured (query.worker / GEOLOC_ADSB_WORKER): using fixture or synthetic tracks.'] };
  }
  const { fetchTracks } = await import('./adsb.js');
  if (signal?.aborted) throw abortErr();
  onProgress?.({ stage: 'index', frac: 0, message: 'Looking up flight index' });
  const types = await loadTypes();
  const f = (u, o) => fetch(u, { ...o, signal });
  let n = 0;
  const tracks = await fetchTracks({ worker, bbox, t0: t0 - padS, t1: t1 + duration_s + padS, types, fetch: f,
    maxAltFt: maxAltM ? maxAltM / 0.3048 : 20000,
    onProgress: (k, total) => { n = k; onProgress?.({ stage: 'download', frac: total ? k / total : null, message: `${k}/${total || '?'} traces` }); } });
  onProgress?.({ stage: 'parse', frac: 1, message: `${tracks.length} tracks from ${n} traces` });
  const counts = { prop: 0, jet: 0, heli: 0, unknown: 0 };
  for (const t of tracks) counts[counts[t.category] != null ? t.category : 'unknown']++;
  return { tracks, source: 'adsb.lol globe_history', attribution: 'ADS-B data © adsb.lol contributors, ODbL 1.0', counts,
    days: tracks.days || [], failed: tracks.failed || [], notes: tracks.warnings || [] };
}

// ------------------------------------------------------------------ spectrogram preparation
const zCache = new WeakMap();
/** Crop the contract spectrogram to [.., fMax] and whiten it per bin (median/MAD, clip [-3, 8]). Cached per object. */
export function prepareSpectrogram(spec, fMax = Infinity) {
  if (spec.unit === 'z') {     // already whitened (e.g. in the DSP worker): whitening is per bin, so only crop the band
    const nF = Math.min(spec.nF, Math.max(2, Math.floor((fMax - spec.f0) / spec.df) + 2));
    const { data, ...meta } = spec;
    if (nF >= spec.nF) return { spec: meta, Z: data };
    const hit = zCache.get(data);
    if (hit && hit.nF === nF) return hit;
    const Z = new Float32Array(spec.nT * nF);
    for (let i = 0; i < spec.nT; i++) Z.set(data.subarray(i * spec.nF, i * spec.nF + nF), i * nF);
    const out = { spec: { ...meta, nF }, Z, nF };
    zCache.set(data, out);
    return out;
  }
  const key = spec.data;
  const hit = zCache.get(key);
  if (hit && hit.fMax >= fMax) return hit;
  const nF = Math.min(spec.nF, Math.max(2, Math.floor((fMax - spec.f0) / spec.df) + 2));
  let s = spec;
  if (nF < spec.nF) {
    const d = new Float32Array(spec.nT * nF);
    for (let i = 0; i < spec.nT; i++) d.set(spec.data.subarray(i * spec.nF, i * spec.nF + nF), i * nF);
    s = { ...spec, nF, data: d };
  }
  const out = { spec: { t0: s.t0, dt: s.dt, f0: s.f0, df: s.df, nT: s.nT, nF: s.nF, unit: 'z' }, Z: whiten(s), fMax: s.f0 + (nF - 1) * s.df };
  zCache.set(key, out);
  return out;
}

/** Reference spectrogram from samples (resampled to 8 kHz; Hann 4096 / hop 1024 / <= 1 kHz, Lane A §6.1). */
export async function referenceSpectrogram(samples, fs, { fmax = 1000 } = {}) {
  let x = samples, rate = fs;
  if (fs !== 8000) {
    const M = fs / 8000;
    if (Number.isInteger(M)) x = decimate(samples, M);       // 16/24/32/48 kHz: fast FIR decimator
    else { const { resample } = await import('./audio.js'); x = resample(samples, fs, 8000); }
    rate = 8000;
  }
  return refSpectrogram(x, rate, { nperseg: 4096, hop: 1024, fmax });
}

// ------------------------------------------------------------------ executor (worker pool)
// B3: without SharedArrayBuffer every worker holds its own copy of Z, so the pool is sized by Z.byteLength against
// the device memory (geoloc-pool.js#poolSizeFor); releaseEngine() terminates it (new file / new project).
let pool = null, poolSize = 0;
async function getExecutor(nWorkers, zBytes = 0) {
  if (nWorkers === 0 || typeof Worker === 'undefined') return createInlineExecutor();
  let mod;
  try { mod = await import('../workers/geoloc-pool.js'); } catch (e) { console.warn('[geoloc] worker pool unavailable, running inline:', e); return createInlineExecutor(); }
  const want = nWorkers || mod.poolSizeFor(zBytes);
  if (pool && poolSize !== want) { pool.close(); pool = null; }
  if (!pool) { pool = mod.createGeolocPool({ size: want }); poolSize = want; }
  return pool;
}
/** Terminate the worker pool and drop every per-recording cache (call when the recording changes). */
export function releaseEngine() { pool?.close(); pool = null; poolSize = 0; }

// Z rows the workers can touch: scoring samples lie within +-tau_half of each event's delayed CPA, shifted by at most
// delta_half and the offset gate (whole-recording uses such as the verdict's time-shift null keep the full Z).
const zCropCache = new WeakMap();
export function cropZToEvents(zs, Z, events, cfg = {}) {
  const ts = events.map((e) => e.t_cpa_audio).filter(Number.isFinite);
  if (!ts.length || cfg.use_offset_filter === false) return { zs, Z }; // no offset gate: any time offset can score
  // The window must cover everything the search can reach (filters.js / search.js): the per-event offset gate
  // (>= 3 x hypot of two events' time sigmas, each >= sigma_t and the event's own t_sigma_s) and the T_start sweep.
  const sd = cfg.soft || {};
  const tSig = Math.max(sd.sigma_t ?? 8, ...events.map((e) => e.t_sigma_s || 0));
  const gate = Math.max(sd.offset_gate ?? 30, cfg.offset_tol ?? 8, 3 * Math.SQRT2 * tSig);
  const dHalf = Math.max(cfg.delta_half ?? 4, sd.delta_half_coarse ?? 12, Math.min(40, 2 * Math.max(0, ...events.map((e) => e.t_sigma_s || 0))));
  const margin = (cfg.tau_half ?? 60) + dHalf + gate + 60;
  const i0 = Math.max(0, Math.floor((Math.min(...ts) - margin - zs.t0) / zs.dt) - 2);
  const i1 = Math.min(zs.nT, Math.ceil((Math.max(...ts) + margin - zs.t0) / zs.dt) + 3);
  if (i1 - i0 < 2 || (i1 - i0) > 0.7 * zs.nT) return { zs, Z };   // not worth a copy
  const key = `${i0}:${i1}`, hit = zCropCache.get(Z);
  if (hit?.key === key) return hit.out;
  const out = { zs: { ...zs, t0: zs.t0 + i0 * zs.dt, nT: i1 - i0 }, Z: Z.slice(i0 * zs.nF, i1 * zs.nF) };
  zCropCache.set(Z, { key, out });
  return out;
}

// ------------------------------------------------------------------ DEM
async function demFunction(input) {
  const d = input.dem;
  if (typeof d === 'function') return async (lat, lon) => d(lat, lon);
  if (d && typeof d.elevations === 'function') return async (lat, lon) => d.elevations({ lat, lon });
  const { createDem } = await import('./dem.js');
  const dem = createDem({ zoom: 12 });
  return async (lat, lon) => dem.elevations({ lat, lon });
}

const EVENT_CATS = { prop: ['prop', 'unknown'], heli: ['heli', 'unknown'], jet: ['jet', 'unknown'], unknown: ['prop', 'unknown', 'heli'] };

// ------------------------------------------------------------------ runSearch
/**
 * input: see geoloc-api.md §3. Extras accepted: input.dem (fn(lat[], lon[]) or {elevations}), input.audio = {samples, fs}
 * (engine computes the reference spectrogram), settings.mode = 'robust' (default) | 'faithful',
 * settings.useRidgeFit (default true), settings.workers (0 = inline), settings.config (raw search.js overrides),
 * settings.cropZ (default true: workers get only the Z rows near the events), input.whitened (unit 'z' copy of input.spec).
 */
export async function runSearch(input, { signal, onProgress, exec: execIn } = {}) {
  const T0 = performance.now();
  let settled = false;
  const prog = (p) => { if (!settled) onProgress?.(p); };
  if (signal?.aborted) throw abortErr();
  const st = input.settings || {};
  const c = st.c || C, notes = [];
  const mode = st.mode || 'robust';
  try {
    // events: optional replacement of the hand-read CPA time by the ridge fit (Lane A §6.9, D7b)
    const pre = {}; let tp = performance.now(); const lap = (k) => { pre[k] = Math.round(performance.now() - tp); tp = performance.now(); };
    let events = (input.events || []).map((e) => ({ ...e })).sort((a, b) => a.t_cpa_audio - b.t_cpa_audio);
    if (!events.length) throw new Error('No events.');
    // D11 ground-ops filter: events whose ridge is not a falling Doppler curve are excluded (settings.keepGroundOps)
    const excluded = [];
    if (!st.keepGroundOps) {
      events = events.filter((ev, i) => {
        if (!ev.ridge) return true;
        const fo = flyoverCheck(ev.ridge);
        if (fo.ok) return true;
        excluded.push({ event: i, reason: fo.reason }); notes.push(`event ${i + 1} excluded: ${fo.reason}`);
        return false;
      });
      if (!events.length) {
        settled = true;
        return { candidates: [], field: null, excluded_events: excluded,
          confidence: { margin: null, ambiguous: true, runnerUp: null, message: 'no flyover event to search with',
            absolute: { verdict: 'no plausible match', reasons: ['every event looks like ground operations (no falling Doppler curve)'], events: [] } },
          stats: { gridPoints: 0, survivorsByStage: {}, elapsedMs: performance.now() - T0, timings: {}, notes } };
      }
    }
    if (st.useRidgeFit !== false) {
      for (const [i, ev] of events.entries()) {
        if (!ev.ridge || ev.ridge.length < 8) continue;
        try {
          const f = await fitEvent(ev.ridge, { c, cls: ev.cls });
          if (f.poorly_constrained) {
            // keep the entered time, but widen its prior to the honest fit uncertainty
            ev.t_sigma_s = Math.max(ev.t_sigma_s || 0, f.t_sigma_s);
            notes.push(`event ${i + 1}: ridge fit poorly constrained (${f.quality.reasons.join('; ')}); kept the entered CPA time, time prior widened to ${ev.t_sigma_s.toFixed(1)} s`);
          } else {
            notes.push(`event ${i + 1}: delayed CPA from the ridge fit ${f.t_cpa_audio.toFixed(1)} +- ${f.t_sigma_s.toFixed(1)} s (entered ${ev.t_cpa_audio.toFixed(1)} s)`);
            ev.t_cpa_audio = f.t_cpa_audio;
            ev.t_sigma_s = f.t_sigma_s;
            // well-constrained fit: Doppler-implied speed and CPA distance as Gaussian priors (sigma includes the
            // straight-line model floor), compared with the ADS-B track at the candidate; ranks the survivor cap
            if (!ev.v_est && st.fitPriors !== false) ev.v_est = [f.point.v, f.sigma_total.v];
            if (!ev.d_est && st.fitPriors !== false) ev.d_est = [f.point.d, f.sigma_total.d];
            if (Math.abs(f.F0 / ev.F0 - 1) < 0.1) ev.F0 = f.F0;
          }
        } catch (e) { notes.push(`event ${i + 1}: ridge fit failed (${e.message}); using the entered values`); }
      }
    }
    // spectrogram -> whitened Z (cropped to the band the harmonics can reach)
    const cfg0 = makeConfig({});
    const harmonics = st.harmonics || cfg0.harmonics;
    const fNeed = Math.max(...events.map((e) => e.F0)) * 1.12 * Math.max(...harmonics) * 1.45;
    let spec = input.spec;
    if (!spec && input.audio) spec = await referenceSpectrogram(input.audio.samples, input.audio.fs);
    if (!spec) throw new Error('runSearch needs input.spec (contract spectrogram) or input.audio {samples, fs}.');
    lap('ridge_refit');
    // input.whitened: the same grid already whitened (UI: DSP worker, B11); whitening is per bin, so cropping it is exact
    const w = input.whitened, sameGrid = w && w.unit === 'z' && w.nT === spec.nT && w.nF === spec.nF && w.t0 === spec.t0 && w.dt === spec.dt && w.f0 === spec.f0 && w.df === spec.df;
    const { spec: zs, Z } = prepareSpectrogram(sameGrid ? w : spec, fNeed);
    lap('whiten');
    if (signal?.aborted) throw abortErr();

    // region -> ENU frame at the centre, half-size, mask
    const region = input.region;
    const center = region.center || [(region.bbox[0] + region.bbox[2]) / 2, (region.bbox[1] + region.bbox[3]) / 2];
    const enu = makeENU(center[0], center[1], 0);
    let half, mask;
    if (region.shape === 'circle' && region.radius_m) {
      half = region.radius_m; const r2 = half * half;
      mask = (xy, N) => { const m = new Uint8Array(N); for (let p = 0; p < N; p++) m[p] = xy[2 * p] ** 2 + xy[2 * p + 1] ** 2 <= r2 ? 1 : 0; return m; };
    } else {
      const [la0, lo0, la1, lo1] = region.bbox, a = enu.fwd(la0, lo0, 0), b = enu.fwd(la1, lo1, 0);
      const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
      half = Math.max(-x0, x1, -y0, y1);
      mask = (xy, N) => { const m = new Uint8Array(N); for (let p = 0; p < N; p++) { const x = xy[2 * p], y = xy[2 * p + 1]; m[p] = x >= x0 && x <= x1 && y >= y0 && y <= y1 ? 1 : 0; } return m; };
    }
    // categories: union of what the events allow
    const cats = [...new Set(events.flatMap((e) => EVENT_CATS[e.cls] || cfg0.candidate_categories))];
    const tol = st.offsetTolS ?? 8;
    const cfg = {
      c, mode, spacing: st.grid_m || 200, box_half: half, harmonics, offset_tol: tol, candidate_categories: cats,
      soft: { sigma_t: Math.max(4, tol), offset_gate: Math.max(30, 3 * tol) },
      t_start_prior: input.time && Number.isFinite(input.time.t0) && Number.isFinite(input.time.t1)
        ? [(input.time.t0 + input.time.t1) / 2, Math.max(0, (input.time.t1 - input.time.t0) / 2)] : null,
      silences: input.silences || [],
      ...(st.config || {}),
    };
    if (st.refine === false) cfg.refine = [];
    // only flights that can matter: raw points inside the region box + 8 km and the time window (+ clip, +-15 min);
    // candidate classes get the W = 15 s smoothing (Doppler needs clean velocity), the others (veto/evidence only) not
    const dur0 = input.duration_s || zs.t0 + zs.nT * zs.dt;
    const tw = cfg.t_start_prior ? [cfg.t_start_prior[0] - cfg.t_start_prior[1] - 900, cfg.t_start_prior[0] + cfg.t_start_prior[1] + dur0 + 900] : null;
    const padLat = 8000 / 111000, padLon = 8000 / (111000 * Math.cos(center[0] * Math.PI / 180));
    const bb = region.bbox ? [region.bbox[0] - padLat, region.bbox[1] - padLon, region.bbox[2] + padLat, region.bbox[3] + padLon]
      : [center[0] - (half + 8000) / 111000, center[1] - padLon - half / (111000 * Math.cos(center[0] * Math.PI / 180)),
        center[0] + (half + 8000) / 111000, center[1] + padLon + half / (111000 * Math.cos(center[0] * Math.PI / 180))];
    const relevant = (t) => {
      const P = t.points; if (!P || P.length < 2) return false;
      if (tw && (P[P.length - 1][0] < tw[0] || P[0][0] > tw[1])) return false;
      for (const p of P) if (p[1] >= bb[0] && p[1] <= bb[2] && p[2] >= bb[1] && p[2] <= bb[3]) return true;
      return false;
    };
    const types = input.types ?? await loadTypes();   // ICAO type DB: engine class -> audible reach (robust)
    const gapS = mode === 'robust' ? (st.gapS ?? 20) : 0;   // D14: kinematic interpolation + down-weighting across ADS-B gaps > 20 s
    const tracks = (input.tracks || []).filter(relevant).map((t) => buildTrack(t, enu, cats.includes(t.category) ? TRACK_SMOOTH_S : 0, types, { gapS, useReportedVel: st.useReportedVel !== false, velLagS: st.velLagS ?? 2.75 }));
    lap('tracks');
    if (!tracks.length) throw new Error('No usable tracks.');
    // D12 tail-number hints (event.reg, e.g. from a video description): restrict that event to matching tracks
    const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const rawById = new Map((input.tracks || []).map((t) => [t.id, t]));
    for (const [i, ev] of events.entries()) {
      if (!ev.reg) continue;
      const want = norm(ev.reg), idx = [];
      tracks.forEach((t, f) => { const r = rawById.get(t.id); if (want && (norm(r?.reg) === want || norm(t.callsign) === want)) idx.push(f); });
      if (idx.length) ev.allowed_flights = idx;
      else notes.push(`event ${i + 1}: no track with registration/callsign ${ev.reg} in the data; hint ignored`);
    }
    const dem = await demFunction(input);
    // D11 montage: events from different clips (event.clip) have independent start times
    const clipIds = new Set(events.map((e) => e.clip).filter((x) => x != null));
    const montage = clipIds.size >= 2;
    const { zs: zw, Z: Zw } = montage || st.cropZ === false ? { zs, Z } : cropZToEvents(zs, Z, events, makeConfig(cfg));
    const exec = execIn || await getExecutor(st.workers, Zw.byteLength);  // opts.exec: executor injection (tests, Node worker pool)
    lap('executor');
    if (montage) { events.forEach((e) => { if (e.clip == null) e.clip = '_'; }); notes.push(`montage: ${clipIds.size} clips, each with its own unknown start time`); }
    const durationS = input.duration_s || zs.t0 + zs.nT * zs.dt;
    const r = montage
      ? await runMontageCore(tracks, dem, events, Z, zs, enu, center, durationS, cfg, { exec, signal, onProgress: prog, mask, topN: st.topN || 10 }, input.clips || [])
      : await runSearchCore(tracks, dem, events, Zw, zw, enu, center, durationS, cfg,
        { exec, signal, onProgress: prog, mask, topN: st.topN || 10, rawSpec: spec });
    if (exec.kind === 'inline') exec.close();

    // candidates (API shape + extras)
    const byId = new Map(tracks.map((t) => [t.id, t]));
    const toApi = (cd) => {
      const o = enu.fwd(cd.lat, cd.lon, cd.elev_m);
      const assignments = cd.flights.map((fid, e) => {
        const Ts = cd.t_start_by_event ? cd.t_start_by_event[e] : cd.t_start_unix;
        if (fid == null) return { event: e, flight: null, clip: events[e]?.clip ?? null, note: 'no flight in this clip explains the event here' };
        const k = cpa(byId.get(fid), [o], c), tdc = cd.tdcpa?.[e] ?? k.t_dcpa[0];
        return { event: e, flight: fid, clip: events[e]?.clip ?? null, t_start_unix: Ts, t_cpa_unix: k.t_cpa[0], cpa_m: k.d_cpa[0], t_dcpa_unix: tdc, t_dcpa_audio: tdc - Ts,
          speed_mps: k.speed[0], score: cd.event_scores[e], offset_resid_s: cd.offset_resid_s[e] };
      });
      return { lat: cd.lat, lon: cd.lon, elev_m: cd.elev_m, score: cd.score, flights: cd.flights, t_start_unix: cd.t_start_unix,
        F0: cd.F0, assignments, raw_score: cd.raw_score, penalty: cd.penalty, level_m: cd.level_m, ridge_rms: cd.ridge_rms ?? null,
        score_doppler: cd.score_doppler ?? cd.score, evidence: cd.evidence ?? null, unexplained_events: cd.unexplained ?? [],
        t_start_by_clip: cd.t_start_by_clip ?? null };
    };
    const candidates = r.candidates.map(toApi);
    if (candidates.length) {
      const b = candidates[0].score;
      candidates.forEach((cd) => { cd.margin = (b - cd.score) / Math.max(Math.abs(b), 1); });
    }
    // heat map: coarse grid best score per cell on a lat/lon raster
    let field = null;
    const g = r.coarse.grid;
    if (g.N) {
      const n = g.nx;
      let la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
      for (let p = 0; p < g.N; p++) { la0 = Math.min(la0, g.lat[p]); la1 = Math.max(la1, g.lat[p]); lo0 = Math.min(lo0, g.lon[p]); lo1 = Math.max(lo1, g.lon[p]); }
      const values = new Array(n * n).fill(NaN);
      let mn = Infinity, mx = -Infinity;
      for (let p = 0; p < g.N; p++) {
        const v = r.coarse.map[p]; if (!Number.isFinite(v)) continue;
        const i = Math.min(n - 1, Math.round((g.lat[p] - la0) / ((la1 - la0) || 1) * (n - 1)));
        const j = Math.min(n - 1, Math.round((g.lon[p] - lo0) / ((lo1 - lo0) || 1) * (n - 1)));
        const k = i * n + j;
        if (!(values[k] >= v)) values[k] = v;
        mn = Math.min(mn, v); mx = Math.max(mx, v);
      }
      field = { bbox: [la0, lo0, la1, lo1], nLat: n, nLon: n, values, min: Number.isFinite(mn) ? mn : 0, max: Number.isFinite(mx) ? mx : 0 };
    }
    const margin = r.margin;
    // D11 absolute test of the best candidate (permutation null + ridge misfit null)
    let absolute = { verdict: 'no plausible match', reasons: ['no flight in the data passes within audible range of the region'], events: [] };
    if (r.best) {
      const o = enu.fwd(r.best.lat, r.best.lon, r.best.elev_m);
      const knownT = !!(cfg.t_start_prior && cfg.t_start_prior[1] <= 120);
      try { absolute = absoluteTest(tracks, o, r.best, r.events_recentred || events, Z, zs, makeConfig(cfg), { known_t: knownT, ...(st.verdict || {}) }); }
      catch (e) { absolute = { verdict: 'no plausible match', reasons: [`absolute test failed (${e.message}): no verdict, treat as unverified`], events: [] }; }
      if (candidates[0]) candidates[0].verdict = absolute.verdict;
    }
    // ambiguity area: coarse cells within 10 % of the best coarse score
    let ambiguity_km2 = null;
    if (r.coarse?.map) {
      let mx = -Infinity; for (const v of r.coarse.map) if (v > mx) mx = v;
      if (Number.isFinite(mx)) { const thr = mx - 0.1 * Math.max(Math.abs(mx), 1); let k = 0; for (const v of r.coarse.map) if (v >= thr) k++;
        ambiguity_km2 = +(k * (cfg.spacing / 1000) ** 2).toFixed(2); }
    }
    absolute.ambiguity_km2 = ambiguity_km2;
    const result = {
      candidates, field, excluded_events: excluded,
      confidence: { margin, ambiguous: margin != null && margin < 0.1, absolute, verdict: absolute.verdict,
        runnerUp: r.runnerUp ? toApi(r.runnerUp) : null,
        message: margin == null ? 'no candidate' : margin < 0.1 ? `ambiguous: a distinct alternative scores within ${(100 * margin).toFixed(1)} %` : `best is ${(100 * margin).toFixed(0)} % above the next distinct alternative` },
      stats: { gridPoints: r.n_grid, survivorsByStage: r.survivorsByStage, elapsedMs: performance.now() - T0, timings: r.timings, preamble: pre,
        mode, executor: exec.kind, workers: exec.workers, refinePoints: r.n_refine_points, notes },
    };
    settled = true;
    return result;
  } catch (e) {
    settled = true;
    throw e;
  }
}

// ------------------------------------------------------------------ simulateCurves
export async function simulateCurves(candidate, { events, tracks, c = C, harmonics = [1, 2, 3] }) {
  const enu = makeENU(candidate.lat, candidate.lon, 0);
  const o = enu.fwd(candidate.lat, candidate.lon, candidate.elev_m || 0);
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const evs = events.slice().sort((a, b) => a.t_cpa_audio - b.t_cpa_audio);
  const out = [], o3 = new Float64Array(3), b6 = new Float64Array(6);
  evs.forEach((ev, n) => {
    const fid = candidate.assignments?.find((a) => a.event === n)?.flight ?? candidate.flights?.[n];
    const raw = byId.get(fid);
    if (!raw || raw.points.length < 2) return;
    const tr = buildTrack(raw, enu, TRACK_SMOOTH_S);
    const F0 = candidate.F0?.[n] ?? ev.F0;
    const tdc = cpa(tr, [o], c).t_dcpa[0];
    const raud = audibleRadius(tr.category, AUDIBLE_R) * 1.5;
    const pts = [];
    for (let tau = -90; tau <= 90 + 1e-9; tau += 0.25) {
      const trx = tdc + tau;
      if (!emissionTime(tr, o[0], o[1], o[2], trx, c, o3, b6) || o3[1] > raud) continue;
      pts.push([trx - candidate.t_start_unix, F0 * c / (c - o3[2])]);
    }
    for (const h of harmonics) out.push({ event: n, flight: fid, harmonic: h, points: pts.map(([t, f]) => [t, f * h]) });
  });
  return out;
}
