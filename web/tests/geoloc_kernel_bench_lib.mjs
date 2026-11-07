// Shared setup for the scoring-kernel benchmark (browser page + Node script + performance-budget test).
// A fixed robust-mode coarse job on scenario1: 256 survivors (grid points around the truth) x 2 events,
// tau 0.5 s, delta +-12 s / 0.5 s, rho +-4 % / 0.5 %, c2f sweep, SNR weighting.
import { parseWav } from '../engine/audio.js';
import { makeENU } from '../engine/geoloc/geo.js';
import { buildTrack } from '../engine/geoloc/track.js';
import { cpa } from '../engine/geoloc/doppler.js';
import { refSpectrogram, whiten } from '../engine/geoloc/spectro.js';
import { makeScoreContext, scoreBatch } from '../engine/geoloc/score.js';
import { makeConfig } from '../engine/geoloc/search.js';

export async function kernelBenchSetup({ readJson, readBin }) {
  const d = 'fixtures/scenario1/';
  const [scen, truth, tracksJson] = await Promise.all([readJson(d + 'scenario.json'), readJson(d + 'truth.json'), readJson(d + 'tracks.json')]);
  const w = parseWav(await readBin(d + 'audio.wav'));
  const spec0 = refSpectrogram(w.samples, w.sampleRate);
  const Z = whiten(spec0);
  const spec = { t0: spec0.t0, dt: spec0.dt, f0: spec0.f0, df: spec0.df, nT: spec0.nT, nF: spec0.nF };
  const enu = makeENU(scen.ref[0], scen.ref[1], 0);
  const tracks = tracksJson.map((t) => buildTrack(t, enu, 15));
  const ids = tracks.map((t) => t.id), fl = truth.events.map((e) => ids.indexOf(e.flight));
  const cfg = makeConfig({ mode: 'robust' });
  const o = truth.observer.enu, S = 256, E = fl.length;
  const job = { S, E, f: new Int32Array(S * E), obs: new Float64Array(3 * S), tdcpa: new Float64Array(S * E), sT: new Float64Array(S),
    F0: truth.events.map((e) => e.F0), tau_step: 0.5, delta: [-12, 12, 0.5], f0_rel: 0.04, f0_step: 0.005, sweep: 'c2f', pen: null };
  for (let s = 0; s < S; s++) {
    const p = [o[0] + ((s % 16) - 8) * 50, o[1] + (Math.floor(s / 16) - 8) * 50, o[2]];
    job.obs.set(p, 3 * s);
    for (let e = 0; e < E; e++) { job.f[s * E + e] = fl[e]; job.tdcpa[s * E + e] = cpa(tracks[fl[e]], [p], 343).t_dcpa[0]; }
    job.sT[s] = truth.t_start_unix;
  }
  return { tracks, Z, spec, cfg, job, ctx: makeScoreContext(tracks, Z, spec, cfg) };
}

export function kernelBenchRun(env) {
  const t = performance.now();
  const r = scoreBatch(env.ctx, env.job);
  const ms = performance.now() - t;
  return { ms: Math.round(ms), samplesM: +(r.evals / 1e6).toFixed(1), nsPerSample: +(ms * 1e6 / r.evals).toFixed(2) };
}
