// Lane AD: automatic flyover detection (web/engine/autodetect.js, docs/AUTODETECT.md).
// node --test web/tests/autodetect.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { stft } from '../engine/stft.js';
import { parseWav } from '../engine/audio.js';
import { straightLineF } from '../engine/geoloc/doppler.js';
import { detectEvents, cropSpec, tonalMap } from '../engine/autodetect.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const log = (...a) => console.log('   ', ...a);
const FS = 8000;
// the app's default spectrogram: web/ui/spec-panel.js stftOptions({preset:'standard', hum:true, impulse:true}) at 8 kHz
const appStft = (x) => stft(x, { fs: FS, nperseg: 2048, nfft: 4096, hop: x.length / FS > 2400 ? 1024 : 512, fMin: 30, fMax: 2000,
  whiten: 'freq', whitenWindowS: 120, clipDb: [-10, 25] });
// same time/frequency grid from the file's own rate (avoids a slow resample of 16 kHz fixtures in the test)
function appSpec(file) {
  const w = parseWav(readFileSync(path.join(ROOT, file))), k = w.sampleRate / FS, dur = w.samples.length / w.sampleRate;
  return stft(w.samples, { fs: w.sampleRate, nperseg: 2048 * k, nfft: 4096 * k, hop: (dur > 2400 ? 1024 : 512) * k, fMin: 30, fMax: 2000,
    whiten: 'freq', whitenWindowS: 120, clipDb: [-10, 25] });
}

// deterministic noise
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

/** synthetic recording: straight-pass harmonic sources (exact model, MATH.md eq. 3.2), static tones, white noise */
function synth(durS, { passes = [], tones = [], noise = 1, seed = 1 } = {}) {
  const n = Math.round(durS * FS), x = new Float32Array(n), r = rng(seed);
  for (let i = 0; i < n; i++) x[i] = noise * gauss(r);
  for (const p of passes) {
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const T = i / FS - p.tc, f = straightLineF(T, p.F0, p.v, p.d);
      ph += 2 * Math.PI * f / FS;
      const R = Math.hypot(p.d, p.v * T), a = p.amp * p.d / R;
      for (let k = 1; k <= 4; k++) x[i] += a * (1 / k) * Math.sin(k * ph);
    }
  }
  for (const tn of tones) for (let i = Math.round(tn.t0 * FS); i < Math.min(n, tn.t1 * FS); i++) x[i] += tn.amp * Math.sin(2 * Math.PI * tn.f * i / FS);
  return x;
}

test('synthetic: two passes found, accurate, confident; static tones ignored', async () => {
  const c = 343, passes = [{ tc: 80, F0: 120, v: 60, d: 700, amp: 0.6 }, { tc: 230, F0: 95, v: 50, d: 500, amp: 0.6 }];
  const x = synth(320, { passes, tones: [{ f: 157, t0: 0, t1: 320, amp: 0.3 }, { f: 310, t0: 140, t1: 190, amp: 0.5 }], seed: 7 });
  const S = appStft(x);
  const evs = await detectEvents(S);
  log(`${evs.length} events, stats ${JSON.stringify(evs.stats)}`);
  for (const e of evs) log(`  t_cpa ${e.fit.t_cpa_audio.toFixed(2)} F0 ${e.fit.F0.toFixed(2)} n=${e.harmonic} v ${e.fit.point.v.toFixed(1)} d ${e.fit.point.d.toFixed(0)} score ${e.score} ${e.label}`);
  for (const p of passes) {
    const tdc = p.tc + p.d / c;                 // delayed CPA (MATH.md §3)
    const m = evs.find((e) => Math.abs(e.fit.t_cpa_audio - tdc) < 3);
    assert.ok(m, `pass at ${tdc.toFixed(1)} s not found`);
    assert.equal(m.label, 'confident');
    assert.ok(Math.abs(m.fit.t_cpa_audio - tdc) < 1, `t_cpa error ${(m.fit.t_cpa_audio - tdc).toFixed(2)} s`);
    assert.ok(Math.abs(m.fit.F0 - p.F0) / p.F0 < 0.02, `F0 ${m.fit.F0} vs ${p.F0}`);
    assert.ok(Math.abs(m.fit.point.v - p.v) / p.v < 0.1, `v ${m.fit.point.v} vs ${p.v}`);
    assert.ok(m.points.length > 100 && m.points.every(([t, f]) => Number.isFinite(t) && f > 0));
    assert.ok(m.seed.t >= m.span[0] - 1 && m.seed.t <= m.span[1] + 1);
  }
  assert.equal(evs.filter((e) => e.label === 'confident').length, 2, 'no confident detection besides the two passes');
});

test('synthetic negative control: noise + static/stepped tones give no confident event', async () => {
  const tones = [{ f: 120, t0: 0, t1: 300, amp: 0.4 }, { f: 240, t0: 50, t1: 120, amp: 0.4 }, { f: 230, t0: 120, t1: 200, amp: 0.4 },
    { f: 400, t0: 210, t1: 260, amp: 0.6 }, { f: 380, t0: 260, t1: 300, amp: 0.6 }];
  const S = appStft(synth(300, { tones, seed: 3 }));
  const evs = await detectEvents(S);
  log(`${evs.length} events: ${evs.map((e) => `${e.fit.t_cpa_audio.toFixed(0)}s ${e.score}`).join(', ')}`);
  assert.equal(evs.filter((e) => e.label === 'confident').length, 0);
});

