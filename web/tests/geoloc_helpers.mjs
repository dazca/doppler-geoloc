// Shared helpers for Lane D tests/benchmarks: scenario loader + analytic DEM (port of ref/doppler_ref/scenarios.py).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseWav } from '../engine/audio.js';
import { makeENU } from '../engine/geoloc/geo.js';
import { buildTrack } from '../engine/geoloc/track.js';
import { refSpectrogram, whiten } from '../engine/geoloc/spectro.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const readJson = (p) => JSON.parse(readFileSync(path.join(ROOT, p)));

/** Analytic DEM: x = R cos(lat0) rad(lon-lon0), y = R rad(lat-lat0); base + gaussian hills + wave. */
export function makeAnalyticDem(p) {
  const R = 6371000.0, [lat0, lon0] = p.ref, D = Math.PI / 180, cl = Math.cos(lat0 * D);
  const one = (lat, lon) => {
    const x = R * cl * (lon - lon0) * D, y = R * (lat - lat0) * D;
    let z = p.base;
    for (const [xi, yi, h, s] of p.hills) z += h * Math.exp(-((x - xi) ** 2 + (y - yi) ** 2) / (2 * s * s));
    const [a, lx, ly] = p.wave;
    return z + a * Math.sin(x / lx) * Math.cos(y / ly);
  };
  const fn = (lat, lon) => Float64Array.from(lat, (la, i) => one(la, lon[i]));
  fn.one = one;
  return fn;
}

const cache = new Map();
export function loadScenario(name, { smoothS = 15, spectrogram = true } = {}) {
  const key = name + smoothS + spectrogram;
  if (cache.has(key)) return cache.get(key);
  const d = `fixtures/${name}`;
  const scen = readJson(`${d}/scenario.json`), truth = readJson(`${d}/truth.json`);
  const events = readJson(`${d}/events_measured.json`), tracksJson = readJson(`${d}/tracks.json`);
  const enu = makeENU(scen.ref[0], scen.ref[1], 0);
  const types = readJson('web/data/types.json');
  const out = { name, scen, truth, events, tracksJson, enu, dem: makeAnalyticDem(scen.dem), types,
    tracks: tracksJson.map((t) => buildTrack(t, enu, smoothS, types)), duration: scen.duration_s, center: scen.search_center };
  if (spectrogram) {
    const t0 = performance.now();
    const w = parseWav(readFileSync(path.join(ROOT, d, 'audio.wav')));
    out.fs = w.sampleRate; out.samples = w.samples;
    out.spec = refSpectrogram(w.samples, w.sampleRate, { nperseg: 4096, hop: 1024, fmax: 1000 });
    const t1 = performance.now();
    out.Z = whiten(out.spec);
    out.timing = { spectrogram_ms: t1 - t0, whiten_ms: performance.now() - t1 };
  }
  cache.set(key, out);
  return out;
}

export function horizErr(sc, lat, lon) {
  const a = sc.enu.fwd(sc.truth.observer.lat, sc.truth.observer.lon, 0), b = sc.enu.fwd(lat, lon, 0);
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
