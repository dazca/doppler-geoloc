// Lane D (D8): accuracy / margin / ambiguity table over scenario1, scenario2 and fixtures/scenario_rand*.
// node web/tests/geoloc_alias_run.mjs [configLabel=all] [--auto]   (--auto: events from ridge + honest fit)
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { loadScenario, horizErr, ROOT } from './geoloc_helpers.mjs';
import { runSearchCore } from '../engine/geoloc/search.js';
import { createGeolocPool, nodeWorkerFactory } from '../workers/geoloc-pool.js';
import { trackRidgeRef, fitPass } from '../engine/geoloc/fit.js';

export const SCENARIOS = ['scenario1', 'scenario2',
  ...readdirSync(path.join(ROOT, 'fixtures')).filter((d) => /^scenario_rand\d+$/.test(d)).sort()];

export const D7_CONFIG = { weighting: 'none', evidence: null, sweep: 'full', prescreen: { min: 64, keep_frac: 0.2, keep_min: 64, recentre: false },
  soft: { seed_min_frac: 0, refine_tau: [0.25, 0.25] } };
export const CONFIGS = {
  'D7': D7_CONFIG,
  'D8': {},
  'D8 + T_start metadata': { meta: 60 },
};

export function autoEvents(sc) {
  return sc.events.map((ev) => {
    const r = trackRidgeRef(sc.Z, sc.spec, ev.t_cpa_audio, ev.F0);
    const f = fitPass(r.t, r.f, { cls: 'prop', weights: r.s });
    return { t_cpa_audio: f.t_cpa_audio, F0: f.F0, v_mps: f.ranges.v_mps, cpa_m: f.ranges.cpa_m, cls: 'prop',
      t_sigma_s: f.sigma_total.t_cpa_audio, ridge: r.t.map((t, i) => [t, r.f[i]]) };
  });
}

export async function runOne(sc, cfgIn, exec, events = sc.events) {
  const t0 = performance.now();
  const { meta, ...cfg } = cfgIn;
  // simulated file-metadata time: true start + 37 s offset, +-meta s window (soft prior in robust mode)
  if (meta) cfg.t_start_prior = [sc.truth.t_start_unix + 37, meta];
  const r = await runSearchCore(sc.tracks, async (a, b) => sc.dem(a, b), events.map((e) => ({ cls: 'prop', ...e })),
    sc.Z, sc.spec, sc.enu, sc.center, sc.duration, { mode: 'robust', ...cfg }, { exec, rawSpec: sc.spec });
  const b = r.best, tf = sc.truth.events.map((e) => e.flight);
  if (!b) return { err: 'FAIL', margin: null, ambiguous: true, ms: Math.round(performance.now() - t0) };
  const ru = r.runnerUp;
  return { err: Math.round(horizErr(sc, b.lat, b.lon)), ok: b.flights.join() === tf.join(), margin: r.margin, ambiguous: r.margin != null && r.margin < 0.1,
    runner: ru ? `${Math.round(horizErr(sc, ru.lat, ru.lon))} m ${ru.flights.join('+')}` : '-', score: b.score, ms: Math.round(performance.now() - t0),
    evidence: b.evidence ?? null };
}

if (process.argv[1]?.endsWith('geoloc_alias_run.mjs')) {
  const only = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  const auto = process.argv.includes('--auto');
  const exec = createGeolocPool({ size: 16, factory: await nodeWorkerFactory() });
  for (const name of SCENARIOS) {
    const sc = loadScenario(name);
    const evs = auto ? autoEvents(sc) : sc.events;
    for (const [label, cfg] of Object.entries(CONFIGS)) {
      if (only && !label.startsWith(only)) continue;
      const r = await runOne(sc, cfg, exec, evs);
      console.log(`${name.padEnd(17)} ${label.padEnd(22)} err ${String(r.err).padStart(5)} m ${r.ok ? 'ok ' : 'BAD'} margin ${r.margin == null ? '  -  ' : r.margin.toFixed(3)} ${r.ambiguous ? 'AMBIG' : 'clear'}  runner-up ${r.runner}  (${r.ms} ms)${r.evidence ? '  ev ' + JSON.stringify(r.evidence) : ''}`);
    }
  }
  exec.close();
}
