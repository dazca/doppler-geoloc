// Lane D: public API (web/engine/geoloc.js, contract web/engine/geoloc-api.md) end to end on scenario1/2.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScenario, horizErr, readJson } from './geoloc_helpers.mjs';
import * as Engine from '../engine/geoloc.js';
import * as Stub from '../engine/geoloc-stub.js';

const G = readJson('fixtures/golden_js/fit_scenarios.json');

test('API surface matches the stub', () => {
  for (const k of ['fitEvent', 'fetchFlights', 'runSearch', 'simulateCurves']) assert.equal(typeof Engine[k], typeof Stub[k], k);
  assert.equal(Engine.ENGINE_INFO.fake, false);
  assert.deepEqual(Engine.STAGE_ORDER, Stub.STAGE_ORDER);
});

test('fitEvent: EventFit shape and values vs fit.py (unweighted)', async () => {
  const g = G.scenario1[0];
  const f = await Engine.fitEvent(g.ridge.t.map((t, i) => [t, g.ridge.f[i]]));
  const py = g.fit_unweighted;
  for (const k of ['F0', 'v', 'd']) assert.ok(Math.abs((k === 'F0' ? f.F0 : f.point[k]) - py[k]) < 0.05 * py.sigma[k], k);
  assert.ok(Math.abs(f.t_c - py.t_c) < 0.05 * py.sigma.t_c);
  assert.ok(Math.abs(f.t_cpa_audio - (f.t_c + f.point.d / 343)) < 1e-9);
  assert.ok(f.v_mps[0] < f.point.v && f.point.v < f.v_mps[1] && f.cpa_m[0] < f.point.d && f.point.d < f.cpa_m[1]);
  assert.equal(f.n, g.ridge.t.length); assert.ok(f.curve.length > 100 && f.rms_hz > 0);
  await assert.rejects(Engine.fitEvent([[0, 100], [1, 100]]), /Too few/);
  await assert.rejects(Engine.fitEvent(Array.from({ length: 20 }, (_, i) => [i, 100])), /flat/);
});

function apiInput(sc, settings = {}, extra = {}) {
  const [la, lo] = sc.center, dLa = 12000 / 111000, dLo = 12000 / (111000 * Math.cos(la * Math.PI / 180));
  return {
    events: sc.events.map(({ _point_estimates, ...e }) => ({ ...e, cls: 'prop' })), silences: [],
    region: { shape: 'rect', center: sc.center, bbox: [la - dLa, lo - dLo, la + dLa, lo + dLo] },
    time: { t0: sc.truth.t_start_unix - 1800, t1: sc.truth.t_start_unix + 1800 }, duration_s: sc.duration,
    tracks: sc.tracksJson, spec: sc.spec, dem: sc.dem,
    settings: { grid_m: 200, c: 343, topN: 10, offsetTolS: 8, refine: true, workers: 0, ...settings }, ...extra,
  };
}

for (const name of ['scenario1', 'scenario2']) {
  test(`runSearch API ${name} (robust default): truth within 50 m, contract result shape, progress semantics`, async () => {
    const sc = loadScenario(name);
    const seen = [];
    let settled = false, late = false;
    const res = await Engine.runSearch(apiInput(sc), { onProgress: (p) => { if (settled) late = true; seen.push(p); } });
    settled = true;
    const b = res.candidates[0], err = horizErr(sc, b.lat, b.lon);
    console.log(`  ${name}: err ${err.toFixed(1)} m, score ${b.score.toFixed(3)}, flights ${b.flights}, dT ${(b.t_start_unix - sc.truth.t_start_unix).toFixed(2)} s, ${res.candidates.length} candidates, confidence: ${res.confidence.message}; ${res.stats.elapsedMs.toFixed(0)} ms`);
    for (const c of res.candidates.slice(0, 4)) console.log(`    cand ${horizErr(sc, c.lat, c.lon).toFixed(0)} m from truth, score ${c.score.toFixed(3)} (margin ${c.margin.toFixed(3)}), flights ${c.flights}, level ${c.level_m} m`);
    assert.ok(err < 50);
    assert.deepEqual(b.flights, sc.truth.events.map((e) => e.flight));
    for (const k of ['lat', 'lon', 'elev_m', 'score', 't_start_unix']) assert.equal(typeof b[k], 'number');
    assert.equal(b.assignments.length, sc.events.length);
    b.assignments.forEach((a, e) => { assert.ok(Math.abs(a.cpa_m - sc.truth.events[e].cpa_m) < 60); assert.ok(Math.abs(a.t_dcpa_audio - sc.truth.events[e].t_cpa_audio) < 2); });
    for (let i = 1; i < res.candidates.length; i++) assert.ok(res.candidates[i - 1].level_m < res.candidates[i].level_m || res.candidates[i - 1].score >= res.candidates[i].score);
    assert.equal(res.field.values.length, res.field.nLat * res.field.nLon);
    assert.ok(res.field.max > res.field.min);
    const st = [...new Set(seen.map((p) => p.stage))];
    assert.deepEqual(st, Engine.STAGE_ORDER);
    for (const s of Engine.STAGE_ORDER) assert.ok(seen.some((p) => p.stage === s && p.frac === 1), `stage ${s} reaches frac 1`);
    assert.ok(!late);
    assert.ok(res.stats.gridPoints > 10000);

    // simulateCurves: the fundamental crosses F0 at the delayed CPA (MATH.md §4)
    const curves = await Engine.simulateCurves(b, { events: apiInput(sc).events, tracks: sc.tracksJson, c: 343, harmonics: [1, 2] });
    assert.equal(curves.length, 2 * sc.events.length);
    for (const cv of curves.filter((q) => q.harmonic === 1)) {
      const a = b.assignments[cv.event];
      let best = null;
      for (const [t, f] of cv.points) if (!best || Math.abs(t - a.t_dcpa_audio) < Math.abs(best[0] - a.t_dcpa_audio)) best = [t, f];
      assert.ok(Math.abs(best[0] - a.t_dcpa_audio) <= 0.13 && Math.abs(best[1] - b.F0[cv.event]) < 0.5, `event ${cv.event}`);
    }
  });
}

test('runSearch API: faithful mode, ridge refit of CPA time, abort', async () => {
  const sc = loadScenario('scenario1');
  const V = readJson('fixtures/golden_js/robust_variants_scenario1.json')['measured t err +-10 s'];
  const evs = V.map(({ _point_estimates, ...e }, i) => ({ ...e, cls: 'prop', ridge: G.scenario1[i].ridge.t.map((t, k) => [t, G.scenario1[i].ridge.f[k]]) }));
  const r = await Engine.runSearch(apiInput(sc, { mode: 'faithful' }, { events: evs }));
  const err = horizErr(sc, r.candidates[0].lat, r.candidates[0].lon);
  console.log(`  t err +-10 s + ridges, faithful: err ${err.toFixed(1)} m; notes: ${r.stats.notes.join(' | ')}`);
  assert.ok(err < 50);
  const ac = new AbortController();
  const p = Engine.runSearch(apiInput(sc), { signal: ac.signal });
  setTimeout(() => ac.abort(), 300);
  const t = performance.now();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.ok(performance.now() - t < 300 + 250);
});
