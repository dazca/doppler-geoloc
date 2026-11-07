// Lane D (D9): performance budget. Guards against regressions with deterministic work counters (machine
// independent) plus generous wall-time ceilings (the CI/dev machine is often shared).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, loadScenario, horizErr } from './geoloc_helpers.mjs';
import { kernelBenchSetup, kernelBenchRun } from './geoloc_kernel_bench_lib.mjs';
import { runSearchCore } from '../engine/geoloc/search.js';
import { parseWav } from '../engine/audio.js';
import * as Engine from '../engine/geoloc.js';

test('perf: scoring kernel throughput and work (scenario1 fixed job)', async () => {
  const env = await kernelBenchSetup({ readJson: async (p) => JSON.parse(await readFile(path.join(ROOT, p))), readBin: (p) => readFile(path.join(ROOT, p)) });
  kernelBenchRun(env); // JIT warm-up
  const r = [kernelBenchRun(env), kernelBenchRun(env)].sort((a, b) => a.nsPerSample - b.nsPerSample)[0];
  console.log(`  kernel: ${r.samplesM} M samples, ${r.ms} ms, ${r.nsPerSample} ns/sample (budget 60 ns; measured 12-14 ns on Node, Firefox 131, Chromium 130)`);
  assert.ok(Math.abs(r.samplesM - 91.8) < 1.0, 'c2f sweep work changed');
  assert.ok(r.nsPerSample < 60, 'kernel too slow');
});

test('perf: robust search work budget on scenario1 (bilinear samples, survivors)', async () => {
  const sc = loadScenario('scenario1');
  const t0 = performance.now();
  const r = await runSearchCore(sc.tracks, async (a, b) => sc.dem(a, b), sc.events, sc.Z, sc.spec, sc.enu, sc.center, sc.duration, { mode: 'robust' });
  const ms = performance.now() - t0;
  console.log(`  scenario1 robust inline: ${(r.evals / 1e6).toFixed(1)} M samples (budget 180 M; D7 was 512 M; D10 soft silence keeps more survivors), ${r.n_surv} coarse survivors, ${ms.toFixed(0)} ms (budget 30 s)`);
  assert.ok(r.evals < 180e6);
  assert.ok(horizErr(sc, r.best.lat, r.best.lon) < 50);
  assert.ok(ms < 30000);
});

test('perf + acceptance: real colsto (5410 tracks, 30 h, 15 km circle) reproduces Lane A within budget', async () => {
  const D = path.join(ROOT, 'fixtures/real/colsto_longisland');
  const meta = JSON.parse(await readFile(path.join(D, 'meta.json')));
  const ridges = JSON.parse(await readFile(path.join(D, 'ridges.json')));
  const tracks = JSON.parse(await readFile(path.join(D, 'tracks_2026.json')));
  const wav = parseWav(await readFile(path.join(D, 'audio.wav')));
  let t = performance.now();
  const spec = await Engine.referenceSpectrogram(wav.samples, wav.sampleRate);
  const tSpec = performance.now() - t;
  const events = [];
  for (const ev of [1, 2]) {
    const pts = ridges.find((r) => r.event === ev && r.harmonic === 1).points;
    const fit = await Engine.fitEvent(pts, { cls: 'prop' });
    events.push({ t_cpa_audio: fit.t_cpa_audio, F0: fit.F0, v_mps: fit.v_mps, cpa_m: fit.cpa_m, cls: 'prop', t_sigma_s: fit.t_sigma_s, ridge: pts });
  }
  const [w0, w1] = meta.date_utc_window.map((s) => Date.parse(s) / 1000);
  t = performance.now();
  const res = await Engine.runSearch({ events, silences: [], duration_s: wav.samples.length / wav.sampleRate, tracks, spec,
    region: { shape: 'circle', center: [meta.true_lat, meta.true_lon], radius_m: 15000, bbox: [meta.true_lat - 0.14, meta.true_lon - 0.18, meta.true_lat + 0.14, meta.true_lon + 0.18] },
    time: { t0: w0, t1: w1 }, dem: (lat) => new Float64Array(lat.length).fill(20),
    settings: { grid_m: 200, mode: 'robust', workers: 0 } });
  const ms = performance.now() - t, sb = res.stats.survivorsByStage, tm = res.stats.timings;
  console.log(`  colsto inline: spectrogram ${tSpec.toFixed(0)} ms; search ${ms.toFixed(0)} ms (budget 120 s); pairs ${sb.cpa} (budget 3 M), before veto/cap ${sb.filters_before_veto_cap}, scored ${sb.filters}; cpa ${tm.cpa.toFixed(0)} ms, filters ${tm.filters.toFixed(0)} ms, veto ${tm.veto.toFixed(0)} ms`);
  assert.ok(tSpec < 15000, 'decimator + spectrogram budget');
  assert.ok(sb.cpa < 3e6, 'sparse CPA pairs budget (engine-aware reach: turboprops 9 km)');
  assert.ok(sb.filters <= 20000);
  assert.ok(tm.filters < 10000 && tm.veto < 10000, 'filters/veto budget');
  assert.ok(ms < 120000, 'search budget');
  // acceptance (Lane A, result_laneA_ridge_2026.json): 40.8762, -73.5251, CST1219 PC-12 a1dfeb + EGE93 B350 ace391,
  // T_start 2026-09-08 20:49:11Z (1788900551.2)
  const b = res.candidates[0], kx = 111320 * Math.cos(40.876 * Math.PI / 180);
  const err = Math.hypot((b.lat - 40.87619) * 110950, (b.lon + 73.52506) * kx);
  console.log(`  colsto answer: ${b.lat.toFixed(5)},${b.lon.toFixed(5)} (${err.toFixed(0)} m from Lane A), ${b.flights.join('+')}, T_start ${new Date(b.t_start_unix * 1000).toISOString()} (${(b.t_start_unix - 1788900551.22).toFixed(2)} s), ridge RMS ${b.ridge_rms?.map((x) => (100 * x).toFixed(2) + ' %')}, ${res.confidence.message}`);
  assert.ok(err < 300, 'position vs Lane A');
  assert.deepEqual(b.flights.map((f) => f.split('_')[0]), ['a1dfeb', 'ace391']);
  assert.ok(Math.abs(b.t_start_unix - 1788900551.22) < 2, 'T_start');
  assert.equal(res.confidence.verdict, 'match', 'D11 absolute verdict');
});
