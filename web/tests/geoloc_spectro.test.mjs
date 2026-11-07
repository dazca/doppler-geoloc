// Lane D: D3 spectrogram + whitening + curve score vs fixtures/golden.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { refSpectrogram, whiten, curveScore } from '../engine/geoloc/spectro.js';

const G = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/golden');
const load = (f) => JSON.parse(readFileSync(path.join(G, f)));

const g = load('spectrogram.json');
const x = new Float64Array(16000);
for (let n = 0; n < x.length; n++) {
  const t = n / 8000;
  x[n] = 0.5 * Math.sin(2 * Math.PI * (200 * t + 50 * t * t)) + 0.2 * Math.sin(2 * Math.PI * 440 * t) + 0.01 * Math.cos(2 * Math.PI * 1234.5 * t);
}
const sp = refSpectrogram(x, g.fs, { nperseg: g.nperseg, hop: g.hop, fmax: g.fmax });
const Z = whiten(sp);

test('D3 reference spectrogram (dB) and whitening vs spectrogram.json', () => {
  for (const k of ['t0', 'dt', 'f0', 'df', 'nT', 'nF']) assert.ok(Math.abs(sp[k] - g.spec[k]) < 1e-12, k);
  let ed = 0, ez = 0;
  for (let i = 0; i < sp.data.length; i++) {
    ed = Math.max(ed, Math.abs(sp.data[i] - g.spec.data[i]));
    ez = Math.max(ez, Math.abs(Z[i] - g.whitened[i]));
  }
  console.log(`  spectrogram ${sp.nT}x${sp.nF}: max |ddB| ${ed.toExponential(2)}, max |dz| ${ez.toExponential(2)}`);
  assert.ok(ed < g.tolerance.dB && ez < g.tolerance.whitened);
});

test('D3 multi-harmonic bilinear curve score vs curve_score_small.json', () => {
  const c = load('curve_score_small.json');
  for (const cs of c.cases) {
    const s = curveScore(Z, sp, cs.t_audio, cs.ratio, cs.F0, cs.harmonics);
    console.log(`  K=${cs.harmonics.length}: js ${s.toFixed(6)} ref ${cs.score.toFixed(6)}`);
    assert.ok(Math.abs(s - cs.score) < c.tolerance.score);
  }
});

import { loadScenario } from './geoloc_helpers.mjs';
import { makeScoreContext, scoreEvent, arange } from '../engine/geoloc/score.js';
import { cpa } from '../engine/geoloc/doppler.js';
import { DEFAULT_CONFIG } from '../engine/geoloc/search.js';

test('D3 scenario1: spectrogram checksums + score_point at 5 observers vs scenario1_point_scores.json', () => {
  const g = load('scenario1_point_scores.json');
  const sc = loadScenario('scenario1');
  const { spec, Z } = sc;
  assert.equal(spec.nT, g.spec_checksums.nT); assert.equal(spec.nF, g.spec_checksums.nF);
  let m = 0, mz = 0;
  for (let i = 0; i < spec.data.length; i++) { m += spec.data[i]; mz += Z[i]; }
  m /= spec.data.length; mz /= Z.length;
  const r100 = Array.from(spec.data.subarray(100 * spec.nF, 100 * spec.nF + 8));
  console.log(`  scenario1 spec ${spec.nT}x${spec.nF} mean ${m.toFixed(5)} dB (ref ${g.spec_checksums.mean_dB.toFixed(5)}), z mean ${mz.toFixed(5)} (ref ${g.spec_checksums.whitened_mean.toFixed(5)}); timing ${JSON.stringify(sc.timing)}`);
  assert.ok(Math.abs(m - g.spec_checksums.mean_dB) < g.tolerance.mean_dB);
  assert.ok(Math.abs(mz - g.spec_checksums.whitened_mean) < 1e-3);
  r100.forEach((v, i) => assert.ok(Math.abs(v - g.spec_checksums.row100_first8[i]) < 1e-3));
  const cfg = { ...DEFAULT_CONFIG };
  const ctx = makeScoreContext(sc.tracks, Z, spec, cfg);
  const ids = sc.tracks.map((t) => t.id);
  const tau = arange(-cfg.tau_half, cfg.tau_half, cfg.tau_step);
  const outS = new Float64Array(1), outR = new Int16Array(1);
  let worst = 0;
  for (const p of g.points) {
    const el = sc.dem.one(p.lat, p.lon);
    assert.ok(Math.abs(el - p.elev_m) < 1e-6, 'analytic DEM');
    const o = sc.enu.fwd(p.lat, p.lon, el);
    const per = p.flights.map((fid, e) => {
      const f = ids.indexOf(fid);
      const t_dcpa = cpa(sc.tracks[f], [o], cfg.c).t_dcpa[0];
      scoreEvent(ctx, f, o[0], o[1], o[2], t_dcpa, p.t_start_unix, tau, cfg.tau_step, [0], [p.F0[e]], outS, outR, 0);
      return outS[0];
    });
    const tot = per[0] + per[1];
    worst = Math.max(worst, Math.abs(tot - p.score), ...per.map((s, e) => Math.abs(s - p.event_scores[e])));
    console.log(`  point (${p.lat.toFixed(5)},${p.lon.toFixed(5)}): js ${tot.toFixed(5)} [${per.map((s) => s.toFixed(4))}] ref ${p.score.toFixed(5)} [${p.event_scores.map((s) => s.toFixed(4))}]`);
  }
  assert.ok(worst < g.tolerance.score_abs, `max score diff ${worst}`);
});