test('options: maxEvents, minScore, tMin/tMax, exclude, abort, cropSpec', async () => {
  const passes = [{ tc: 60, F0: 120, v: 60, d: 700, amp: 0.6 }, { tc: 200, F0: 100, v: 55, d: 600, amp: 0.6 }];
  const S = appStft(synth(270, { passes, seed: 11 }));
  const all = await detectEvents(S);
  assert.ok(all.length >= 2);
  assert.equal((await detectEvents(S, { maxEvents: 1 })).length, 1);
  assert.equal((await detectEvents(S, { minScore: 1.01 })).length, 0);
  const late = await detectEvents(S, { tMin: 130 });
  assert.ok(late.length >= 1 && late.every((e) => e.seed.t >= 130), 'tMin respected');
  const ex = await detectEvents(S, { exclude: [{ t_cpa_audio: 60 + 700 / 343 }] });
  assert.ok(!ex.some((e) => Math.abs(e.fit.t_cpa_audio - 62) < 10), 'excluded pass not returned');
  const ac = new AbortController(); ac.abort();
  await assert.rejects(detectEvents(S, { signal: ac.signal }), (e) => e.name === 'AbortError');
  const progress = [];
  await detectEvents(S, { onProgress: (p) => progress.push(p.stage) });
  assert.ok(progress.includes('scan') && progress.includes('fit'));
  // zero-copy crop keeps the time axis
  const C = cropSpec(S, 100, 150);
  assert.equal(C.data.buffer, S.data.buffer);
  assert.ok(Math.abs(C.t0 - 100) <= S.dt && C.nT * C.nF === C.data.length);
  const m = tonalMap(S, { fMin: 40, fMax: 600 });
  assert.ok(m.sigma > 0 && m.nb > 0);
});

// ---------------------------------------------------------------- fixtures (truth events)
for (const name of ['scenario1', 'scenario2']) {
  test(`${name}: every truth pass detected (t_cpa < 3 s, F0 < 4 %)`, async () => {
    const S = appSpec(`fixtures/${name}/audio.wav`);
    const truth = JSON.parse(readFileSync(path.join(ROOT, `fixtures/${name}/truth.json`)));
    const t = performance.now();
    const evs = await detectEvents(S);
    log(`${evs.length} events in ${(performance.now() - t).toFixed(0)} ms`);
    for (const ev of truth.events) {
      const m = evs.find((e) => Math.abs(e.fit.t_cpa_audio - ev.t_cpa_audio) < 10);
      assert.ok(m, `${ev.flight} at ${ev.t_cpa_audio.toFixed(1)} s missed`);
      log(`  ${ev.flight}: t err ${(m.fit.t_cpa_audio - ev.t_cpa_audio).toFixed(2)} s, F0 ${m.fit.F0.toFixed(1)}/${ev.F0} Hz, v ${m.fit.point.v.toFixed(0)}/${ev.v_mps.toFixed(0)}, score ${m.score}`);
      assert.ok(Math.abs(m.fit.t_cpa_audio - ev.t_cpa_audio) < 3);
      assert.ok(Math.abs(m.fit.F0 - ev.F0) / ev.F0 < 0.04);
    }
    assert.ok(evs.length <= truth.events.length + 1, `${evs.length} detections for ${truth.events.length} passes`);
  });
}

test('colsto (real): both known passes detected, confident and ranked first', { skip: !existsSync(path.join(ROOT, 'fixtures/real/colsto_longisland/audio.wav')) }, async () => {
  const S = appSpec('fixtures/real/colsto_longisland/audio.wav');
  const t = performance.now();
  const evs = await detectEvents(S);
  log(`${evs.length} events in ${(performance.now() - t).toFixed(0)} ms: ${evs.map((e) => `${e.fit.t_cpa_audio.toFixed(0)}s ${e.score}`).join(', ')}`);
  // hand-marked ridges (fixtures/real/colsto_longisland/ridges.json) fit to t_cpa 255.3 s and 1168.8 s
  const top2 = evs.slice(0, 2).map((e) => e.fit.t_cpa_audio).sort((a, b) => a - b);
  assert.ok(Math.abs(top2[0] - 255.3) < 5 && Math.abs(top2[1] - 1168.8) < 5, `top-2 ${top2}`);
  assert.ok(evs.slice(0, 2).every((e) => e.label === 'confident'));
});

test('dsp.worker autodetect message', async () => {
  const { Worker } = await import('node:worker_threads');
  const url = pathToFileURL(path.join(ROOT, 'web/workers/dsp.worker.js')).href;
  // the worker file expects a browser `self`: shim it on top of worker_threads
  const code = `const { parentPort } = await import('node:worker_threads');
    globalThis.self = { postMessage: (m, t) => parentPort.postMessage(m, t) };
    await import(${JSON.stringify(url)});
    parentPort.on('message', (data) => self.onmessage({ data }));
    parentPort.postMessage('ready');`;
  const w = new Worker(new URL('data:text/javascript,' + encodeURIComponent(code)));
  try {
    await new Promise((res) => w.once('message', res));
    const S = appStft(synth(160, { passes: [{ tc: 70, F0: 110, v: 60, d: 600, amp: 0.6 }], seed: 5 }));
    const stages = new Set();
    const result = await new Promise((resolve, reject) => {
      w.on('message', (m) => { if (m.type === 'progress') stages.add(m.p.stage); else if (m.type === 'result') resolve(m.result); else if (m.type === 'error') reject(new Error(m.message)); });
      w.postMessage({ id: 1, type: 'autodetect', spec: S, opts: { maxEvents: 5 } });
    });
    assert.ok(Array.isArray(result.events) && result.events.length >= 1 && result.stats.tracklets >= 1);
    assert.ok(Math.abs(result.events[0].fit.t_cpa_audio - (70 + 600 / 343)) < 1.5);
    assert.ok(stages.has('scan'));
  } finally { await w.terminate(); }
});
