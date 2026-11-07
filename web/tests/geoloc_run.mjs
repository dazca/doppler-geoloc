// Lane D: run the JS search on a scenario and print accuracy / timings.  node web/tests/geoloc_run.mjs scenario1 [robust]
import { loadScenario, horizErr } from './geoloc_helpers.mjs';
import { runSearchCore } from '../engine/geoloc/search.js';

const names = process.argv.slice(2).filter((a) => a.startsWith('scenario'));
const mode = process.argv.includes('robust') ? 'robust' : 'faithful';
for (const name of names.length ? names : ['scenario1', 'scenario2']) {
  const sc = loadScenario(name);
  const dem = async (lat, lon) => sc.dem(lat, lon);
  const t0 = performance.now();
  const r = await runSearchCore(sc.tracks, dem, sc.events, sc.Z, sc.spec, sc.enu, sc.center, sc.duration, { mode });
  const el = performance.now() - t0;
  const b = r.best;
  console.log(`== ${name} [${mode}]: grid ${r.n_grid}, coarse survivors ${r.n_surv}`);
  for (const L of r.levels) console.log(`   refine ${L.spacing} m: ${L.n_points} pts, ${L.n_surv} surv, best ${L.best.score.toFixed(3)} err ${horizErr(sc, L.best.lat, L.best.lon).toFixed(0)} m`);
  console.log(`   best ${b.lat.toFixed(6)},${b.lon.toFixed(6)} score ${b.score.toFixed(4)} flights ${b.flights} dT ${(b.t_start_unix - sc.truth.t_start_unix).toFixed(2)} s F0 ${b.F0.map((x) => x.toFixed(2))}`);
  console.log(`   evals ${r.evals}; HORIZONTAL ERROR ${horizErr(sc, b.lat, b.lon).toFixed(1)} m; margin ${r.margin?.toFixed(3)}; total ${el.toFixed(0)} ms; timings ${JSON.stringify(Object.fromEntries(Object.entries(r.timings).map(([k, v]) => [k, Math.round(v)])))}`);
}
