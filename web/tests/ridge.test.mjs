// Ridge tracking on the synthetic Doppler pass (fixtures/dsp/doppler_110.wav). Run: node --test web/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stft } from '../engine/stft.js';
import { parseWav } from '../engine/audio.js';
import { trackRidge } from '../engine/ridge.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/dsp');
const truth = JSON.parse(readFileSync(path.join(FIX, 'doppler_110_truth.json')));
const x = parseWav(readFileSync(path.join(FIX, 'doppler_110.wav'))).samples;
const S = stft(x, { fs: 16000, nperseg: 4096, nfft: 8192, hop: 512, fMax: 2000, whiten: 'freq' });

// analytic f(t) by linear interpolation of the truth grid
const fTrue = (h, t) => {
  const g = truth.t, f = truth.f[String(h)], k = Math.min(g.length - 2, Math.max(0, Math.floor(t / 0.05)));
  return f[k] + (f[k + 1] - f[k]) * (t - g[k]) / (g[k + 1] - g[k]);
};
function errStats(pts, h) {
  const e = pts.map((p) => Math.abs(p.f - fTrue(h, p.t))).sort((a, b) => a - b);
  return { n: e.length, t0: pts[0].t, t1: pts.at(-1).t, median: e[e.length >> 1], p95: e[Math.floor(e.length * 0.95)], max: e.at(-1) };
}
const fmt = (s) => `n=${s.n} t=[${s.t0.toFixed(1)},${s.t1.toFixed(1)}] |err| median ${s.median.toFixed(2)} p95 ${s.p95.toFixed(2)} max ${s.max.toFixed(2)} Hz`;

for (const [h, clickT, clickErr] of [[1, 31, 3], [2, 25, -4], [2, 33, 3], [3, 33, 2]]) {
  test(`ridge h=${h}: seed near curve at t=${clickT}s`, () => {
    const seed = { t: clickT, f: fTrue(h, clickT) + clickErr };
    const t = performance.now();
    const r = trackRidge(S, seed, process.env.PEN ? { penalty: +process.env.PEN } : {});
    const ms = performance.now() - t;
    const st = errStats(r.points, h);
    console.log(`    h=${h} (${(h * 110)} Hz) ${fmt(st)} [${ms.toFixed(0)} ms]`);
    assert.ok(st.n > 150, 'ridge too short');
    assert.ok(st.median < 1.5 && st.p95 < 7, 'ridge error too large');
  });
}

for (const [label, h, mult] of [['fundamental, harmonics [1,2,3]', 1, [1, 2, 3]],
  ['fundamental, harmonics [1..6]', 1, [1, 2, 3, 4, 5, 6]], ['2nd harmonic clicked, [0.5,1,1.5,2]', 2, [0.5, 1, 1.5, 2]]]) {
  test(`ridge with harmonic stacking: ${label}`, () => {
    const r = trackRidge(S, { t: 30, f: fTrue(h, 30) + 2 }, { harmonics: mult, ...(process.env.PEN ? { penalty: +process.env.PEN } : {}) });
    const st = errStats(r.points, h);
    console.log(`    stacked ${label}: ${fmt(st)} (threshold ${r.threshold.toFixed(2)} dB, null ${r.nullStats.mean.toFixed(2)}±${r.nullStats.std.toFixed(2)})`);
    assert.ok(st.n > 300 && st.median < 1.0 && st.p95 < 3);
  });
}

test('pure-noise seed returns (almost) nothing', () => {
  const r = trackRidge(S, { t: 10, f: 700 });
  console.log(`    noise seed (700 Hz, t=10): ${r.points.length} points`);
  assert.ok(r.points.length < 40);
});
