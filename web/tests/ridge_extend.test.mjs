// Lane E2: one-click ridge auto-extension (web/engine/ridge-extend.js).
// node --test web/tests/ridge_extend.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stft } from '../engine/stft.js';
import { parseWav } from '../engine/audio.js';
import { trackRidge } from '../engine/ridge.js';
import { extendRidge, REAL_AUDIO_OPTS } from '../engine/ridge-extend.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OPTS = { harmonics: [1, 2, 3], monotonic: 'down', ...REAL_AUDIO_OPTS, snap: 6 };
// the app's "standard" preset (8 kHz: 2048/4096/hop 512), scaled to the file's rate
function appSpec(file) {
  const w = parseWav(readFileSync(path.join(ROOT, file))), k = w.sampleRate / 8000;
  return stft(w.samples, { fs: w.sampleRate, nperseg: 2048 * k, nfft: 4096 * k, hop: 512 * k, fMin: 30, fMax: 2000,
    whiten: 'freq', whitenWindowS: 120, clipDb: [-10, 25] });
}
// exact straight-pass model (MATH.md eq. 3.2)
const model = (T, F0, v, d, c = 343) => { const b = v / c, tau0 = d * Math.sqrt(1 - b * b) / v; return F0 / (1 - b * b) * (1 - b * T / Math.sqrt(T * T + tau0 * tau0)); };

test('scenario1: one click tracks each pass accurately (no drift onto noise)', () => {
  const S = appSpec('fixtures/scenario1/audio.wav');
  const truth = JSON.parse(readFileSync(path.join(ROOT, 'fixtures/scenario1/truth.json')));
  for (const [i, seed] of [[0, { t: 100.46, f: 125.86 }], [1, { t: 1023.21, f: 114.16 }]]) {
    const r = extendRidge(S, seed, OPTS), ev = truth.events[i];
    assert.ok(r.points.length > 500, `event ${i}: ${r.points.length} points`);
    const tc = ev.t_cpa_audio - ev.cpa_m / 343;          // symmetry centre (delayed CPA − d/c)
    const errs = r.points.filter((p) => Math.abs(p.t - tc) < 20).map((p) => Math.abs(p.f - model(p.t - tc, ev.F0, ev.v_mps, ev.cpa_m)));
    errs.sort((a, b) => a - b);
    assert.ok(errs[errs.length >> 1] < 1.5, `event ${i} median error ${errs[errs.length >> 1]} Hz within ±20 s of CPA`);
  }
});

test('colsto event 1: a single click spans ~201–276 s like Lane C\'s 3-click track', { skip: !existsSync(path.join(ROOT, 'fixtures/real/colsto_longisland/audio.wav')) }, () => {
  const S = appSpec('fixtures/real/colsto_longisland/audio.wav');
  for (const seed of [{ t: 230, f: 145.2 }, { t: 255, f: 115 }]) {
    const single = trackRidge(S, seed, OPTS).points, r = extendRidge(S, seed, OPTS).points;
    const span = [r[0].t, r[r.length - 1].t];
    assert.ok(span[0] < 205 && span[1] > 270, `click ${seed.t}s: extended span ${span.map((x) => x.toFixed(1))}`);
    assert.ok(span[1] - span[0] > (single[single.length - 1].t - single[0].t) + 15, 'extension adds > 15 s');
    assert.ok(r[0].f > 165 && r[r.length - 1].f < 105, `sweep ${r[0].f.toFixed(0)} → ${r[r.length - 1].f.toFixed(0)} Hz`);
  }
});
