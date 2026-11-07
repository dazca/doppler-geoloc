// Lane D (D11): absolute verdict, montage support (independent T_start per clip), ground-ops filter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScenario, horizErr } from './geoloc_helpers.mjs';
import { apiInput } from './geoloc_verdict_run.mjs';
import * as Engine from '../engine/geoloc.js';
import { refSpectrogram } from '../engine/geoloc/spectro.js';
import { createGeolocPool, nodeWorkerFactory } from '../workers/geoloc-pool.js';

const factory = await nodeWorkerFactory();

test('D11 verdict: true synthetic solutions are a match; a hypothesis on the wrong flights is not', async () => {
  const exec = createGeolocPool({ size: 8, factory });
  try {
    for (const name of ['scenario1', 'scenario2']) {
      const sc = loadScenario(name);
      const res = await Engine.runSearch(apiInput(sc, sc.events), { exec });
      const a = res.confidence.absolute;
      console.log(`  ${name}: ${a.verdict} (weakest event z ${a.z_min}); ${a.reasons[0]}`);
      assert.equal(a.verdict, 'match');
      assert.equal(res.confidence.verdict, 'match');
    }
    // wrong flights: scenario1 events but only distractor tracks (P1/P2 removed) -> must not be a confident match
    const sc = loadScenario('scenario1');
    const inp = apiInput(sc, sc.events);
    inp.tracks = sc.tracksJson.filter((t) => t.id !== 'P1' && t.id !== 'P2');
    const res = await Engine.runSearch(inp, { exec });
    const v = res.confidence.absolute.verdict;
    console.log(`  scenario1 without the true flights: ${res.candidates.length ? horizErr(sc, res.candidates[0].lat, res.candidates[0].lon).toFixed(0) + ' m' : 'no candidate'}, verdict ${v}; ${res.confidence.absolute.reasons.slice(0, 2).join(' | ')}`);
    assert.notEqual(v, 'match');
  } finally { exec.close(); }
});

test('D11 ground-ops filter: static tones, run-ups and rpm steps are not flyovers; real passes are', () => {
  const st = Array.from({ length: 200 }, (_, i) => [i * 0.1, 120 + 0.3 * Math.sin(i)]);
  const up = Array.from({ length: 200 }, (_, i) => [i * 0.1, 100 + 0.2 * i]);
  const step = Array.from({ length: 200 }, (_, i) => [i * 0.1, i < 100 ? 150 : i < 108 ? 150 - 2.5 * (i - 100) : 130]);
  const pass = Array.from({ length: 300 }, (_, i) => { const T = i * 0.1 - 15, b = 0.17, t0 = 5; return [i * 0.1, 120 / (1 - b * b) * (1 - b * T / Math.sqrt(T * T + t0 * t0))]; });
  assert.equal(Engine.flyoverCheck(st).kind, 'static');
  assert.equal(Engine.flyoverCheck(up).kind, 'rising');
  assert.equal(Engine.flyoverCheck(step).kind, 'step');
  assert.equal(Engine.flyoverCheck(pass).kind, 'flyover');
});

test('D11 montage: three clips of scenario2 re-ordered (independent T_start) are located with clip ids', async () => {
  const sc = loadScenario('scenario2');
  const fs = sc.fs, T0 = sc.truth.t_start_unix;
  const ev = sc.events.map(({ _point_estimates, ...e }) => e);
  // clip windows around each pass (original audio time), re-ordered C, A, B
  const win = ev.map((e) => [Math.max(0, e.t_cpa_audio - 90), Math.min(sc.duration, e.t_cpa_audio + 90)]);
  const order = [2, 0, 1], parts = [], clips = [], events = [];
  let off = 0;
  for (const k of order) {
    const [a, b] = win[k];
    parts.push(sc.samples.subarray(Math.round(a * fs), Math.round(b * fs)));
    clips.push({ id: `clip${k}`, t0: off, t1: off + (b - a), T_true: T0 + a - off });
    events.push({ ...ev[k], t_cpa_audio: ev[k].t_cpa_audio - a + off, clip: `clip${k}`, cls: 'prop' });
    off += b - a;
  }
  const x = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { x.set(p, o); o += p.length; }
  const spec = refSpectrogram(x, fs);
  const exec = createGeolocPool({ size: 8, factory });
  try {
    const base = apiInput(sc, events);
    base.spec = spec; base.duration_s = off; base.clips = clips.map(({ id, t0, t1 }) => ({ id, t0, t1 }));
    base.time = { t0: T0 - 1800, t1: T0 + 1800 };
    const t = performance.now();
    const res = await Engine.runSearch(base, { exec });
    const b = res.candidates[0], err = horizErr(sc, b.lat, b.lon);
    const dT = clips.map((c) => (b.t_start_by_clip[c.id] - c.T_true).toFixed(2));
    console.log(`  montage with clip ids: err ${err.toFixed(0)} m, flights ${b.flights.join('+')}, T_start error per clip ${dT.join(' / ')} s, verdict ${res.confidence.verdict}, ${(performance.now() - t).toFixed(0)} ms`);
    assert.ok(err < 150);
    assert.deepEqual(b.flights, order.map((k) => sc.truth.events[k].flight));
    clips.forEach((c) => assert.ok(Math.abs(b.t_start_by_clip[c.id] - c.T_true) < 3));
    // same input without clip ids: offsets are inconsistent, the single-timeline search cannot explain it
    const noClip = { ...base, events: events.map(({ clip, ...e }) => e) };
    delete noClip.clips;
    const r2 = await Engine.runSearch(noClip, { exec });
    const b2 = r2.candidates[0];
    console.log(`  same montage without clip ids: ${b2 ? horizErr(sc, b2.lat, b2.lon).toFixed(0) + ' m, verdict ' + r2.confidence.verdict : 'no candidate'}`);
  } finally { exec.close(); }
});
