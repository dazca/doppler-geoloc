// C6 robustness options (all opt-in; defaults unchanged). Run: node --test web/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stft } from '../engine/stft.js';
import { parseWav } from '../engine/audio.js';
import { trackRidge, trackRidgeMulti, cleanRidge } from '../engine/ridge.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/dsp');
const truth = JSON.parse(readFileSync(path.join(FIX, 'doppler_110_truth.json')));
const x0 = parseWav(readFileSync(path.join(FIX, 'doppler_110.wav'))).samples;
const fTrue = (h, t) => truth.f[String(h)][Math.min(truth.t.length - 1, Math.max(0, Math.round(t / 0.05)))];

// add a hum line at 600 Hz that switches on at t = 40 s, and loud broadband bursts
const x = Float32Array.from(x0);
for (let i = 40 * 16000; i < x.length; i++) x[i] += 0.05 * Math.sin(2 * Math.PI * 600 * i / 16000);
let s = 7;
for (const tb of [12, 28.5, 33, 50]) for (let i = tb * 16000; i < (tb + 0.15) * 16000; i++) { s = (s * 16807) % 2147483647; x[i] += 2 * (s / 2147483647 - 0.5); }
const base = { fs: 16000, nperseg: 4096, nfft: 8192, hop: 512, fMax: 2000, whiten: 'freq' };

const lineContrast = (S, f, t0, t1) => {
  const j = Math.round((f - S.f0) / S.df);
  let a = 0, b = 0, n = 0;
  for (let i = 0; i < S.nT; i++) {
    const t = S.t0 + i * S.dt; if (t < t0 || t > t1) continue;
    a += S.data[i * S.nF + j]; b += S.data[i * S.nF + j + 15]; n++;
  }
  return (a - b) / n;
};

test('whitenWindowS removes a hum line that switches on mid-file; clipDb clips', () => {
  const G = stft(x, base), L = stft(x, { ...base, whitenWindowS: 20, clipDb: 20 });
  const g = lineContrast(G, 600, 45, 58), l = lineContrast(L, 600, 45, 58);
  let mx = -Infinity; for (const v of L.data) mx = Math.max(mx, v);
  console.log(`    600 Hz on-switching hum, contrast t=45-58 s: global median ${g.toFixed(1)} dB, 20 s running median ${l.toFixed(1)} dB; max after clip ${mx}`);
  assert.ok(g > 8 && Math.abs(l) < 2 && mx <= 20);
});

test('ridge options: monotonic + impulseDb + emClip + robust null + guide + multi-seed', () => {
  const S = stft(x, { ...base, whitenWindowS: 20 });
  const real = { nullStat: 'robust', emClip: 15, impulseDb: 6, monotonic: 'down' };
  const h1 = trackRidgeMulti(S, [{ t: 27, f: fTrue(1, 27) }, { t: 33, f: fTrue(1, 33) }], { ...real, harmonics: [1, 2, 3] });
  const err = (pts, h) => { const e = pts.map((p) => Math.abs(p.f - fTrue(h, p.t))).sort((a, b) => a - b); return [e.length, e[e.length >> 1], e[Math.floor(0.95 * (e.length - 1))]]; };
  const [n1, m1, p1] = err(h1.points, 1);
  const h2 = trackRidge(S, { t: 30, f: 2 * fTrue(1, 30) }, { ...real, monotonic: null, guide: h1.points, guideMult: 2, guideTolHz: 6, guideOnly: true });
  const c2 = cleanRidge(h2.points, { winS: 2, maxDevHz: 4 });
  const [n2, m2, p2] = err(c2, 2);
  console.log(`    h1 (multi-seed, stacked, monotonic): n=${n1} median ${m1.toFixed(2)} p95 ${p1.toFixed(2)} Hz; h2 guided+clean: n=${n2} median ${m2.toFixed(2)} p95 ${p2.toFixed(2)} Hz`);
  // monotonic: frequency never increases by more than refinement jitter
  let up = 0; for (let k = 1; k < h1.points.length; k++) up = Math.max(up, h1.points[k].f - h1.points[k - 1].f);
  assert.ok(n1 > 300 && m1 < 1 && p1 < 3 && n2 > 150 && m2 < 1.5 && p2 < 5);
  assert.ok(up < S.df, `monotonic violated by ${up}`);
});
