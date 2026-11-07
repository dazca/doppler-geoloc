// Lane D (D8): robust-mode work/accuracy for several speed configurations.
// node web/tests/geoloc_speed_run.mjs [scenario names...]   (default: scenario1 scenario2)
// Prints bilinear samples (machine independent), wall time with a 16-worker pool, error and margin.
import { loadScenario, horizErr } from './geoloc_helpers.mjs';
import { runSearchCore } from '../engine/geoloc/search.js';
import { createGeolocPool, nodeWorkerFactory } from '../workers/geoloc-pool.js';

const names = process.argv.slice(2).length ? process.argv.slice(2) : ['scenario1', 'scenario2'];
const CONFIGS = {
  'D7 robust (full sweep)': { weighting: 'none', sweep: 'full', prescreen: { min: 64, keep_frac: 0.2, keep_min: 64, recentre: false }, soft: { seed_min_frac: 0, refine_tau: [0.25, 0.25] } },
  '+ c2f sweep': { weighting: 'none', prescreen: { min: 64, keep_frac: 0.2, keep_min: 64, recentre: false }, soft: { seed_min_frac: 0, refine_tau: [0.25, 0.25] } },
  '+ prescreen re-centred (delta +-1.5 s)': { weighting: 'none', soft: { seed_min_frac: 0, refine_tau: [0.25, 0.25] } },
  '+ tau 0.5 s at 100 m': { weighting: 'none', soft: { seed_min_frac: 0 } },
  '+ seed pruning (< 50 % of best)': { weighting: 'none' },
  'D8 default (+ SNR-envelope weighting)': {},
};
const pool = createGeolocPool({ size: 16, factory: await nodeWorkerFactory() });
for (const name of names) {
  const sc = loadScenario(name);
  for (const [label, cfg] of Object.entries(CONFIGS)) {
    const run = () => runSearchCore(sc.tracks, async (a, b) => sc.dem(a, b), sc.events, sc.Z, sc.spec, sc.enu, sc.center, sc.duration,
      { mode: 'robust', ...cfg }, { exec: pool });
    await run();
    const t0 = performance.now();
    const r = await run();
    const el = performance.now() - t0;
    console.log(`${name.padEnd(17)} ${label.padEnd(56)} samples ${(r.evals / 1e6).toFixed(1).padStart(6)} M  pool16 ${el.toFixed(0).padStart(5)} ms  err ${horizErr(sc, r.best.lat, r.best.lon).toFixed(1)} m  score ${r.best.score.toFixed(4)}  margin ${r.margin?.toFixed(3)}  refine pts ${r.n_refine_points}`);
  }
}
pool.close();
