// Lane D (D8 scale): real-traffic benchmark on fixtures/real/colsto_longisland (adsb.lol 2026-09-08, 5410 tracks, 30 h).
// node web/tests/geoloc_colsto_bench.mjs [workers=16] [region=bbox|circle15] [tracks=all|nojet]
// Events: one-click honest fits of the ridges (ridges.json, harmonic 1), class prop. DEM: flat 20 m (offline).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './geoloc_helpers.mjs';
import { parseWav } from '../engine/audio.js';
import * as Engine from '../engine/geoloc.js';
import { createGeolocPool, nodeWorkerFactory } from '../workers/geoloc-pool.js';

const W = +(process.argv[2] ?? 16), regionKind = process.argv[3] || 'bbox', trackKind = process.argv[4] || 'all';
const D = path.join(ROOT, 'fixtures/real/colsto_longisland');
const meta = JSON.parse(readFileSync(path.join(D, 'meta.json')));
const ridges = JSON.parse(readFileSync(path.join(D, 'ridges.json')));
let tracks = JSON.parse(readFileSync(path.join(D, 'tracks_2026.json')));
if (trackKind === 'nojet') tracks = tracks.filter((t) => t.category !== 'jet');
let t = performance.now();
const wav = parseWav(readFileSync(path.join(D, 'audio.wav')));
const spec = await Engine.referenceSpectrogram(wav.samples, wav.sampleRate);
const tSpec = performance.now() - t;
const events = [];
for (const ev of [1, 2]) {
  const rd = ridges.find((r) => r.event === ev && r.harmonic === 1);
  const pts = rd.points.map(([a, f]) => [a, f]);
  const fit = await Engine.fitEvent(pts, { cls: 'prop' });
  events.push({ t_cpa_audio: fit.t_cpa_audio, F0: fit.F0, v_mps: fit.v_mps, cpa_m: fit.cpa_m, cls: 'prop', t_sigma_s: fit.t_sigma_s, ridge: pts });
}
const toUnix = (s) => Date.parse(s) / 1000;
const [w0, w1] = meta.date_utc_window.map(toUnix);
const region = regionKind === 'circle15'
  ? { shape: 'circle', center: [meta.true_lat, meta.true_lon], radius_m: 15000, bbox: [meta.true_lat - 0.14, meta.true_lon - 0.18, meta.true_lat + 0.14, meta.true_lon + 0.18] }
  : { shape: 'rect', center: [(meta.bbox[0] + meta.bbox[2]) / 2, (meta.bbox[1] + meta.bbox[3]) / 2], bbox: meta.bbox };
const input = { events, silences: [], region, time: { t0: w0, t1: w1 }, duration_s: wav.samples.length / wav.sampleRate,
  tracks, spec, dem: (lat) => new Float64Array(lat.length).fill(20), settings: { grid_m: 200, c: 343, topN: 10, offsetTolS: 8, mode: 'robust', config: JSON.parse(process.env.GEOLOC_CFG || '{}') } };
const exec = W ? createGeolocPool({ size: W, factory: await nodeWorkerFactory() }) : undefined;
console.log(`colsto: ${tracks.length} tracks (${trackKind}), region ${regionKind}, window ${((w1 - w0) / 3600).toFixed(0)} h, clip ${input.duration_s.toFixed(0)} s, spectrogram ${tSpec.toFixed(0)} ms, workers ${W || 'inline'}`);
console.log('events:', events.map((e) => `t ${e.t_cpa_audio.toFixed(1)}+-${e.t_sigma_s.toFixed(1)} F0 ${e.F0.toFixed(1)} v [${e.v_mps.map((x) => x.toFixed(0))}] d [${e.cpa_m.map((x) => x.toFixed(0))}]`).join(' | '));
const marks = {};
const mem0 = process.memoryUsage().rss;
let peak = mem0;
const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 100);
t = performance.now();
const res = await Engine.runSearch(input, { exec, onProgress: (p) => { if (p.frac === 1 && !marks[p.stage]) console.log(`  [${((performance.now() - t) / 1000).toFixed(1)} s] ${p.stage} done ${p.message || ''} ${p.survivors ?? ''}`); if (p.frac === 1) marks[p.stage] = Math.round(performance.now() - t); if (p.message && p.frac === 1) marks[p.stage + '_msg'] = p.message; } });
const el = performance.now() - t;
clearInterval(iv);
console.log(`total ${(el / 1000).toFixed(2)} s; stage end times ${JSON.stringify(marks)}`);
console.log(`timings ${JSON.stringify(Object.fromEntries(Object.entries(res.stats.timings).map(([k, v]) => [k, Math.round(v)])))}; survivors ${JSON.stringify(res.stats.survivorsByStage)}; peak RSS ${((peak) / 1e6).toFixed(0)} MB`);
const kx = 111320 * Math.cos(meta.true_lat * Math.PI / 180);
for (const c of res.candidates.slice(0, 5)) {
  const err = Math.hypot((c.lat - meta.true_lat) * 110950, (c.lon - meta.true_lon) * kx);
  console.log(`  ${c.lat.toFixed(5)},${c.lon.toFixed(5)} (${(err / 1000).toFixed(1)} km from the rounded label) score ${c.score.toFixed(3)} flights ${c.flights.join('+')} T_start ${new Date(c.t_start_unix * 1000).toISOString()} margin ${c.margin.toFixed(3)}`);
}
console.log('verdict:', res.confidence.verdict, JSON.stringify({ z: res.confidence.absolute?.z, z_min: res.confidence.absolute?.z_min, ridge: res.confidence.absolute?.worst_ridge_ratio, reasons: res.confidence.absolute?.reasons })); console.log('confidence:', res.confidence.message, '| notes:', res.stats.notes.join(' | '));
exec?.close();
