// Lane D: D5 full search vs the Python reference (result_ref.json), D6 worker pool equivalence, D7 robustness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScenario, horizErr, readJson } from './geoloc_helpers.mjs';
import { runSearchCore } from '../engine/geoloc/search.js';
import { createGeolocPool, nodeWorkerFactory } from '../workers/geoloc-pool.js';
import { variants, runVariant } from './geoloc_robust_run.mjs';

const factory = await nodeWorkerFactory();
const run = (sc, cfg, opts = {}, events = sc.events) =>
  runSearchCore(sc.tracks, async (a, b) => sc.dem(a, b), events, sc.Z, sc.spec, sc.enu, sc.center, sc.duration, cfg, opts);

for (const name of ['scenario1', 'scenario2']) {
  test(`D5 ${name}: faithful mode reproduces ref/doppler_ref run_search (result_ref.json)`, async () => {
    const sc = loadScenario(name), ref = readJson(`fixtures/${name}/result_ref.json`);
    const t0 = performance.now();
    const r = await run(sc, { mode: 'faithful' });
    const el = performance.now() - t0;
    const err = horizErr(sc, r.best.lat, r.best.lon);
    console.log(`  ${name} faithful inline: grid ${r.n_grid} (ref ${ref.n_grid}), surv ${r.n_surv} (ref ${ref.n_surv}), levels ${r.levels.map((L) => `${L.n_points}/${L.n_surv}`)} (ref ${ref.levels.map((L) => `${L.n_points}/${L.n_surv}`)}), score ${r.best.score.toFixed(6)} (ref ${ref.best.score.toFixed(6)}), err ${err.toFixed(1)} m (ref ${ref.horizontal_error_m.toFixed(1)}), dT_start ${(r.best.t_start_unix - ref.best.t_start_unix).toFixed(4)} s vs ref, ${el.toFixed(0)} ms`);
    assert.equal(r.n_grid, ref.n_grid); assert.equal(r.n_surv, ref.n_surv);
    r.levels.forEach((L, i) => { assert.equal(L.n_points, ref.levels[i].n_points); assert.equal(L.n_surv, ref.levels[i].n_surv); });
    assert.ok(Math.abs(r.best.lat - ref.best.lat) < 1e-9 && Math.abs(r.best.lon - ref.best.lon) < 1e-9);
    assert.ok(Math.abs(r.best.score - ref.best.score) < 2e-3);
    assert.ok(Math.abs(r.best.t_start_unix - ref.best.t_start_unix) < 1e-3);
    r.best.F0.forEach((f, e) => assert.ok(Math.abs(f - ref.best.F0[e]) < 1e-6));
    assert.deepEqual(r.best.flights, ref.best.flights);
    assert.ok(err < 50);
  });

  test(`D6 ${name}: worker pool (x4) gives identical results to inline, robust mode within 50 m`, async () => {
    const sc = loadScenario(name);
    const pool = createGeolocPool({ size: 4, factory });
    try {
      const a = await run(sc, { mode: 'faithful' });
      const b = await run(sc, { mode: 'faithful' }, { exec: pool });
      assert.equal(a.best.score, b.best.score); assert.equal(a.best.lat, b.best.lat); assert.equal(a.n_surv, b.n_surv);
      const t0 = performance.now();
      const stages = [];
      const r = await run(sc, { mode: 'robust' }, { exec: pool, onProgress: (p) => stages.push(p.stage) });
      const err = horizErr(sc, r.best.lat, r.best.lon);
      console.log(`  ${name} robust pool x4: err ${err.toFixed(1)} m, score ${r.best.score.toFixed(4)}, margin ${r.margin.toFixed(3)}, surv ${r.n_surv}, ${(performance.now() - t0).toFixed(0)} ms`);
      assert.ok(err < 50);
      assert.deepEqual([...new Set(stages)], ['grid', 'cpa', 'filters', 'sim', 'score', 'refine']);
    } finally { pool.close(); }
  });
}

test('D6 abort: pool and inline searches reject with AbortError within 250 ms', async () => {
  const sc = loadScenario('scenario1');
  const pool = createGeolocPool({ size: 2, factory });
  try {
    for (const exec of [pool, undefined]) {
      const ac = new AbortController();
      const p = run(sc, { mode: 'robust' }, { exec, signal: ac.signal });
      await new Promise((r) => setTimeout(r, 400));
      const t = performance.now();
      ac.abort();
      await assert.rejects(p, (e) => e.name === 'AbortError');
      const dt = performance.now() - t;
      console.log(`  abort (${exec ? 'pool' : 'inline'}) honoured after ${dt.toFixed(0)} ms`);
      assert.ok(dt < 250);
    }
  } finally { pool.close(); }
});

test('D7 robustness (scenario1): robust mode recovers the variants that fail in faithful mode', async () => {
  const sc = loadScenario('scenario1');
  const pool = createGeolocPool({ size: 8, factory });
  try {
    const want = ['measured t err +-10 s', 'event-0 CPA range wrong (excludes truth)', 'measured v err +-30%, d err +-60%', 'measured t err +-6 s'];
    for (const v of variants(sc).filter((v) => want.includes(v.label))) {
      const f = await runVariant(sc, v, 'faithful', pool), r = await runVariant(sc, v, 'robust', pool);
      console.log(`  ${v.label}: faithful ${f.err_m} m (margin ${f.margin}) | robust ${r.err_m} m (margin ${r.margin}, ${r.time_ms} ms)`);
      assert.ok(r.err_m < 50 && r.ok_flights, v.label);
    }
  } finally { pool.close(); }
});
